# 最近72小时滚动日志独立复核（晚间刷新）

固定范围 CST **2026-10-15 23:47:01—2026-10-18 23:47:01**（UTC 2026-10-15 15:47:01—2026-10-18 15:47:01）。upper 为本次首个 clock 返回值。本报告重新计算，未复用17:14截止旧报告计数。

结论：无法证明完整72h覆盖，不能给出用户故障率或SLA。Host轮转现存最早仅到10-17 23:56:26，之前约48h缺口；Signal轮转.1/.2/.3均缺失，大量无时间戳续行未归属窗口。min/max跨度不表示连续覆盖。服务重载/覆盖/轮转缺口不能由旧报告补齐。

## 读取与完整性

仅指定11个路径；O_NOFOLLOW，fstat regular-only，64MiB/file，256MiB累计上限。三轮有界前缀分析总读 155,359,406 bytes，未超限；最后一轮51,801,426 bytes。每轮读取当时固定cap，附JSON记录最后一轮device/inode/size/cap/SHA256。末行不完整则排除；晚于upper的记录排除。文件未落盘原文，内存解析后仅输出白名单聚合；没有config/credentials读取、进程/网络/服务/浏览器/native操作或仓库改动。

去除exact full-record重复 5586 条，剩余窗口内带时间戳记录 66769 条。不同plain/structured表示不自动认作独立事件；以下均为记录或关键词提及数，不相加为故障数。

| 文件 | 状态 | 实际读取bytes | 读取前缀内时间跨度 CST |
|---|---|---:|---|
| /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log | read | 7039495 | 2026-10-18T19:40:49.521000+08:00 — 2026-10-18T23:48:57.498000+08:00 |
| /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.1 | read | 10484296 | 2026-10-18T12:59:07.806000+08:00 — 2026-10-18T19:40:43.521000+08:00 |
| /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.2 | read | 10485058 | 2026-10-18T06:17:52.371000+08:00 — 2026-10-18T12:59:02.806000+08:00 |
| /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.3 | read | 10485726 | 2026-10-17T23:56:26.065000+08:00 — 2026-10-18T06:17:52.248000+08:00 |
| /tmp/signal-server.log | read | 3539237 | 2026-10-03T11:57:16.202000+08:00 — 2026-10-18T23:48:03.139000+08:00 |
| /tmp/signal-server.log.1 | missing | 0 | 缺失 — 缺失 |
| /tmp/signal-server.log.2 | missing | 0 | 缺失 — 缺失 |
| /tmp/signal-server.log.3 | missing | 0 | 缺失 — 缺失 |
| /tmp/wrd-fixed-domain.log | read | 549007 | 2026-10-02T20:15:23+08:00 — 2026-10-18T19:44:29+08:00 |
| /tmp/wrd-fixed-watch.log | read | 1933362 | 2026-10-01T15:48:19+08:00 — 2026-10-18T23:48:20+08:00 |
| /tmp/wrd-fixed-watch-launch.log | read | 7285245 | 2026-10-01T15:48:19+08:00 — 2026-10-18T23:48:20+08:00 |

## 控制断连与重置阻塞

断连关键词61条，latest=10-18 23:09:03.108；23:09:00.673出现Signal断连/cleanup同一时间相邻表示，23:09:03.107–.108出现Viewer cleanup和reset相关表示。仅凭这些记录无法区分probe、维护重载和真实用户异常；不能认定61次用户故障。

reset提及20条，但明确 reset timeout / reset failed / reset rejected / blocked 关键词均为0；本报告定义的reset-block词组也0。pending泛词15,408条主要可能来自结构化状态字段，不能解释为阻塞。时间戳外续行与保留缺口存在，因此0不是无阻塞证明。

## Host lag ≥1秒

结构化采样窗口 15393 条；maxLagMs≥1000ms窗口187条，current lag≥1000ms记录13条；最大当前/窗口值7641.923ms。current lag≥1s最后10-18 02:48:48.872；保留窗口max≥1s最后03:29:31.434。重复窗口持有同一峰值，不是187个独立卡顿，也不能从窗口p95恢复全程p95。

Host结构化覆盖10-17 23:56:26.065—10-18 23:46:55.518，仅约24h。该后段未出现≥1s样本不等于72h无故障；采样缺口仍存在。

## 入口分层

明确 unauthorized / tunnel not found / error 1033 / code 1033 / 502 bad gateway 词组为0；数字1033不能在任意JSON数值中匹配为入口错误。connection refused提及51条、health3828条、origin3967条、DNS12条、registered tunnel connection41条；这些是层次线索，不能证明同一时刻的Viewer入口/Signal健康/Host在线/实际媒体或交互全部可用。未运行任何现时探测，不能将历史成功记录描述为当前连接验收。

Watch/launch可有镜像记录；仅全行相同才去重，plain与structured或镜像不同格式绝不相加成同一故障的多个事件。

## 诊断保留与版本维护边界

diagnostic提及2781条，最后10-18 23:24:04.167，只说明日志中出现诊断相关记录，不证明上传bundle持久保存、完整回收或72h诊断覆盖。/tmp/wrd-diag inventory本次NOT_RUN；诊断保留验证NOT_RUN。无时间戳续行一律不跨时间推定。

维护/版本关键词14条，latest=10-18 19:23:25.462；关键窗口包含19:23 Signal断连/cleanup。旧混合probe+用户日志不能映射为单一版本的故障率；未读取运行配置或核对部署，未执行维护授权范围内外的任何操作。

## 实际R5单列（23:18—23:24 CST）

实际R5 Viewer bb581651b422e400，13 startup + 301 passive-baseline样本，共314；被动媒体持续进展不等于验收PASS。实际结论 **FAILED / cleanup-incomplete**，ownedProcessExitEvidence=not-observed。business native inputs、visible effect、physical display与recovery均NOT_RUN；六项输入指标保持null / NOT_RUN。inputAllowed仅为准备状态。

该R5约300秒的被动媒体表现：回调约19.39Hz、fresh capture滚动约6.03–7.66Hz、输出reuse约68.46%。源像素age、真实可见效果、三小时持续与故障恢复未验证。Host与Viewer源版本不同，不能将滚动窗口归结为该Viewer构建。详见/tmp/wrd-r5-baseline-performance-assessment-20261018.md。

JSON附完整哈希/cap、范围、缺失、白名单关键词分层和最近窗口标量；没有原始输入、坐标、身份ID、异常全文或密码。
