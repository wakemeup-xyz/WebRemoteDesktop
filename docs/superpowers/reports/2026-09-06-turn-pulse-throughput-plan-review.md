# TURN 下一轮优化计划审查

日期：2026-09-06。代码事实基线：`91cf000`。范围：设计、计划、相关当前源码和已归档运行证据；仅规划，未实施。

- 设计：`../specs/2026-09-06-turn-pulse-throughput-next-design.md`
- 计划：`../plans/2026-09-06-turn-pulse-throughput-next-plan.md`
- 上轮证据：`2026-09-06-turn-pulse-followup-implementation.md`

## 结论

**历史复审结果：当轮PASS；该结论已由后续主线程自审修正，不再表示无遗留验收缺口。** 新发现、反例与计划修订见 `2026-09-06-turn-pulse-throughput-self-review.md`。 主线程自审，Terra High子代理分别完成架构/隔离/因果边界审查及执行顺序/证据门槛审查；首轮要求修改，修订后分别复审通过。此结论不表示编码候选、runtime设施或产品已经通过验收。

## 主要发现与修订

| 级别 | 首轮问题 | 最终修订 |
|---|---|---|
| P1 | preset声明不等于真实codec提交值 | T1记录每次实际创建的submittedCodecOptions；缺失/漂移/reopen拒绝 |
| P1 | 注入resolver仍可能收到legacy而非候选身份 | 不可变PolicySelection、VerifiedLabContext、独立Lab子类选择路径；resolver严格匹配实验digest，普通入口仍拒绝 |
| P1 | 捕获与编码没有可执行的逐帧join | 明确recv→encoder registry→真实RTP包头→rVFC链路；随机origin、回绕、RTX、过期/冲突和缺失都有失败测试 |
| P1 | 自动Quartz输入会作用于共享桌面 | 自动化要求专用测试桌面及真实执行边界guard；普通输入协议保持，缺条件不自动注入 |
| P1 | 1201帧编码器安全网仅做观察 | 独立必需场景，实际bitstream IDR、PSNR/变化/成本和runtime突发均纳入门禁 |
| P2 | 场景连续性/单独聚合不明确 | 固定五个ScenarioRun；滚动后静止继承同一会话，每场景独立指标、缺帧/缺场景拒绝 |
| P2 | 任意10%被当成性能改进证据 | 改为六次独立run、预声明成本、完整范围对比，只筛待确认候选，仍以原产品SLA最终验收 |
| P2 | 可见nonce缺少可解码格式 | 固定格子、灰阶、字段位宽、双副本及CRC32；两档真实编解码测试，不依赖OCR或跨帧拼接 |
| P2（复审） | 本地人工操作可能冒充远程输入通过 | executionMode与status分开；producer-local不满足远程gate，operator-remote仍需完整机器核验的远程因果链 |

对最后一项，未采纳“一切人工触发都不能成为远程输入证据”的过宽限制：原验收要求真实Viewer→Host路径及可测ack/效果，并不要求动作必须自动生成。因此仅操作者通过实验Viewer发起、且原inputId/ack/producer/decoded marker链路完整时可计入，直接在Host打字永远不可替代。独立架构审查确认这一边界后PASS。补充独立控制端与既有授权转发要求，避免实验Viewer在捕获桌面内自指。

## 主线程事实核对

- 当前生产parser仅允许legacy，policy.preset此前未进入实际codec options；计划没有把它们误写成已修复。
- 直接读取本机安装的aiortc `_run_rtp` 源码，确认实际RTP timestamp是随机origin与encoder timestamp相加后的uint32值；计划已据此纠正join，不使用两套时钟直接相减。
- 当前collector的受控输入函数和marker gate仍固定NOT_RUN，不能仅凭flag或页面截图通过；T5明确以完整SceneResult替换。
- 当前Docker CLI存在，但只读 `docker info` 返回daemon不可连接；T6明确记录设施未就绪，禁止将CLI存在当作隔离丢包已可执行。
- 新旧计划连接、任务依赖、所列源路径、场景/接口名称和文档空白检查已核对。所有任务checkbox仍未勾选，新CLI明确标为待实施接口。

## 实施优先级与未满足前置条件

先做T1实际preset生效、T2单一superfast候选和T3阶段观测；T4-legacy可独立准备，T4-candidate必须等离线合格。T5/T6/T7补齐受控场景、网络恢复与吞吐证据，最后T8推广与生产复验。

当前尚未证明superfast通过；尚无可用的隔离丢包运行时证明；自动输入的专用桌面也未提供。人工远程模式需要独立控制端和既有授权连接。它们是实施时必须检查的前置条件，缺失时记录BLOCKED，不影响不依赖它们的离线开发，也不允许跳过后推广。

本轮没有运行编码矩阵、产品回归、浏览器、输入注入或服务重启；未改业务源码、runtime配置、凭据、tunnel或用户既有脏文件。只交付版本化设计、计划和审查记录。
