# Viewer 准入恢复执行计划

设计：[准入补充设计](../specs/2026-10-17-viewer-admission-recovery-addendum.md)。基线 adfcb48。用户已授权实现与本地服务验收。

1. C5.1 用真实 Signal handler 固化两个 RED：失联 A 在 grace 内被 B 顶替后返回；grace 到期后 B 接入、A 返回。验证 B 的 map、lease、producer 不变，不能只检查拒绝字符串。
2. C5.2 实现有界服务端显式准入意图和当前 session/代次恢复；在任何抢占副作用前判定。认证 API/Signal 共用同一实例状态；明确旧版兼容、重复/迟到/过期、容量和未知历史行为。
3. C5.3 接入真实 Viewer Start/重新连接桌面；自动恢复只 resume，不续发显式 ticket。记录明确可恢复 UI 状态，保留草稿和现有 reset/regrant 屏障。
4. C5.4 针对实际集成边界测试，不启动服务或真实输入。更新需求/专门实现报告，保持其他 dirty 文件；精确提交。
5. C5.5 独立 scoped review。通过后 root 保留原 checkout 修改与回滚快照，只同步审查补丁、构建、重启授权本地服务；tunnel/watcher 不变。
6. C5.6 正式域名实际登录、当前帧/控制门禁和可完成的连续性验证。自动化必须 fresh zero-Viewer + proof；现有真实 Viewer 优先。不把无法在 proof 约束下完成的普通自动重连或实际可见输入效果标为 PASS。

## C5.1–C5.4 执行状态

2026-10-17：源码和离线集成完成，473 项直接 Node 回归通过；真实 handler 两种旧页恢复原始 RED 已固化。详细命令、设计选择与限制见 [C5 实施报告](../reports/2026-10-17-task-C5-admission-recovery.md)。测试仅使用内存 handler/VM 与测试进程的临时 loopback 端口；未启动/重启生产 Signal/Host，未触碰 tunnel/watcher。C5.5 独立审查及 C5.6 部署/公网与设备验收仍由 root 执行，不能由离线测试替代。
