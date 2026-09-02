# 远程桌面输入、诊断与界面稳定性设计

**状态：** 待实施
**日期：** 2026-09-03
**范围：** Viewer 生产资源、鼠标/触控输入恢复、断连后的网络模式入口、延迟诊断语义、状态栏布局稳定性

## 1. 问题与目标

当前生产构建未装配 `touch-input-adapter.js` 与 `mobile-text-input.js`，导致触控 Pointer Events 无法转换为 v2 mouse 输入；首帧前 `#loading` 覆盖层还会拦截桌面鼠标。自动连接失败进入 `disconnected` 后，Chrome capability gate 隐藏网络模式按钮，用户无法从失败状态切换到 relay/tunnel。诊断面板把未测量阶段显示成 `-`，旧时间戳路径可能混用 Host 时钟和 Viewer `Date.now()`；每秒刷新 RTT 文本又改变宽度，造成页面周期性横移。

目标是修复上述四条边界，同时保持既有 v2 envelope、ACTIVE lease、ACK/reset barrier、Strict STUN 策略和 tunnel 生命周期不变。

## 2. 方案与非目标

采用“边界修复 + 契约测试”：

1. 生产 asset graph 显式包含触控和移动文本适配器，并通过构建产物检查。
2. `disconnected` 保留网络模式能力；模式切换沿用现有重连流程，不自动改写用户选择。
3. 延迟统计区分 Host 实测阶段、Viewer 本地测量和 unavailable；非法/不完整数据不进入统计分母。
4. 动态状态栏字段使用固定布局槽位，确保统计采样不会移动相邻控件。

非目标：不新增网络模式、不改 WebRTC/Signal 协议、不重建 Cloudflare tunnel、不重新设计 lease、不承诺真实手机或物理公网路径验收。

## 3. 组件与接口

### 3.1 生产输入装配

`signal-server/scripts/web-asset-graph.js` 的 `desktopScripts` 必须按依赖顺序包含：`js/touch-input-adapter.js`、`js/mobile-text-input.js`，且两者在 `input.js` 前加载。`Input` 继续是唯一发送入口；适配器只能调用注入的 `sendMouse`/`sendText`，不得复制 envelope、lease 或坐标公式。

`#loading` 仅在 `uiPhase === 'signaling'` 显示连接态并接收遮挡；其它阶段必须允许视频层按 capability 决定是否可交互。`streamReady === false` 时桌面输入仍 fail-closed。

### 3.2 网络模式 capability

`ChromeLayout.getCapabilities(snapshot)` 返回 `canOpenNetwork: true`，当 `uiPhase` 为 `signaling`、`media-pending`、`connected`、`media-stalled` 或 `disconnected`；`idle` 仍为 false。`applyCapabilities` 在 disconnected 显示并启用 `networkModeBtn`。

选择模式执行现有 `setNetworkMode(mode)`/重连路径：先清理旧 attempt 和手动搜索，再保存模式并发起标准连接。自动失败不得静默切换模式；用户选择 relay/tunnel 后必须使用该模式重连。

### 3.3 延迟数据契约

Host v2 `timings` 的 `capturePrepareMs`、`frameConvertMs` 仅接受有限、`>= 0` 的实测数值；`encoderMs`、`rtpSendMs`、`endToEndVideoMs` 为 `null` 时保持 unavailable。Viewer `LatencyMonitor.getStats()` 对每个阶段返回 `{last, p50, p95, count, available}`，unavailable 阶段的数组为空。

旧 schema 只有在所需时间戳均为有限数值且满足 `captureStart <= captureEnd <= scaleEnd <= encodeEnd <= packetSend` 时才计算；否则丢弃该阶段样本，不用 `Date.now()` 与 Host 秒值推导 network。Viewer input RTT、paint 使用同一 `performance.now()` 时间基准；Host `hostExecuteMs` 作为独立本机耗时接收。

诊断面板对 `available:false` 显示“未测量”，对合法 `0` 显示 `0ms`，不以连字符或零值混淆两者。

### 3.4 稳定布局

FPS、RTT/缓冲和候选链路分别放在固定 `inline-size`/`min-width` 槽位；文本使用 `white-space: nowrap` 与 `font-variant-numeric: tabular-nums`。动态文案可以改变内容但不能改变槽位尺寸。保留 1 秒 stats sampler，不通过降低采样频率掩盖抖动。

## 4. 错误处理、兼容与回滚

- 资源缺失：ShellGuard/构建测试必须明确指出缺失脚本，不能静默启动。
- 断连态：网络面板可打开；模式切换失败沿用现有连接错误和重试提示。
- 诊断字段缺失或非法：标记 unavailable，不能阻断连接。
- 不支持 `ResizeObserver` 或旧浏览器：沿用现有 56px/`vh` fallback。
- 回滚只移除上述 asset、capability、诊断渲染和 CSS/测试改动，不触碰 tunnel、lease 或协议。

## 5. 测试与验收

自动化覆盖：

- Node：asset graph/build、`ChromeLayout` disconnected capability、`LatencyMonitor` null/0/NaN/旧时间戳、Input 桌面 pointer 和 Touch adapter。
- Python/Signal：现有全量测试必须保持通过；Host v2 timing fixture 不得回归。
- 浏览器：正式入口脚本 HTTP 200；touch tap/drag/wheel 与桌面 click 产生 v2 mouse envelope；自动失败后网络按钮可切换并重连；连续 5 秒每秒刷新时相邻状态栏 bounding box 位移 <= 1px，375/768/1440 视口无重叠。

真实 Android/iOS/iPad、实体 Quartz 组合键和公网物理路径若无操作者证据，统一标记 `NOT RUN`，不得以 Playwright 模拟冒充。

## 6. 交付与运行约束

实现前后不得启动、停止、重启或重建 Cloudflare tunnel。若必须重启本地服务，只能按 `docs/runbook-safe-startup.md` 的 signal-server/Host 流程，并报告运行时密码；本次设计/计划阶段不执行服务操作。所有提交必须只包含本任务文件和明确的实现 hunks，不覆盖现有 dirty 用户改动。
