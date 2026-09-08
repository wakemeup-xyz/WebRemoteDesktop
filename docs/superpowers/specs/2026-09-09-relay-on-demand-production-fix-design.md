# Relay 按需 IDR 生产修复设计

日期：2026-09-09

## 问题和范围

当前生产默认 relay-legacy-v1 在 20fps relay 会话中每 20 帧主动发送 IDR。
受控文字画面和运行样本均显示该节奏约为 1Hz，造成周期性清晰度脉冲。此前
relay-balanced-v2 及 superfast 候选虽改善部分画质指标，但两档编码 P95
耗时均未通过门槛，因此不能把候选标为通过或部署。

本修复只移除生产 relay 的应用层 20 帧 IDR 节奏。它不调整分辨率、帧率、
码率、VBV、preset、采集节奏、网络模式或 Viewer 策略。

## 策略

新增版本化 relay-on-demand-v1，作为 WRD_RELAY_ENCODER_POLICY 的默认生产值。
对于 relay，它复用 legacy 的 libx264、ultrafast、Baseline、分辨率对应的
bitrate floor/target/cap、100ms VBV 和 target FPS。

它把 periodic_idr_frames 设为 0，因此 encoder 不再在每 20 帧调用应用层
强制 I 帧。已有的零 cadence 映射保留 keyint=1201 安全网；生产新策略启用
FFmpeg 的 forced-idr=1 AVOption，显式的 PLI、解码 stall 或 refresh 请求仍
在请求帧提交真实 IDR。direct 路径维持原有 VideoToolbox、40 帧 cadence 和
成本参数。

## 准入和回滚

生产 allowlist 只有 relay-on-demand-v1 和显式回滚 relay-legacy-v1。
relay-balanced-v2 和其 superfast 变体继续只能供 resolver/evaluator 实验，
Host 启动时 fail closed。回滚只需在 Host 环境设置
WRD_RELAY_ENCODER_POLICY=relay-legacy-v1 后按既有 Host 重启流程生效。

编码日志只在 policy cadence 实际 due 时把 IDR 标为 periodic。codec 首帧和
1201 帧 safety-net IDR 分别计为 initial 与 safety；它们不会被记录成旧 1Hz
脉冲，bytes.idrCount 仍完整。安全网仍可能产生单次 IDR 质量谷，本修复不
声称所有画面波动均被消除。

## 验收边界

自动化验证使用真实 PyAV/libx264 比较 240 帧 legacy 与 400 帧新策略：
legacy 保留 20 帧 IDR 序列；新策略没有该序列，带 causal token 的单次恢复
请求在请求帧产生 type-5 NAL，且从该帧单独起始的新 decoder 能连续解码。
另有 1226 帧新策略测试，确认 index 0 initial 与 index 1201 safety-net
IDR 及完整解码。该测试不模拟有限丢包，不证明 TURN、Viewer paint、正式
公网或物理设备表现；后者仍需独立真实 Viewer 验收。
