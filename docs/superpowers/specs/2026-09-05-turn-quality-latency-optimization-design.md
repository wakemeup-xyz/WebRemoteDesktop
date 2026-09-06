# TURN 画质、延迟与周期抖动优化设计

日期：2026-09-05
状态：Reviewed / Ready for implementation
范围：桌面 WebRTC 的 `relay`（TURN）媒体链路
证据基线：`docs/superpowers/reports/2026-09-05-turn-quality-latency-review.md`

关联设计：

- `docs/superpowers/specs/2026-08-02-quality-lock-low-latency-design.md`
- `docs/superpowers/specs/2026-08-29-relay-paint-continuity-design.md`
- `docs/superpowers/specs/2026-08-01-turn-relay-reconnect-stability-design.md`
- `docs/superpowers/specs/2026-07-19-remote-desktop-media-suspension-design.md`

## 1. 目标

解决 TURN 桌面画面的两类独立问题，并建立后续优化所需的真实指标：

1. 修正 Host 视频帧的 RTP 时间线，消除错误时间戳造成的播放停顿、追帧和缓冲异常风险。
2. 消除健康链路下约 1 秒一次的周期性清晰度跳变。
3. 让 720p 与用户显式选择的 1080p 都有可解释的码率、帧率和关键帧策略。
4. 将“网络 RTT”“编码耗时”“接收缓冲”“实际出画间隔”分开观测，不再以单个 RTT 或浏览器瞬时 FPS 推断端到端体验。

目标行为：

> 健康 TURN 会话不再每秒出现清晰度脉冲；发生真实丢包或解码停顿时，系统通过有界按需关键帧恢复，并能说明耗时发生在哪一段。

本设计只覆盖并取代旧设计中的“relay固定1秒GOP / 周期IDR”和“有包无解码时的恢复顺序”。旧设计的默认720p、显式1080p override、Quality Lock、真实出画门禁和不自动切链路约束继续有效。

## 2. 已确认事实

### 2.1 RTP 时间基错误

`ScreenCaptureTrack.next_timestamp()` 当前返回：

```python
pts = int((time.time() - self._start) * 90000)
return pts, 90000
```

`pts` 已按 90kHz 计数，`time_base` 应为 `Fraction(1, 90000)`。当前写法进入 `convert_timebase()` 后把 50ms 帧间隔转换为异常巨大的 RTP 时间跳跃。该问题位于 TURN 与直连共享的 Host 采集路径中。

### 2.2 周期画质脉冲来自编码侧

当前 relay 策略把以下决策绑定在 `gop <= 20` 上：

- 编码器切为 `libx264`
- 每 20 个编码帧强制 I/IDR
- `ultrafast + zerolatency + Baseline`
- 100ms VBV
- 720p 码率地板 1.8Mbps
- 1080p 码率地板和上限均为 2.5Mbps

离线静止文字图复现中，1080p 在 IDR 前约 32.6dB，IDR 帧约 19.3dB，随后逐帧恢复；720p 结果相同。运行日志中的 720p IDR 周期中位数为 1.02 秒，与用户感知一致。

### 2.3 1080p 帧预算不足

同一在线会话由 1152×720 切到 1728×1080 后，约 1Hz 采样中的解码帧数中位数从 19 降到 12。Host 进程只读采样约占一个 CPU 核；离线 1080p 软件编码耗时也已占用显著的 50ms 帧预算。

### 2.4 统计契约存在语义混用

`webrtc-stats.js` 已计算区间解码增量，却又优先使用浏览器累计报告中的 `framesPerSecond`；运行日志曾出现显示 90FPS、同一秒实际只解码 8 帧。`processStatsSnapshot()` 还把本次区间 `framesDecoded` 与上次区间值比较，无法可靠判断“本秒是否有解码进展”。

## 3. 产品与运维约束

