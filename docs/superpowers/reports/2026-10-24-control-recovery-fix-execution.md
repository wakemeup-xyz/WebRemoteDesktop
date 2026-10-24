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
- 代码提交 `09d5c24`，22:38 通过服务 helper 仅重启 Signal，PID `99844`。Host 保持原进程并重新上线。生产 build 与隔离构建一致，正式域名获取的 desktop bundle 字节与本地产物一致；tunnel PID/启动时间及缺失的 safe URL 文件均未变化。
- 正式域名 TURN 被动连续会话：120 秒、121 次采样、无缺失/失败、无身份或路径切换，最大观测无新帧时间 933.4ms；启动点击到首帧约 3,667ms。仅为 passive continuity，不含业务输入/可见效果。
- 第一次短断线验收：300 秒连续基线 301 样本无缺失；一次 native direct-close 后 5.024 秒完成 within-grace rebind，稳定 20.571 秒，随后 `host-observation-unavailable`，浏览器 close 超时。该次为 **INCOMPLETE**，不能记完整通过；同时间 Host 仍在线且无 Host disconnect 事件，不能把观察不可用等同 Host 掉线。正在核对并独立重测。
- 第二次：300 秒基线仍有 301 样本且无缺失；原 lease rebind 后出现释放/重新获取，最终 Viewer 为 socket connected、PC connected、media active、inputAllowed=true，但已不再是原 lease，严格恢复判定为 **INCOMPLETE / recovery-deadline**。Host 观察完整、无 disconnect，浏览器清理完成。不能因为最后可控制就把原租约恢复验收改为通过。
- 公网接口差异已复现：默认 `Python-urllib/3.11` User-Agent 收到 Cloudflare HTTP 403/1010；相同请求换浏览器 User-Agent 或 curl 默认均 200。项目 `WRD-Entry-Health/2.0` 探针亦 200。因此默认 urllib 的拒绝不能代表浏览器入口宕机；本轮没有修改入口规则。

## 新增原生栈证据

22:43:29 的 `/usr/bin/sample` 采样（请求 5 秒、10ms 间隔，各长期线程 420 个采样点）中，抓帧 worker 287/420（68.33%）处于 `CGDataProviderCopyData`，其中 286 个明确在 `CGSCaptureImageProviderBytePointer → mach_msg` 等待；另 12 个采样点在 `SLWindowListCreateImage` 分支。`bytearray` 内存复制 74/420（17.62%），该 worker 的 `take_gil` 25/420（5.95%）。main 从 select 恢复时 `take_gil` 71/420（16.90%），所有 main `take_gil` 分支共 92/420（21.90%）；main `kevent` 245/420（58.33%）也包含正常 I/O 等待。

这份栈与 MSS ctypes/CoreGraphics 实现吻合，直接支持系统抓屏数据/IPC 等待与进程内 GIL 竞争并存。采样比例不是单帧耗时分解、不是抓帧 p95，也不能证明它们分别导致了哪次 ACK 超时。原始采样留在本机临时目录，不纳入版本管理；仓库只保留脱敏比例和覆盖窗口。进程隔离 A/B 应分别验证 GIL 干扰、bytearray 复制和 native IPC 等待，不能把进程隔离当作 WindowServer 加速保证。

两段 Host 性能见 `evidence/2026-10-24-continuing-disconnect/postfix-host-performance.json`。第二段 rolling fresh cadence 从约 17.14 降至 1.93Hz；失败附近抓帧 wall 366–820ms，其中 nonCPU 334–782ms。转换/编码五秒窗口加权均值分别 24.66/50.06ms；末60秒 event-loop p95=172.43ms。可靠/无序输入队列无积压或新增丢弃。抓帧和转换/编码都存在退化，不能只修其中一个指标就宣布完成。

22:55:36 整机单点：12 逻辑核、load 301.57/195.93/126.61、158 个运行态进程、CPU idle 15.53%、压缩内存约 8,966MiB；22:57:16 运行态进程回落到 19。load 不是 CPU 百分比，压缩内存也不证明该秒正在换页；这些说明压力具有明显波动，不能把不同时间的 capture 数值直接比较成受控 A/B。未调整或停止其他项目任务。

新生产 runtime receipt 当前 reportCount=0，reported/retained/redacted/trace 计数均为 null；summary gap=0、ring drop=1（诊断/心跳环保留）。这份运行证据证明缺测被正确暴露，不能证明已经收到新版本诊断报告或真实输入效果。日志计数贯通目前由离线持久化反例验证，生产新样本仍待观测。

## 验收探针诊断增强

`read_local_host_status()` 原来把连接、HTTP 头/body、关闭及期限错误都压成相同 ValueError。现保留原错误契约，另携带固定 stage/errorCategory 和 bounded elapsedMs，失败时只在该次验收私有输出目录写 `status-observation-failure.json`；不写异常原文、URL、身份或密码，不更改严格 summary/lifecycle schema。页面观察失败本身不能生成 status-reader 证据。750ms status、2s tick、1s final export 及 cleanup 时限不变；写入失败保留首失败且不能生成 PASS。主套 91/91 与取消/清理期限 focused 6/6 通过。旧两次验收没有该侧文件，无法回溯具体失败阶段。

## 尚未解决

抓帧 native 等待、全机 CPU/换页压力、实际 TURN 路径抖动与 marker→可见效果仍需独立测量。本次没有通过扩大 reset deadline 或关闭身份门禁来掩盖这些问题。

## 测试隔离事故与证据边界

本轮执行既有诊断回归时，`diagnostic.test.js` 未设置私有 `WRD_DIAG_DIR`，原测试中的递归清理作用到默认 `/tmp/wrd-diag`，删除了该目录的历史诊断文件。这是 agent 的执行造成的证据损失，不能解释为正常保留策略。已向用户披露。Host、Signal 文本及结构化运行日志仍在，服务没有因此停止；原 raw 和目录内日汇总没有恢复。

修复为模块导入前分配唯一临时根，所有写入/清理归属该根，清理前检查路径，退出恢复环境变量；默认目录测试只做纯路径断言。新增子进程 canary 验证继承的模拟生产目录及文件清单完全不变。三个诊断文件修复后安全回归 55/55 通过。

另查明既有 `terminal-bootstrap.test.js` 的两项 API 测试直接启动真实 `server.js` 主入口，触发 `startServerFromSource()` 提前构建并发布实际 `web-client/dist`，还因继承环境和加载 `.env` 将测试事件写入生产 structured log。14:18 的 retained build `64e7e974fab20d09` 及同窗口的测试 admin 授权事件属于测试污染，不能解释为独立生产会话或正式加载验收。已仅修改测试，以短子进程 fixture 调用公开 `startServer()`，通过 `runtime.close()` 与 `server.close()` 保留 SIGTERM 优雅退出；诊断目录、structured log 及 Terminal audit 路径全部指向唯一临时根。修复后仅运行该文件，3/3 PASS；执行前后生产 manifest 的 SHA-256 `3e5a63df64aebf9504c1983ea2315f975e3f348da533e5c484cfb058c031b70b`、mtime `1792852701505165257ns` 均不变，生产 structured log 文件清单、SHA、mtime 与大小快照也保持不变；临时日志内独立验证最终 entry window 和测试 admin 授权事件，没有再次调用旧主入口。

`evidence/2026-10-24-continuing-disconnect/control-recovery-findings.json` 仅保存删除前检查已提取的脱敏摘要，并明确标注原件丢失、无法重新回放；没有伪造或重建历史 raw。后续诊断需结合仍保留的 Host/Signal 日志和新版本产生的新样本，不能继续宣称旧 raw 可复核。
