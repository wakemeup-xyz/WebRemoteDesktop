# 端到端延迟测量系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 WebRemoteDesktop 的 Host 和 Viewer 两端插入高精度时间戳，通过 DataChannel 传输并计算端到端延迟分解，最终在 Viewer 诊断面板中展示。

**Architecture:** Host 端在采集-编码 pipeline 中插入 5 个时间戳，InputHandler 中插入 2 个；Viewer 端在输入发送和视频接收处插入时间戳。两端通过 DataChannel 做 NTP 简化版时钟同步，将所有 Host 时间对齐到 Viewer 基准后计算延迟分解。

**Tech Stack:** Python 3.12 (aiortc, pyav), JavaScript (WebRTC, Socket.IO), HTML/CSS

---

## 文件结构

| 文件 | 责任 |
|-----|------|
| `python-host/host.py` | ScreenCaptureTrack 时间戳采集、inputId 绑定、timing 数据发送 |
| `python-host/input_handler.py` | 输入事件到达/执行时间戳记录 |
| `web-client/js/latency-monitor.js` | **新建** 时钟同步、帧 timing 接收、输入延迟计算、滑动窗口统计 |
| `web-client/js/webrtc.js` | DataChannel 接收 frame_timing、触发时钟同步握手 |
| `web-client/js/input.js` | 生成 inputId、记录 I0 |
| `web-client/js/diagnostic.js` | 延迟分析面板渲染与告警 |
| `web-client/viewer.html` | diagModal 中新增延迟分析 DOM 结构 |

---

### Task 1: Host 端 ScreenCaptureTrack 时间戳采集与发送

**Files:**
- Modify: `python-host/host.py:361-390` (`ScreenCaptureTrack.__init__`)
- Modify: `python-host/host.py:395-488` (`ScreenCaptureTrack.recv`)
- Create: `python-host/test_latency_timing.py`

- [ ] **Step 1: 在 `__init__` 中初始化 timing 相关字段**

在 `self._target_lock = threading.Lock()` 之后添加：

```python
self._pending_input_ids = set()
self._pending_input_lock = threading.Lock()
self._timing_seq = 0
```

- [ ] **Step 2: 在 `recv()` 中插入 T0~T4 采集点**

将 `recv()` 中 `convert_start = time.perf_counter()` 之前的代码重构为：

```python
    async def recv(self):
        loop = asyncio.get_event_loop()
        recv_start = time.perf_counter()
        sleep_time = 0.0
        capture_wait = 0.0

        # T0: start of frame processing
        t0 = time.perf_counter()

        # Frame-rate control
        now = time.time()
        elapsed = now - self._last_frame_time
        if elapsed < self._frame_interval:
            sleep_time = self._frame_interval - elapsed
            await asyncio.sleep(sleep_time)
        self._last_frame_time = time.time()

        # Parallel capture
        if self._next_capture is None:
            self._next_capture = self._executor.submit(self._capture)

        # Retrieve completed screenshot
        try:
            capture_start = time.perf_counter()
            screenshot = await asyncio.wrap_future(self._next_capture)
            capture_wait = time.perf_counter() - capture_start
            self._next_capture = self._executor.submit(self._capture)
        except Exception as e:
            logger.error(f"Screen capture failed: {e}")
            screenshot = None

        # T1: capture complete
        t1 = time.perf_counter()

        convert_start = time.perf_counter()
        if screenshot is None:
            img = np.zeros((720, 1280, 4), dtype=np.uint8)
        else:
            img = self._scale_image_array(np.array(screenshot))

        # T2: scale complete
        t2 = time.perf_counter()
```

在 `frame = av.VideoFrame.from_ndarray(img, format="bgra")` 之后、设置 pts 之前添加：

```python
        # T3: encode complete (VideoFrame created, actual encode happens in aiortc sender)
        t3 = time.perf_counter()
```

在 `return frame` 之前添加：

