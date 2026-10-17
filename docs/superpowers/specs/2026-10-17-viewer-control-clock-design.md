# Viewer 本页控制期限的单调时钟

状态：源码3ca62fe已实现、427项主要回归通过，独立spec/quality review PASS；已随d0c1223加载为builda6e8b15122bde656，新proof会话验收等待普通Viewer退出。补充已有控制恢复整改，独立于 Host 媒体节流修复。

## 确定问题

实际方法的假时钟反例见[审查报告](../reports/2026-10-17-viewer-clock-review.md)。真实仅经过 100ms 时，系统前跳 60 秒会把鼠标最早 ACK 的剩余 2900ms 改成 0，回拨会改成 62900ms；移动端有效 ACK 可被误判 late-ack。信令恢复的 12000ms 等待也会提前或延后。相邻本页视频新鲜度和恢复冷却使用同类墙钟，负 age 甚至被判健康。这些是确定的代码风险，不是已证明三天中每次失控的历史根因。

## 选择与范围

使用本页 `performance.now()` 统一以下私有 duration 字段的创建、读取、清理和测试 fixture：

- Input `_desktopWritePending` 的发送时刻，仅用于最早可靠鼠标/命令/reset ACK deadline。
- 移动手势 `downDeadline/upDeadline` 的创建、排序重排和 ACK late 检查。
- WebRTC `_signalRecoveryStartedAt`，及 `_lastInboundFramesDecodedAt`、`_lastRefreshAt`、`_lastKeyframeRequestAt` 的新鲜度/冷却判断。

不采用“负值截零”或墙钟 fallback，前者不能解决前跳，后者继续引入缺陷。Performance API 是当前浏览器运行环境的既有依赖，离线 VM 显式提供独立假时钟；不要为了原先缺少 API 的 fixture 在生产加入 Date.now 或固定零兜底。实现可直接调用 API 或使用各 owner 的简短本地 accessor，不新增共享加载模块、依赖或 timer。单调时钟零是合法时刻，未设置的恢复/新鲜度/冷却 origin 使用 `null`，不能用 falsy0 作为未开始。

## 保留的契约

ACK 3000ms、signal fallback 12000ms/retry1500ms、现有 refresh/rebuild/keyframe 冷却值保持原样；不改变 ACK admission、同 lease/attempt/socket/generation 校验、单次恢复预算、业务输入不重放、手动断开/superseded 禁止重连、健康 PC 复用或服务端票据/proof 权威。

这些字段仅属本页，不能外发或持久化。保留 opaque input/request IDs 的 epoch 部分、日志/诊断墙钟、Host clock-sync、auth/ticket expiry，以及 leaseEpoch/sequence/generation 等计数器。KeyboardTransport 已使用 performance.now，保留其协议和独立 owner。未参与控制判断的 `_recoveryCycle.deadline`、unordered hint、wheel batch、UI stall 统计不纳入本次修改。

## 测试与部署

真实 Input/WebRTC VM 对象上建立独立 wall 和 monotonic clocks，模拟 ±60000ms 墙钟变化。两笔 pending write 重排仍守住最早 3000ms；100ms 有效 down/up ACK 正常，真实超时仍 uncertain/reset；signal 1.5s 不提前重建、到原阈值才重建，成功/手动断开/supersede 后旧回调无效；媒体新鲜度/冷却在 monotonic0 初始时刻与真实经过时间均正确。

只运行离线 Node suites，不访问浏览器或全局输入。独立 review 后构建到临时目录，验证当前与保留构建资源；controller 在零 Viewer 的授权维护窗口同步生产，保留 HEAD/index/用户修改及所有 tunnel。新浏览器真实短测与长测单独记录。此修复不代替原生输入到可见画面的实测，也不使一次性 proof 自动重连成为普通用户恢复验收。
