# 控制恢复与采集长尾修复计划

日期：2026-10-20

## 阶段 0：基线和保护

- [x] 固定最近两天日志窗口、当前 Signal/Host PID、Viewer 占用和当前构建 ID。
- [x] 保留用户会话；不启动任何真实 Viewer/输入场景。
- [x] 为每次离线运行保存代码 SHA、测试命令、结果和失败原始证据。

## 阶段 1：恢复时钟对齐

- [x] 在 Signal Server 增加受控的 `viewerDisconnectGraceMs` 配置，默认 30000 ms，严格限制上限。
- [x] 将 Viewer `SIGNAL_RECOVERY_MAX_WAIT_MS` 调整为 24000 ms，并在同一处定义配置来源。
- [x] 增加测试：断线、恢复、宽限到期、同会话 resume、不同会话拒绝、Host 离线。
- [x] 检查所有 reset/rebind 回调都比较 viewer session、connectionAttemptSequence 和 leaseEpoch。

## 阶段 2：重绑定 ACK 重试

- [x] 把 `viewer-session-rebind` 改为有界重试，时间预算不超过 24 秒。
- [x] 每次重试只发送同一 operation 的不可变字段，不重用已结束 operation。
- [x] 为成功、拒绝、超时、旧回调和 Host 替换分别增加测试和诊断事件。
- [x] 保持 fail-closed：预算耗尽后释放租约并要求新的显式控制获取。

## 阶段 3：采集长尾整改

- [x] 先在离线 fixture 中增加 grab/convert/encode/queue wait 的长尾模型。
- [x] 增加 active capture 预算告警、profile 降级和 latest-frame 丢弃计数。
- [x] 验证 page-hidden → pageshow 的 sender、capture、keyframe、input gate 顺序。
- [ ] 只有离线数据证明收益后，才实现抓帧与编码的双阶段 bounded worker。
- [ ] 对 RSS、CPU、实际 FPS、capture p95 和 max 做独立验收。

## 阶段 4：端到端诊断补齐

- [x] 为输入和帧建立有界、脱敏的阶段关联。
- [x] 失败时保留最小事件环，不写原始输入或坐标。
- [~] 让 `logCount`、summary gap、ring drop 和各阶段缺测成为明确指标；生产日志补采仍需维护窗口。
- [x] 增加输入到 frame/paint/visible effect 的独立统计，不用 ACK RTT 替代。

## 阶段 5：离线回归和独立复核

- [x] 运行 Signal lease/rebind、Viewer recovery、Host capture 和 observability 既有回归。
- [x] 新增负例先经过失败/修复/通过闭环，离线结果写入执行记录。
- [x] 做一次独立静态 review，确认旧 Socket、旧 Host、旧 leaseEpoch 都不能写入。
- [x] 不把离线通过写成公网或长会话验收。

## 阶段 6：维护窗口上线和验收

- [x] 仅在用户明确释放当前会话后构建、加载和重启本地 Signal/Host。
- [x] tunnel 不重建；公网地址保持现有事实来源。
- [~] 本地健康、Host 在线和正式入口 health 已验证；首帧与控制 ACK 仍待真实 Viewer 会话。
- [ ] 做短断线恢复、30 分钟控制投屏和输入到可见效果验收。
- [ ] 任何失败保留服务可用态并记录，不通过强制宣称完成。

## 完成标准

- 断线恢复时钟不再出现“客户端还在恢复、服务端已释放租约”的窗口；
- Host 重绑定在有界重试内完成或明确 fail-closed；
- 活动捕获 p95 接近一个帧周期，长尾有降级和告警；
- 输入到可见效果有有效数据；
- 本地、公网、控制、投屏和长会话结果分开记录。