1. 保留 Quality Lock：默认不自动降低用户分辨率。
2. relay 默认会话上限仍为 1280×720；用户可在本次会话显式选择 1080p，并继续看到现有风险提示。
3. 自动恢复不得切换网络模式、TURN 节点或 JPEG tunnel。
4. 继续演进现有 `LinkQualityController`，不增加第二套媒体恢复状态机。
5. 继续使用 H.264；本阶段不引入 AV1、SVC、脏矩形或新的浏览器兼容矩阵。
6. 不将增大 VBV、提高码率或切回 VideoToolbox 作为未经验证的单点修复。
7. 本优化不授权重启、重建或旋转 Cloudflare tunnel。实施后的本地重启只允许 `signal-server` / Host，并遵守 safe startup runbook。
8. Signal Server 的“严格单桌面 Viewer”契约保持不变。Host 在新 offer 前关闭旧 PeerConnection，因此进程级当前编码策略只能服务当前 connection attempt；策略更新必须带 generation 防止旧事件覆盖。

## 4. 架构

```text
Viewer session presentation
  width / height / targetFps / requestedBitrate / networkMode
                         │
                         ▼
Host session intent ──► H264SessionPolicy.resolve(intent)
                         │
                         ├─ codec（不再由 GOP 推导）
                         ├─ IDR 周期与按需恢复预算
                         ├─ bitrate min/target/max
                         ├─ VBV / preset / profile
                         └─ policyId + attempt generation
                         │
                         ▼
ScreenCaptureTrack ──► H264 encoder ──► aiortc RTP sender ──► TURN
      │                    │                                      │
      │ correct RTP clock  │ encode/IDR metrics                   │
      └────────────────────┴──────────────────────────────────────┘
                                  │
                                  ▼
Viewer WebRtcStats + requestVideoFrameCallback
  derived FPS / receive gap / paint gap / jitter / freeze / geometry
```

设计采用三个深模块：

1. **`RtpFrameClock`**：用一个小接口封装时间原点、90kHz换算和单调性。
2. **`H264SessionPolicy`**：从会话意图解析完整编码策略，隐藏路径、GOP、编码器与码率约束之间的实现细节。
3. **`WebRtcStats`**：输出名称明确的区间指标，Viewer 和测试只依赖这一份语义。

`LinkQualityController` 保持现有接口与职责，只消费修正后的统计并输出恢复意图。

## 5. RTP 时间线设计

### 5.1 模块接口

新增 `python-host/media_timing.py`：

```python
class RtpFrameClock:
    def next_timestamp(self) -> tuple[int, Fraction]: ...
```

构造器允许注入单调纳秒时钟用于测试，生产默认使用 `time.monotonic_ns`。时钟依赖是模块内部 seam，不暴露到 `ScreenCaptureTrack` 的业务接口。

### 5.2 不变量

1. 永远返回 aiortc 的 `VIDEO_TIME_BASE`，即 `Fraction(1, 90000)`。
2. `pts` 表示从当前 track 时间原点起经过的 90kHz tick。
3. 即使底层时钟分辨率不足或测试时钟重复，后一次 `pts` 也必须大于前一次。
4. 系统 wall clock 调整不能让时间倒退。
5. 正常暂停期间不生成帧；恢复后的首帧允许反映真实暂停间隔，不伪造密集补帧。
6. 新 track / 新 connection attempt 创建新时钟；不跨 PeerConnection 复用旧时间原点。

### 5.3 集成

`ScreenCaptureTrack` 持有一个 `RtpFrameClock`，所有正常帧、停止兜底帧和恢复后首帧都只通过该实例取得时间戳。删除 `_start` 与直接使用 `time.time()` 计算媒体 PTS 的实现。

## 6. H.264 策略解耦

### 6.1 模块接口

新增纯计算模块 `python-host/h264_encoder_policy.py`：

```python
@dataclass(frozen=True)
class MediaSessionIntent:
    connection_attempt_id: str
    generation: int
    path: str
    width: int
    height: int
    target_fps: int
    requested_bitrate_bps: int

@dataclass(frozen=True)
class H264SessionPolicy:
    policy_id: str
    codec_name: str
    target_fps: int
    periodic_idr_frames: int
    keyframe_cooldown_ms: int
    min_bitrate_bps: int
    target_bitrate_bps: int
    max_bitrate_bps: int
    vbv_buffer_ms: int
    preset: str
    profile: str

def resolve_h264_policy(intent: MediaSessionIntent, policy_version: str) -> H264SessionPolicy: ...
```

