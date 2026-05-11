# WebRemoteDesktop 端到端延迟测量系统设计

## 背景与目标

当前 WebRemoteDesktop 在所有网络模式下都存在 **1 秒左右的端到端延迟**，隧道中继模式下甚至达到 **2 秒以上**。之前的性能优化（分辨率上限、帧率降低、动态码率）针对的是编码吞吐，但并未解决延迟问题。

本系统目标是通过在关键路径上插入高精度时间戳，将 1 秒延迟分解到具体环节（采集、编码、网络、浏览器缓冲、输入回传），从而精确定位瓶颈并指导后续优化。

## 测量架构与采集点

在 Host 端和 Viewer 端的关键路径上插入 7 个时间戳，覆盖从"屏幕变化"到"眼睛看到"的完整链路。

### Host 端（python-host）

| 时间戳 | 位置 | 说明 |
|-------|------|------|
| T0 | `ScreenCaptureTrack.recv()` 开头 | 开始截屏 |
| T1 | `self._next_capture.result()` 返回后 | 截屏完成（MSS.grab 返回） |
| T2 | `_scale_image_array()` 返回后 | 缩放完成 |
| T3 | `codec.encode(frame)` 返回后 | H.264 编码完成 |
| T4 | 第一个 RTP packet 发出后 | 通过 `getStats` 或发送回调估算 |
| I1 | `InputHandler.handle_input()` 收到时 | 输入事件到达 Host |
| I2 | `InputHandler` 执行完 Quartz 后 | 输入模拟完成 |

### Viewer 端（web-client）

| 时间戳 | 位置 | 说明 |
|-------|------|------|
| T5 | 收到完整帧时 | 最后一个 RTP packet 到达 |
| T6 | `video.requestVideoFrameCallback()` 回调 | 视频解码完成 |
| I0 | `Input.sendInput()` 调用时 | 输入事件从浏览器发出 |

### 关键指标定义

| 指标 | 公式 | 正常范围参考 |
|-----|------|-----------|
| CaptureLatency | T1 - T0 | < 50ms |
| ScaleLatency | T2 - T1 | < 20ms |
| EncodeLatency | T3 - T2 | < 100ms (720p@20fps) |
| SendLatency | T4 - T3 | < 10ms |
| NetworkVideo | T5 - T4_viewer | 取决于 RTT |
| PlayoutBuffer | T6 - T5 | < 200ms (理想 < 100ms) |
| InputNetwork | I1_viewer - I0 | ~RTT/2 |
| ExecuteTime | I2 - I1 | < 10ms |
| WaitForCapture | T0 - I2 | < 50ms (一帧间隔) |
| **InputRoundTrip** | **T6 - I0** | **< 300ms (目标)** |

## 数据流与传递机制

### Host → Viewer 的时间戳传递

Host 端每完成一帧编码后，将该帧的 `(T0..T4)` 和绑定的输入信息打包成 JSON，通过 **WebRTC DataChannel** 发送给 Viewer。

```json
{
  "type": "frame_timing",
  "frameId": 12345,
  "timings": {
    "captureStart": 1715432100.000,
    "captureEnd": 1715432100.050,
    "scaleEnd": 1715432100.080,
    "encodeEnd": 1715432100.200,
    "packetSend": 1715432100.210
  },
  "input": {
    "ids": ["input-uuid-1", "input-uuid-2"],
    "receiveTime": 1715432099.800,
    "executeTime": 1715432099.805
  }
}
```

**选择 DataChannel 的原因：**
- 与视频帧走同一条网络路径，网络延迟测量更真实
- 低延迟、轻量（每帧 ~100 字节）
- Tunnel 模式降级为 Socket.IO 传输

### Viewer 端时间戳收集

- **T5**：通过 `RTCPeerConnection.getStats()` 的 `inbound-rtp` 统计中的 `lastPacketReceivedTimestamp`
- **T6**：`video.requestVideoFrameCallback(callback)` 回调触发时间
- **T7（可选）**：`callback.metadata.expectedDisplayTime`

### 时钟同步

Host（Python `time.time()`）与 Viewer（JS `performance.now()`）时钟不同步，必须通过 RTT 握手校准：

```
Viewer (V0) --sync_req------------------> Host
Host   (H0) <------------------------------ Host 收到
Host   (H1) --sync_resp(V0, H0, H1)------> Viewer
Viewer (V1) <------------------------------ Viewer 收到

offset = ((H0 - V0) + (H1 - V1)) / 2
rtt    = (V1 - V0) - (H1 - H0)
```

握手每 30 秒重复一次。所有 Host 时间戳转换为 Viewer 基准：`H_viewer = H_host + offset`。

## 展示层与最小侵入性实现

### 诊断面板 UI

在现有的 `diagModal` 中新增 **"延迟分析"** 区域：

```
┌─────────────────────────────────────────┐
│  延迟分析 (5秒滑动窗口)                    │
├─────────────────────────────────────────┤
│  采集:   15ms  ████░░░░░░  P95: 45ms   │
│  编码:   80ms  ████████░░  P95: 150ms  │
│  网络:   60ms  ██████░░░░  P95: 120ms  │
│  缓冲:   400ms ████████████████████░   │  ← 标红提示瓶颈
│  渲染:   8ms   ██░░░░░░░░  P95: 15ms   │
├─────────────────────────────────────────┤
│  输入→画面: 580ms  (最近5次平均)          │
│  时钟同步: RTT=45ms, offset=+12ms       │
└─────────────────────────────────────────┘
```