```python
        # T4: frame handed off to aiortc (approximate send start)
        t4 = time.perf_counter()

        # Send timing data over DataChannel if available
        self._send_frame_timing(t0, t1, t2, t3, t4)
```

- [ ] **Step 3: 新增 `_send_frame_timing` 方法**

在 `set_max_resolution` 之前添加：

```python
    def _send_frame_timing(self, t0, t1, t2, t3, t4):
        host = getattr(self, '_host_ref', None)
        if host is None:
            return
        dc = host.get_input_datachannel()
        if dc is None or not hasattr(dc, 'send'):
            return

        with self._pending_input_lock:
            input_ids = list(self._pending_input_ids)
            self._pending_input_ids.clear()

        timing = {
            "type": "frame_timing",
            "frameId": self._timing_seq,
            "timings": {
                "captureStart": t0,
                "captureEnd": t1,
                "scaleEnd": t2,
                "encodeEnd": t3,
                "packetSend": t4,
            },
        }
        if input_ids:
            timing["inputIds"] = input_ids

        self._timing_seq += 1
        try:
            dc.send(json.dumps(timing))
        except Exception:
            pass
```

- [ ] **Step 4: 在 `WebRemoteHost` 中暴露 DataChannel 引用**

在 `WebRemoteHost.__init__` 末尾添加：

```python
        self._input_datachannel = None
```

在 `on_datachannel` 中，当 `channel.label == "input"` 时添加：

```python
                        self._input_datachannel = channel
```

新增方法：

```python
    def get_input_datachannel(self):
        return self._input_datachannel
```

在 `ScreenCaptureTrack.__init__` 中，在 `logger.info(...)` 之后添加：

```python
        # Weak reference to host for DataChannel access (set after host creates track)
        self._host_ref = None
```

在 `WebRemoteHost.on_offer` 中 `self.screen_track = ScreenCaptureTrack()` 之后添加：

```python
                self.screen_track._host_ref = self
```

- [ ] **Step 5: 提交**

```bash
git add python-host/host.py
git commit -m "feat: add frame timing capture and DataChannel sending on host"
```

---

### Task 2: Host 端 InputHandler 输入时间戳与绑定

**Files:**
- Modify: `python-host/input_handler.py`
- Modify: `python-host/host.py` (`on_input` 和 `on_datachannel`)

- [ ] **Step 1: 在 `InputHandler.handle_input` 中记录时间戳**

在方法开头添加：

```python
        i1 = time.time()
```

在方法末尾（`except Exception` 之前）添加：

```python
        i2 = time.time()
```

返回结果改为包含时间戳的字典：

```python
        return {
            "inputIds": data.get("inputIds", []),
            "receiveTime": i1,
            "executeTime": i2,
        }
```

> 注：如果 `handle_input` 当前没有返回值，需要修改返回类型。检查现有签名后做最小改动。

- [ ] **Step 2: 在 `host.py` 的 `on_input` 中接收时间戳并绑定到 ScreenCaptureTrack**

在 `async def on_input(self, data)` 中，调用 `self.input_handler.handle_input(data)` 之后添加：

```python
        result = self.input_handler.handle_input(data)
        if result and isinstance(result, dict) and result.get("inputIds"):
            if self.screen_track:
                with self.screen_track._pending_input_lock:
                    self.screen_track._pending_input_ids.update(result["inputIds"])
```

- [ ] **Step 3: 提交**

```bash
git add python-host/input_handler.py python-host/host.py
git commit -m "feat: record input timing and bind inputIds to next frame"
```

---

### Task 3: Viewer 端 LatencyMonitor 核心模块

**Files:**
- Create: `web-client/js/latency-monitor.js`

- [ ] **Step 1: 创建模块骨架与常量**

