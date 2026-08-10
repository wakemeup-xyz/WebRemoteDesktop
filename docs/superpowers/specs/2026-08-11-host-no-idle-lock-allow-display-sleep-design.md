# Host 空闲不自动锁屏、允许熄屏设计

日期：2026-08-11  
状态：Implemented (2026-08-11；本机已 install awake + check exit 2 仅 manual_verify/电池 sleep 警告)  
关联：锁屏远程键盘失效调查（会话结论：优先防空闲锁屏；不宣称远程解锁 Secure Input）  
既有组件：`scripts/run-awake-keeper.sh`、`scripts/install-awake-keeper.sh`、`launchd/com.webremotedesktop.awake.plist`

## 1. Goal

让 WebRemoteDesktop 的 macOS Host 在日常无人值守时：

1. **不会因空闲熄屏 / 屏保而进入「需要密码」的锁定屏幕**（避免远程只能看图、键盘被 Secure Input 吞掉）。
2. **允许按系统电源策略关闭显示器**（省电；接受熄屏后远程画面可能发黑或卡住）。
3. **尽量阻止空闲系统睡眠**（尤其电池上 `sleep` 很短时），保证 Host / Signal / tunnel 进程与网络不因整机睡眠掉线。

一句话：

> **禁空闲自动锁屏；显示可灭；系统尽量不睡。不改键盘注入，不支持远程解锁已锁会话。**

## 2. Background

### 2.1 问题事实

- 远程连上后若主机已在 loginwindow 密码页，画面可采集，但用户态 `CGEventPost(kCGHIDEventTap)` 对密码框常无效（Secure Input）。
- 工程现有 awake 设计为 `caffeinate -dims`，其中 **`-d` 禁止显示睡眠**，与「显示屏可以熄」相反。
- 调查时 `com.webremotedesktop.awake` **未安装**；机器上仅有超时约 300s 的临时 `caffeinate`，不是 KeepAlive 守护。
- 用户已在「系统设置 → 锁定屏幕」手动将 **「屏幕保护程序启动或显示器关闭后需要密码」设为「永不」**（本机基线，见 §4）。

### 2.2 非目标

| 不做 | 原因 |
|------|------|
| 远程解锁已锁屏幕 / 绕过 Secure Input | OS 安全边界；当前 Host 无 pre-login agent |
| 禁用手动锁定（Ctrl+Cmd+Q 等） | 无法也不应禁止 |
| 修改 Viewer/Host 键盘协议或 Quartz 注入 | 范围外；防锁屏即可规避主路径 |
| 保证熄屏后画面一定非黑 | 用户已接受可能黑屏 |

## 3. 成功标准

| ID | 标准 | 验证 |
|----|------|------|
| S1 | `com.webremotedesktop.awake` 以 KeepAlive 运行 | `launchctl print gui/$(id -u)/com.webremotedesktop.awake` 成功 |
| S2 | awake 使用 **不含 `-d`** 的 caffeinate（默认 `-ims`） | `run-awake-keeper.sh` 与进程参数可核对 |
| S3 | 断言中存在 **非短超时** 的 `PreventUserIdleSystemSleep`（由 awake 持有） | `pmset -g assertions` 可见长期 caffeinate，而非仅 300s 临时票 |
| S4 | 检查脚本能报告：awake 状态、caffeinate 参数、pmset sleep/displaysleep（AC/Battery）、密码策略可读性 | `./scripts/check-host-lock-policy.sh` 退出码与输出约定见 §6 |
| S5 | 文档写明推荐锁定屏幕设置与边界（手动锁、合盖、电池系统睡、熄屏黑屏） | README + runbook + 需求文档相关节一致 |
| S6 | 插电空闲超过屏保时间后，远程连接 **默认不是** 密码锁屏（依赖本机「需要密码=永不」） | 人工验收；脚本对密码项 best-effort |

## 4. 本机基线（用户已配置，写入运维契约）

以下为 2026-08-11 本机「锁定屏幕」推荐/已采纳值，检查脚本与文档按此对照：

| 设置项 | 推荐值 | 说明 |
|--------|--------|------|
| 屏幕保护程序启动或显示器关闭后需要密码 | **永不** | 防空闲自动锁屏的主开关 |
| 使用电源适配器供电且不活跃时关闭显示器 | **永不**（可接受） | 插电远程采集更稳；与「可熄屏」在 AC 上折中 |
| 使用电池供电且不活跃时关闭显示器 | **允许有限时间**（例：2 分钟） | 允许熄屏省电 |
| 不活跃时启动屏幕保护程序 | 可保留（例：20 分钟） | 因「需要密码=永不」，屏保不应再变成密码墙 |

**说明：** 新版 macOS 可能不把「需要密码」写回旧 `defaults askForPassword`。检查脚本 **不得** 仅因读不到旧 key 就判失败；应提示人工核对此表。

## 5. 架构与组件

