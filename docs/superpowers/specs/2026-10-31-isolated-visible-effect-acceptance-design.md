# 隔离 Lab 的真实输入到可见效果验收设计

日期：2026-10-31

## 目标

在独立的 macOS 测试用户/WindowServer 环境中，建立可验证的真实输入到可见 marker 证据链：

`Viewer input → ACK → Host apply → native input receipt → capture → encode/RTP → Viewer decode/rVFC → marker match`

该能力只服务于隔离 Lab，不能改变共享生产 Host 的全局 HID 输入和 MSS 捕获行为。

## 现状边界

共享生产 Host 的 Quartz 输入使用全局 HID event stream，MSS 捕获和输入映射没有共同的稳定 display/window identity。命令行 flags、浏览器 DOM 事件、ACK 或“当前窗口在前台”都不能证明输入落到被测窗口。因此生产环境中的真实输入、visible effect 和 physical display 必须保持 `NOT_RUN`。

## NativeFixtureProbe 契约

Lab Host 在启动捕获和输入前必须从 native adapter 得到有界证明：

```json
{
  "schemaVersion": 1,
  "runId": "lab-run-hash",
  "desktopIdHash": "hash",
  "displayIdentityHash": "hash",
  "windowIdHash": "hash",
  "captureTargetHash": "hash",
  "geometry": {"x": 0, "y": 0, "width": 1792, "height": 1120},
  "isolated": true,
  "foreground": true,
  "fixtureWindow": true,
  "proofEpoch": 4,
  "issuedAtMonoMs": 1000,
  "expiresAtMonoMs": 5000
}
```

要求：

- `desktopIdHash`、`displayIdentityHash`、`windowIdHash`、`captureTargetHash` 必须来自同一次 native observation。
- `isolated`、`foreground`、`fixtureWindow` 必须为 true；任何字段缺失或变更都 fail-closed。
- `proofEpoch` 在输入前、输入后和捕获绑定复核时必须一致。
- geometry 必须与 MSS/CGWindow capture target 相同；不能由 CLI 或浏览器自行声明。
- 证明只保留 hash、geometry、epoch 和时间，不保存窗口标题、屏幕截图、原始输入或坐标。

## 运行时证据

每个受控动作使用唯一的脱敏 `inputIdHash`、attempt、generation、scene、action 和 marker tick。必须同时存在：

1. Viewer 发送和 ACK status/时间；
2. Host 当前 lease/attempt 的 apply claim；
3. native input receipt，含 proofEpoch；
4. 捕获帧与 RTP/frame trace 的同一 scope；
5. Viewer rVFC marker 匹配，含 runNonce/scene/action/tick/layoutDigest。

任一阶段缺失、scope 不一致、proofEpoch 改变或 marker 不匹配，结果为 `UNALIGNED`/`NOT_RUN`，不能计算端到端可见延迟。rVFC 只证明视频帧呈现，不证明显示器光子时间；光学测量单独记录。

## 安全边界

- 不在共享用户桌面启用自动输入。
- 不把 `dedicated_desktop=true`、`fixture_window=true` 等 flags 当成 native proof。
- 不使用生产 Host 的 global HID 路径作为隔离证据。
- Lab Host 必须使用独立 Signal、独立 Viewer admission、独立 capture target 和独立输出目录。
- run 结束时销毁 fixture、撤销 lease、关闭 capture，并验证 proofEpoch 不再有效。

## 完成标准

隔离 Lab 具备：

- 一次原子 native probe；
- 输入前后 proofEpoch 复核；
- Host capture target 与 fixture window 同 identity；
- 至少一个 scroll、一个 drag、一个 text transaction 的完整关联；
- 每个动作都能通过 ACK、Host claim、native receipt、RTP/rVFC marker；
- 失败/竞态负例覆盖 stale proof、window change、capture target change、late ACK、wrong attempt 和 duplicate input；
- 生产共享 Host 的真实输入验收仍保持独立、可审计。