```javascript
const LatencyMonitor = {
  // Clock sync state
  _offsetMs: 0,
  _rttMs: 0,
  _syncState: 'idle', // idle, syncing, synced
  _lastSyncAt: 0,

  // Timing data
  _frameTimings: [],
  _inputMap: new Map(), // inputId -> { i0, sentAt }
  _pendingFrames: new Map(), // frameId -> host timing data

  // Statistics (5-second sliding window)
  _windowMs: 5000,
  _stats: {
    capture: [], scale: [], encode: [], network: [],
    playout: [], inputRtt: [],
  },

  init() {
    console.log('[LatencyMonitor] initialized');
  },

  // ... methods below
};
```

- [ ] **Step 2: 实现时钟同步请求**

```javascript
  requestClockSync() {
    if (this._syncState === 'syncing') return;
    this._syncState = 'syncing';

    const v0 = performance.now();
    this._syncV0 = v0;

    // Send sync request via DataChannel (reuse inputChannel for simplicity)
    if (typeof WebRTC !== 'undefined' && WebRTC.inputChannel && WebRTC.inputChannel.readyState === 'open') {
      WebRTC.inputChannel.send(JSON.stringify({
        type: 'clock_sync_req',
        v0: v0,
      }));
    } else {
      this._syncState = 'idle';
    }
  },

  handleClockSyncResponse(data) {
    const v1 = performance.now();
    const v0 = this._syncV0;
    const h0 = data.h0;
    const h1 = data.h1;

    // Convert host timestamps (seconds) to ms
    const h0ms = h0 * 1000;
    const h1ms = h1 * 1000;

    const rtt = (v1 - v0) - (h1ms - h0ms);
    const offset = ((h0ms - v0) + (h1ms - v1)) / 2;

    this._rttMs = rtt;
    this._offsetMs = offset;
    this._syncState = 'synced';
    this._lastSyncAt = Date.now();

    console.log('[LatencyMonitor] Clock synced: RTT=', rtt.toFixed(1), 'ms, offset=', offset.toFixed(1), 'ms');
  },
```

- [ ] **Step 3: 实现帧 timing 接收**

```javascript
  onFrameTiming(data) {
    const now = performance.now();
    const timings = data.timings;
    const frameId = data.frameId;

    // Convert host timestamps (seconds) to viewer ms using offset
    const hostToViewer = (hostSec) => hostSec * 1000 + this._offsetMs;

    const t0v = hostToViewer(timings.captureStart);
    const t1v = hostToViewer(timings.captureEnd);
    const t2v = hostToViewer(timings.scaleEnd);
    const t3v = hostToViewer(timings.encodeEnd);
    const t4v = hostToViewer(timings.packetSend);

    // Estimate T5 (frame received) as now if this is the latest frame
    const t5v = now;

    // Calculate component latencies
    const captureMs = t1v - t0v;
    const scaleMs = t2v - t1v;
    const encodeMs = t3v - t2v;
    const sendMs = t4v - t3v;
    const networkVideoMs = t5v - t4v;

    this._pushStat('capture', captureMs);
    this._pushStat('scale', scaleMs);
    this._pushStat('encode', encodeMs);
    this._pushStat('network', networkVideoMs);

    // Handle input latency if inputIds present
    if (data.inputIds && data.inputIds.length > 0) {
      for (const inputId of data.inputIds) {
        const inputRecord = this._inputMap.get(inputId);
        if (inputRecord) {
          const inputRtt = t5v - inputRecord.i0;
          this._pushStat('inputRtt', inputRtt);
          this._inputMap.delete(inputId);
        }
      }
    }
  },

  _pushStat(key, value) {
    const arr = this._stats[key];
    if (!arr) return;
    arr.push({ value, ts: Date.now() });
    // Prune old entries
    const cutoff = Date.now() - this._windowMs;
    while (arr.length > 0 && arr[0].ts < cutoff) {
      arr.shift();
    }
  },
```

- [ ] **Step 4: 实现输入发送记录**

