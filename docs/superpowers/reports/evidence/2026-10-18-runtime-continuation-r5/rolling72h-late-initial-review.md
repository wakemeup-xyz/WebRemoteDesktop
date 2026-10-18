# 晚间滚动72小时报告：独立只读复核

## 结论与发现

**ChangesRequested。** 有一项重要统计方法错误，影响多个章节；修正前不应把这组结果作为完成的72小时系统复核记录。以下结论来自本次固定前缀重新读取，不沿用此前三小时长会话review的批准结论。

### [P2] 多行Signal记录被拆成时间戳物理行，整记录去重和关键词结果因此失真

位置：`/tmp/wrd-rolling72h-refresh-20261018-late.md:11`，以及第29、31、41、43、47行；JSON的 `exactDuplicateRecordsExcluded`、`uniqueTimestampedWindowRecords`、`structuredEventRecordCounts`、`disconnectTaxonomy`、`resetTaxonomy`、`entryLayerTaxonomy` 及其latest/聚合字段。

报告称去掉5,586个“exact full-record”重复后剩66,769条记录，但我按物理行寻找时间戳并对该物理行去重，恰好复现66,769。Signal窗口内8,342个带时间戳物理行中，有3,706行只是多行对象的 `ts` 字段。时间戳行本身没有该事件的event、reason、meta等上下文；将其单独去重，还会把同一毫秒内不同事件的同一ts行折叠。报告把129,430个Signal无时间戳物理行一律排除，丢掉了可由完整对象边界可靠归属的字段，不能全部视为不可归属的孤立续行。

同一已记录Signal前缀内，我按顶层对象起止边界保留整块，限定其ts落入固定窗口，再以整块字节内容去重：得到3,706个完整多行对象、3,703个唯一对象，仅3个整块重复。这是Signal多行表示的子集，不是替代报告的全来源总数，也不能与plain表示相加成事故数。它已经足以证明“full-record”口径不成立。

必须一并修正的实质影响：

1. **断连latest错误且漏掉R5清理。** 完整对象中 `signal_socket_disconnected` 为116条，最新 **2026-10-18 23:24:00.317 CST**；`viewer_disconnect_grace_started` 为288条，最新23:24:00.319。报告断连61条、latest23:09:03.108只覆盖其受限逐行selector，不能表述成该来源窗口的最新断连记录。
2. **重置/控制转换信息漏检。** 完整对象中 `control_transition_failed_closed` 为255条、最新23:24:08.321；`control_reset_retry` 为123条、最新15:01:24.856；`control_reset_completed` 为11条、最新23:24:08.384。不能用“reset提及20、reset-block词组0”替代这些明确类型的控制日志。这里的failed-closed本身也不能自动当成真实用户故障或超时，应保留事件类型、结果及probe/维护归属未知。
3. **断连原因taxonomy的0是解析缺失，不是整记录扫描结果。** 唯一完整多行块中有41条包含字面词组 `transport close`、64条包含 `ping timeout`；JSON相应计数均0。需要完整对象上下文重新匹配，区分记录、重复表示和事件，不能直接将这些数字改名为事故次数。
4. **入口unauthorized零值错误。** 同一完整块子集中7条含字面 `unauthorized`；正文第41行及JSON写0。应在完整上下文中重新判定其认证/入口层级，不能仅因这个词出现就归因Cloudflare、HTTP状态或历史网页故障。本复核只确认其不是完整记录扫描的0。
5. **其他受同一parser影响的标量也需同步。** severity、daily、diagnostic、maintenance/version、structured event计数以及latest字段，应由修正后的统一record framing重新派生。不能只手工替换上述被抓到的几个数字，而保留其余物理行计数并继续标为full-record。

修复建议：按已知日志格式先分帧为完整记录，再从该记录的权威时间戳判窗和做完整记录去重。Signal Node inspect形式的多行对象不是JSON；不要用逐行json.loads失败后只保留ts行的办法。完整对象内的字段继承该对象的时间戳是结构归属，不是对无关续行猜时间。真正孤立、截断、无法可靠闭合的片段单独计数并保持unknown。对plain/structured镜像保留来源和表示类别，仅做明确的同表示exact记录去重；不要无依据逻辑合并。记录完整的有限selector（字段、词组/regex、大小写和边界）及未覆盖类别，再更新报告与JSON所有依赖统计。

