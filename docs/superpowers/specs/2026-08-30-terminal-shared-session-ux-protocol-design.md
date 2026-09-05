# Terminal 共享会话 UX 与协议治理设计

**状态：** 已实施；Task 5 文档与验收边界已同步，真实单/双浏览器验收待执行
**范围：** presenter/observer 可见性、PTY 生命周期提示、事件 canonical 化和旧输入路径治理
**明确排除：** 新增 Terminal transport、独立 WSS、PTY 安全沙箱、桌面网络模式

## 1. 价值与合理性审查

共享 PTY 的后端权限和流控已有较多自动化覆盖，但用户看不懂“谁在控制、输入影响谁、关闭 tab 是否销毁 shell”。这是高价值的认知安全问题。事件 alias 和孤立 `/input` 是中等价值的维护风险；应与 UX 治理一起收敛，但不能直接删除兼容事件，必须先有观察期和拒绝日志。

## 2. 用户可见契约

Terminal 顶部显示 session 名称、processStatus、observerCount、presenter 状态和当前浏览器身份：`观察者`、`当前控制者`、`可接管`、`控制切换中`。输入区明确“输入会进入共享 PTY，所有观察者可看到”。关闭 tab 说明为 detach；显式“关闭会话”说明会销毁共享 PTY，并只对 attached observer 开放。

## 3. 状态与事件契约

内部 canonical 事件为 `pool_snapshot`、`session_created`、`session_attached`、`session_presence`、`session_output`、`session_closed`、`session_error`。Socket adapter 可在迁移期发送 legacy alias，但前端只在 adapter 层去重一次；记录 alias 命中计数和版本，达到连续发布周期零命中后才删除。

session snapshot 分离：`processStatus=starting|running|exited|failed|closed` 与 `presence=attached|detached`；非 running 禁止 input，close/detach 语义明确。

## 4. 孤立 input 模块处理

`signal-server/websocket/input.js` 当前未由 `server.js` 挂载，且不带 lease。第一阶段在文件头和测试中标记 deprecated，并添加启动断言确保未挂载；第二阶段在兼容观察期结束后删除文件和历史引用。不得重新挂载它来“修复输入”。

## 5. 错误与恢复

presenter 断开时显示“控制权正在复位”，输入冻结直到 reset ack；非 presenter detach 只离开观察，不触发共享 PTY 或 presenter 的销毁。socket 断线显示“正在重新附着”，不得承诺 Terminal session 自动恢复，直到真实验收完成。`activateSession` 对已附着会话不得无条件抢 presenter。`terminal_session_not_found`、`terminal_session_not_attached`、`pty_starting`、`pty_exited` 等稳定错误直接映射为用户可理解的状态。

失焦或页面隐藏时，先释放 pointer；若桌面输入 DataChannel 为 `open`，发送 keyboard reset；若 DataChannel 已关闭或不可用，则 park 本地输入状态。短暂失焦不释放控制租约，也不制造无法恢复的 reset barrier。页面隐藏只有持续 **5 分钟（300s）** 才暂停桌面 capture、编码和视频 payload；切换 Terminal 或手动暂停可立即暂停，信令、ICE、DataChannel、Terminal Socket 和共享 PTY 保持连接。

PTY 清理使用 `WRD_TERMINAL_PTY_KILL_WAIT_MS`，默认 **200ms**，等待 node-pty 异步 `onExit` 后再确认退出；该值由 Signal Server 做有界配置校验。

## 5.1 运行时状态归属

`TerminalPanel` 是 session、presenter、attach、transport 与生命周期状态的唯一运行时 owner。`createTerminalSessionFsm` 保留为不依赖 DOM/Socket 的确定性测试 seam，用来验证状态迁移、pending operation correlation 和错误门禁；它不是生产状态真相，也不得与 Panel 各自维护一份可竞争的 session 状态。

## 6. 验收

自动化覆盖 snapshot、presenter 变更、alias 去重、旧 input 未挂载、exited 禁写、close 权限、presenter reset barrier、失焦时 DataChannel open/closed 的 reset/park 分支，以及 Panel/FSM 状态归属 seam。真实双浏览器验收必须观察 presenter/observer 文案、共享输入和 detach 不销毁 PTY；Terminal 断网恢复、物理设备和公网 formal/quick-tunnel 路径均可标 `NOT RUN`，不得用单元测试替代。
