# 晚间诊断增量 review 与执行记录

基线文档/工具6e45276，生产产品afd598a/build a6e8b15122bde656。任务继续按brainstorming + writing-plans及逐项独立review执行；原工作区修改保留，不操作tunnel/watcher。

## 设计复核

独立preflight发现并在实施前纠正两项兼容问题：当前事件标识是16–64位小写hex（实际producer常为32位），不能误限为64位SHA256；logger会脱敏含token的key，观测类别采用auth_verify，数据进入既有envelope.meta并验证真实序列化。随后设计PASS。

控制器另外明确：HTTP202是正常诊断API成功状态，只有有效匹配保存回执才能返回true；202自身既不能证明保存，也不能一律拒绝。Socket ACK阶段到期后忽略晚ACK，HTTP只使用总8秒的剩余预算。入口摘要沿用一个60秒timer，tracker最多256；其观察过期不是业务请求超时。

## Task 1：诊断保存回执

实现af020eb，修正f592089。初始209项定向回归通过，包括Socket/HTTP同ID去重、202有效与拒绝回执、4096B流式上限、pending重放与并发。独立review发现重要问题：ACK回调只校验总8秒截止，可能在2秒timer延迟时接受阶段过期ACK。fix round1改为独立绝对单调时间检查；1999/2000/2500ms回归覆盖边界，修正后51项覆盖测试通过，复审spec/quality均PASS。

保留Minor：部分负向测试夹具打印预期console错误，影响输出整洁，不是生产故障；最终增量review仍须审视此项。生产build/部署/真实回执尚未验收，不能用209或51项离线通过替代。

## 后续任务

Task 2：f87668b已完成，74项定向测试通过（17项新增）；独立spec/quality review均PASS，无重要或次要新发现。实际logger序列化envelope约2935B，扩大数值位宽后4455B，低于16KiB。生产sink与覆盖核对仍待部署。Task 3：9641ecc已实现独立于输出帧的抓屏attempt/completion/failure/age观测，39项安全测试通过（16项既有runtime、23项新增pure/AST）；剥离观察语句后的capture loop AST与基线相同。没有import Host/native依赖，也未执行原生抓屏。独立spec/quality review均PASS，无新发现；实际JSONL、部署和开销由控制器继续核对。Task 4：最终增量review、隔离build、冻结apply、既有helper本地重启、实际运行覆盖核对及继续故障定位。

抓屏观测不改变截图/编码/输入行为，不被描述为性能根因修复。现有短时sample提示GIL复制、系统换页与调度候选；全帧零拷贝涉及原生内存所有权，尚未实施。普通重连、真实输入可见效果与三小时稳定资格仍未完成。


## 最终增量review与运行加载

6e45276..db5d2b1共7个commit/23个文件的独立跨层review通过，无Critical/Important；两项Minor（预期负向console噪声、既有helper清理分类覆盖）均非阻断，解释边界保留。测试范围交叠，不把209+51+74+39相加为独立总数。最终review没有重复跑测试或进行线上操作。

隔离build067dfc41e8374b4e通过，生产源码和资源hash核对通过；本地restart-local25.829s，22:06新Signal/Host在线，tunnel/watcher及主工作区HEAD/index保留。实际JSONL首窗完整、目录0700/文件0600、Host空闲capture=null语义正确。两次同IDHTTP保存均得到有效回执并清pending；source VM不是渲染UI验收。公网300秒新窗口已结束INCOMPLETE，maxgap8666.3ms；随后定位启动期DC计时阶段错误，转入独立spec/plan修复。三小时、普通重连和真实输入可见效果仍未通过；不能因review无发现宣布故障已解决。


## 控制器决策与代价

以下是执行ledger中的全部Ruling，不在清理临时ledger后遗失：

| 决策 | 原因 | 判断错误的代价 |
|---|---|---|
| Socket阶段2s到期后忽略晚ACK；只做一次总8s剩余预算HTTP补投 | 避免双live winner，沿用同ID去重 | Socket其实保存而HTTP失败时可能显示未确认，不能误报成功 |
| 入口只用一个60s timer，正常tracker过期60–120s | 控制计时器和状态开销；不是业务timeout | pending观察粒度较粗，但256上限仍生效 |
| ID沿用16–64位hex；类别用auth_verify | 与producer及现有redactor兼容 | 错误限制会丢确认，错误key会使字段被脱敏 |
| HTTP202只按有效匹配receipt判断true | 保持现有API成功状态契约 | 一律拒绝会把已保存诊断留在pending，一律接受会误报 |
| 本机启用现有私有WRD_LOG_DIR轮转sink | stdout对象inspect会折叠嵌套信息且无轮转 | 增加有界磁盘写入；本机配置有私有备份 |
| 新增独立抓屏观测Task3 | 现有输出帧耗时看不到在途和失败调用 | 需要Host加载、每帧两次固定tuple发布；不等于性能修复 |
| HTTP时长含finish/abort/unfinished-close，expiry/stop截断排除 | 不伪造未观察到的完成 | 不能把此直方图当成功请求延迟分布 |

最终review保留两个非阻断Minor：预期负向console输出的测试整洁度、既有helper cleanup覆盖主分类；后者继续用原始采样/失败数/maxgap解释。没有改变helper pins或据此重跑已存在的旧测试。


后续运行review区分累计maxgap导致的301个失败观测与5条瞬时frameAge>5s；信令close处于清理期。真实capture记录及native sample已按各自时钟/字节窗口分析，不把总进程CPU当百分比或把grab wall time当CPU执行。日志写盘专项检查确认WRD_LOG_DIR覆盖全部structured events，Socket非move/wheel输入存在同步写盘；本次无主动输入，开销保持未验收，且不归因启用前故障。

本证据增量完成开发、独立review、加载与指定回执/JSONL验收；整体稳定性失败保留。新发现的启动watchdog问题由独立2026-10-17-startup-datachannel-watchdog spec/plan继续，不将其隐藏在本轮“无代码review发现”结论下。
