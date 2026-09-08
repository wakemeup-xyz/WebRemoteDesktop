# Relay Peak Sliced 生产启用计划

日期：2026-09-09

1. 版本化 resolver 将已测 720p/1080p relay 映射为精确 offline 参数。
2. 默认和生产 allowlist 启用 peak；保留 on-demand、legacy 回滚，拒绝 balanced。
3. 以真实 PyAV codec creation record 验证两档 submitted options 与固定 bitrate。
4. 合并后由主线程执行用户授权的本机 Host restart 与真实 TURN 验收；若失败，
   选择 on-demand 或 legacy 回滚。此分支不重启服务、不执行公网或物理设备声明。
