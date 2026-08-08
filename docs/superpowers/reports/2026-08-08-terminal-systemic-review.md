# Terminal 系统性代码审查与 Webtest 报告

**日期：** 2026-08-08  
**范围：** `signal-server/lib/terminal/*`、`signal-server/websocket/terminal.js`、`web-client/js/terminal*.js`、`shell-guard.js`（影响 Terminal 入口）、设计文档与运行时验收  
**原则：** 只收录有代码证据或已复现的问题

---

## 1. 执行摘要

| 维度 | 结果 |
|------|------|
| 单元/集成测试 | **212/212 PASS**（含本次新增 shell-guard 2 项） |
| Runtime probe | **PASS**（python 路径、env allowlist、exited 拒输入） |
| Playwright webtest | **主路径 PASS**（登录→授权→xterm→composer 命令→多会话→tab 往返） |
| 实机阻塞缺陷（已修） | ShellGuard `DOMContentLoaded` 在 deferred `installCore` 之后重新禁用 `[data-core-control]`，**Terminal 按钮永久 disabled** |
| 后端 High | 2（WebRTC 双 observer 清理不全；create/attach 尺寸越界） |
| 前端 High | 5（TURN rebind/静默回退、pending sticky、未附着可输入） |
| 中/低 | 后端 7 + 前端 ~15 + 本次 webtest 观察到的 composer/exited 门闩缺口 |

**结论：** hardening 主链路（admin JWT、socket 身份、env allowlist、流控、composer ack）扎实，单测覆盖主路径充分。但 **Viewer bootstrap 竞态曾让 Terminal 完全点不开**；多会话 + TURN + 失败路径状态机仍有可复现正确性缺陷，建议按优先级修后再宣称 Terminal 生产就绪。

详细分报告：

- 前端：`artifacts/terminal-webtest-2026-08-08/frontend-review.md`
- 后端：`artifacts/terminal-webtest-2026-08-08/backend-review.md`
- Webtest 产物：`artifacts/terminal-webtest-2026-08-08/`

---

## 2. 本次已修复

### F-0 [High][Fixed] ShellGuard 与 deferred core 竞态，Terminal tab 永久禁用

**证据（Playwright trace）：**

1. `installCore` @ ~77ms → `terminalDisabled=false`
2. `DOMContentLoaded` @ ~78ms → 无条件 `setCoreControlsDisabled(true)`
3. 之后 8s 轮询 `terminalTabBtn.disabled === true` 不变

**修复：** `web-client/js/shell-guard.js` — DOMContentLoaded 仅在 `!coreInstalled` 时禁用；新增 2 个回归测试；`npm run build:web` 后 webtest 全绿。

**影响：** 所有 `data-core-control` 控件（含 Terminal、请求控制、分辨率等），不仅 Terminal。

---

## 3. 后端 Findings（摘要）

| ID | 严重度 | 问题 |
|----|--------|------|
| B-01 | High | `detachObserver({socketId})` 只 `break` 一次；WebRTC observer `webrtc:${socketId}` 与 Socket.IO 共享 socketId → 显式 detach / 异常 disconnect 可残留 observer，idle reaper 失效 |
| B-02 | High | create/attach 透传 cols/rows **无 10–300 / 5–100 校验**；仅显式 resize 有边界；可把极端几何交给 node-pty |
| B-03 | Medium | `WRD_TERMINAL_MAX_IN_FLIGHT_*` 在 `parseTerminalConfig` 有、`loadConfig`/session-manager **未贯通**，运维调参静默无效 |
| B-04 | Medium | Admin 密码 `!==` 非 constant-time；存在未使用 bcrypt `verifyPassword` |
| B-05 | Medium | PTY `kill(SIGHUP)` 成功即 confirmed，无 exit 等待 / SIGKILL 升级；server shutdown 不收割 PTY |
| B-06 | Medium | close 清理失败已标 CLOSED 但不 quarantine |
| B-07–09 | Low | 服务端不强制 websocket-only；WebRTC metrics 名不在 allowlist；burst 可配到小于单包上限 |

