# WebRemoteDesktop 稳定性整改实现 Review

日期：2026-09-28
实现代理：`gpt-5.6-terra / high`（此前 `gpt-6-luna / max` 因容量不足多次中断）
Review 角色：主线程独立复核

## Review 结论

离线实现和自动化回归可以接受，未发现会阻止合并的代码级问题。现场验收已执行一部分：本地 Relay 和本地断网恢复通过，但正式域名 Relay 60 秒长样本以约 7 FPS 失败，因此公网稳定性不能标记为通过。

## Phase 状态

| Phase | 状态 | Review 结论 |
|---|---|---|
| 0 基线与 setter 来源 | 完成 | incident summarizer、文件 hash、setter source/no-op/reopen 统计已加入；摘要不复制任意日志 payload |
| 1 媒体应用协调 | 完成 | policy fingerprint、attempt/generation 去重、fixed relay no-op、真实 codec 首帧后的 `mark_applied` 已接入 |
| 2 资源与事件循环 | 完成（离线） | 旧 Peer、sender adapter、capture buffer、pending input、frame trace 的 teardown 已补强；长跑仍待真实环境 |
| 3 双 reset/ICE 恢复 | 已有实现并通过回归 | 现有 lease/reset barrier、bounded retry、attempt/epoch/inputId 校验保持 fail-closed；本次未放宽安全门禁 |
| 4 Relay/TURN 验收 | 部分执行，未通过 | 本地 Relay/离线恢复通过；正式域名 20s 约 16 FPS，60s 约 7 FPS，长跑门槛失败 |
| 5 诊断/告警/文档 | 完成 | alert 派生、持久化启动摘要、runbook、需求文档和验收报告已同步 |

## 独立验证

```text
python3.11 -m pytest -q python-host       332 passed, 1 existing mss deprecation warning
cd signal-server && npm test               365 passed (含 web build)
cd signal-server && node --test test/diagnostic.test.js
                                             17 passed
python3.11 scripts/test_summarize_wrd_incident.py
                                             passed
git diff --check                            passed
```

## 关键 Review 发现

### 已修复：Phase 0 摘要泄露风险

初版 `scripts/summarize-wrd-incident.py` 会把匹配日志的尾部文本写入 examples，未来日志字段若包含凭据或输入就会进入证据文件。已改为只保留时间前缀和白名单事件名，并加入敏感字段回归测试。

### 保持：`applied=false` 的真实语义

编码器无法证明 PyAV/VideoToolbox 热更新生效时继续返回 `applied=false`。媒体协调器只去重、合并 pending policy，并在真实 codec 首帧创建后调用 `mark_applied`，没有用日志状态伪造应用成功。

### 保持：控制 fail-closed

没有改动 lease reset barrier 的安全原则。旧 attempt、旧 lease epoch、错误 input type 或迟到 ACK 仍不能解锁控制；当前变更只增加诊断和资源清理。

## 未关闭的运行时风险

- 正式域名 Relay 已出画并恢复控制，但 60s 长样本出现约 7 FPS；需要继续处理 CPU/编码退化。
- 30–60 分钟教学长跑仍未通过，因此 RSS、event-loop lag、旧 sender/task 是否长期稳定不能宣称完成。
- `mss` 仍有既有 deprecation warning，不影响本次测试结果，但后续应单独升级 API。

## 发布建议

先在单一真实 Viewer 上执行 runbook 的本地健康检查和 Relay 短测，再执行长跑；任何失败都只回滚本地代码/策略，不重建 tunnel。验收证据至少包含 `WRD_MEDIA_APPLY`、`WRD_ENCODER_RATE`、`WRD_ENCODER_SAMPLE`、`host_event_loop_lag`、`dc-error`、`ice-disconnected` 和 reset ACK 的同一 attempt 时间线。
