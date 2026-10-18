# 晚间72h滚动日志复核 v2（单次方法修正）

**v1的多行Signal分帧错误已修正；v1保留。** v2先识别完整记录，再按权威时间戳判窗，最后对同表示完整原始record bytes做SHA256 exact去重。所有severity、daily、diagnostic、maintenance/version、event、disconnect、reset、entry与latest统一重新派生，没有手工替换review数字。

固定范围CST **2026-10-15 23:47:01—2026-10-18 23:47:01**。仍不能证明完整72h覆盖，不能给出SLA或用户故障率。Host最早现存10-17 23:56:26.065，约48h前段缺失；Signal轮转.1/.2/.3缺失。文件跨度不证明连续采集，旧报告不能补缺口。

## 证据与方法

原v1固定device/inode/prefixCap/SHA256全部匹配；仅读取这些prefix，未偷换为后来快照。O_NOFOLLOW、regular-only，每文件不超64MiB；本修正轮读取51,801,426 bytes（小于60MiB）。作者前轮155,359,406 + 独立review72,904,863 + 本轮51,801,426 = **280,065,695 bytes**，小于此次授权combined上限402,653,184 bytes。后追加字节不读；前缀内晚于upper记录排除。

Node inspect以独立行未缩进{至独立行未缩进}闭合；嵌套字段缩进。取顶层两空格ts/event/level，非逐物理行json.loads。普通记录以行首可选[加timestamp开始，后续行归属于该记录直到下一个已知记录；完整JSON尾含event时分为timestamp-inline-json。Node用顶层ts，其余用外层leading timestamp；无时区日志按CST。截断尾或无权威时间戳对象保持unknown。

同表示exact完整record bytes去重，表示间不逻辑合并、不相加为事故。JSON附全部有限regex（case-insensitive完整记录re.search，每selector每record至多一次）、未覆盖类别和每表示聚合。多个selector可命中同条记录，不能相加。plain记录续行归属依赖已知日志格式，不是任意孤立行补时间。

最终窗口唯一记录按表示：{'timestamp-inline-json': 15442, 'timestamp-plain': 48505, 'node-inspect': 3703}；exact重复按表示：{'timestamp-plain': 66, 'node-inspect': 3}。Signal Node inspect唯一3,703条、重复3条；不是v1的逐时间戳物理行口径。未知片段统计：{'/tmp/signal-server.log:orphan-physical-lines': 3908, '/tmp/wrd-fixed-watch-launch.log:orphan-physical-lines': 1}，这些是孤立物理行数，不是事件数。

## 控制断连与重置事件（Node inspect表示）

| 精确event字段 | 完整记录数 | 最新CST |
|---|---:|---|
| signal_socket_disconnected | 116 | 2026-10-18T23:24:00.317000+08:00 |
| viewer_disconnect_grace_started | 288 | 2026-10-18T23:24:00.319000+08:00 |
| viewer_disconnect_grace_expired | 2 | 2026-10-18T23:24:08.321000+08:00 |
| control_transition_failed_closed | 255 | 2026-10-18T23:24:08.321000+08:00 |
| control_reset_retry | 123 | 2026-10-18T15:01:24.856000+08:00 |
| control_reset_blocked | 8 | 2026-10-17T13:24:59.086000+08:00 |
| control_reset_completed | 11 | 2026-10-18T23:24:08.384000+08:00 |
| signal_input_rejected | 14 | 2026-10-18T00:04:08.716000+08:00 |
| viewer_rebind_failed | 2 | 2026-10-17T03:00:06.584000+08:00 |

完整Node记录中transport close词组41条、最新23:24:00.317；ping timeout词组64条、最新10-18 00:04:08.169。它们是记录上下文词组，不是独立事故数。control_transition_failed_closed不是自动认定用户故障/超时；probe、维护、真实用户归属未知。

通用disconnect selector按表示：{"timestamp-inline-json": {"matchingRecords": 16, "latestCst": "2026-10-18T23:09:03.108000+08:00"}, "timestamp-plain": {"matchingRecords": 45, "latestCst": "2026-10-18T23:09:00.673000+08:00"}, "node-inspect": {"matchingRecords": 505, "latestCst": "2026-10-18T23:24:08.321000+08:00"}}。通用词组latest与精确socket-disconnect event latest含义不同，不能互替。v1的23:09不能继续描述为窗口最新Signal断连。

## Host lag ≥1秒

Host inline结构化完整记录15,393条；窗口max≥1s 187条，current≥1s 13条，最大current/window=7641.923ms。current最后10-18 02:48:48.872，窗口max最后03:29:31.434。重复窗口保留峰值，不能当187次独立卡顿，不重建全程p95或唯一GIL因果。Host覆盖仍仅约24h。

## 入口分层与诊断保留

入口相关有限selector按表示：

- unauthorized: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 0, "latestCst": null}, "node-inspect": {"matchingRecords": 7, "latestCst": "2026-10-17T03:31:17.082000+08:00"}}

