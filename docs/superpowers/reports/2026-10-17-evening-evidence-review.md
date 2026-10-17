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
