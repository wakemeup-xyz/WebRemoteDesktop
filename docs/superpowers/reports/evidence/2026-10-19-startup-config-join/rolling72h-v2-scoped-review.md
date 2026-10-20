# 晚间72h报告 v2：单次修正定向复审

## Verdict

**Approved（原P2已修正；附一处不阻断归档的P3 schema说明）。** 本结论只覆盖v1的多行framing根因及其派生统计修正，不批准运行操作，不扩大为产品、R5或72h完整性验收。

## 原发现逐项状态

| 原发现/影响 | 状态 | 复核依据 |
|---|---|---|
| P2根因：Signal多行对象按ts物理行计数、去重 | **ADDR** | parser先以未缩进独立大括号构成完整Node inspect对象，提取顶层ts/event/level；判窗后以 `(representation, SHA256(raw complete record))` 去重。不是逐行JSON失败后丢弃上下文。3,706个窗口完整对象对应3,703唯一+3重复，与先前已核固定前缀一致。 |
| 影响1：断连latest漏掉23:24 R5清理 | **ADDR** | 精确事件与通用selector分列。116个socket disconnect及最新23:24:00.317、288个grace及最新23:24:00.319均恢复；通用disconnect 505/23:24:08.321不再冒充精确socket事件。 |
| 影响2：reset/failed-closed信息漏检 | **ADDR** | 精确事件统一从framed records派生：failed-closed255、retry123、blocked8、completed11，最后完成23:24:08.384。正文明确这些不是自动认定用户故障/超时，也不依靠通用reset词组代替event枚举。 |
| 影响3：transport close/ping timeout错误为0 | **ADDR** | 完整Node记录有限selector恢复41/64及对应latest；JSON、执行记录和正文一致，未升级为事故数。 |
| 影响4：unauthorized错误为0 | **ADDR** | Node表示恢复7条及10-17 03:31:17.082，其他表示的0有明确定义，未据词组推断Cloudflare/HTTP责任。 |
| 影响5：其余聚合需统一重派生 | **ADDR（派生统计）** | event/latest、每表示severity/daily、所有有限selector都从同一`records`集合计算；正文更新diagnostic、maintenance/version等结果，不手填review计数。残留legacy元数据标注见下方P3。 |

## 唯一保留项

**[P3 / NOT / 非阻断] 旧coverage/per-file物理行元数据需要明确标为legacy。**

位置：`/tmp/wrd-rolling72h-refresh-20261018-late-v2.json:582` 仍有 `timestampFreeLinesNotAttributed: true`，由 `/tmp/wrd-rolling72h-parser-v2.py:77` 直接继承v1 `coverageAssessment`；但v2已明确按完整对象归属没有独立时间戳的字段。JSON第84–86行等处的 `timestampedLines` / `unparsedLines` / `inWindowLines` 也通过parser第43行复制自v1，属于原物理行扫描统计，并非v2的record-framing结果。

这不影响新`framing`、`aggregates`、event、severity或daily结果；它们独立计算且一致，因此不阻断本次修正批准。归档说明应明确这些是v1物理行快照，并把coverage语义限定为“真正orphan/unknown片段不归属”，避免机器消费者误读为所有无独立时间戳行仍被排除。无需为此重新扫原日志或扩展产品修复范围。

## 静态方法和一致性核对

完整读取v2正文、JSON schema、parser及执行记录；首次工具输出截断的JSON部分另行读取，未以截断结果冒充完整检查。

- 原文件读取代码维持O_NOFOLLOW、regular-only、固定device/inode、size>=cap和固定prefix SHA校验；单轮60MiB、每文件64MiB检查在读取前执行。没有换用后续快照，原先missing条目继续明确缺失。
- framing中Node对象闭合前不会逐行emit；plain记录以已知leading timestamp开始，延续到下一个已知记录；完整JSON尾的inline表示独立分类。顶层ts与外层日志timestamp的选择明确。无法识别、缺权威时间戳和截断尾单独计入unknown；没有拿未知片段补故障或延迟数值。
- 同表示完整字节exact去重与跨表示不做逻辑事故合并的边界明确；plain与Node重复数分别66/3，而非保留v1的5,586行重复。
- 所有selector完整列于JSON，明确case-insensitive、每selector每record至多一次。正则与精确event计数分离；word-boundary限制会使health等数值不同于v1的泛子串扫描，报告已公开口径，不构成漏报成全局无故障。多个selector命中同条记录不可相加。
- 三表示唯一记录数15,442 / 48,505 / 3,703，分别与其severity总数和daily总数完全一致；unknown severity单列。执行log的framing、events、latest、lag及全部selected结果与最终JSON逐字段相等。
- Host lag仍为15,393完整inline事件、187个rolling超限与13个current超限，max7641.923；没有把重复窗口当独立卡顿或生成全程p95。此前定向原prefix验证的这些值继续成立。
- diagnostic通用selector与精确uploaded事件分开，entry_window内diagnostic字段可使词组latest晚于上传时间的限制写明；不把词组命中当实际保留成功。
- 固定lower/upper、约48h Host前段缺失、Signal缺失路径、未知格式/片段、probe/维护/用户归属限制均保留。0只表示有限selector在已解析表示未命中。
- R5保持FAILED / cleanup-incomplete、not-observed、qualificationPass=false及输入/可见/物理/recovery NOT_RUN。正文明确沿用既有R5独立产物而非本轮重新验证；没有调用此前三小时Approved来覆盖R5失败。

## 精确审查身份

- v2 JSON：19,743 bytes；SHA256 `1710c686df8e48813f1541dc5b75d20d0c9697035c493a862d5f3527b01d8aa4`。
- v2 Markdown：9,384 bytes；SHA256 `7592a5a0f04e090b7f112f8c419dc2b2f1e90bdc3e6dbb81e38ade16e8a68fa5`。
- parser：8,246 bytes；SHA256 `f5cf60da046d4a512a43a22e34c676c47f82de5ebe164259f6cb9b4d076c6cba`。
- execution log：6,978 bytes；SHA256 `2daa4b65b52024e967d79ac11d808d5d569cd62c71c8bd7f3a20cd1843bb9f11`。
- parser与execution log哈希与JSON provenance完全匹配。最终JSON另附execution-log hash/重定向命令属于执行后来源信息，不把它误认为parser在执行过程中已知的值。

## 本次范围

没有运行parser或重新读取原日志；使用完整静态代码/产物与前次已核固定前缀结果做定向复审。只用标准库读取、hash和结构一致性计算；未运行产品测试、运营模块导入、network/browser/native/process采样、service、source/index或仓库操作。仅写本文件。原日志本轮新增读取0 bytes；不消耗额外原日志重读预算。

**原P2可以关闭。** 可归档v2作为有覆盖限制的滚动日志复核，并保留上述P3元数据解释；不得由此宣称72h完整验收或R5成功。
