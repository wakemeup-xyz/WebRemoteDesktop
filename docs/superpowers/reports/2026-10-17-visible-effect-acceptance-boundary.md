# 真实输入到可见效果验收边界

2026-10-17；基于本机源码、已安装库与 Apple SDK 的只读核对，没有执行输入、窗口切换、虚拟显示器创建或抓屏。

## 结论

当前共享桌面缺少既有 guard 要求的独立 GUI 输入环境，自动 `inputToVisibleEffectMs` 验收保持 BLOCKED，数值为 null/NOT RUN。这是实际环境能力缺失，不是用单元测试或 ACK 代替实测的理由。正常远程连接、视频与控制门禁仍可独立验收。

## 代码和本地 API 依据

- `scripts/turn_lab_host.py:_local_fixture_probe` 返回 isolated/foreground/fixtureWindow=false；`scripts/turn_controlled_scene_runtime.py:run_automatic_scene` 因同一缺口保持 BLOCKED。命令行布尔值不能建立原生隔离。
- 实际 `quartz_keyboard_adapter.py` 和 `input_handler.py` 经 `CGEventPost(kCGHIDEventTap, event)` 注入全局事件流。Apple SDK `CGEvent.h:347` 定义 event-stream tap，键盘创建接口没有 display/window/session 目标。虚拟显示器或独立 Space 仅有额外像素区域，不能证明独立键盘焦点。
- 当前 Host 的 MSS 捕获和 InputHandler 的 screeninfo 输入映射分别选择首个显示器，没有绑定共同的稳定 display identity。新增虚拟显示器不能证明两者必然指向同一测试页面。
- `CGEventPostToPid` 是另一种进程路由接口；改用它或 DOM dispatch 会改变被测输入路径，不能证明当前全局 HID 路径。先检查前台窗口再发输入也不是与 WindowServer 的原子事务。
- 本机 SDK 没有公开 CGVirtualDisplay 声明，已安装 PyObjC CoreGraphics metadata 无对应绑定；这一有限证据不等于私有 runtime 类不存在。即使类存在，也不证明输入隔离。

## 最小完整验收环境

复用已有 `turn-runtime-controlled-producer.html`，其 scroll/drag/text 操作会产生受控 marker。还需要专用测试 Mac 或拥有独立 WindowServer 的测试环境，只含测试应用与合成数据；Host 捕获和真实输入在该环境内，Viewer 位于独立控制端。原生生命周期 owner 必须提供可验证的环境、display、producer PID/window、geometry 和 generation，并在输入执行边界及捕获中保持一致；环境消失或身份改变立即拒绝输入。不得通过把当前 probe 改成 true 来绕过。

届时按原路径关联实际 Viewer 输入、applied ACK、Host guard claim、producer 原生事件和匹配 RTP/rVFC 解码 marker，使用 Viewer 同钟计算延迟。光学发光时间仍需单独测量。既有设计另允许独立设备上的人工 operator-remote 操作，但当前 runner 没有完成该收集入口，且本轮未取得这类实际证据。

因此，本轮可报告的网络/捕获/解码阶段、业务 ACK 与输入后新帧均保留各自语义；不宣称已达到 150–200ms 真实可见效果目标。完整只读核对记录保存在本机 `/tmp/wrd-visible-fixture-feasibility.md`。
