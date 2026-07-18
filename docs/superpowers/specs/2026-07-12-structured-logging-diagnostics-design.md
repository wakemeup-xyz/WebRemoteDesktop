# Structured Logging and Diagnostics Design

日期：2026-07-12

> 本设计解决当前仓库“有诊断、有日志，但没有统一日志体系”的问题。目标不是把所有高频数据默认全量落盘，而是在**保守默认**前提下，把服务端运行日志、浏览器诊断包、Terminal 审计日志、Host 摘要日志统一到一套结构化模型、关联 ID、脱敏规则和排障入口上。

## 背景

当前仓库已经有几条局部可用的观测链路，但它们没有形成统一体系：

1. `web-client/js/diagnostic.js` 已经能拦截浏览器 `console`、采集网络快照、输入状态、Terminal 状态，并通过 Socket.IO 或 `POST /api/diagnostics` 上报。
2. `signal-server/lib/diagnostic.js` 已经能做浏览器诊断脱敏，并在 `WRD_ENABLE_DIAG_PERSIST=1` 时把脱敏后的 JSON 写入系统临时目录。
3. `signal-server/websocket/terminal.js` 和 `signal-server/lib/terminal/session-manager.js` 已经有少量 terminal audit 事件，但只有 `logger.info('[terminal] ...')` 这一层薄包装。
4. `python-host/host.py` 已经会接收 `diagnostic` 事件并把浏览器日志打印到 `back-debug.log`，但当前输出以大段文本块为主，不利于检索、聚合和限噪。
5. 需求文档已经明确了两件事：
   - 浏览器诊断日志应支持上送服务端。
   - Terminal 审计日志仍是未闭环项。

因此，现在的问题不是“从零开始加日志”，而是：

1. 结构不统一。
2. 关联关系弱。
3. 落盘策略粗。
4. 服务端和浏览器端的日志边界不清。
5. 排障时仍要跨 `front-debug.log`、`back-debug.log`、`/tmp/signal-server.log`、`/tmp/wrd-diag` 手工拼图。

## 目标

1. 建立一套统一的结构化事件包，覆盖 Node 服务端运行日志、浏览器诊断包、Terminal 审计、Python Host 摘要日志。
2. 保持当前浏览器“手动发送日志 / 失败自动上报 / 本地补发”的能力，并把它纳入统一关联模型。
3. 让 Terminal 审计日志成为一条独立、低噪、可落盘的安全事件流。
4. 让 `signal-server` 成为浏览器诊断的**唯一接收与规范化入口**，并把 ingest 真相源放在库层，而不是留在具体 transport handler 里。
5. 保持**保守默认**：
   - 结构化运行日志默认开启。
   - 浏览器详细诊断包默认不上持久化存储，只在手动上报、失败上报、或显式开启持久化时进入临时目录。
   - Terminal 完整 IO 默认不记录。
6. 提供轻量级服务端摘要读取面，支撑运维和排障，不在本轮建设完整前端日志后台。

## 非目标

1. 不建设完整的 Web 日志检索 UI。
2. 不引入 ELK、OpenTelemetry Collector、外部 SaaS 日志平台等重型基础设施。
3. 不默认记录完整 Terminal 输入输出内容。
4. 不把浏览器端所有高频输入事件实时流式落盘。
5. 不改变现有 Viewer / Host / Terminal 的认证模型和连接拓扑。

## 方案比较

### 方案 A：在现有文件上继续零散加日志

优点：

1. 改动最小。
2. 上线快。

缺点：

1. `console.log`、`[terminal]`、Host 文本块、诊断 JSON 继续各说各话。
2. 无法稳定按 `connectionAttemptId`、`browserSessionId`、`terminalSessionId` 串联。
3. 后续每加一个观测点，都要再补一层定制解析。

结论：不是系统性方案。

### 方案 B：统一结构化观测层，详细诊断保持按需持久化（推荐）

优点：

1. 单一接收边界清晰。
2. 运行日志、审计日志、浏览器诊断包职责分离。
3. 既保留现有手动上报链路，又避免默认把高频详细 payload 全量落盘。
4. 便于给后续 Cloudflare、STUN、Terminal、Host 问题做统一关联分析。

缺点：

1. 需要补一层共享的事件包装与摘要存储。
2. 需要同时改 Node、Browser、Python Host 三个面。

结论：这是当前仓库最合适的平衡点。

