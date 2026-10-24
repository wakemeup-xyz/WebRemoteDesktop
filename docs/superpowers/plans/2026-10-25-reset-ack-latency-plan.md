# Reset ACK Latency Implementation Plan

> **For agentic workers:** 使用superpowers:subagent-driven-development进行分文件实施与独立复核；按下列checkbox跟踪，不重复请求用户已授予的实施授权。

**Goal:** 保留单次Socket安全reset和Socket ACK兜底，利用当前DC缩短成功ACK回程，并实测收益。

**Architecture:** Host只镜像已执行成功的reset结果，不复制输入请求。Viewer只对该reset的当前pending接纳发送时捕获的第二ACK source，仍通过全部owner及barrier验证。

**Tech Stack:** Python asyncio/aiortc，浏览器Socket.IO/WebRTC，Node测试及Python unittest。

**Spec:** [reset-ack-latency-design](../specs/2026-10-25-reset-ack-latency-design.md)

## Global Constraints

- 请求只执行一次；只镜像schema2 mouse/keyboard reset单ID成功ACK，固定resetAckMirrorVersion=1。
- 保留Socket请求/ACK、3秒barrier、原seq、lease/attempt/socket/DC owner门禁；不重放业务输入、不操作tunnel。
- 真实输入可见效果仍NOT RUN；reset-only native safety release不替代业务输入guard。
- 测试使用私有目录；隔离build不能发布生产dist，运行有界并保留失败证据。

### Task 1: 当前生产分段基线

**Files:** 私有`/tmp`探针；现有scripts/ordinary_session_recovery.py helper只读复用；新报告evidence。

- [ ] 只读复核10个历史reset的Viewer/Signal/Host口径和计时盲区。
- [ ] 审查私有owned reset-only探针：正常UI Start、scope冻结、20对/≥1.5秒、Socket prependAny入口与后置监听分段、有界cleanup。
- [ ] 在无Viewer时采改前基线，保留当前build/source、实际通道、逐样本hash及缺测，不从窗口max补造单输入值。

### Task 2: Host成功ACK镜像

**Files:** `python-host/host.py`，`python-host/test_host_input_admission.py`或专用无native依赖focused测试。

**Interfaces:** 消费`_send_input_ack(data,result,local_execute_ms)`既有成功结果；生成含固定marker的同结果DC ACK，原Socket ACK保持。

- [ ] 先写失败反例：成功reset镜像且Socket仍emit；DC发送throw/非open/拥塞只走Socket；非reset/negative/旧绑定不镜像。
- [ ] 在无await区间验证authority、PC/DC实际归属及绑定，best-effort发送镜像，异常不越过Socket兜底。
- [ ] focused测试红绿并独立复核，不创建或重启服务。

### Task 3: Viewer精确第二ACK source

**Files:** `web-client/js/keyboard-transport.js`、`input.js`及对应tests，必要时`webrtc.js`观测集成测试。

**Interfaces:** pending只增加内存中的reset镜像ACK source；原`acceptMouseAck`/`ownsAckSource`和seq/barrier验证仍为权威。

- [ ] 先写反例：Socket reset经匹配DC成功、普通输入拒跨源、无marker/negative/wrong ID/type/epoch/attempt/socket/DC拒绝、首ACK后迟到副本无副作用。
- [ ] 发送时捕获健康当前DC；到达时重新核对实际当前source，例外只限成功reset单ID。
- [ ] focused真实Input/WebRTC/keyboard集成及Host测试通过，独立审查scope和故障回退。

### Task 3b: 分离ACK原始到达与验权阶段

**Files:** `web-client/js/webrtc.js`、`latency-monitor.js`及对应tests；Signal诊断白名单直接复用LATENCY_METRIC_NAMES，核对其新指标持久化。

**Interfaces:** `onInputAck(data,{scope,arrivalAtMs})`消费既有入口时钟，在原匹配成功后新增有界`inputAckArrivalRttMs`/`inputAckValidationMs`；原RTT及全局clock不变。

- [ ] fake clock复现入口100、验权/UI后140；分别应记100/40，原RTT140。覆盖scope sync已推进clock、非法/缺失arrival、旧scope/negative/duplicate缺测。
- [ ] WebRTC仅在既有C验权后提交已捕获入口时间，不传为nowMs或绕过C；两个指标只记已匹配正向pending，不做clock回退。
- [ ] 定向回归与真实WebRTC→Input→M1及私有Signal redactor持久化验证；独立复核。私有未连接DC listener顺序反例保留，不称production到达。

### Task 4: 维护加载与收益验收

**Files:** 运行报告、脱敏evidence；spec/plan当前状态同步。

- [ ] 定向回归及隔离构建；git diff --check；按逻辑提交main。仅无Viewer维护窗口重启本地Signal/Host，不动tunnel。
- [ ] 同一探针改后20对reset，核对DC实际完成比例、RTT/处理时间、Socket迟到副本与Host无重复执行；保留未达200ms目标的真实结论。
- [ ] 测Socket-only fallback或离线真实路径等效反例；短断线正式rebind与至少5分钟被动连续性复验。
- [ ] 独立最终review；更新报告与剩余问题，核对本地/公网health、Host online、用户会话与密码，服务保持可用。
