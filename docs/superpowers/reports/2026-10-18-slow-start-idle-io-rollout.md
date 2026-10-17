# 慢启动与日志隔离上线记录

2026-10-18。冻结候选93f390890aeb1198865d88ee8ed7426bedc82c5d，包含逐项修订及最终380b250回调归属修复；[整体与定向复审](2026-10-18-slow-start-idle-io-review.md)通过后，仅执行本地Signal/Host重载。

## 实际上线

临时目录完整Viewer构建验证通过，build为ed92d1313adb54f6；正常Signal启动随后从相同已核对完整源码重建，实测301个浏览器样本都加载该build。精确应用24路径（其中10个运行/相关测试路径），本地helper0退出、26.648秒，Signal51710/02:44:12 CST、Host51808/02:44:19 CST，均核对实际监听/工作目录/入口/新birth。Host新结构化记录持续写入既有back-debug.log；没有新增Host JSONL文件。

主仓HEAD b6bd0c11和index哈希保留，已有修改及四个未部署watcher文件保留；cloudflared84671/Oct16 19:44:27与watcher897/Oct1 15:47:50身份不变，debug quick URL仍缺失。正式入口仍为既有固定域名。没有tunnel/watcher操作。重载后已从运行配置重新读取并向用户回报两种密码；密码不落入版本化记录。

## 新正式短测：INCOMPLETE

新一次Start、一次性准入，TURN/relay路径，首末采样跨度300.00105秒/301行（约02:46:13.689–02:51:13.690 CST）；helper总计302.938秒包含后续清理，supervisor总计336.085秒。无missing、late、failed或identity-change observations；全部样本socket、ACTIVE控制相关门禁、可信当前帧和viewport条件开启，UI connected，keyboard READY/ready、surface settled。最大已完成画面间隔2716.6ms，小于本工具5000ms连续性阈值，但属于需要排查的明显卡顿。不得据“未超过5秒”称性能已解决。

最终结果INCOMPLETE，原因是browser.close API超时（约2751ms）；manager.stop约66ms完成。七个已登记测试身份自然退出、未向其发送信号，但这不能改写helper的INCOMPLETE，也不证明完整进程树退出。测试前后health正常、Host在线，结束后Viewer0/relay0、相同新服务PID及build；不能把工具关闭超时直接称服务断线。

>2秒frameAge触发了一次3秒Host线程采样。采样命令已完成采样但卡在符号处理阶段，配置10秒外部预算到期后被终止，输出文件0字节，没有可用线程栈。记录超时检测与退出观察时间，不把采样“开始”当根因证据，不据空栈归因某个调用。

浏览器时钟推算卡顿约02:48:46.296–02:48:49.012 CST。同窗Host02:48:48.872记录一次最近完成grab括号2959.926ms、event-loop last/max1491.700ms、load1=154.437、资源缓存7151ms；grab括号包含失去调度的墙钟时间，不能等同native调用CPU耗时。相邻编码窗口max201.783/124.527/86.609ms，没有同窗秒级编码证据。23份高loop max属于重叠60秒窗口，不能称23次独立停顿；61份CAPTURE_STATS输出4167帧、复用2639帧，边界跨越浏览器采样窗口，不能等同独立抓屏数量。最佳支持的方向是抓屏/调度和资源压力，底层唯一根因仍未证实。

Viewer关闭后，同Signal时钟02:51:22.107进入epoch2 reset屏障，23.110重试一次，23.113记录唯一JSONL `control_reset_completed/applied/FREE`：进入至完成1006ms，重试至完成3ms。当前版本已有正向归零证据；历史事件名failed_closed不能直接称最终失败。stdout镜像不重复计数。

## 延迟与下一步

本次页面原始mark：点击至信令3201.8ms、点击至首帧8811.5ms、bootstrap699.5ms。这是单次启动，不能称P95；点击首帧超过8秒性能目标仍需保留，且不等于从首次media init计时的故障截止。301个frameAge快照P50/P95/max为40.6/221.5/2394ms；candidate RTT为43/269/619ms，jitter last299份为121.6/217.9/240.6ms，decode last299份为1.487/1.955/4.516ms。它们不是同一动作因果链，不能相加或把RTT除2叫单向耗时。

实际业务input ACK/Host排队执行/输入后捕获呈现/真实可见效果可用样本均0，保持null/NOT RUN。共享GUI的全局HID不能安全隔离，等待真实用户设备/独立环境的反馈；维护授权已具备，不重复询问。

继续按本轮失败复核Host/Signal有界日志、reset正向完成和采样/清理工具边界，再决定ResourceSampler完整spawn隔离或媒体处理隔离的独立spec/plan。三小时尚未通过；不以旧版本通过、短场次拼接、复用proof或更改媒体配置替代。服务保持运行。完整固定字段与缺测见[短测证据](evidence/2026-10-18-slow-start-idle-short/summary.json)。