这是一个方法根因及其完整可行动影响清单，不应拆成互相重复的多个修复。

## 已核对成立的部分

- 固定lower/upper确为CST 2026-10-15 23:47:01至10-18 23:47:01，相差72小时；报告明确Host保留仅约24小时、早段约48小时缺失，没有把当前Host片段当成完整72h，也没有用跨度宣称连续覆盖。
- 对JSON中标记read的全部8个原路径读取记录的固定prefixCap，逐一验证device/inode和SHA-256，全部匹配；只使用固定前缀，不纳入随后追加的内容。报告表格可以展示前缀内晚于upper的实际时间范围，但窗口统计必须继续排除它们。
- 逐行扫描独立复现各文件窗口带时间戳行数和最终66,769，证实这些数字有当前前缀计算依据，不是明显从旧报告照搬；但也同时暴露其物理行而非整记录的统计单位。无法仅凭最终产物证明作者此前两次读取的过程，作者三轮累计读取声明仍属其执行记录。
- Host inline结构化lag事件总数 **15,393** 独立匹配。对包含全部超限样本的 `.3` 前缀完整事件复核：**rolling max≥1000ms为187条，direct/current lag≥1000ms为13条，二者最大值均7641.923ms**。没有把187个重叠窗口当187次独立卡顿。嵌入事件ts与human日志外层时间戳略有毫秒差，报告使用外层时间戳的末次02:48:48.872 / 03:29:31.434与该边界一致，不构成新的计数缺陷。
- 未发现把任意JSON数值1033当成入口错误的证据；正文明确禁止这种误匹配。修订时仍须保留短语或结构字段约束。
- 诊断inventory及保留验证NOT_RUN、缺测不填零延迟、不提供SLA或用户故障率、probe/维护/用户归属未知等限制方向正确。但这些限制不能补救已有可恢复完整Signal记录被parser丢弃的问题。
- R5单列明确 **FAILED / cleanup-incomplete**、ownedProcessExitEvidence=not-observed、qualificationPass=false，未把媒体进展写成PASS；native/visible/physical/recovery保持NOT_RUN。这与本次任务提供的R5实际结果一致。本复核没有重新打开R5私有原始证据，不能据此声称独立重算了其314样本或性能数值。
- 本报告没有唯一归因当前故障到某个Viewer/Host版本或边缘服务，亦没有借新证据改写旧失败。

## 输入身份与复核方法

- 输入Markdown：5,924 bytes，SHA-256 `8662bb045148412404d468dabadfc5a47c98e90aaf2048c42a4889b1d1459c19`。
- 输入JSON：16,126 bytes，SHA-256 `857a699c99f8625765cca9e13e8a2729049f1d50f839974f20a2373c75b8a41f`。
- 原路径限于报告列出的白名单；每次用 `O_NOFOLLOW`、`fstat` regular-file和记录的device/inode/cap检查，前缀读满后核验记录SHA。未读取超过记录cap的原日志字节。
- 本复核原日志累计读取 **72,904,863 bytes**，包括一次终止的低效解析尝试所读前缀以及重读；另外少于100KiB为上述报告/JSON重复读取。每文件单次小于64MiB，本复核小于256MiB；即使加上作者声明155,359,406 bytes也仍低于256MiB。只输出白名单类别、计数与时间，不输出原始日志、身份ID、输入、坐标、异常全文或凭据。
- 只用标准库解析/hash；没有网络、浏览器、进程采样、服务、native、配置、仓库/source/index操作、产品测试或运营模块导入。只写本文件。一次低效JSON解析的自身分析命令被终止后，改为有界已知对象分帧；未影响或操作产品进程。

## 交付门槛

作者应修正多行记录framing、完整记录去重与有限selector，重新生成同一固定lower/upper范围的报告/JSON，并提供新输入hash及所有受影响聚合。保持Host覆盖缺口、R5失败及NOT_RUN边界。若原prefix不再可读或哈希变化，明确无法复核，不能猜补或沿用未验证数字。修订后应定向复审以上根因及派生结论。
