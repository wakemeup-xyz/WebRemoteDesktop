# C5 Viewer admission/recovery 实施报告

日期：2026-10-17。运行实现基线 `adfcb48`；工作树已包含 root 的后续文档提交。范围 C5.1–C5.4；C5.5 独立审查、部署和 C5.6 公网/设备验收尚未由本报告确认。

## 结果

旧页 A 失联后 B 成为 ACTIVE，A 在 grace 内或过期后返回：新增 admission 检查拒绝 A，B 的 Viewer map、lease snapshot、Host 事件流和 proof epoch 均保持不变。服务端不再把自动恢复当作新的人工作用；当前 session 仍可恢复，新的明确 Start 可顶替，Host rebind/reset/regrant 屏障保持不变。

## RED

命令（工作树内）：

```sh
node --test signal-server/websocket/viewer-admission.integration.test.js
```

在加入 admission 实现前，用真实 `setupSignaling`、`FakeSocket/makeIo`、独立 runtime 和可控 grace scheduler 固化 2 个行为 RED：`old disconnected page cannot supersede ACTIVE B inside grace` 与 `... after grace`。两项均失败于 `b.disconnected` 实际 `true`、预期 `false`；旧 A 成为唯一 Viewer 并向 Host 产生新的 reset。初始夹具环境/lease factory 的装配错误先被修正，再取得上述行为 RED。未用替代 admission helper 模拟缺陷。

## GREEN

以下命令直接运行 Node 测试，没有调用 `npm test` / `pretest` 或构建生产网页：

```sh
node --test \
  signal-server/websocket/signaling.test.js \
  signal-server/websocket/runtime-context.test.js \
  signal-server/websocket/viewer-admission.integration.test.js \
  signal-server/test/viewer-admission-api.test.js \
  signal-server/test/auth.test.js \
  signal-server/test/proof-admission.test.js \
  signal-server/test/lab-proof-signaling.integration.test.js \
  signal-server/test/signaling-transport-fallback.test.js \
  web-client/js/webrtc.test.js \
  web-client/js/auth-start-integration.test.js \
  web-client/js/input-signaling-continuity.test.js \
  web-client/js/input-recovery.test.js
```

实际结果：473 tests、473 pass、0 fail、0 skipped，约 24.2 秒。`git diff --check` 通过。

- 新增真实 handler 矩阵 13 项：原始 grace 内/外两个 RED、当前 owner grace 内 applied ACK/grace 外 reset/regrant、显式替代与 reset 屏障、重复/乱序/过期/未知/异主体 ticket、容量与 TTL、旧版兼容、服务重启后的未知恢复、proof 单次/占用/旧普通恢复、Host 缺失/拒绝/超时，以及同 session 旧版不能省略新代次。
- 新增真实 `createServerApp` HTTP + Socket.IO 集成 2 项：认证角色和主体/session 绑定、同一 runtime 发放/消费 ticket、容量满保留已消费证据、旧 session 恢复拒绝、strict proof-only runtime 禁止发放普通 ticket。只监听测试进程临时 `127.0.0.1:0`，结束关闭；没有 Host 进程、抓屏或原生输入。
- 新增真实 Viewer 调用链 5 项：Start/reclaim 并发点击去重、确认后 Socket.IO auth 改为 resume、pageshow/socket 重建/PC refresh 不申请 ticket、拒绝停止恢复并保留草稿/手动入口、proof Start/reclaim（含损坏标记）不升级普通准入、API 失败/迟到认证响应不打开信令。VM 只替代平台网络、PC 和 DOM，Start/init/listeners/refresh/reclaim/拒绝清理使用实际源码。
- 原 supersede 测试中的第二个不同 session 改成 `connectManual`，明确模拟用户动作；保留普通 `connect` 不自动发放 ticket。fixture 认证 Viewer subject 统一为真实密码登录的 subject，恢复测试验证同一认证身份。已有 lease/producer/rebind/proof 断言仍执行。

## 实施选择

- 新增 `signal-server/lib/viewer-admission.js`：30 秒/128 条默认有界 ticket 状态，TTL 上限 120 秒、容量上限 256；不淘汰有效去重记录。一个固定大小 current owner 与发行 high-water 独立于 ticket 清理。未消费旧 ticket 不能越过后来发行的意图；已消费 ticket 仅命中原当前代次。未知恢复始终保守拒绝。
- `runtime-context.js` 注入 admission 状态，成功 proof 接纳失效普通历史；`server.js` 把同一 runtime 传给 `routes/auth.js` 与 signaling。API 使用已有 Viewer bearer JWT，绑定 `sub` 和 session；响应 `no-store`。此设计校验客户端协议意图，不声称服务器能证明真实物理点击。
- `signaling.js` 在 `noteHumanViewerAdmission`、rebind/map/supersede 之前判定。拒绝无 Host/lease/proof 副作用；接纳返回恢复代次。此代次独立于 proof Viewer epoch 和控制 lease epoch，未改变原 proof 单次规则。
- `webrtc.js` 只有 Start/reclaim 申请 ticket，5 秒 deadline，认证代次与请求序号校验；welcome 后把 socket auth 替换为 resume。拒绝复用既有 superseded 关闭/手动重连 UI。proof 标记保持原隔离入口。
- 旧版仅首次 pristine zero-Viewer 接纳；当前旧版 owner 有有效 session 可恢复。后续显式/proof 接纳不开放旧版冲突分支；无 session 的旧版无法证明恢复身份，需刷新新版本并显式重连。已确认新协议 owner 不接受省略代次的旧版握手。

## 文件与文档

运行源码：`signal-server/lib/viewer-admission.js`、`routes/auth.js`、`server.js`、`websocket/runtime-context.js`、`websocket/signaling.js`、`web-client/js/webrtc.js`。测试：新增 server handler/API 文件；更新 `signaling-test-fixture.js`、`signaling.test.js`、`webrtc.test.js`、`auth-start-integration.test.js`。

补充设计/计划在 `docs/superpowers/specs/2026-10-17-viewer-admission-recovery-addendum.md` 与 `docs/superpowers/plans/2026-10-17-viewer-admission-recovery-plan.md`。需求只追加标题为 `C5 Viewer 准入与恢复补充（2026-10-17）` 的末尾 7 行；开始前已有的 7 行 dirty 需求增量及其他文档修改保持原样，不纳入本任务提交。

## 未覆盖与注意事项

未部署、未重启本地生产 Signal/Host、未改 tunnel/watcher，未打开生产 Viewer、未执行真实输入/抓屏/其他应用操作。VM/内存 handler/loopback 通过不等同于公网断网恢复、真实帧连续性、设备可见效果或长会话验收。生产日志已有 Viewer churn 的原因不能仅由本修复推断为旧页自动恢复。

Signal 进程重启后 current owner/代次不保留，未知自动 resume 拒绝，用户需新 Start；这是显式保守兼容选择。ticket API 故障/超时不回落为无认证意图顶替；旧版客户端的冲突需要刷新后显式连接。短期 ticket 在丢失 welcome 时仅能在 TTL 内重试原代次，过期后需手动重连。准入成功本身不授权输入。
