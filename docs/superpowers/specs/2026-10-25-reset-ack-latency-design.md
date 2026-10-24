# Reset ACK 回程延迟优化设计

日期：2026-10-25（Asia/Shanghai）
状态：实现已提交 main `6312429` 并加载，改后 20 对公网安全 reset 完成；200 ms 目标未通过，详细运行与剩余项见本轮报告。

## 问题与目标

生产a88五次短断线的每轮两个唯一reset关联中，rolling窗口较大ACK值405.5–496.3ms。Host adapter很快，但不包含外层准入等待；不能用RTT减adapter称纯网络。公网与loopback心跳有明显额外往返等待，尚未分离上下行。实际ACK到达、产品同步处理完成及M1统计时点必须分列，防止仅修指标而未改善真实等待。

目标是在保持安全reset单次请求、当前owner校验及3秒barrier期限的条件下，减少reset确认回程等待。200ms仍是目标；没有前后对照数据时不保证达标，不承诺收益固定一半。业务输入到可见效果不在本次reset-only验收中。

## 方案比较

1. **Socket请求唯一，成功ACK经当前DC补充回传（选定）。** 不产生第二次reset，Socket请求与ACK兜底保留；健康DC可减少回程等待，坏DC不阻断Socket。上行公网等待仍存在。
2. **Socket/DC同时发reset请求（拒绝）。** Mouse sequence-gap会rewind并发新reset；旧副本迟到可能消耗新业务输入的seq，不能仅凭同inputId/seq假定永远幂等。
3. **延长期限或只调整RTT计时（不作为优化）。** 不减少实际到达或gate等待，也可能掩盖失效。

## Host契约

- 只为既有执行路径已确认的schema2、type mouse/keyboard、action reset、单inputId、status applied/duplicate的Socket请求镜像ACK；非reset、negative、legacy不镜像。
- 无await间隙核对captured authority、当前绑定viewer/lease/epoch、当前connected PC及其input DC归属。仅向open的当前通道发送：序列化ACK≤4KiB，已有buffer加本ACK≤32KiB；无法证明归属时不发送。
- 镜像包添加固定`resetAckMirrorVersion: 1`，保留原请求transport=socket；不包含viewerId、leaseId或输入正文。先best-effort DC，再按原流程emit Socket ACK；DC发送异常与Socket发送隔离，不能使原Socket兜底跳过。
- 不新增native输入调用、不复制请求、不改变队列、seq、授权、Host结果或TTL。Socket发送后的authority变化不得补发到新peer。

## Viewer契约

- 仅在发送Socket reset时，捕获健康当前input DC作为内存中的可选第二ACK source；不将它当作请求发送源。
- 镜像ACK必须同时满足marker=1、schema2、确切inputType、成功状态、单个匹配ID，以及原pending的lease/epoch、attempt、socket对象/id和捕获DC仍current。mouse及keyboard原seq/状态/barrier验证继续执行。
- 普通业务ACK、无marker、negative、旧/新替换DC、换socket id、换attempt或lease均不能使用该例外。首个有效ACK按原流程消费pending；迟到副本不能再次清barrier或推进指标。
- 不扩大公共snapshot暴露；所有身份/通道对象仅驻内存。原单通道controlled输入证据不伪造混合路径已认证；reset-only探针单独注明请求/ACK实际通道。
- 老Host继续单Socket；老Viewer忽略DC镜像并使用Socket，原回退成立。

## ACK到达与验权耗时的生产观测

私有未连接RTCDataChannel浏览器顺序fixture已证明后加capture:true listener仍晚于既有onmessage，不能用它伪造原始到达。复用WebRTC.acceptObservedInputAck入口已采集的Viewer单调时刻：C原身份/控制校验通过后才传给LatencyMonitor，分别新增inputAckArrivalRttMs（原M1发送时点→入口）与inputAckValidationMs（入口→C验权及M1提交时点）。原inputAckRttMs保持原意义和数值，不改原控制处理顺序。

入口时刻仅作为差值数据，不传给全局clock而使其回退；必须为有限非负数，落在该pending.sent与当前处理时刻之间，同scope且正向匹配真实pending才记两个指标。缺失/非法/未来/早于send、旧scope、拒绝或迟到副本保持缺测，不能补0。只持久化原有有界指标聚合，不记录原始输入或增加控制授权。原始DC前置listener阶段仍明确unknown，新增指标由产品入口时钟证明。

## 验收与运行边界

- 私有owned页面正常登录、vacant-only Start；只调用产品reset API进行有界安全释放，不发送业务键鼠/文字，不绕过隔离GUIguard。
- 改前/改后各最多20对独立reset，同会话同scope串行，间隔≥1.5秒。记录ACK最早到达、产品处理结束、原M1 RTT、Host阶段及Signal本地转发到ACK；保持各自时钟口径，不相减成单向网络。
- 先证明Socket-only基线；改后记录真正经DC匹配完成的比例与Socket后续副本，核对无第二次reset执行。缺失和失败保留，分位使用nearest-rank且给样本数。
- 离线覆盖成功、DC unavailable/throw/backpressure、old owner、wrong ID/type/epoch/seq、scope切换、late duplicate与普通输入不得跨源；Host原Socket兜底必须逐例验证。
- 无Viewer维护窗口提交main后按服务技能只加载本地Signal/Host；生产代码/build/PID分组件记录。任何用户会话优先，不操作tunnel。
- 保存spec、plan、review及脱敏源SHA；本地/公网health、Host在线与当前密码按既有约定核对。reset ACK改善不等于业务可见效果或三小时验收通过。

## 实施与真实收益

改前/改后各20对、每种输入n=20：原M1 ACK RTT p95，mouse 500.7→275.8ms、keyboard 502.6→276.5ms。改后40个首个有效ACK均来自当前DC，40个原Socket副本后续均被拒绝为已消费，不重复推进M1或barrier。同一输入的DC后置处理完成先于Socket副本的实测差为mouse中位196.6ms、keyboard中位195.4ms；这不是单向网络延迟。

新arrival/validation两指标40/40独立归属，产品入口至M1提交的阶段max为mouse1.0ms、keyboard1.1ms。仍有keyboard462.1ms的RTT长尾，不能据此宣布200ms达标或全部CPU/网络原因已定位。离线定向前端1080/1080、Host57/57与独立跨文件审查通过；运行恢复与最终边界以[完整报告](../reports/2026-10-25-reset-ack-latency-review.md)为准。
