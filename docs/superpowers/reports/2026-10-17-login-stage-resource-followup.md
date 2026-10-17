# 登录分段与整机资源补充诊断

时间：2026-10-17 13:42–13:45 北京时间。部署仍为 d0c1223 / Viewer build a6e8b15122bde656；worker stages 00d1a81 已离线审查通过但未加载，传输 gate d5ecb23 已通过116项定向测试和独立审查但未加载。

## 实际登录失败

原 guarded JPEG 尝试耗时50.0547s、0采样，登录阶段超时，未执行 Start/proof/创建 Viewer。随后仅登录分段探针：总耗时82.9226s，root HTTP200、当前 login asset200，无 pageerror；登录提交约42.810s，/api/auth/login 在50.708s requestfailed，无该请求 response 记录。页面保持根路径，显示 timeout，按钮已恢复可重试，WebRTC 未加载且 Viewer 未连接。约7.9s 请求窗口与现有8s客户端截止时间一致，但不能由 requestfailed 确认后端是否收到或执行。

因此本次具体失败在认证请求/跳转之前，不是 Viewer核心脚本下载后的等待。root响应约24.671s、entry阶段完成41.639s均从整个探针开始计（含浏览器启动），不可当单请求TTFB或网络耗时。此前13:19 root导航9.590s是另一窗口，不能混为同一时延样本。

只读取响应path/status/相对时刻与枚举页面状态，不保存密码/token/响应正文/桌面内容。没有Start/proof/业务输入。browser.close API超时，manager.stop API完成；本次通过CDP记录的所有浏览器进程ID在结束时均已不存在。不能把这项新证据倒推到以前未记录PID的浏览器。

## 新的资源证据

13:44受限快照 load641.71/514.48/369.59，swap used30240.25MiB/free479.75MiB；两次vm_stat约2秒间有372MiB换入、327MiB换出。最近5分钟Host有32条critical滚动窗口，其中22条当前采样lag≥1s，当前采样最高40.127s；Signal Node窗口最高41.329s/missed52。滚动窗口重叠，不能写成32次独立故障。Host媒体空闲仍延迟，说明不能只修JPEG编码来解决全部网页/心跳故障。

共享资源压力是已实测的关键运行条件，可以同时延迟浏览器、Node、Host及网络处理。CPU前列有Codex Renderer/Service、WindowServer、Chrome；单点CPU不能证明泄漏/唯一责任。未停止、修改或重排任何其它应用/项目。已请求用户释放其它负载，同时继续当前离线修复。

## 处置顺序与验收

1. 不通过反复重启或增加心跳/登录超时掩盖整机调度停顿；保留已有自动重连和有界错误提示。现有Host曾13:33:51断开、13:33:56自行恢复，同PID。
2. 先让共享主机有可持续资源余量，再进行有代表性的真实连接测试。不能依据未释放资源时的 health 偶尔200宣称服务稳定。
3. 继续最小源码修复：worker processor/delivery阶段观测（23+6离线PASS及独立PASS）；每次捕获前的transport queue.join gate（独立设计已完成，116项定向测试与独立审查通过、未加载），不修改tunnel和质量。
4. 经独立review后仅Host受控重载，再执行fresh zeroViewer单次proof短JPEG/TURN、暂停恢复；成功后才启动长会话。仍缺原生隔离输入可见测试，保持NOT RUN。

证据：[共享资源](2026-10-17-shared-resource-correlation.md)、[初次登录失败复核](2026-10-17-reset-login-failure-review.md)、[本地超时与自动恢复](2026-10-17-local-timeout-runtime-review.md)、[JPEG传输缺口](2026-10-17-jpeg-transport-backpressure-review.md)。本地私有原始探针位于 /tmp/wrd-c5-rollout-private-ilovzfv1/login-stage-probe-20261017a.json。
