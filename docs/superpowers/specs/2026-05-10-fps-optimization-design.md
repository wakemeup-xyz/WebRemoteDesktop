# FPS 优化设计方案

## 1. 问题陈述

WebRemoteDesktop 当前视频流传输的实际 FPS 约为 **9fps**，远低于目标 15fps，更无法满足 30fps 的需求。经过基准测试，瓶颈分布在屏幕捕获、内存拷贝、颜色空间转换和软件编码四个环节。

## 2. 基准测试数据

测试环境：macOS, 1792x1120 分辨率

| Pipeline | FPS | 单帧耗时 |
|----------|-----|----------|
| 当前（BGRA→BGR→RGB→libx264） | 11.9 | 84.1ms |
| 优化1：BGRA直通+VideoToolbox | 21.4 | 46.7ms |
| 优化2：再叠加并行捕获 | **30.9** | **32.4ms** |

结论：通过 **H.264 VideoToolbox 硬件编码 + BGRA 零拷贝 + 捕获编码并行化**，可在不牺牲画质、不降低分辨率的前提下达到 30fps。

## 3. 技术方案

### 3.1 自定义 H264VideoToolboxEncoder

- 继承 aiortc `Encoder` 基类，实现 `encode()` 接口
- 内部使用 `av.CodecContext.create("h264_videotoolbox", "w")`
- 编码参数：
  - `profile`: Baseline
  - `pix_fmt`: yuv420p
  - `bit_rate`: 3 Mbps（远程桌面场景，保持清晰）
  - `framerate`: 30
- **移除** libx264 特有参数：`tune=zerolatency`, `level=31`（VideoToolbox 不支持）
- 注意：VideoToolbox 前 2-3 帧存在内部缓冲延迟，启动时可能不立即输出 packet，后续帧正常

### 3.2 帧处理零拷贝优化

当前 pipeline：
```
MSS BGRA → np.array → BGR切片 → np.ascontiguousarray → BGR→RGB翻转 → VideoFrame RGB24 → 编码
```

优化后 pipeline：
```
MSS BGRA → np.array → VideoFrame BGRA → 编码
```

- MSS 原生输出即为 BGRA 格式
- 直接调用 `av.VideoFrame.from_ndarray(img, format='bgra')`
- PyAV 内部负责 BGRA→YUV420P 转换，比手动 BGR→RGB 再转 YUV 更高效
- **节省约 15ms/帧**

### 3.3 捕获-编码并行化

当前模式是串行：捕获 → 处理 → 编码 → 下一帧捕获

优化后模式：
- 使用 `concurrent.futures.ThreadPoolExecutor(max_workers=1)`
- 每次编码开始前，立即在后台线程提交下一帧的 `sct.grab()`
- 主线程等待上一帧编码完成后，直接取走已捕获好的下一帧
- 屏幕捕获（~25ms）与编码（~15ms）重叠执行
- **节省约 20ms/帧**

### 3.4 SDP Codec 优先级调整

- 在 `RTCPeerConnection` 创建时，通过 `addTransceiver()` 配置 codec preferences
- 将 H.264 排在 VP8 之前，确保浏览器优先选择 H.264 解码
- 若浏览器不支持 H.264，自动 fallback 到 VP8

## 4. 架构改动

### 修改文件

| 文件 | 改动内容 |
|------|----------|
| `python-host/host.py` | 重写 `ScreenCaptureTrack.recv()`：并行捕获 + BGRA 直通 |
| `python-host/h264_videotoolbox_encoder.py` | 新增：自定义 VideoToolbox 编码器 |
| `python-host/host.py` | 修改 `on_offer()`：SDP 中优先 H.264；注册自定义编码器 |

### 关键代码结构

```python
class ScreenCaptureTrack(VideoStreamTrack):
    def __init__(self, target_fps=30):
        ...
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._next_capture = None

    async def recv(self):
        # 1. 启动下一帧后台捕获
        if self._next_capture is None:
            self._next_capture = self._executor.submit(self._capture)

        # 2. 取回已完成的当前帧
        screenshot = self._next_capture.result()
        self._next_capture = self._executor.submit(self._capture)

        # 3. BGRA 直通
        img = np.array(screenshot)
        frame = av.VideoFrame.from_ndarray(img, format='bgra')

        # 4. 时间戳
        pts, time_base = await self.next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        return frame
```

## 5. 风险与回退

| 风险 | 影响 | 回退方案 |
|------|------|----------|
| VideoToolbox 前3帧延迟输出 | 启动时短暂黑屏或卡顿 | 可接受；或在发送端预填充3帧 |
| VideoToolbox 编码失败 | 完全无法推流 | 动态检测：若不可用，fallback 到优化版 libx264（BGRA直通+并行化，预计 ~20fps） |
| 浏览器不支持 H.264 | SDP 协商失败 | aiortc 自动 fallback 到 VP8；仅损失性能，不影响功能 |
| 高分辨率下带宽不足 | 画面卡顿 | 动态码率调整：根据 RTT 和丢包率自适应降低 bit_rate |

## 6. 测试计划

1. **功能测试**：WebRTC 连接建立、视频正常播放、鼠标/键盘输入同步
2. **性能测试**：对比优化前后 FPS，使用 `startStats()` 采集 viewer 端数据
3. **稳定性测试**：连续运行 30 分钟，观察是否出现内存泄漏或编码器崩溃
4. **回退测试**：故意禁用 VideoToolbox，验证是否能自动降级到 libx264
5. **兼容性测试**：Chrome、Safari、Edge 浏览器分别测试 H.264 协商

## 7. 验收标准

- [ ] viewer 端稳定显示 **≥25 FPS**（1792x1120 分辨率）
- [ ] CPU 占用相比优化前 **下降 ≥30%**
- [ ] 画质主观评估与优化前 **无可见差异**
- [ ] 鼠标/键盘输入延迟 **无明显增加**
- [ ] 连续运行 30 分钟 **无崩溃、无内存泄漏**
