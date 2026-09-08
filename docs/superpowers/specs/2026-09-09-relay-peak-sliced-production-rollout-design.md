# Relay Peak Sliced 生产启用补充设计

日期：2026-09-09

离线 fresh-codec 矩阵已完成，冻结 artifact 为
docs/superpowers/reports/evidence/2026-09-09-on-demand/peak-headroom-bgra-sliced2-cadence-v2.raw.json，
由主线提交 791525e 归档，SHA-256 为
ccfb07aec93e1b45a78ee0120edb167e7542fe39d264993bdcdd1d92579607c2，
source execution revision 为 d825df7，状态为 OFFLINE_PASS_ONLY。
候选 on-demand-peak-headroom-sliced2-v1 的两档 1226 帧 prescreen 和五个
full 场景通过；720p 编码 P95 最大值为 14.24ms，小于 25ms，1080p 最大值为
25.237ms，小于 45ms。initial、recovery 与 safety IDR 的 PSNR 为 31--32。
这只构成离线准入，不能表示真实 TURN、Viewer、丢包或物理设备已经通过。

relay-peak-sliced-v1 成为默认生产策略。只有标准 20fps 720p intent
1280x720 或其验证的 16:10 编码尺寸 1152x720 固定为 3.2Mbps、4.8Mbps
VBV maxrate、1000kbit buffer；标准 20fps 1080p intent 1920x1080 或验证的
16:10 编码尺寸 1728x1080 固定为 5Mbps、7.2Mbps maxrate、1300kbit buffer。
两档均使用 libx264 superfast、Baseline、2 slice threads、VBV init 1、零
应用层周期 IDR、keyint 1201 safety-net 和 forced IDR 恢复。

其它 resolution（包括 900p）、其它 session FPS、或非标准 720p/1080p intent
没有此离线资格，resolver 必须实际返回 relay-on-demand-v1 的 ultrafast
单线程 policy，而不是标为 peak。direct 路径维持 VideoToolbox 和既有策略。
生产环境允许 peak 默认、on-demand 回滚和 legacy 回滚；balanced 继续拒绝。

用户已授权本地受控 rollout。合并和 Host 重启后，主线程必须在本机真实 TURN
验证连续出画、恢复和成本；失败即设置 on-demand 或 legacy 回滚。没有这一步
不得宣称公网、丢包或物理设备验收通过。