告警规则：
- `PlayoutBuffer > 300ms` → 标红，提示"浏览器缓冲过长"
- `InputRoundTrip > 1000ms` → 标红，提示"端到端延迟过高"
- `EncodeLatency > 200ms` → 标黄，提示"编码器过载"

### Host 端实现

1. `ScreenCaptureTrack.recv()` 中插入 `time.perf_counter()` 采集 T0~T4
2. 新增 `send_timing_over_datachannel(timing_data)`，复用现有 DataChannel
3. `InputHandler` 收到输入时记录 I1，执行后记录 I2
4. `ScreenCaptureTrack` 维护 `pending_input_ids`（线程安全集合），`recv()` 的 T0 时刻绑定 inputId

### Viewer 端实现

1. `webrtc.js` 监听 DataChannel `message`，解析 `frame_timing`
2. `input.js` 的 `sendInput()` 生成 `inputId` 并记录 I0
3. 新增 `LatencyMonitor` 模块（`js/latency-monitor.js`）：
   - 时钟同步状态机（`idle` → `syncing` → `synced`）
   - `inputId → I0` 映射表
   - 5 秒滑动窗口的 P50/P95 统计
4. `diagnostic.js` 新增 `renderLatencyPanel()`，每 2 秒刷新

## 完整的输入往返测量

### 数据流

```
Viewer 按下按键
  │
  ▼ I0 = performance.now()
  input.js sendInput({ inputId: "uuid", ... })
  │
  ├──► Socket.IO/DataChannel ────────────────┐
  │                                          ▼
  │                                    Host 收到 input
  │                                    I1 = time.time()
  │                                          │
  │                                    InputHandler 执行 Quartz
  │                                    I2 = time.time()
  │                                          │
  │                                    ScreenCaptureTrack.recv()
  │                                    T0 = time.time()
  │                                    绑定 inputId → 当前帧
  │                                    T1/T2/T3/T4 正常采集
  │                                          │
  │                                    DataChannel.send({
  │                                      type: "frame_timing",
  │                                      frameId, inputId,
  │                                      timings: { T0..T4 },
  │                                      input: { I1, I2, ids }
  │                                    })
  │                                          │
  │◄─────────────────────────────────────────┘
  │
  ▼ Viewer 收到 frame_timing
  用 offset 将所有 Host 时间戳对齐到 Viewer 基准

  T5 = performance.now()   # 该帧最后一个 RTP packet 到达
  T6 = rVFC 回调时间       # 解码完成
```

### 分解计算（Viewer 时间基准）

```
InputRoundTrip = T6 - I0

  = (I1_v - I0)          # NetworkInput: 输入事件网络传输
  + (I2_h - I1_h)        # ExecuteTime: Quartz 执行耗时
  + (T0_h - I2_h)        # WaitForCapture: 等下一帧 capture
  + (T4_h - T0_h)        # CaptureEncode: 截屏+缩放+编码+发送
  + (T5   - T4_v)        # NetworkVideo: 视频帧网络传输
  + (T6   - T5)          # PlayoutBuffer: 浏览器缓冲
```

## 错误处理与边界情况

| 场景 | 处理方案 |
|-----|---------|
| 多帧连续输入 | `ids` 用数组承载，多个 input 绑定到同一帧 |
| 输入后画面无变化 | `WaitForCapture` 偏长，但 `T0` 仍是下一帧，正确反映用户感知 |
| 时钟漂移 | 30 秒重新同步；offset 变化 > 50ms 时丢弃前 5 秒数据 |
| DataChannel 未建立 | 降级为 Socket.IO 传输 timing 数据 |
| 输入 ack 丢失 | 5 秒后超时清理 `inputId → I0` 映射，避免内存泄漏 |
| Viewer 统计面板未打开 | 数据仍采集和计算，仅在打开时渲染 |

## 测试验证方案

1. **本地环回测试**：Host 和 Viewer 在同一台机器，NetworkLatency 应接近 0ms，验证采集+编码+缓冲延迟
2. **局域网测试**：预期 `InputRoundTrip < 150ms`，`PlayoutBuffer < 50ms`
3. **外网测试**：预期 `InputRoundTrip < 400ms`
4. **隧道中继测试**：预期 `InputRoundTrip < 800ms`，重点观察 `NetworkVideo` 和 `PlayoutBuffer`
5. **压力测试**：连续快速输入（如打字），观察 `WaitForCapture` 是否累积

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|-----|---------|------|
| `python-host/host.py` | 修改 | ScreenCaptureTrack 插入时间戳、绑定 inputId |
| `python-host/input_handler.py` | 修改 | 记录 I1/I2、回传 input_ack |
| `web-client/js/webrtc.js` | 修改 | DataChannel 接收 frame_timing、时钟同步握手 |
| `web-client/js/input.js` | 修改 | 生成 inputId、记录 I0 |
| `web-client/js/diagnostic.js` | 修改 | 新增延迟面板渲染 |
| `web-client/js/latency-monitor.js` | 新增 | LatencyMonitor 模块：同步、统计、计算 |
| `web-client/viewer.html` | 修改 | diagModal 中新增延迟分析区域 |