### 方案 C：默认把所有日志、诊断、Terminal IO 全量持久化

优点：

1. 信息最全。
2. 历史追溯最强。

缺点：

1. 噪音大。
2. 隐私和泄露面更大。
3. 对家庭网常驻服务不友好，日志文件膨胀快。
4. 和需求文档中“Terminal 不默认记录完整命令和输出内容”的约束冲突。

结论：不适合当前项目。

## 推荐设计

### 一、把日志分成三类，而不是一锅端

系统内统一存在三类观测对象：

1. **结构化运行日志**
   - 来源：`signal-server`、`python-host`
   - 作用：记录服务端关键状态变化和错误
   - 默认：开启
   - 形式：JSONL 或等价结构化对象，经 logger 输出到 stdout / 运行日志文件

2. **浏览器诊断包**
   - 来源：`web-client/js/diagnostic.js`
   - 作用：手动排障、连接失败自动上报、重放补发
   - 默认：只上送、不持久化；只有显式开启持久化时写系统临时目录
   - 形式：一次一包的 JSON payload，经 `signal-server` 规范化后变成事件摘要 + 可选 bundle 文件

3. **Terminal 审计日志**
   - 来源：`signal-server/websocket/terminal.js`、`signal-server/lib/terminal/session-manager.js`
   - 作用：记录 admin 登录、socket 连接、create / attach / detach / close / error / resize / input reject 等安全与运维事件
   - 默认：摘要日志开启；完整 IO 关闭
   - 形式：结构化 audit event，可单独输出到 audit file

这三类日志共享一套 envelope，但持久化策略不同。

### 二、Signal Server 是浏览器诊断的唯一真相入口

浏览器端可以继续通过以下路径发送诊断：

1. `WebRTC.socket.emit('diagnostic', payload)`
2. 临时 Socket.IO 连接
3. `POST /api/diagnostics`

但不管入口是哪一条，**统一以 `signal-server` 库层的 ingest helper 为规范化边界**。浏览器只负责“尽量多带上下文”，不负责定义最终落盘格式。

统一后的行为：

1. 接收浏览器诊断包。
2. 按统一脱敏规则处理。
3. 生成一个结构化摘要事件写入运行日志。
4. 在 `WRD_ENABLE_DIAG_PERSIST=1` 时，把完整脱敏 bundle 写入临时目录。
5. 继续允许把诊断摘要 relay 给 Host，但 Host 默认只记摘要，不再无条件打印整包浏览器日志。

代码职责上，这意味着：

1. Socket.IO `diagnostic` 和 `POST /api/diagnostics` 都只是 transport 入口。
2. 真正的 ingest / normalize / redact / summarize 行为应下沉到 `signal-server/lib/diagnostic.js` 或等价库层 helper。
3. `websocket/signaling.js` 不再持有诊断规范本身，只负责调用库层并转发结果。

### 三、统一事件包结构

所有结构化事件使用同一套核心字段：

```json
{
  "ts": "2026-07-12T10:15:30.123Z",
  "level": "info",
  "domain": "viewer",
  "event": "diagnostic_uploaded",
  "message": "Viewer uploaded diagnostic bundle",
  "source": "signal-server",
  "schemaVersion": 1,
  "correlation": {
    "browserSessionId": "browser-abc",
    "connectionAttemptId": "attempt-123",
    "viewerId": "viewer-42",
    "terminalSessionId": null,
    "socketId": "socket-1",
    "clientId": null
  },
  "meta": {
    "trigger": "manual",
    "reason": null,
    "logCount": 48
  },
  "redactionVersion": 1
}
```

规则：

1. `domain` 用来区分 `server`、`viewer`、`terminal`、`host`、`tunnel`。
2. `event` 是稳定机器可读标识，不把中文文案当事件名。
3. `message` 只是摘要，给人看。
4. `correlation` 固定为一组对象，避免散落在 `meta` 顶层。
5. `meta` 放领域特有字段，但不放敏感原文。

### 四、统一关联 ID 模型

本轮以现有 ID 为主，不重新发明：

1. `connectionAttemptId`
   - 浏览器连接尝试级别
   - 现有连接诊断已在用

2. `browserSessionId`
   - 新增
   - 一个浏览器 tab / session 生命周期内稳定
   - 存在 `sessionStorage`，不放长期 `localStorage`

3. `viewerId`
   - 现有 viewer subject 或 HTTP upload 的 `http-${sub}`

