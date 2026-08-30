# WebRTC、Host 与 Signal 深模块演进设计

**状态：** 已实施；真实运行链路验收待执行
**范围：** `webrtc.js`、`host.py`、`signaling.js` 的内部 seam 和 state owner 演进
**明确排除：** 新协议、新网络模式、一次性大拆文件、行为重写

## 1. 价值与合理性审查

这是长期维护价值最高但近期交付风险最大的项目。三个核心文件分别约 5241、3532、1468 行，接口包含大量共享可变状态；理解一个行为需要跨媒体、租约、信令和 UI 时序跳转。直接拆文件会放大回归面，因此合理路径是“先建立可测试内部 seam，再以两个真实 adapters 证明 seam 有变化价值”，每阶段可独立回滚。

## 2. 目标架构

### Viewer

`DesktopSessionCoordinator` 编排 `ConnectionSession`、`MediaSession/PaintGate`、`ControlLease`、`NetworkPolicy` 和 `UiPresenter`。外部仍只暴露现有 `WebRTC` facade；新模块通过事件/快照通信，不直接互相写 DOM。

### Host

`HostRuntime` 编排 `SignalingAdapter`、`CaptureAdapter`、`MediaSenderAdapter`、`InputAdapter`、`RelayProducer` 和 `LifecycleCoordinator`。现有 `WebRemoteHost` 暂保 facade，避免改变 LaunchAgent 和启动参数。

### Signal

`SignalingCoordinator` 依次调用 `DesktopRegistry`、`ControlLeaseAdapter`、`MediaControlRouter`、`InputRouter`、`RelayRouter` 和 `ProtocolCompatibilityAdapter`。模块级 registry 迁入显式 runtime context，测试可以创建两个隔离实例。

## 3. Seam 规则

- 先抽出纯 snapshot/reducer，再抽出副作用 adapter。
- 一个实现时只有一个 adapter 时，不建立公开 seam；第二个真实 adapter 出现才提升为可替换 interface。
- facade 保持旧方法和事件名；内部模块不认识 legacy alias。
- 每个 seam 必须能通过其 interface 测试，禁止测试直接篡改 facade 内部字段。

## 4. 阶段与停止条件

阶段一：识别 state owner、冻结快照字段和事件图。
阶段二：Viewer 先抽 Media/PaintGate 与 UI presenter。
阶段三：Signal 抽 registry/lease，并完成双实例测试。
阶段四：Host 抽 capture/input/lifecycle adapter。
阶段五：移除 facade 内已无 caller 的重复逻辑。

任何阶段出现行为差异、测试只能越过 seam 修改内部字段、或没有第二个 adapter 的抽象，应停止并回退该阶段，不继续扩大拆分。

## 5. 验收与价值

自动化必须保持全绿且新增 seam 测试覆盖旧事件顺序、attempt/lease、媒体 fail-closed、shutdown。运行验收仍单独验证首帧、输入、relay、双 Viewer 和睡眠唤醒。成功标准不是行数减少，而是调用者 interface 更小、state owner 唯一、变更 locality 和测试 leverage 提高。