---

## 4. 前端 Findings（摘要）

| ID | 严重度 | 问题 |
|----|--------|------|
| F-01 | High | TURN 下 `activateSession` **不 rebind** DC；`shouldPreferWebRtcOutput` 仍压制 active 会话的 Socket.IO 输出 → 切 tab 后“死终端” |
| F-02 | High | preferred=webrtc-turn 但 DC 未 open 时，`emitTerminalInput` **静默走 Socket.IO**（与“不静默回退”文案不符） |
| F-03 | High | 关闭未附着会话 → `terminal_session_not_attached` **不清** `pendingCloseSessionIds` → 关闭永久卡住 |
| F-04 | High | attach 失败不清 `pendingAttachSessionIds` → 无法重试 attach |
| F-05 | High | xterm `onData` → `emitTerminalInput` **不检查** `attachedSessionIds`，可乐观回显 + 服务端拒绝 |
| F-06–15 | Medium | TURN send 失败不回滚 pending；answer 超时 listener 泄漏；bootstrap 失败被缓存；starting 丢 resize；**composer 不看 processStatus**；alt-screen 跨 chunk；replay 不清 mode；双击 create 覆盖 requestId；草稿未 flush；destroySocket 清理不全 |
| F-16–20 | Low | 无 detached 监听；loader init false 仍 ready；token sessionStorage；多 attach 不 detach 等 |

**Webtest 旁证 F-10：** 单测声称 exited 禁输入，但 `isComposerReady()` 只看 `socket.connected + attached`，**不含 processStatus**。多会话场景下 exit 后若仍附着，composer 可保持可点（扩展 webtest 曾 WARN）。

---

## 5. 测试与验收

### 5.1 自动化

```text
signal-server terminal* + web-client terminal* + shell-guard
→ 212 pass, 0 fail
```

### 5.2 Runtime probe（真实 /terminal Socket.IO）

- shell: `/bin/zsh`
- python: Homebrew 3.11 路径
- forbidden env: 空
- exited + input reject：通过

### 5.3 Playwright webtest（`artifacts/terminal-webtest-2026-08-08/`）

修复 ShellGuard 后：

| 步骤 | 结果 |
|------|------|
| viewer_login | PASS |
| open_terminal_tab | PASS |
| terminal_admin_auth | PASS（websocket · 网络A档） |
| session_tabs / xterm_mounted | PASS |
| command_echo via composer | PASS |
| create_second_session | PASS 1→2 |
| transport_select | PASS（Socket.IO / TURN DC） |
| tab_switch_roundtrip | PASS（socket 保持） |
| reload 后 sessionStorage 免二次密码 | PASS |
| exit 后 composer 门闩 | WARN（见 F-10） |

脚本：`artifacts/terminal-webtest-2026-08-08/terminal_webtest.py`

---

## 6. 建议修复优先级

### P0（正确性 / 入口）

1. ~~ShellGuard DOMContentLoaded 竞态~~ **已修**
2. B-01 双 observer 全量 detach
3. B-02 create/attach/resize 统一尺寸 clamp
4. F-01/F-02 TURN rebind + 禁止静默 Socket.IO 输入
5. F-03/F-04 pendingClose / pendingAttach 失败释放
6. F-05 / F-10 输入与 composer 统一要求 `attached && processStatus==='running'`

### P1（运维 / 资源）

7. B-03 maxInFlight 配置贯通  
8. B-05 kill/shutdown 收割  
9. F-08 bootstrap 失败可重试；F-09 running 后补 resize  

### P2

其余 Medium/Low + 失败路径单测补强（见前端报告“高风险缺口”）。

---

## 7. 优点（保持）

