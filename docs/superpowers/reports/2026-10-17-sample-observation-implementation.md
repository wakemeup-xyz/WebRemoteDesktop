# 私有故障采样器观测修复

实现仅位于本机0700目录/tmp/wrd-owned-turn-probe-private，两个文件0600；生产helper/source/proof未改。

- supervisor SHA256: d99fb2896cbf627902b3792ee18ee79a219a549840c541a2d4871ef71ff82f24
- tests SHA256: d81a89cee89c744e62c8f0ae9d6cd2ef375d7ee5f0d0d81a0cc36973c3eb3e8b
- 独立区分timeoutDetected、exitObserved、finalized；timeout后持续非阻塞观察，不把worker结束时间覆盖为sample退出。
- 每轮先deadline再至多64KiB诊断排空，只保留16KiB私有前缀；不增线程、不改变10秒预算、8MiB raw限制、目标核对与归属清理。
- 实施者19项PASS（包括原16项）；review独立16项纯离线PASS，按review范围未重跑3项无业务真实子进程测试。不是19+16个不同用例。
- [独立review](2026-10-17-sample-observation-task-review.md)spec/quality PASS。生产Host采样及其权限可用性未验证；后续先由root对自己创建的sleep子进程执行一次能力检查。

Root能力检查（新建无业务Python sleep子进程，不是Host）：一次3秒/10ms采样，3.622s后观察正常退出code0，报告28,086B；目标PID匹配、Call graph、线程及Python sleep栈均存在。诊断243B无截断。sample登记身份自然退出；仅对自己创建的sleep子进程按归属清理，两者均确认已登记身份退出。完整进程树退出证明仍false。raw仅本机私有0600，未版本化。这个PASS证明当前工具能对该自建子进程工作，不证明之前生产Host有栈、Host权限相同或未来资源压力下也能成功。