```text
launchd gui/UID/com.webremotedesktop.awake
  → scripts/run-awake-keeper.sh
  → /usr/bin/caffeinate -ims     # 无 -d：不阻止显示睡眠

scripts/install-awake-keeper.sh  # 安装/重载 LaunchAgent（已有，需随参数变更验证）
scripts/check-host-lock-policy.sh  # 新建：只读检查 + 明确退出码
docs: README / runbook-safe-startup / 需求文档  # 策略与边界
```

### 5.1 caffeinate 参数契约

| 旗标 | 含义 | 本设计 |
|------|------|--------|
| `-d` | 阻止显示睡眠 | **不使用**（允许熄屏） |
| `-i` | 阻止空闲系统睡眠 | **使用** |
| `-m` | 阻止磁盘睡眠 | **使用** |
| `-s` | 在 AC 上阻止系统睡眠 | **使用** |

默认命令：`/usr/bin/caffeinate -ims`。

注释必须写清：去掉 `-d` 后熄屏可能导致采集黑屏/停帧，这是有意权衡。

### 5.2 与 pmset 的关系

- awake **不替代** 用户的 `pmset displaysleep` 选择；只补充「进程级防系统空闲睡」。
- 电池上若 `sleep` 仍很短，检查脚本 **警告**，不在本设计默认强制 `pmset -a sleep 0`（避免未授权改全局电源策略；若后续要加，另开变更）。
- 合盖、菜单睡眠、断电：文档声明仍可能中断，与现状一致。

### 5.3 密码策略

- **权威来源：** 系统设置 → 锁定屏幕 UI（及本 spec §4 表）。
- 脚本：尝试读取已知 defaults；失败则打印「请人工确认需要密码=永不」，检查结果记为 `password_policy=manual_verify`。
- 本设计 **不要求** 脚本自动写入密码策略（用户已手改；自动写在新系统上脆弱且需更高权限）。

## 6. `check-host-lock-policy.sh` 行为

只读（或仅读系统状态），面向 agent/人：

**输出（人类可读 + 可选末尾一行机器摘要）：**

- awake LaunchAgent：installed? running? program args path
- `run-awake-keeper.sh` 解析到的 caffeinate 参数是否含 `-d`（期望：不含）
- `pmset -g custom`：AC/Battery 的 `sleep`、`displaysleep`
- `pmset -g assertions`：是否存在 caffeinate 的 PreventUserIdleSystemSleep；是否像「长期」而非仅短 timeout
- 密码策略：readable value 或 `manual_verify`
- 边界提醒：手动锁、合盖、熄屏黑屏

**退出码：**

| Code | 含义 |
|------|------|
| 0 | awake 已装且在跑，caffeinate 无 `-d`，无硬失败项 |
| 1 | awake 未装/未跑，或 caffeinate 仍含 `-d`，或 keeper 脚本异常 |
| 2 | 仅警告级（如电池 sleep 过短、密码策略需人工确认），awake 本身 OK |

（实现时可把「仅警告」固定为 2，便于 CI/人工区分；不得把 manual_verify 单独打成 1。）

## 7. 文档变更要点

1. **README**：防睡眠一节改为「防系统空闲睡 + 允许熄屏」；删除/更正「必须 -d / PreventUserIdleDisplaySleep」类过时验收；补充锁定屏幕推荐表与「需要密码=永不」。
2. **docs/runbook-safe-startup.md**：启动/巡检增加 `check-host-lock-policy.sh`；说明与 Host 启动的关系（建议装 awake，但不阻塞 signal 启动除非 runbook 显式要求）。
3. **docs/需求文档/WebRemoteDesktop-需求文档.md**：系统睡眠约束改为与本 spec 一致；增加空闲锁屏策略与非目标（不支持远程解锁）。

## 8. 测试

| 类型 | 内容 |
|------|------|
| 脚本单测 | 对 `run-awake-keeper.sh` 期望参数含 `-ims`、不含单独作为显示抑制的 `-d` 契约（可用 node/shell 测文件内容或 dry 解析） |
| 检查脚本 | mock/fixture 或纯函数解析：含 `-d` → 失败；无 awake → 失败；仅 manual_verify → 不导致 code 1 |
| 人工 | 安装 awake 后 `launchctl print` + assertions；插电空闲不进密码墙 |

## 9. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 熄屏后远程黑屏 | 文档声明；插电 displaysleep=永不为推荐 |
| 电池仍 sleep | 检查脚本警告；可选后续 pmset 变更 |
| 用户改回「需要密码=立即」 | 文档 + check 提示 manual_verify |
| 旧文档仍写 `-dims` | 本变更同步改三处文档 |

回滚：将 `run-awake-keeper.sh` 恢复 `-dims` 并 `install-awake-keeper.sh` 重装；系统「需要密码」由用户自行改回。

## 10. 实现顺序

1. 改 `run-awake-keeper.sh` 参数与注释  
2. 新增 `check-host-lock-policy.sh`（及必要的小测试）  
3. 更新 README / runbook / 需求文档  
4. 本机执行 install + check，记录验收输出（不把密码或机器敏感信息写入仓库）