- tunnelNotFound: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 0, "latestCst": null}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- error1033: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 0, "latestCst": null}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- badGateway502: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 0, "latestCst": null}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- connectionRefused: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 51, "latestCst": "2026-10-18T23:09:01.999000+08:00"}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- health: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 2, "latestCst": "2026-10-16T19:44:24+08:00"}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- origin: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 26, "latestCst": "2026-10-17T13:45:10+08:00"}, "node-inspect": {"matchingRecords": 1542, "latestCst": "2026-10-18T23:46:03.115000+08:00"}}

- dns: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 12, "latestCst": "2026-10-18T12:56:05+08:00"}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

- registeredTunnel: {"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 41, "latestCst": "2026-10-18T16:20:27+08:00"}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}

unauthorized在Node完整记录中7条，最新10-17 03:31:17.082；不能根据字面词归因Cloudflare、HTTP状态或网页故障。error/code 1033只匹配带前缀词组，任意数字字段不算入口错误。各层日志并非同一时刻实际连接验收；本轮没有现时探测。

diagnostic有限selector按表示：{"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 2781, "latestCst": "2026-10-18T23:24:04.167000+08:00"}, "node-inspect": {"matchingRecords": 1876, "latestCst": "2026-10-18T23:46:03.115000+08:00"}}。精确diagnostic_uploaded event=334，latest=2026-10-17T22:09:27.826000+08:00。selector含diagnostic的entry_window状态字段也可命中，所以词组latest不是最新上传时间。

诊断/tmp/wrd-diag inventory与保留验证仍NOT_RUN。记录上传事件不证明bundle长时持久保存/完整回收。无原始输入、坐标、身份ID、异常全文或密码写入输出。

## 版本和维护边界

maintenanceVersion有限selector按表示：{"timestamp-inline-json": {"matchingRecords": 0, "latestCst": null}, "timestamp-plain": {"matchingRecords": 19, "latestCst": "2026-10-18T19:23:25.462000+08:00"}, "node-inspect": {"matchingRecords": 0, "latestCst": null}}。只代表明确词组命中，未覆盖所有维护或版本表示，不能证明部署边界。severity与daily均由新记录framing重派生并在JSON按表示保存；unknown severity保持unknown。未核对运行配置、未执行服务维护、网络、browser、native、process采样或仓库改动。

## 实际R5单列

23:18—23:24 CST的实际R5（Viewer bb581651b422e400）13 startup + 301 passive baseline样本，仅被动媒体进展；**FAILED / cleanup-incomplete**，owned-process退出证据not-observed，qualificationPass=false。无native业务输入，inputAllowed不是实际操作；六输入指标null / NOT_RUN，visible effect/physical/recovery均NOT_RUN。R5数值继承本轮既有独立性能产物，v2未重读R5样本，不能宣称此次重新验证。滚动日志23:24的disconnect/grace/failed-closed/reset-completed属于记录事实，不将其抹掉，也不凭时间关联独断为用户故障。

## 可重现材料

Parser: /tmp/wrd-rolling72h-parser-v2.py；实际命令：`python3 /tmp/wrd-rolling72h-parser-v2.py > /tmp/wrd-rolling72h-parser-v2-execution.log`。脚本遇固定prefix身份/hash不符会拒绝。SHA256：parser=f5cf60da046d4a512a43a22e34c676c47f82de5ebe164259f6cb9b4d076c6cba；execution log=2daa4b65b52024e967d79ac11d808d5d569cd62c71c8bd7f3a20cd1843bb9f11；输入v1 JSON=857a699c99f8625765cca9e13e8a2729049f1d50f839974f20a2373c75b8a41f。每文件原prefix SHA/cap/identity见v2 JSON。

未覆盖：未知/截断/孤立片段、其他日志语法、其他命名事件、事件跨表示因果去重、用户/probe/维护归因、72h连续完整诊断保留。0仅表示已定义selector在已解析表示中未命中，不能作为系统事件扫描为零或全局无故障的声明。