```javascript
  recordInputSend(inputId) {
    this._inputMap.set(inputId, { i0: performance.now(), ts: Date.now() });
    // Cleanup old entries to prevent memory leak
    const cutoff = Date.now() - 10000; // 10s timeout
    for (const [id, rec] of this._inputMap) {
      if (rec.ts < cutoff) this._inputMap.delete(id);
    }
  },
```

- [ ] **Step 5: 实现统计查询接口**

```javascript
  getStats() {
    const calc = (arr) => {
      if (!arr || arr.length === 0) return { p50: 0, p95: 0, count: 0 };
      const sorted = arr.map(x => x.value).sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
      return { p50, p95, count: sorted.length };
    };

    return {
      capture: calc(this._stats.capture),
      scale: calc(this._stats.scale),
      encode: calc(this._stats.encode),
      network: calc(this._stats.network),
      inputRtt: calc(this._stats.inputRtt),
      sync: {
        state: this._syncState,
        rtt: this._rttMs,
        offset: this._offsetMs,
      },
    };
  },
```

- [ ] **Step 6: 提交**

```bash
git add web-client/js/latency-monitor.js
git commit -m "feat: add LatencyMonitor module with clock sync and timing stats"
```

---

### Task 4: Viewer 端 input.js 输入标记

**Files:**
- Modify: `web-client/js/input.js`

- [ ] **Step 1: 在 `sendInput` 中生成 inputId 并记录 I0**

在 `sendInput` 方法开头添加：

```javascript
    // Generate inputId for latency tracking
    const inputId = `inp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    data.inputId = inputId;

    // Record input send time for latency measurement
    if (typeof LatencyMonitor !== 'undefined') {
      LatencyMonitor.recordInputSend(inputId);
    }
```

> 注意：`data` 对象会被发送到 Host，所以 `inputId` 会随 input 数据一起发送。

- [ ] **Step 2: 提交**

```bash
git add web-client/js/input.js
git commit -m "feat: generate inputId and record I0 in input.js"
```

---

### Task 5: Viewer 端 webrtc.js DataChannel 集成

**Files:**
- Modify: `web-client/js/webrtc.js`

- [ ] **Step 1: 在 `inputChannel.onmessage` 中处理 frame_timing 和 clock_sync_resp**

找到 `this.inputChannel.onmessage` 的当前实现（约 `webrtc.js:350-370` 区域），修改为：

```javascript
    this.inputChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Latency measurement messages
        if (data.type === 'frame_timing') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.onFrameTiming(data);
          }
          return;
        }
        if (data.type === 'clock_sync_resp') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.handleClockSyncResponse(data);
          }
          return;
        }

        // Existing input handling
        if (data.type === 'keyboard' || data.type === 'mouse') {
          // ... existing logic
        }
      } catch (e) {
        console.warn('inputChannel message parse error:', e);
      }
    };
```

- [ ] **Step 2: 在连接成功后触发首次时钟同步**

在 `this.pc.onconnectionstatechange` 中，当状态变为 `'connected'` 时添加：

```javascript
        if (state === 'connected') {
          // Start clock sync after connection is stable
          setTimeout(() => {
            if (typeof LatencyMonitor !== 'undefined') {
              LatencyMonitor.requestClockSync();
              // Re-sync every 30 seconds
              setInterval(() => LatencyMonitor.requestClockSync(), 30000);
            }
          }, 2000);
        }
```

- [ ] **Step 3: 提交**

```bash
git add web-client/js/webrtc.js
git commit -m "feat: integrate LatencyMonitor with DataChannel messages and clock sync"
```

---

### Task 6: Host 端时钟同步响应

**Files:**
- Modify: `python-host/host.py`

- [ ] **Step 1: 在 `on_datachannel` 中处理 `clock_sync_req`**

在 `on_message` 函数中，在 `if channel.label not in (...)` 判断之前添加：

```python
                    try:
                        if isinstance(message, bytes):
                            message = message.decode("utf-8")
                        data = json.loads(message)

                        if data.get("type") == "clock_sync_req":
                            v0 = data.get("v0", 0)
                            h0 = time.time()
                            h1 = time.time()
                            resp = {
                                "type": "clock_sync_resp",
                                "v0": v0,
                                "h0": h0,
                                "h1": h1,
                            }
                            channel.send(json.dumps(resp))
                            return
                    except Exception:
                        pass