4. `terminalSessionId`
   - 现有共享 PTY 会话 ID

5. `socketId`
   - Signal Server / Terminal namespace socket

6. `clientId`
   - Terminal 浏览器侧 client identity

所有 runtime/audit/diagnostic summary 都尽量带上这些字段的可用子集。

### 五、浏览器侧只保留轻量内存日志缓冲，不默认转成持久化日志

浏览器日志模型保留现有优势，但做两点收敛：

1. `Diagnostic.logs` 从纯字符串数组升级为结构化内存条目：
   - `at`
   - `level`
   - `message`
   - `channel`（console / input / terminal / webrtc）

2. 发送给服务端时：
   - modal 里仍然显示可读文本
   - wire payload 附带结构化条目和 `browserSessionId`

这样可以同时满足：

1. 用户手动查看日志时可读。
2. 服务端摘要和持久化时可结构化处理。

### 六、Terminal 审计日志必须从“字符串前缀”升级为真正审计流

`signal-server/lib/terminal/audit.js` 不再只做 `logger.info('[terminal] ' + event, meta)`，而是成为 terminal 安全事件包装器。

必须覆盖的事件：

1. `terminal_admin_authorized`
2. `terminal_socket_connected`
3. `terminal_socket_transport_upgrade`
4. `terminal_session_created`
5. `terminal_session_attached`
6. `terminal_session_detached`
7. `terminal_session_closed`
8. `terminal_resize_rejected`
9. `terminal_input_rejected`
10. `terminal_error`
11. `terminal_session_count_above_soft_threshold`

Terminal audit 设计原则：

1. 默认记录事件摘要。
2. `WRD_TERMINAL_RECORD_IO=1` 才允许记录输入输出内容摘要或字节数以上的附加信息。
3. `WRD_TERMINAL_AUDIT_LOG` 为空时，仅进入统一运行日志；配置为文件路径时，再额外写一份独立 audit JSONL。
4. `/api/auth/login/admin` 的成功、失败、禁用态、未配置态都属于 Terminal 审计域的一部分，不能只记 socket 连接后的事件。

### 七、Host 侧改成“结构化摘要 + 可选详细块”

当前 `python-host/host.py` 对浏览器诊断会打印完整块：

1. `=== DIAGNOSTIC LOGS FROM VIEWER ===`
2. 所有 `[VIEWER] ...` 行
3. `=== END DIAGNOSTIC LOGS ... ===`

这不适合作为默认观测策略。推荐改成：

1. 默认只记录结构化摘要事件：
   - `host_viewer_diagnostic_summary`
   - `host_viewer_stats_summary`
   - `host_remote_input_error`
   - `host_offer_state_changed`
2. 对浏览器上传的详细 `logs[]`：
   - 默认不逐行打印
   - 如需保留旧式 verbose 排障，再用显式开关开启

这样 Host 日志仍然保留“连接失败 / 候选类型 / RTT / mode / turn 状态”等核心事实，但不会被浏览器 console 文本刷满。

### 八、持久化与保留策略

保守默认如下：

1. **结构化运行日志**
   - 默认开启
   - 输出到 stdout / 现有运行日志文件
   - 不额外复制成大块 JSON 文件目录

2. **浏览器诊断 bundle**
   - 默认不上持久化存储
   - `WRD_ENABLE_DIAG_PERSIST=1` 时写入 `os.tmpdir()/wrd-diag`
   - 保持数量和时间上限，防止临时目录无限增长

3. **Terminal audit**
   - 默认进入统一运行日志
   - `WRD_TERMINAL_AUDIT_LOG=/path/to/file.jsonl` 时额外单独落盘

4. **Terminal IO**
   - `WRD_TERMINAL_RECORD_IO=0` 默认不记录原文

5. **Host verbose browser logs**
   - 默认关闭
   - 只在明确排障时开启
   - 必须有显式配置项控制，而不是靠临时代码分支

### 九、脱敏规则统一，不让每个模块自己猜

统一脱敏规则由 `signal-server` 侧 helper 定义，至少覆盖：

1. `token`
2. `secret`
3. `password`
4. `authorization`
5. `cookie`
6. 完整 URL 中的 query secrets

规则：

1. 摘要日志不输出明文凭据。
2. 浏览器诊断 bundle 即使持久化，也必须先脱敏。
3. Terminal audit 默认不带原始输入输出。
4. Host verbose 模式如果打开，也必须只输出已脱敏的诊断包内容，而不是浏览器原始未经处理的 payload。

