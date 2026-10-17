# Current resource and ownership review

一次初始采集因工具输出截断而解析失败，没有保留可用数据；本报告不从该失败结果推导任何结论。调用方随后授权一次精简重取，本次将唯一有效process快照直接落盘，避免再次截断。未杀进程、改配置/服务/tunnel、执行native input或读取进程完整参数/环境。

采样时间与资源（约2秒vm_stat差分；进程单次快照）：

```json
{
  "observedLocal": "2026-10-17T12:57:15.062993+08:00",
  "intervalSeconds": 2.013383749872446,
  "pageSize": 4096,
  "swapInMiBPerSecond": 6.31710174516198,
  "swapOutMiBPerSecond": 0.0,
  "freeMiB": 301.703125,
  "compressedPhysicalMiB": 3020.84375,
  "compressedLogicalMiB": 58353.80078125,
  "vm.swapusage": "total = 29696.00M  used = 28984.00M  free = 712.00M  (encrypted)",
  "vm.loadavg": "{ 7.67 9.54 13.45 }",
  "hw.memsize": "34359738368",
  "kern.memorystatus_vm_pressure_level": "1"
}
```

共955个进程；下列仅列RSS最高18、CPU最高12及已知服务/祖先后代的并集，共34行。CPU为ps的进程百分比估计，不是本2秒内精确CPU差分；RSS含共享映射，不能求和当作物理内存使用或swap归属。kernel pressure字段保留原始值，不据未验证枚举自行解释。

| PID | PPID | Age | CPU% | RSS MiB | Executable basename |
|---:|---:|---|---:|---:|---|
|14457|512|04-10:40:49|1.1|2916.2|Google Chrome Helper (Renderer)|
|80997|80896|10-09:48:28|1.4|2130.2|mysqld|
|25366|77267|01-11:17:28|0.0|1604.4|Codex (Renderer)|
|13488|77267|01-11:34:13|0.0|1277.8|Codex (Renderer)|
|77355|77267|01-14:53:02|0.0|1261.3|Codex (Renderer)|
|79562|77267|01-14:47:04|0.0|967.7|Codex (Renderer)|
|10564|77267|01-11:37:10|0.0|865.4|Codex (Renderer)|
|8802|77267|01-11:38:51|0.0|849.7|Codex (Renderer)|
|6832|77267|01-11:40:18|0.0|778.9|Codex (Renderer)|
|77378|77267|01-14:53:01|1.7|756.0|codex|
|85893|77267|17:11:41|0.0|527.4|Codex (Renderer)|
|512|1|15-21:09:59|8.9|450.7|Google Chrome|
|16492|16491|10:52:06|0.0|399.8|Python|
|55223|55214|02:29|100.4|394.9|Python|
|77267|1|01-14:53:28|0.3|373.8|ChatGPT|
|77619|77267|01-14:52:40|0.0|342.4|Codex (Renderer)|
|47401|512|14-11:16:56|0.0|290.0|Google Chrome Helper (Renderer)|
|54176|54167|03:36|0.0|255.3|Python|
|17320|16492|10:51:39|6.7|228.4|Python|
|877|512|15-21:09:25|7.7|92.2|Google Chrome Helper|
|149|1|15-21:10:19|8.0|53.0|WindowServer|
|15135|1|01:23:46|0.0|46.0|node|
|42127|1|23:12|0.0|44.6|Python|
|38769|1|05-17:29:11|0.8|14.9|bluetoothd|
|42299|42127|23:07|0.0|14.6|Python|
|55214|77378|02:29|0.0|13.3|Python|
|222|1|15-21:10:18|5.8|9.6|coreaudiod|
|15148|15135|01:23:42|0.0|8.8|esbuild|
|54167|77378|03:36|0.0|6.5|Python|
|1099|512|15-21:09:01|0.9|5.9|Google Chrome Helper|
|16491|16490|10:52:07|0.0|2.7|login|
|449|1|15-21:10:09|7.5|2.6|sysmond|
|16490|1|10:52:07|0.0|0.2|SCREEN|
|80896|1|10-09:48:30|0.0|0.0|sh|

同名executable资源聚合（不是任务归属）：

| Executable | Count | Sum RSS MiB | Sum ps CPU% |
|---|---:|---:|---:|
|Codex (Renderer)|30|9925.1|0.0|
|Google Chrome Helper (Renderer)|124|7176.4|1.8|
|mysqld|1|2130.2|1.4|
|node|80|1929.6|0.0|
|Python|11|1396.4|107.1|
|codex|3|811.4|1.7|
|Code Helper (Renderer)|3|575.4|0.1|
|Google Chrome|2|543.1|8.9|
|chrome-devtools-mcp|16|505.6|0.0|
|npm exec chrome-devtools-mcp@latest|16|482.6|0.0|
|ChatGPT|1|373.8|0.3|
|mcp@latest --isolated|12|362.0|0.0|
|Electron|4|313.9|0.0|
|Google Chrome Helper|9|301.2|8.7|

## 已知服务和旧测试身份

- PID 42127: 存在，name=Python，PPID=1，age=23:12，RSS=44.6MiB，psCPU=0.0%；可见后代PID=[42299]。
- PID 15135: 存在，name=node，PPID=1，age=01:23:46，RSS=46.0MiB，psCPU=0.0%；可见后代PID=[15148]。
- PID 19194: 快照中不存在。