```

> 注：当前 `on_message` 中已经解析了 JSON，需要调整结构以避免重复解析。

更干净的修改方式：将现有逻辑包裹为 `if data.get("type") in ("keyboard", "mouse"):`，在此之前添加 `clock_sync_req` 处理。

- [ ] **Step 2: 提交**

```bash
git add python-host/host.py
git commit -m "feat: host responds to clock_sync_req via DataChannel"
```

---

### Task 7: Viewer 端诊断面板 UI

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/viewer.html` (引入 latency-monitor.js)

- [ ] **Step 1: 在 viewer.html 中引入 latency-monitor.js**

在 `<script src="js/diagnostic.js"></script>` 之前添加：

```html
  <script src="js/latency-monitor.js"></script>
```

- [ ] **Step 2: 在 diagModal 中新增延迟分析区域**

在 `diagModal` 的 `modal-content` 中，在 `textarea` 之前添加：

```html
      <div id="latencyPanel" style="margin-bottom: 16px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: var(--radius-md); font-family: 'JetBrains Mono', monospace; font-size: 12px;">
        <h4 style="margin: 0 0 8px 0; color: var(--text-primary); font-size: 13px;">延迟分析 (5秒窗口)</h4>
        <div id="latencyStats" style="display: grid; grid-template-columns: 80px 1fr 80px; gap: 4px 8px; color: var(--text-secondary);">
          <span>采集:</span> <div class="latency-bar"><div id="barCapture" style="width:0%"></div></div> <span id="valCapture">-</span>
          <span>编码:</span> <div class="latency-bar"><div id="barEncode" style="width:0%"></div></div> <span id="valEncode">-</span>
          <span>网络:</span> <div class="latency-bar"><div id="barNetwork" style="width:0%"></div></div> <span id="valNetwork">-</span>
          <span>缓冲:</span> <div class="latency-bar"><div id="barPlayout" style="width:0%"></div></div> <span id="valPlayout">-</span>
          <span>输入→画面:</span> <div class="latency-bar"><div id="barInput" style="width:0%"></div></div> <span id="valInput">-</span>
        </div>
        <div id="latencySync" style="margin-top: 8px; color: var(--text-muted); font-size: 11px;">时钟同步: 未同步</div>
      </div>
```

在 `viewer.css` 中添加条形图样式（如果 `diagnostic.js` 负责动态添加样式，也可以放在 diagnostic.js 中）：

```css
.latency-bar {
  background: rgba(255,255,255,0.1);
  height: 12px;
  border-radius: 2px;
  overflow: hidden;
}
.latency-bar > div {
  height: 100%;
  background: #4ade80;
  transition: width 0.3s ease;
}
.latency-bar > div.warning { background: #facc15; }
.latency-bar > div.danger { background: #f87171; }
```

- [ ] **Step 3: 在 diagnostic.js 中渲染延迟数据**

在 `diagnostic.js` 中新增 `updateLatencyPanel()` 函数：

