# 2026-10-24 控制恢复修复记录

## 确认的问题

本轮从 CPU 归因转到独立可复现的控制恢复缺口。没有修改抓帧倍率、分辨率、编码器或全机业务负载。

1. active 成功 ACK 后等待新鲜帧，同 generation soft replay 会被 Signal 或 Host 拒绝。旧 Viewer 用 Host stale-generation 覆盖成功 ACK 并取消剩余 fallback；之后的新帧被 no-active-ack 拒绝，永久 resuming。真实 Signal 更早拒绝重复请求且不带请求身份，Host ACK 转发又丢失 reason，因此仅修改 Viewer 的直连 Host fixture 不足以修复生产路径。
2. DataChannel 的 send 同步失败会让上层重新抛异常，没有进入已存在的 Socket fallback。
3. schema 3 主动删除控制台原文后用空数组生成 logCount=0，误导诊断；原上送条数与仍保留的结构化 trace 没有分别记录。

前两项由真实生产函数/validator 和可控时钟反例证实；第三项由实际 v3 raw、ingest 源码与持久化 canary 反例证实。不能把这些反例反推成今天所有断连的唯一根因。

## 修改范围

- `web-client/js/webrtc.js`：同 scope 已确认媒体请求的重复回复不覆盖成功证明；保留有界新帧恢复期限；DC 同步 send 失败交给既有 Socket fallback。
- `signal-server/websocket/signaling.js`：拒绝回复携带经过验证的 state/generation/attempt，不回显 lease；Host ACK 仅透传固定原因枚举，Viewer 按当前请求处理拒绝；旧身份和无 scope 回复不能取消当前恢复期限。
- `signal-server/lib/diagnostic.js`、`diagnostic-store.js`、`observability/runtime-evidence.js`：只持久化 reported/retained/redacted/trace 计数，不保存控制台原文。历史未知保留 null；v3 非法身份/capture 不进入 legacy 原文分支。
- 将 `input-events-dropped` 更正为 `input-trace-truncated`、`input-reset-ack-expired` 更正为 `input-ack-observation-expired`。真实 ring 仅记录生命周期事件也会淘汰，不能把它解释为键鼠动作丢失。
- 新增或扩展与上述行为对应的回归反例；没有新依赖。

## 验证与加载状态

- 最终 Viewer 全套：1,507/1,507 PASS；Signal 全套（含 signaling）：432/432 PASS，无跳过。
- 媒体路径独立审查：PC/socket/lease/attempt/generation 隔离、legacy relay 及固定恢复期限未发现必修问题。
- 隔离构建：`/tmp/wrd-web-preview-20261024-final-control-recovery`，buildId `544814d637669668`；`git diff --check` 通过。
- 本地加载、公网连接和短断线正在执行，当前不声明已验收。

## 尚未解决

抓帧 native 等待、全机 CPU/换页压力、实际 TURN 路径抖动与 marker→可见效果仍需独立测量。本次没有通过扩大 reset deadline 或关闭身份门禁来掩盖这些问题。

## 测试隔离事故与证据边界

本轮执行既有诊断回归时，`diagnostic.test.js` 未设置私有 `WRD_DIAG_DIR`，原测试中的递归清理作用到默认 `/tmp/wrd-diag`，删除了该目录的历史诊断文件。这是 agent 的执行造成的证据损失，不能解释为正常保留策略。已向用户披露。Host、Signal 文本及结构化运行日志仍在，服务没有因此停止；原 raw 和目录内日汇总没有恢复。

修复为模块导入前分配唯一临时根，所有写入/清理归属该根，清理前检查路径，退出恢复环境变量；默认目录测试只做纯路径断言。新增子进程 canary 验证继承的模拟生产目录及文件清单完全不变。三个诊断文件修复后安全回归 55/55 通过。

`evidence/2026-10-24-continuing-disconnect/control-recovery-findings.json` 仅保存删除前检查已提取的脱敏摘要，并明确标注原件丢失、无法重新回放；没有伪造或重建历史 raw。后续诊断需结合仍保留的 Host/Signal 日志和新版本产生的新样本，不能继续宣称旧 raw 可复核。