外部调用者只提交会话意图。编码器不再调用 `codec_name_for_gop()` 或通过 GOP 猜测链路类型。

### 6.2 策略传播

`WebRemoteHost._bind_session_presentation()` 在 offer generation 已验证后解析策略，并在 `addTrack()` 前发布为当前 generation。自定义 aiortc encoder factory 为编码器提供当前策略；编码器只在 generation 变化、分辨率变化或策略明确要求 reopen 时替换 codec。

`media-profile-change` 可以热更新目标码率/帧率，但必须验证 `connectionAttemptId + generation`。旧 Viewer、旧 attempt 或低 generation 的事件无副作用。

### 6.3 legacy 与 balanced 策略

保留两套受控策略：

| policy id | 用途 | 默认状态 |
|---|---|---|
| `relay-legacy-v1` | 当前参数，作为回滚 | 可选 |
| `relay-balanced-v2` | 通过离线和真实TURN门禁后的新策略 | 验收后默认 |

使用 Host 本地配置 `WRD_RELAY_ENCODER_POLICY` 选择，只接受枚举值；未知值启动失败并说明合法值。该开关只改变编码策略，不改变 TURN 节点、凭据、ICE policy 或 URL。

`scripts/run-host-launchctl.sh` 已用 `set -a` 加载 `signal-server/.env`，因此该非敏感枚举会自然传播到 Host；不扩展 `lib-turn-env.sh`，避免把编码策略错误归入 TURN 凭据加载职责。实施测试必须证明未配置时采用默认值、合法覆盖能生效、未知值能在创建媒体会话前给出明确错误。

### 6.4 balanced-v2 的确定行为

1. codec 独立选择为 `libx264`，修改 IDR 周期不得隐式切到 VideoToolbox。
2. 健康 relay 不再每 20 帧强制全帧 IDR。
3. 首帧、媒体恢复、浏览器 PLI/FIR 和确认的解码 stall 仍可请求 IDR。
4. periodic IDR 是长周期安全网，不承担首要恢复职责；候选范围为 2、4、10 秒及“仅按需”。最终值由第 6.5 节门禁选择并写死在 `relay-balanced-v2`，不得在生产运行时自行探索。
5. 关键帧请求全局受单一 cooldown 管理。同一 generation 内来自 ontrack、Viewer stall 和 Host stall 的请求合并；成功恢复前不得形成每秒多路重复请求。aiortc 直接转交的 RTCP PLI/FIR 在 encoder 侧只能识别为 `rtcp-or-unknown`，不得伪造更精确的 reason；若刚好存在待处理的应用请求，才沿用该应用 reason。
6. 码率范围按分辨率显式解析。初始候选范围：720p 为 1.8–3.2Mbps，1080p 为 2.5–5Mbps。最终上限通过真实链路门禁确定；Quality Lock 的分辨率所有权不变。
7. 码率 setter 必须记录 requested、clamped、effective 与 apply mode。若 libx264 在已打开 codec 上不能证实热更新生效，返回 `applied=false, reopenRequired=true`，不能记录虚假的 `hot=true`。
8. VBV 候选范围 100–250ms。扩大 VBV 只有在关键帧画质与 TURN 缓冲同时通过时才能进入 v2。

### 6.5 编码候选选择门禁

新增 `scripts/eval-turn-encoder-quality.py`，使用确定性的高频文字/边缘合成画面，输出逐帧 JSON 和摘要。按保守顺序评估：

1. 现有码率 + 2秒IDR + 100/150ms VBV。
2. 分辨率上限码率 + 2秒IDR + 150/200ms VBV。
3. 分辨率上限码率 + 4/10秒IDR + 150/200ms VBV。
4. 仅按需IDR；必须额外通过丢包与恢复验证。

候选必须同时满足：