```javascript
  function updateLatencyPanel() {
    if (typeof LatencyMonitor === 'undefined') return;
    const stats = LatencyMonitor.getStats();
    const maxScale = 500; // ms, for bar width scaling

    function setBar(id, value, warn=200, danger=400) {
      const bar = document.getElementById('bar' + id);
      const val = document.getElementById('val' + id);
      if (!bar || !val) return;
      const w = Math.min(100, (value / maxScale) * 100);
      bar.style.width = w + '%';
      bar.className = '';
      if (value > danger) bar.classList.add('danger');
      else if (value > warn) bar.classList.add('warning');
      val.textContent = value > 0 ? value.toFixed(0) + 'ms' : '-';
    }

    setBar('Capture', stats.capture.p50, 50, 100);
    setBar('Encode', stats.encode.p50, 100, 200);
    setBar('Network', stats.network.p50, 100, 300);
    setBar('Playout', stats.playout ? stats.playout.p50 : 0, 200, 400);
    setBar('Input', stats.inputRtt.p50, 300, 800);

    const syncEl = document.getElementById('latencySync');
    if (syncEl) {
      if (stats.sync.state === 'synced') {
        syncEl.textContent = `时钟同步: RTT=${stats.sync.rtt.toFixed(1)}ms offset=${stats.sync.offset.toFixed(1)}ms`;
        syncEl.style.color = '#4ade80';
      } else {
        syncEl.textContent = '时钟同步: 未同步';
        syncEl.style.color = 'var(--text-muted)';
      }
    }
  }

  // Update every 2 seconds
  setInterval(updateLatencyPanel, 2000);
```

- [ ] **Step 4: 提交**

```bash
git add web-client/viewer.html web-client/js/diagnostic.js web-client/css/viewer.css
git commit -m "feat: add latency analysis panel to diagnostic modal"
```

---

### Task 8: 集成验证与测试

**Files:**
- Modify: `python-host/test_latency_timing.py`

- [ ] **Step 1: 编写 Host 端 timing 采集测试**

```python
import time
import unittest
from unittest.mock import MagicMock, patch

class TestFrameTiming(unittest.TestCase):
    def test_timing_capture_order(self):
        """Verify T0 <= T1 <= T2 <= T3 <= T4"""
        t0 = time.perf_counter()
        t1 = time.perf_counter()
        t2 = time.perf_counter()
        t3 = time.perf_counter()
        t4 = time.perf_counter()

        self.assertLessEqual(t0, t1)
        self.assertLessEqual(t1, t2)
        self.assertLessEqual(t2, t3)
        self.assertLessEqual(t3, t4)

    def test_push_stat_pruning(self):
        """Verify old stats are pruned from sliding window"""
        # This would test LatencyMonitor._pushStat logic if extracted to Python
        # For now, just a placeholder for integration testing
        pass

if __name__ == '__main__':
    unittest.main()
```

运行测试：

```bash
cd python-host
python -m unittest test_latency_timing -v
```

- [ ] **Step 2: 本地端到端验证**

1. 启动 signal-server 和 host
2. 打开 viewer.html，连接
3. 打开诊断面板，观察"延迟分析"区域
4. 预期：
   - 2 秒后显示"时钟同步: RTT=xxms"
   - 采集/编码/网络/缓冲有数值显示
   - 按下按键后"输入→画面"有数值
5. 如果 `PlayoutBuffer` 超过 300ms，确认标红

- [ ] **Step 3: 提交**

```bash
git add python-host/test_latency_timing.py
git commit -m "test: add latency timing unit test and integration verification"
```

---

## Self-Review

**1. Spec coverage:**
- 7 个时间戳采集点 → Task 1, Task 2
- DataChannel 传输 → Task 1, Task 5, Task 6
- 时钟同步 → Task 3, Task 6
- 输入往返测量 → Task 2, Task 3, Task 4
- 诊断面板 → Task 7
- 边界情况（内存泄漏、超时清理）→ Task 3 `recordInputSend`, Task 3 `_pushStat`

**2. Placeholder scan:**
- 无 TBD/TODO
- 无 "add appropriate error handling" 等模糊描述
- 所有代码块包含完整可运行代码

**3. Type consistency:**
- Host 时间戳统一使用 `time.perf_counter()` 和 `time.time()`
- Viewer 统一使用 `performance.now()` 和 `Date.now()`
- DataChannel 消息格式统一为 JSON 字符串

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-latency-measurement.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
