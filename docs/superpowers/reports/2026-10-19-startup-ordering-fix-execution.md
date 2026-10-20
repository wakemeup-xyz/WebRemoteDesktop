# 2026-10-19 启动顺序缺陷与验收续查

本报告为00:38 CST源码复审检查点。服务保持运行，启动修正已完成task复审，最终增量复审待执行；尚未构建或部署，新长会话验收尚未开始。此前R5及工具实现记录分别保留，不用离线通过覆盖实际失败。

## 新确认的连接问题

真实Viewer方法离线复现并获独立review确认P2：普通认证页面并行拉取配置与连接Signal。配置较慢、控制grant较快时，grant提前创建PC1并发offer；随后init应用配置却把PC1替换成未发offer的PC2，现有正确的stale-answer guard拒绝其后到达的answer。配置先完成的对照仅1个peer/offer且能应用合成answer。

这证明了当前源码的条件顺序缺陷，可能延迟/阻断初次媒体建立直到后续恢复介入。未执行真实Server/Host/ICE/视频/原生输入；定时器不运行，不能断言永久卡死、频率或真实恢复结局。本轮R5配置早于Signal连接，因此该复现不能解释R5失败。首个私有DOM夹具错误另存，不算产品RED；最终characterization exit0代表成功断言旧缺陷，不能当修复PASS。

修正选择在配置完成和有效grant两个既有点汇合，保留并行启动。配置前禁止非tunnel peer/offer，两个先后顺序都只产生匹配当前配置/身份的初始offer；不合成grant，不跳过实际Input.setControlLease拒绝/恢复分支，不改answer guard。保持后续合法重协商、8/72/12秒预算、租约/reset/网络/质量/tunnel语义。设计与计划见2026-10-19-startup-config-grant-ordering-*。

## 源码、运行与验证范围

当前实际Viewer仍c802a68362459b46b84593c7e8921575e0783394/buildbb581651b422e400。Signal33747和Host36877仍加载backenddfb15434e79da90b803b763c533836e16c080c71。00:06本地helper观察健康且Host在线；这不是新的公网/输入验收。没有停止、重启或重建tunnel/watch，quickURL保持缺失，正式入口不变。

前述移动可靠通道隔离兜底已实际交付。验收工具的preclose admission-detach及首错优先级修正2822441获独立最终复审Approved（针对性8、相关166新代码一次通过），但尚未复制到primary工具。a68只归档文档，未作为新Viewer运行。拟tool-only包遇到新P2后停止：未seal、无manifest/执行票据/nonce/promotion，保留12项purePASS记录；未进行任何新实际验收。

当前客户端修正fefc555已完成task：有效RED为ready对照通过、delayed配置失败；针对性7/7通过，受影响首次559/561因旧Input mocks未记录acceptedlease，修正夹具后561/561通过（39.337秒）。新正向用例实际加载Input，负向驱动真实invalid-input ACK产生reacquire-required，未伪造输入门禁或画面。独立task spec及quality review Approved；没有部署或实际运行通过结论。最终增量review后需全新源码/资源/context，实际Signal-only构建重载时保留Host与tunnel，再从零进行基线、grace内外恢复及三小时连续性。旧三个实际失败保持原样。

## 最新三天日志复查（修正版本）

固定窗口为2026-10-15 23:47:01≤t<2026-10-18 23:47:01 CST。晚间v1错误把Signal多行对象拆成时间戳物理行，已作无效草稿保留；v2重新从相同device/inode/cap/SHA前缀按完整记录分帧，统一派生所有统计，独立定向review Approved。

Signal Node表示3703个完整唯一对象（3个exact重复）；socket disconnect116条，最新23:24:00.317；grace-start288条；failed-closed255、reset retry123、blocked8、completed11，最后完成23:24:08.384。它们是混合版本、probe、维护和未知归属的记录，不是用户故障数。unauthorized7只为有限关键词命中，不推断Cloudflare/HTTP责任。

Host约最后24小时原始保留；此前约48小时缺失。15393个结构化lag窗口中direct≥1秒13条、rolling max≥1秒187条，最大7641.923ms；滚动峰值不可算作187个独立卡顿，也不能重建全程P95。无完整72h覆盖或用户SLA结论。

v2 JSON保留v1 per-file物理行快照与timestampFreeLinesNotAttributed旧字段，独立review列为非阻断P3。必须读归档解释：这些legacy字段不是v2完整record人口；已闭合对象内字段正确继承该对象时间戳，只有真正orphan/unknown/truncated片段不归属。新framing/aggregates/event/latest不受此残留影响。总原日志读取280065695 bytes，显式384MiB上限内；review未再读原日志。

## 性能与后续取证

R5单次标记start→signal4577.8ms、标记start→frame7880.8ms并非真实click或P95：start-click在Auth.whenReady之后，bootstrap-start在admission之前，910ms混入admission/缓存等，不能叫bootstrap HTTP耗时。现有bootstrap与signaling已经并行，不能把已有并行写成新优化。配置ready→signal3667.3ms也不能归为纯socket传输。独立启动critical-path报告列出有限同钟边界埋点，当前未新增或运行这些埋点。

最新被动R5画面约19.39Hz，fresh capture约6.03–7.66Hz、输出复用68.46%，主要测得pacing等待超额，尚不能唯一归因GIL/内核/QoS。原生输入采集器v3 spec/plan已versioned并通过草稿/离线接线范围复审，尚未实现或部署；独立桌面资源仍未提供，已有问题保持待答不重复询问。

六项输入耗时均null/NOT_RUN，原生/真实可见/物理显示未验收。控制门禁开放、callback推进、RTT、旧三小时被动PASS或当前离线测试都不能替代它们。新实际运行不足时继续保留NOT_RUN，而不宣布所有问题已解决。

归档review、方法、受限统计和原件SHA见evidence/2026-10-19-startup-config-join/evidence-index.json。

00:27额外HTTP观察：首次环境默认路径连接阶段3秒截止超时（curl28），随后分开的direct/default请求HTTP200，用时2.292/2.957秒，本地origin200用时0.018秒。原失败保留，不被后来的成功替换。默认路径CONNECT200且TLS累计值包含CONNECT，未定位唯一代理/网络/Cloudflare原因；HTTP200不能替代认证、资源、Host、媒体或输入验收。未来源码仅发布4个已有文件，新增文档保留在版本化sourceworktree，primary knownregular1016不增路径。
