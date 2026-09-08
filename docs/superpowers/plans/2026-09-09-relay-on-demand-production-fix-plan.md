# Relay 按需 IDR 生产修复实施计划

日期：2026-09-09

1. 在 h264_encoder_policy.py 新增 relay-on-demand-v1，作为默认生产 policy；
   只允许它和 relay-legacy-v1 通过 Host 环境 gate。
2. 新策略复用 legacy relay 的 codec、FPS、bitrate、VBV 和 preset，仅设置
   periodic_idr_frames=0 与 force_idr_option=True；direct 不改。
3. 覆盖 resolver、默认环境、legacy 显式回滚、balanced 拒绝、zero cadence、
   policy cadence 日志归因和真实 PyAV 编码/解码。
4. 串行执行短本机 encoder 健康测试，避免和单独的成本 probe 重叠；记录
   自动化结果，但不把它升级为 TURN/Viewer PASS。
5. 合并后由主线程按既有本地 Host 重启流程部署。真实 Viewer 需确认无约
   1Hz 清晰度脉冲、正常恢复、无成本回归。