- 健康静止画面不再出现 0.8–1.5 秒周期的全帧质量脉冲。
- 若候选保留周期 IDR，静止合成桌面在 IDR 处的帧间 `changeMAE <= 3.0`；若选择仅按需 IDR，则健康 60 秒窗口不得出现应用强制的 periodic IDR。
- 720p 和 1080p 的按需 IDR PSNR 目标均不低于 28dB。PSNR 只作为回归指标，最终仍需真实文字可读性观察。
- IDR 突发不得令 Viewer 播放缓冲超过 300ms，也不得产生连续 1秒无解码增长。
- 720p 编码 p95 不超过 25ms；1080p 编码 p95 不超过 45ms。CPU只作为上下文，阻塞门禁使用 Host event-loop lag p95 ≤50ms、远程输入 ack p95 ≤150ms，避免用不同机器不可比的CPU百分比代替用户体验。
- 人为有限丢包后，按需关键帧使画面在 2秒内恢复；恢复期间不重建 PeerConnection、不改分辨率。

若没有候选同时通过，停止在 `relay-legacy-v1`，保留时间线修复和观测修复，不凭主观选择编码参数。

2026-09-06 补充有界细化路径：以新测的“仅按需 IDR + 上限码率 + VBV200”为共同基线，依次比较 VBV225、250（225全部离线门槛通过则停止）。旧矩阵不改写为成功。对照的作用是证明有效、可比且仅改变一个变量的测量，不要求保留已知问题的对照先达到最终产品门槛；最终候选仍必须满足上列全部条件。输入、版本、实际配置或双分辨率逐帧证据缺失/漂移均拒绝。该离线路径不开放生产 v2；TURN、输入及有限丢包门槛仍需独立真实验证。

## 7. 恢复状态机修正

继续使用 `LinkQualityController`，修正输入语义：

```text
decodedDelta > 0
  └─ HEALTHY：更新最后解码进展时间

decodedDelta == 0 && receivedDelta > 0
  └─ DECODER_STALLED：有 RTP 无出画，合并请求一次关键帧

decodedDelta == 0 && receivedDelta == 0 && selected relay
  └─ MEDIA_STALLED：先关键帧；达到既有 dead-channel 门限才刷新连接

intentional media pause
  └─ SUPPRESSED：不计入 stall，不触发关键帧或重连
```

删除“只要 inbound 仍有帧就禁止 keyframe 请求”的判断。有包无解码正是解码器需要恢复的情形，但请求仍受 generation 与 cooldown 保护。

Host 现有 `request_decoder_refresh()` 会 reopen codec，并产生 1–2秒空窗。v2 中它降为最后手段：只有按需 IDR 已确认发出、随后连续两个采样周期仍无解码增长时才允许执行一次；同一 stall episode 最多一次。

## 8. 统计与可观测性

### 8.1 Viewer 统计接口

`WebRtcStats.normalizeStats()` 输出：

```javascript
{
  derivedFps,
  browserReportedFps,
  receivedDelta,
  decodedDelta,
  bytesDelta,
  packetsLostDelta,
  framesDroppedDelta,
  freezeDelta,
  jitterBufferMs,
  rttMs,
  totals
}
```

UI、健康判断和 Host `viewer-stats` 使用 `derivedFps / decodedDelta`。`browserReportedFps` 仅用于诊断，不覆盖派生值。第一份没有 previous 的样本标记 `warmup=true`，不能触发 stall。

### 8.2 Paint 统计

通过现有 `requestVideoFrameCallback` 每5秒聚合：

- paint interval p50 / p95 / max
- 最大连续无 paint 时长
- presented frame delta
- `videoWidth / videoHeight`
- `remoteVideo.getBoundingClientRect()` 的位置与尺寸变化

只聚合，不逐帧打印。视频内容波动与页面几何抖动由不同字段表示。

自动证明只输出 candidate 类型、protocol 和 RTT，不输出 local/remote address 或端口。严格单 Viewer 意味着自动证明会顶替已有 Viewer，因此启动浏览器前必须确认没有活跃人工 Viewer，或由操作者明确安排测试窗口。

### 8.3 Host 编码统计

