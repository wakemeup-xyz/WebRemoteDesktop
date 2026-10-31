# 隔离 Lab 真实输入验收执行计划

日期：2026-10-31

## 阶段 1：隔离环境

- [ ] 准备独立 macOS 测试用户或独立 WindowServer 会话。
- [ ] 创建仅包含合成 marker 页面和 Lab Host 的专用 desktop/display。
- [ ] 固定 Lab Signal/Viewer/Host origin，禁止连接生产 tunnel。
- [ ] 验证 fixture 消失、窗口切换和 display 变化会使 proof 失效。

## 阶段 2：NativeFixtureProbe

- [ ] 在 Lab-only adapter 中实现一次原子采样：desktop、display、window、capture target、geometry、foreground、proofEpoch。
- [ ] 将 MSS/CGWindow capture target 与 probe 的 display/window identity 绑定。
- [ ] 在输入前、输入后、capture start 和 capture completion 复核 proofEpoch。
- [ ] 将所有原始 native 标识转换为固定长度 hash；不写标题、像素、原始坐标或输入正文。

## 阶段 3：输入和帧关联

- [ ] 为 Viewer inputId、attempt、generation、scene、action、tick 建立 bounded correlation。
- [ ] 记录 ACK、Host apply claim、native receipt、capture/encode/RTP/frame trace 和 rVFC marker。
- [ ] 对 scroll、drag、text 明确事务边界；多事件动作不能按时间猜配。
- [ ] 缺失或错配阶段输出 `UNALIGNED`/`NOT_RUN`，不输出伪造延迟。

## 阶段 4：负例和资源

- [ ] 覆盖 proofEpoch 变化、窗口切换、capture target 变化、旧 attempt、迟到 ACK、重复输入。
- [ ] 验证 Lab capture p95/max、RSS、CPU、FPS、丢帧和编码/传输阶段。
- [ ] 验证 run cleanup 会释放 lease、关闭 capture、删除临时 evidence。
- [ ] 对生产 Host 运行一次 guard 负例，确认所有自动输入仍被拒绝。

## 阶段 5：验收和合入

- [ ] 使用 root-attested Lab manifest，记录源码、build、origin、desktop/display/capture hash。
- [ ] 完成至少一组真实 input→visible marker 样本，并独立记录 rVFC 与 optical limitation。
- [ ] 由 reviewer 逐项检查证据链和缺测语义。
- [ ] 将 Lab-only 代码与生产路径隔离，运行全量测试后再合入 main。
- [ ] 生产 Signal/Host 保持在线；不得用 Lab 验收重启或重建生产 tunnel。