### 十、读取面只做轻量摘要，不做完整日志后台

本轮只建设轻量服务端读取面：

1. 保留现有：
   - `/api/admin/connection-summary`
   - `/api/admin/connection-attempts`

2. 新增：
   - `/api/admin/observability/summary`
   - `/api/admin/observability/recent?domain=&limit=`

返回内容以结构化摘要事件为主，不直接回完整浏览器 bundle 原文。

这样做的原因：

1. 满足“系统性排障可见性”。
2. 不把本轮范围膨胀成前端日志平台。

### 十一、配置语义要收敛，而不是继续模糊

本轮需要明确几项配置语义：

1. `WRD_ENABLE_DIAG_PERSIST`
   - 只控制浏览器诊断 bundle 临时目录持久化
   - 不控制普通运行日志是否输出

2. `WRD_TERMINAL_AUDIT_LOG`
   - 明确为“独立审计日志文件路径”
   - 为空表示不单独写文件，但 audit 事件仍进入统一运行日志

3. `WRD_TERMINAL_RECORD_IO`
   - 明确为“是否允许记录终端 IO 细节”

4. `WRD_HOST_VERBOSE_DIAGNOSTICS`
   - 明确为“是否允许 Host 输出浏览器诊断详细日志行”
   - 默认 `0`

5. 新增统一日志配置：
   - `WRD_LOG_LEVEL`
   - `WRD_LOG_FORMAT`
   - 可选 `WRD_LOG_DIR` 或仅复用现有 stdout/file 重定向

## 文件职责建议

1. `signal-server/lib/observability/logger.js`
   - 统一结构化 logger

2. `signal-server/lib/observability/redact.js`
   - 统一脱敏 helper

3. `signal-server/lib/observability/store.js`
   - 最近事件 ring buffer 与摘要聚合

4. `signal-server/lib/diagnostic.js`
   - 浏览器诊断 bundle 的规范化与持久化

5. `signal-server/lib/terminal/audit.js`
   - Terminal audit event builder

6. `signal-server/routes/auth.js`
   - Terminal admin 登录审计入口

7. `web-client/js/diagnostic.js`
   - 浏览器端日志缓冲、manual upload、auto-send、pending replay

8. `python-host/observability.py`
   - Host 侧结构化摘要输出 helper

## 兼容性结论

1. 浏览器手动发送诊断日志功能继续保留。
2. 连接失败自动上报继续保留。
3. `WRD_ENABLE_DIAG_PERSIST=1` 继续控制临时目录落盘。
4. 现有 `/api/diagnostics`、Socket.IO `diagnostic`、`/api/admin/connection-summary` 继续保留。
5. 变化点在于：
   - Host 默认不再刷出整包浏览器日志。
   - Terminal audit 变成真正结构化事件流。
   - 运行日志与诊断 bundle 的职责会被明确拆开。

## 验证标准

实现完成后，至少要证明：

1. 浏览器页面手动发送日志时，Signal Server 会产出一条结构化 `viewer.diagnostic_uploaded` 摘要事件。
2. `WRD_ENABLE_DIAG_PERSIST=0` 时，不会在临时目录留下新的诊断 bundle 文件。
3. `WRD_ENABLE_DIAG_PERSIST=1` 时，诊断 bundle 会以脱敏后的 JSON 写到临时目录。
4. Terminal create / attach / detach / close / reject 路径都会产出结构化审计事件。
5. `WRD_TERMINAL_RECORD_IO=0` 时，不会记录完整 Terminal IO 原文。
6. Host 收到诊断时，默认只输出结构化摘要，不输出整段浏览器日志块。
7. `/api/admin/observability/summary` 和 `/api/admin/observability/recent` 能返回最近事件摘要。

## 最终结论

这套设计的关键不是“多加几行日志”，而是把仓库里的观测行为收敛成一个稳定模型：

1. `signal-server` 负责统一接收、规范化、脱敏、摘要化。
2. 浏览器继续负责高上下文诊断采集和按需上送。
3. Terminal 审计从弱日志升级为安全事件流。
4. Host 从“大段文本回显”收敛为低噪结构化摘要。

这样做以后，后续不管是排查 Cloudflare / STUN / shared terminal / 输入失效 / reconnect / 高延迟，都会落在同一套关联字段和读取面上，而不是继续靠多份散落日志手工拼接。
