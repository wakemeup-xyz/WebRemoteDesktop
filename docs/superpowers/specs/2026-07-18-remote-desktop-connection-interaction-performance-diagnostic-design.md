# Remote Desktop Connection and Interaction Performance Diagnostic Design

日期：2026-07-18

## 目标

对 WebRemoteDesktop 的远程桌面连接、画面传输、鼠标键盘交互、Web Terminal、断线恢复和诊断能力做一次端到端检查，输出可复核的当前状态、瓶颈定位、风险分级和整改优先级。

本次工作只做诊断与报告，不修改产品代码，不重启本地服务，不停止、重启或重建 Cloudflare tunnel。

## 范围

### 连接与入口

- 本地入口 `http://127.0.0.1:8080`
- 固定公网入口 `https://link.stockhub.wiki`
- `/tmp/wrd-safe-current-url.txt` 指向的当前 safe quick tunnel
- Signal Server、Python Host、Host LaunchAgent、Cloudflare 进程和 URL 文件的一致性
- Viewer 登录、Socket.IO 信令、SDP/ICE 协商、候选链路和连接恢复

### 画面与媒体

- 屏幕捕获、颜色转换、H.264/VideoToolbox 编码和 WebRTC 解码显示
- 分辨率、目标 FPS、实际 FPS、RTT、jitter、丢包、jitter buffer 和帧停滞
- Strict STUN、TURN 配置、手动 tunnel relay 的边界和降级行为
- 采集端、编码端、网络端和浏览器端的延迟可观测性是否闭环

### 交互

- 鼠标移动、点击、滚轮、键盘和组合键的采集与坐标映射
- 可靠 `input` DataChannel、非可靠 `input-move` DataChannel 和 Socket.IO 兜底
- 输入队列、20ms 串行节流、浏览器事件抑制和 Host Quartz 执行
- 暂停、恢复、断开、刷新画面、模式切换和自动重连

### Web Terminal

- Socket.IO `/terminal`、node-pty、shared session、重连与授权
- 本地与公网 RTT、input ack、首个输出和长尾延迟
- 指标时钟域、乐观回显和全屏 TUI 兼容性

## 证据模型

每项结论必须标注以下来源之一：

1. **当前实测**：2026-07-18 本机命令、HTTP/Socket 探针、进程状态或浏览器数据。
2. **当前代码事实**：工作树中的实现、测试和配置；工作树有未提交改动时，以当前文件内容为准并明确说明。
3. **历史样本**：仓库内已有报告或历史运行记录，只用于趋势对比，不能冒充当前实测。
4. **未验证**：受认证、外部网络或非破坏性边界限制而无法取得当前样本的项目。

## 诊断方法选择

### 方案 A：纯静态审计

只检查代码、配置和测试。优点是零运行干扰；缺点是不能证明当前服务、网络和浏览器表现。

### 方案 B：平衡型证据链

组合静态审计、只读运行态探针、日志/指标分析和浏览器非破坏性验证。只有获得明确许可才发送真实远程键鼠输入。该方案能覆盖当前状态，同时不改变被测系统，是本次采用的方案。

### 方案 C：注入式性能剖析

增加时间戳、采样器或网络整形后复测。可获得最细粒度的数据，但会修改代码或环境，不属于本次只读诊断范围。

## 端到端分层

### 桌面媒体路径

`屏幕捕获 -> 像素转换 -> H.264 编码 -> WebRTC packetization -> ICE candidate pair -> 浏览器 jitter buffer/解码 -> video paint`

需要分别判断 CPU/捕获、编码、网络和浏览器显示是否构成瓶颈，不能只用一个“延迟”数值概括。

### 桌面输入路径

`DOM 事件 -> 坐标/按键归一化 -> DataChannel 或 Socket.IO -> Host 输入队列 -> Quartz -> macOS 应用`

鼠标移动和可靠控制事件的传输语义不同，必须分别评估排队、丢弃和兜底行为。

### Terminal 路径

`xterm.js -> Socket.IO /terminal -> signal-server -> node-pty -> shell -> Socket.IO -> xterm.js`

Terminal 不经过 WebRTC，因此不能用桌面媒体的 STUN/TURN/候选链路解释 Terminal 延迟。

## 安全与干扰边界

- 不调用任何启动、停止、重启或 tunnel rotation 命令。
- 不修改 `/tmp/wrd-safe-current-url.txt` 和 Cloudflare 配置。
- 不在报告中记录明文密码、JWT、TURN 凭据或 cookie。
- 浏览器默认只检查页面、连接状态、统计和无副作用控件。
- 未获得用户明确许可时，不发送会作用到 Host 的真实鼠标、键盘或 Terminal 输入。

## 报告结构

最终报告保存到 `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`，包括：

1. 执行摘要和总体评级
2. 测试环境、范围和限制
3. 当前运行态与入口可达性
4. 桌面连接与恢复状态机
5. 视频性能与延迟分解
6. 鼠标键盘交互链路
7. Web Terminal 性能
8. 可观测性和测试覆盖
9. 按严重度排序的问题清单
10. 根因、整改优先级和验收指标
11. 命令、样本和文件引用证据附录

## 完成标准

- 本地、固定域名和 safe quick tunnel 都有当前状态结论，无法验证的项目明确说明原因。
- 桌面媒体、输入和 Terminal 三条数据路径分别给出瓶颈判断。
- 当前实测与历史样本明确分开。
- 所有高优先级建议都能追溯到证据和可量化验收标准。
- 报告不包含敏感凭据，也不声称未执行的真实输入测试已经完成。