- Admin 二次授权 + server-owned `socket.id` 身份
- PTY env allowlist + no-rc shell + Python PATH 隔离（probe 已证）
- Observer 级输入限流与输出背压（慢 observer detach，不杀 PTY）
- Composer inputId/ack/reject unlock 契约完整
- 桌面 disconnect 不拆 terminal socket（shared-terminal 设计）
- 主路径单测体量大，别名事件去重正确

---

## 8. 未改动的边界

- 未重启 Host / tunnel；公网 URL 未变更
- 未对 TURN DataChannel 做实机延迟对比（本地 A 档默认 Socket.IO）
- 未提交 git（仅工作区修改 shell-guard + 测试 + 本报告 + webtest 产物）

---

## 9. 工作区变更（审查期间）

- `web-client/js/shell-guard.js` — 竞态修复
- `web-client/js/shell-guard.test.js` — 回归
- `web-client/dist/*` — `npm run build:web` 重建
- `artifacts/terminal-webtest-2026-08-08/*` — webtest 与分报告
- 本文件

---

## 10. 修复跟踪与 Closure（2026-08-08 实施）

**状态：** Phase 1 + Phase 2 行为目标已落地；结构抽取部分完成。

### 10.1 证据总表（G-01…G-09）

| ID | 证据 |
|----|------|
| G-01 ShellGuard | `6669f34` + shell-guard 6 tests + webtest Terminal 可点 |
| G-02 presence 全量 detach | `5a07f5a` + presence/session-manager tests |
| G-03 geometry | `67db1d7` + geometry + manager integration tests |
| G-04 TURN rebind/硬拒绝 | `c7955ea` + turn-transport + panel tests |
| G-05 pending 精确释放 | `ad644fb` 最小 sticky 修复 + `9846b1d` operationId 关联 |
| G-06 输入门闩 | `ad644fb` InputGate + composer/exited tests |
| G-07 maxInFlight | `ef0b677` config 贯通 + manager 窗口测试 |
| G-08 kill/shutdown | `85ef5d3` escalation + closeAllAsSystem + `dc56bcf` 测试 await 修复 |
| G-09 bootstrap/resize | `6952064` + `eea9eea` |

### 10.2 结构抽取

| 模块 | 状态 |
|------|------|
| geometry / presence / lifecycle kill | 完成 |
| terminal-input-gate | 完成 |
| terminal-turn-transport | 完成 |
| terminal-session-fsm | 完成（`a0bb924`） |
| terminal-socket-transport | **未抽完**（bootstrap 逻辑仍主要在 panel；可后续） |

### 10.3 验证（closure 时）

- `node --test` terminal 相关：**274/274 PASS**
- `npm run build:web`：成功
- Playwright `artifacts/terminal-webtest-2026-08-08/terminal_webtest.py`：主路径 PASS
- 未重建 tunnel

### 10.4 Residual（仍不在本轮 DoD）

1. SocketTransport 完整抽取  
2. B-04 timing-safe admin password  
3. B-06 close quarantine 策略重做  
4. B-07 服务端强制 websocket-only  
5. 进程组杀光保证  
6. F-11 alt-screen 跨 chunk 等 UX 深修  

### 10.5 关键 commit 链（相对 origin/main 实施段）

```
6669f34 fix(viewer): keep core controls enabled after deferred installCore
67db1d7 fix(terminal): validate cols/rows on create attach and resize
5a07f5a fix(terminal): detach all observers sharing a socket id
ad644fb fix(terminal): gate input on attach and process status
c7955ea fix(terminal): rebind turn dc on session activate and reject undeliverable input
cdf3dc8 docs(terminal): add modular remediation spec plan and review
ef0b677 fix(terminal): plumb max in-flight output config to dispatcher
9846b1d fix(terminal): correlate attach close pending with operationId
a0bb924 refactor(terminal): extract session fsm
6952064 fix(terminal): retry failed terminal bootstrap
eea9eea fix(terminal): resize when pty becomes running
85ef5d3 fix(terminal): escalate pty kill and harvest sessions on shutdown
dc56bcf test(terminal): await async session create close in metrics bootstrap
```