编码器每5秒输出一个 `WRD_ENCODER_SAMPLE`：

- `connectionAttemptId / generation / policyId`
- size、codec、target/effective bitrate、target fps
- encode count、encode ms avg/p95/max
- total bytes、IDR count、IDR bytes avg/max
- forced / periodic / PLI keyframe reason 计数

任何跨机器端到端估算必须标记为 estimate。`frame_timing` 中没有真实测得的 `encoderMs / rtpSendMs / endToEndVideoMs` 时继续为 `null`，不得填推算值。

## 9. 性能优化顺序

在时间线和编码策略通过后，再做以下有证据的小步优化：

1. 将后台抓屏频率从固定 `target_fps × 2` 做成策略值，比较 1.0×、1.25×、1.5×；优先选择不降低 paint FPS 且减少CPU的最低倍率。
2. 比较 `cv2.INTER_LINEAR` 与 `INTER_AREA` 的文字可读性和缩放耗时；只在质量提升且720p p95预算内时切换。
3. 量化 BGRA→YUV420 和 `VideoFrame.from_ndarray` 的拷贝成本，再决定是否需要复用缓冲或新的捕获 Adapter。
4. 只有发现大 IDR 进入发送队列后形成可测排队，才评估有界 RTP pacing。不得基于 VBV 大小直接修改 aiortc 私有 sender。
5. VideoToolbox 作为独立候选 Adapter 评估；必须同时通过延迟出帧、可验证IDR、SPS/PPS和TURN突发门禁，才允许替换 relay 的 libx264。

每项一次只改变一个变量。失败的实验不叠加进入下一项。

## 10. 兼容性与失败处理

1. 旧 Viewer 未携带新增字段时，Host 从既有 offer 解析相同的会话意图，继续支持当前协议。
2. 新字段只添加到诊断与 Host 内部策略，不改变认证、lease、TURN credential 或 ICE candidate 过滤。
3. 策略解析失败时拒绝建立该媒体会话并记录非敏感原因；不得静默回落到不可知参数。
4. 运行中 v2 失败可通过本地配置回滚到 `relay-legacy-v1`，无需改 Viewer 或 tunnel。
5. 直连继续使用原有策略，除了共享的时间线和统计修复；直连编码调整不与本计划捆绑。
6. Terminal Socket.IO / 可选 WebRTC TURN 链路均不在本设计范围。

## 11. 验收门禁

### 11.1 自动化

- RTP 20FPS 连续帧增量为 4500 tick，时间基等于 `VIDEO_TIME_BASE`，PTS严格递增。
- wall clock 后退、相同tick、暂停恢复、新track均有测试。
- 改 GOP 不再改变 codec；改 path 不再隐式覆盖用户分辨率。
- legacy/v2 policy解析、generation拒绝、码率clamp和apply truth有测试。
- Viewer canonical FPS只取区间解码增量；90FPS异常值只能出现在diagnostic字段。
- `decodedDelta > 0` 每次都刷新健康状态；区间值比上次低不误判stall。
- intentional pause不触发恢复；有包无解码触发一次且仅一次合并后的keyframe。
- 构建产物包含更新模块，完整 Python/Node 测试通过。

### 11.2 离线画质与耗时

- 同一合成输入、相同机器状态记录 baseline 与 candidate JSON。
- 不再出现约1秒周期的IDR画质脉冲。
- 编码时间、IDR大小和画质同时满足第6.5节，不能只挑一个指标。

### 11.3 本地真实TURN

- 使用 `http://127.0.0.1:8080` 登录并手动选择外网中继，selected pair 确认为 relay。
- 默认720p连续10分钟；显式1080p连续5分钟。
- 720p：derived FPS p50 ≥18，连续无paint不得超过1秒，播放缓冲p95 ≤150ms、max ≤300ms。
- 1080p：derived FPS p50 ≥15；若达不到，UI必须诚实显示实际帧率并保留手动720p建议，不得自动降分辨率。
- 健康窗口中不存在0.8–1.5秒周期的文字清晰度脉冲；`remoteVideo`几何位置和尺寸漂移 ≤1 CSS px。
- 人为暂停/恢复、刷新画面和一次有限丢包后2秒内重新出画。
- 鼠标/键盘输入仍通过原控制 lease；Host event-loop lag p95 ≤50ms，远程输入 ack p95 ≤150ms。

