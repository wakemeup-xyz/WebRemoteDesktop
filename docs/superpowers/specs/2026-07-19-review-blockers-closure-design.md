# Review Blockers Closure Design

日期：2026-07-19

## 范围

关闭 committed-history review 基线 `65b49c9` 后发现的两个阻塞缺陷：控制租约到期竞态，以及 Terminal composer 在服务端拒绝输入后保持 pending 的问题。本设计不改变媒体暂停、Terminal 授权或 tunnel 生命周期语义。

## 控制租约到期竞态

`DesktopControlLease` 的 accessor 只读取状态，不再隐式推进到期状态。到期检查通过一个显式 dispatcher seam 执行：该 seam 调用到期检查、广播控制状态并发送唯一 `control-transition`。所有主动操作在继续处理前经过同一 seam，因此晚到的 heartbeat、authorize、snapshot 或 requestControl 都不能吞掉 reset transition。

进入 `REVOKING` 后，旧凭据立即失效，状态保持在 reset ack 到达前；新 controller 不能获得 grant。transition timeout 只报告失败并保持 reset barrier 的安全语义，不作为正常绕过 Host reset 的释放路径。reset-only transition 和日志不包含 lease token。

## Terminal composer 拒绝输入

Signal Server 对每个 `terminal:input` 失败结果回传可信的 `sessionId` 和客户端提供的 opaque `inputId`，不记录命令正文。Viewer 仅按匹配 `inputId` 清理对应 pending submission，保留当前 draft 并恢复提交按钮；不匹配错误不会影响其他 session。成功 ack 继续使用 draft snapshot 判断，只有用户未继续编辑时才清空草稿。重试生成新的 inputId，并只发送一次新的 payload。

## 验证

每个缺陷先新增失败测试，再实现最小修复，运行对应 Signal/Viewer 回归测试。两个 blocker 使用独立 conventional commit，媒体暂停计划随后按既有 Task 1-10 执行。
