# Terminal 共享会话 UX 与协议治理设计

**状态：** 已审查，待实施
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

presenter 断开时显示“控制权正在复位”，输入冻结直到 reset ack；socket 断线显示“正在重新附着”，不得承诺 Terminal session 自动恢复，直到真实验收完成。`terminal_session_not_found`、`terminal_session_not_attached`、`pty_starting`、`pty_exited` 等稳定错误直接映射为用户可理解的状态。

## 6. 验收

自动化覆盖 snapshot、presenter 变更、alias 去重、旧 input 未挂载、exited 禁写和 close 权限。真实双浏览器验收必须观察 presenter/observer 文案、共享输入和 detach 不销毁 PTY；Terminal 断网恢复仍可标 `NOT RUN`。
