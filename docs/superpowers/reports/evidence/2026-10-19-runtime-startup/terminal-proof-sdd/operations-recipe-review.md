# R5 root 操作配方独立审查 — 2026-10-19

**Verdict: Needs fixes（一个文档级 Important/P2；不重开代码 final review）。**

审查对象：`/tmp/wrd-r5-root-operation-recipe-20261019.md` 与仓库 `docs/superpowers/plans/2026-10-19-r5-real-qualification-operations.md`。两个实际文件 SHA256 均为 `d8b065b79145d5832b20e7b2712aabc3009e005918e6bef04d42f151b630b48d`。代码维持已审 `55ceb32` 的事实由 root 提供；本轮没有执行 Git 或重读全分支 diff。

## Finding

**[P2] prepare-attempt 失败并不一律意味着 baseline reservation 已消费。**

位置：`docs/superpowers/plans/2026-10-19-r5-real-qualification-operations.md:210`（同 bytes `/tmp/wrd-r5-root-operation-recipe-20261019.md:210`）。

配方称“先 reserve_attempt，之后才进行真实门禁/HTTP/source 检查。即使失败也已消费 … reservation”。实际原 `prepare-attempt.py` 的 main 先执行 `sequence(...)` 和 `decision_and_predecessor(...)`，再执行 `reserve_attempt(...)`，最后才进入 try 中的 deployed_gate/origin/source 检查。原 sequence 又调用 ready_context 与 integration；ready_context 包含真实 asset_context/source/历史验证。因此前置校验可以在 reservation 尚不存在、也未产生 preparation-result 时失败。reserve_attempt 本身也可能部分完成后失败，不能单凭 CLI 非零断言消费状态。

影响：操作配方可能把前置失败错误记录为已消费，并错误描述失败到达阶段；这与末节要求记录真实 one-use 状态冲突。

修正：区分三阶段：① sequence/decision 前置校验失败，尚未调用 reserve_attempt；② reserve_attempt 中途失败，按真实目录/marker 状态报告；③ reserve_attempt 成功返回后的失败，已消费 reservation，保留原失败产物。所有情况均不自动重试、删除或覆盖；是否消费只以实际 marker/到达阶段为证据，不能由非零退出码推断。

Critical: None。其他 Important: None。Minor: None；无 parked/deferred finding。

## 已核对的有效部分

- 原 `prepare-frontend-sequence.py` 与 deployment.args_parser 的 CLI flags、sequence decision 精确 schema、部署四字段、readiness/offline refs，以及输出 sequenceDirectory/sequenceSHA256 均与配方一致。原 prepare-attempt flags、decision schema、固定 relay/origin、F3 legacy priorFailure 与 baseline previousResult=null 一致；F4 正确保留在 R5 层。
- 实际 b630 offline envelope、其 independentReview 与 result 已只读核对。原审查明确相同 source/component/build ID 的原 R3B checker 证据可复用为 offline-only，并要求保持原 provenance。原 integration 消费的是 source/tool/build/component/checker/review/result，配方未将本轮 R5 code review 替换成旧收据、未声称新 checker 执行。现存 b630 与 independentReview 的实际 SHA 分别匹配 b63020856af50db03d7a16b2ff732d07491f7d2a6952158b79d41ea3b1b94b2c、e055f48a0821ba07562fae66f5dd236ed46d50cc278a37eb44c4136b200325d5。资产审查 ref 指向同一独立审查和 frozen/template/build-result；这是静态适用性核对，不代替当前 real gate。
- S.toolSequence、T.thirdSequence/thirdRuntimeManifest 等名称确实存在于实际 pinned history records；first variant 未补造 sequence/attempt。R5 seal closure、全部 manifest mode/SHA、exact34 union/provenance 的派生方式与已审接口契约一致；raw ref SHA 与 canonical object digest 分开说明。
- 第39–45行要求最终完整 HEAD 与两 production 文件 bytes/Git blob 一致；须结合 root 已明确的“归档本审查→最终 docs-only commit→冻结 HEAD 与两文件直到序列结束”操作约束执行，不在运行中提交证据导致 HEAD 漂移。该后续冻结尚未执行，也不由本审查补签。
- 原 check_runtime_binding 确实要求 admission 创建不超过900000ms、剩余至少 budget+120秒；preparer 初始 validity 是21600000ms。配方先静态准备、最后签 issued、把 expensive checks 纳入双钟60秒，check-only 后独立新 run root/新 decision、复用仍未消费的新 legacy attempt 的顺序符合现有设计。
- check-only 的无 marker/result/proof/worker 与真实只读 FS/Git/process/network 成本区分正确；成功后仅单次 baseline，不自动推进后续场景。原 Host/tunnel/质量/时限/旧sequence/rawFAIL 保留，历史 offline/readiness/新代码审查都没有被当作 runtime qualification。

## 范围与实际动作

只读该配方、原两 preparer、相关 continuation_common/deployment 定义、直接相关 history/ref JSON 与现存 asset review；使用文件内容哈希核对上述绑定。未导入或执行受审/操作代码，未运行任何 prepare/check-only/qualification、测试、Git、进程/网络/浏览器/服务/Host/sample 命令，未创建 ID/nonce/decision/receipt，未派生 agent 或修改源文件。仅写本0600审查记录。shasum 有环境 locale warning，仍正常返回完整哈希；不是测试或运行结果。

**Actual old successful gate chain 仍为 NOT_CLOSED。** 修正文档后仍必须由 root 执行真正只读 check-only；本审查不是运行授权、通过收据、当前可用性或 qualification 证据。

Root 收束确认：最终 HEAD 和两 production 文件 bytes 必须从 check-only 起，经过 fresh run，保持到完整四场景序列 closure；期间不做任何 commit（包括 docs-only），runtime evidence 先私有保存，闭序列后再归档。该约束已在 ledger ruling 和 code final-review recommendation 中；root 将在本次最小操作计划修订中显式补入。以上没有新增 code finding，也不改变本审查唯一 P2 的文档修复范围。原 /tmp 配方保留原件，只修仓库操作计划；修复后可按最小文档 diff 复核，无需扩大代码或现场检查。
