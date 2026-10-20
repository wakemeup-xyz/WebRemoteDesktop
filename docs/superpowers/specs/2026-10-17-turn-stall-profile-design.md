# TURN 首次停帧受控采样设计

本增量用于诊断，不能计为性能或三小时验收。现有 14:07 窗口先发生媒体停滞，Host encode 单次13.541s、当前loop lag12.771s；15.773s窗口Host仅消耗0.633CPU秒。原因还不能在系统调度、内存页入或原生编码等待之间确定。默认阶段日志已提供起点，先取有界native stack证据，不先改编码参数或生产源码。

## 方案

选择私有独立supervisor运行未改动的 passive_session_soak.py，维护本次子进程PID+create_time归属记录，并在首个frameAgeMs>2000时对固定当前Host做一次3s/10ms的/usr/bin/sample。相比直接再跑helper，它补足OS清理旁证；相比更换编码器或开逐帧trace，不改变媒体策略与生产配置。无需manager proxy/CDP：归属来自实际supervisor子进程树，避免launch包装引入新超时；CDP也不能解决轮询漏掉快速孤儿化进程的问题。

## 边界

- 单次正式入口relay模式、300秒sampling；沿用真实登录/Start、fresh zeroViewer及一次性proof。不重领/清proof，不普通ticket，不业务输入。
- 原helper与sampler固定SHA；原summary/lifecycle/samples由helper独占，supervisor只写独立sidecar。
- 独立child脚本进程以start_new_session启动，记录PID/create_time，从启动至清理每0.25秒核对当前已知根的后代；最多128个身份，超出即结束诊断并保留不完整状态。不读取argv、环境、页面输入或profile内容。
- 登记后代前核对父链仍通向本次worker或已记录且birth仍匹配的owned父进程。名字、创建分钟、进程组、CDP PID均不能单独授权清理。
- 总墙钟deadline600s；helper自然结束后观察1s，仍存活owned身份TERM、最多等待3s，再对同birth身份KILL、最多等待2s。信号前逐个重新验证create_time，并使用psutil Process方法。权限/归属未知或PID重用则跳过。只清理本次显式创建的测试进程，不操作Host/Signal/tunnel/用户应用。
- macOS仍存在检查到signal的微小竞态，轮询也可能漏掉快速孤儿化子进程；报告必须区分“已记录身份均退出”和“完整树退出未证明”，不能把前者扩写为后者。
- 首次观察完整samples.jsonl行中的非空frameAgeMs>2000后先锁定触发；再次核验固定Host87412的启动身份及原有PID文件。仅运行一次sample，10s外部上限、输出最多8MiB，sample子进程另行归属管理。未触发/Host变更/无法读取分别报告，不寻找替代Host、不重启。
- 只读sample会扰动被测系统，结果明确为诊断。raw输出含路径等metadata，仅私有0700目录/0600文件；版本化文档只写脱敏结论。

## 审核与下一步

运行前离线覆盖：归属未知/重用PID不signal；已知后代可登记；helper失败/超时仍收尾；sample最多一次且Host身份变更拒绝；旁车不改helper产物。独立审查通过后才进入一次真实诊断。若未复现，不将短测成功当作历史问题消失；结合资源、stack和原阶段日志决定是否有可验证代码修复。
