# Host lag observer 静态 review v2：版本边界澄清

**原报告“这六文件新代码尚未加载”的说法不适用于这六文件，应撤回。** Root 已导出 live backend pin dfb15434e79da90b803b763c533836e16c080c71 的对应文件并比较 held41 当前文件；固定摘要 manifest 和原审查文件哈希交叉核对后，六项全部字节相同。因此，原 review 的资源 private-loop owner、有界 writer、producer/Thread.start/短锁等静态结构，可以关联到这个已核对的 dfb 源码版本。

本次只读 manifest 和原 review，未重读/复制六个源文件、重做审查或执行受审代码。旧报告原件保留；本 v2 只修正其版本来源边界。

| 文件 | 字节数 | 同 dfb pin 的 SHA256 |
| --- | --- | --- |
| host.py | 282920 | 3a54db3f9f6f06fe951cdbf60361c839eda316c8e6f4d678851bfeb94d349346 |
| runtime_observability.py | 26894 | 63f60336cad1b34d9fc32db0c3d84ac1f68cb3def57995f9533e63b71353da10 |
| observability.py | 9419 | 79156962e21a3bb4988c608d8e75bff3e18ef191dd047be01001611e4080f916 |
| bounded_log_writer.py | 10221 | fc59ac20851e2748e48eea80c9828926364ae779d6748144ffc8872cfd1a7931 |
| input_admission_queue.py | 6640 | f4f94a1c87e69abf5b12d9a353c27fb4f8bd1a3aac6a5913300abd18ca776354 |
| relay_frame_worker.py | 6708 | cea5dcc5979cb943424ec3a094483434e2c44131372f7db01f6f19d36c608777 |

原 review 结论保持：未确认可重复秒级阻塞的确定 bug；首次 Thread.start、producer redact/JSON/format 和短锁为已确认同步边界，但耗时未测。资源命令在 private loop，日志文件 I/O 在 writer 且锁外；未见这些慢 I/O 跨 observer 共享锁持有。

源码相同不证明具体运行分支确已执行，不证明调用或锁的实际耗时、现场栈、模块对象身份，更不证明此次秒级 lag 的因果关系；也不扩展为完整 worktree 或其他文件一致。没有新增根因、实现方案或修复动作。

Manifest：/tmp/wrd-live-host-source-review-20261019-walu85ev/manifest.json

SHA256：c7a6d8e599ab86e9ff30f6015f06970558dfd225f0144604eceb001123e64a55

原 MD：/tmp/wrd-host-lag-observer-source-review-20261019.md；SHA256 67674a2a654cfeae5c91c5de0f25349edf9e859a80ad3870c9043aa138d8acf4

原 JSON：/tmp/wrd-host-lag-observer-source-review-20261019.json；SHA256 f054178bfdb57d89578b352ab4ec73587ceaabf27f1acaca65ab9f9d2317cfe4

本次无 HTTP、日志、进程、Git、服务、测试或受审代码执行，无旧原件/源码/index 改写。新 JSON 保存六个绝对审查路径、逐项匹配与保留结论：/tmp/wrd-host-lag-observer-source-review-v2-20261019.json。两份 v2 产物均 private0600。