42127与15135由调用方提供为当前Host/Signal身份；它们及其后代属于运行服务，不能仅因RSS非零当成过期测试垃圾。旧owned soak PID19194在longrun-owned-stop.json记录为明确本任务owned，已于12:14左右SIGINT；若该PID当前不存在，只证明根进程已消失，不证明所有reparented浏览器后代都已退出。旧进程名称/PPID1不构成ownership证明。

已知cleanup：long3h与clock-TURN300的lifecycle均browserClose=closed、managerStop=ok，但cleanup=api-finished-exit-unknown、ownedProcessExitEvidence=not-observed；JPEG summary仅ownedBrowserClosed=true。它们证明API清理调用成功，未证明所有OS进程退出。无persisted owned Chrome/browser PID可与当前快照逐个核对，不能把所有Chrome/Python/node进程都认作本次acceptance残留。

## 与11:44:09先前快照的身份交叉

- PID14457 / PPID512 / Google Chrome Helper (Renderer) 在11:44旧快照已经存在；旧RSS2897.3→当前2916.2MiB，当前age04-10:40:49。
- PID25366 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS1548.1→当前1604.4MiB，当前age01-11:17:28。
- PID13488 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS1278.1→当前1277.8MiB，当前age01-11:34:13。
- PID77355 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS1428.9→当前1261.3MiB，当前age01-14:53:02。
- PID79562 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS970.0→当前967.7MiB，当前age01-14:47:04。
- PID10564 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS920.1→当前865.4MiB，当前age01-11:37:10。
- PID8802 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS845.4→当前849.7MiB，当前age01-11:38:51。
- PID6832 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS820.5→当前778.9MiB，当前age01-11:40:18。
- PID77378 / PPID77267 / codex 在11:44旧快照已经存在；旧RSS655.9→当前756.0MiB，当前age01-14:53:01。
- PID85893 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS528.4→当前527.4MiB，当前age17:11:41。
- PID512 / PPID1 / Google Chrome 在11:44旧快照已经存在；旧RSS342.7→当前450.7MiB，当前age15-21:09:59。
- PID77267 / PPID1 / ChatGPT 在11:44旧快照已经存在；旧RSS407.0→当前373.8MiB，当前age01-14:53:28。
- PID77619 / PPID77267 / Codex (Renderer) 在11:44旧快照已经存在；旧RSS351.6→当前342.4MiB，当前age01-14:52:40。

上述同PID/PPID/name且age足够长的既有Chrome/Codex/Code进程，早于最近的300秒TURN和JPEG验收启动，不是由这两次验收新建的进程。它们可能承载用户已有页面、其它聊天或共享应用工作，不能据进程名进一步断言完全无关或可关闭；本聊天在共享Codex进程内的资源份额无法从本快照分离。

## 归属结论与限制

本快照只能确认已知服务根及当前仍可见的父子关系。没有得到“明确属于本任务且已过期的acceptance/browser/test后代”证据。也不能据此证明绝无漏清理的reparented子进程，因为原browser PID/start identity未持久化。当前大RSS/CPU的候选按表可定位到具体既有应用/系统进程，但系统swap是全机计数，不能分配给某一个PID。若需要清理，必须另有owned PID/start/launch记录；本报告不建议根据名称终止用户进程。


## 精确候选PID有限核对（不含argv/env）

调用方授权对已保存快照最高CPU候选55223及其父55214做一次PID/lstart/cwd核对；未重复全机进程快照。以下仅保留该两PID身份与cwd：

```text


```

父链在原有效快照中是55223 Python→55214 Python→77378 codex→77267 ChatGPT；这能关联到Codex应用进程树，但不能单凭该共享应用父链断定是本聊天拥有、是acceptance helper、已经完成或可停止。调用方说明其当前实现测试使用Node，不能将该Python自动认领为该测试。若其cwd/start与具体已知启动记录能对应，才能收窄归属；本次不读取argv或环境。


## 当前判断

12:57:15的有效2.013秒计数窗口swap-in约6.32MiB/s、swap-out0，load1为7.67；相比JPEG失败窗fresh swap-in约335MiB/s、swap-out约453MiB/s和load1最高64.54，采样时活动压力已显著缓解。这是分时观察，不是确定某个应用释放资源的因果证明；约28.3GiB已用swap和压缩逻辑页存量仍大，存量不会随短时流速下降立即归零，不能把它当持续高换页率。

单次ps的最高CPU Python55223（100.4%、394.9MiB，父55214）在随后限定PID/lstart/cwd核对时两者均已不在ps中、lsof也无结果。故没有可继续处置的该候选活进程，也没有足够记录证明它由本任务创建。其原先Codex父链是应用族关联，不能补成具体chat或test所有权。

最大的常驻RSS候选为既有Chrome renderer14457约2.85GiB、mysqld80997约2.08GiB及多个Codex renderer约0.8–1.6GiB。Chrome/Codex中多PID可与11:44旧快照核对并且age达天级；不是最近TURN300/JPEG验收新建的实例。它们更像长期用户/共享应用负载的内存存量，不能判定可安全清理，也不能从RSS直接判定谁产生swap。

Host42127和Signal15135在本快照分别44.6/46.0MiB、ps CPU均0；其子进程42299 Python约14.6MiB、15148 esbuild约8.8MiB，父链明确属于运行服务，不应归作acceptance遗留。已知owned soak19194不存在。当前未发现能确定为本任务stale的仍存活后代；API cleanup“exit未知”的历史边界仍保留，不能据此保证所有旧reparented browser进程均已退出。没有执行任何kill或清理动作。