### 11.4 公网与物理设备

- 正式入口只使用 `https://link.stockhub.wiki`。
- 真实公司网/手机网/物理设备验收必须由对应访问端执行并记录；本机自连接不能替代。
- 未执行的公网或物理设备项必须写 `NOT RUN`，不得由单测或本地TURN结果推断通过。

## 12. 文档同步

### 2026-09-06 复核修正：呈现测量与事件循环隔离

- 连续性验收必须来自逐帧回调间隔和当前尚未结束的无帧时长；1Hz 采样时距上一帧的帧龄不能称为最大帧间隔。采集器应使用 `paintAgeMs` 与 `maxPaintGapMs` 区分两者；phase 开始建立新基线，窗口内 tracker/attempt/video 变更、缺测及非有限值不能通过门槛。
- 同时记录并验证呈现帧尺寸与 CSS x/y/width/height 的完整变化范围；快照首尾相同不能排除中途跳动。周期清晰度验收仍需受控文字与 IDR 关联，不由 FPS 或间隔单独推断。
- `ScreenCaptureTrack.recv()` 中复用帧复制和 PyAV 帧构造与缩放共用现有单线程 `imgproc` 池；事件循环只在 await 后接受结果并设置本 track 的 PTS/time_base。每个输出独占 VideoFrame；暂停/停止/profile 改变后的旧处理结果不得作为当前有效帧泄漏。线程池保持有界，每个 recv 至多一个在途处理任务。
- 该隔离修复不改变编码参数、捕获倍率或分辨率，不自动构成性能通过；必须以实际负载下 Host loop lag、输入 ack、FPS、逐帧画质及恢复验收判定收益。

实施完成后同步：

- `docs/需求文档/WebRemoteDesktop-需求文档.md`：将“GOP 1秒即延迟优化”的绝对表述改为“策略化按需恢复 + 已验收的长周期安全网”，记录正确RTP时间线和canonical FPS。
- `README.md`：补充诊断字段与策略回滚配置，不写入密码或TURN凭据。
- `docs/runbook-safe-startup.md`：补充如何区分编码脉冲、解码stall、几何抖动，以及本地重启边界。
- `docs/superpowers/reports/`：保存离线矩阵、真实TURN验收和遗留限制。

## 13. Review 结论

本设计已按当前代码、既有 Quality Lock / relay continuity 设计、当前测试和9月5日运行证据复核。Review 后作出以下修正：

1. 将原先可能的“直接改GOP”改为先解耦 codec 与 GOP，避免一次实验同时换编码器。
2. 将“扩大VBV”改为候选矩阵，增加TURN缓冲和IDR突发双门禁。
3. 不承诺当前缺失的精确端到端毫秒收益；先补 canonical stats 与 paint 观测。
4. 保留严格单Viewer与 generation 约束，避免全局策略被旧事件污染。
5. 将 Host decoder reopen 降为最后手段，避免恢复动作本身制造周期黑屏。
6. 把页面几何抖动列为独立验收项，不用编码PSNR替代。
7. 修正 runtime 顺序：Viewer 代码更新后先执行一次 `restart-local` 完成构建与本地服务加载，再用 `restart-host` 切换编码 policy 做 A/B。
8. 加固自动证明：必须确认真实 selected relay pair、使用当前 DOM 字段，并脱敏 candidate 地址；存在人工 Viewer 时不得启动会顶替会话的 headless proof。
9. 明确 RTCP PLI/FIR 只能按现有 aiortc 接口记为 `rtcp-or-unknown`，避免计划要求实现不存在的精确来源。
10. 将可比性较差的 CPU 门限改为 event-loop lag 和 input ack 硬门限。

未决参数只限于 `relay-balanced-v2` 的编码候选选择，选择方法、范围和停止条件已经固定；实施者无权绕过门禁凭感觉挑选参数。
