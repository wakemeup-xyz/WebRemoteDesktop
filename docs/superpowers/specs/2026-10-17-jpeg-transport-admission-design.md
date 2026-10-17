# JPEG 传输准入设计

状态：完成上下文及独立方案审查，待实施。用户已授权完成修复及维护验收；保持 tunnel 不变。

## 已证实问题与方案

ACK metadata 的 2000ms TTL 会释放应用槽位，但 `await sio.emit` 在当前 python-socketio5.16.1/python-engineio4.13.1 中只完成无界 asyncio.Queue 入队。旧图片仍可被队列或 writer 已取出的 batch 持有，继续捕获/提交会积压。离线六帧复现中，metadata 只剩一项，队列仍有六张图片。历史 5.2 秒停帧的起因尚未确定，不能因修复该风险就认定历史故障已解决。

采用每次 JPEG 捕获前等待当前 Engine.IO queue.join 的保守准入。它覆盖尚在 queue 以及被 writer 取出但未 task_done 的工作。超时只继续阻止准入，不清理共享队列，不把超时作为已发送。独立 worker 阶段观测同时推进，以定位实际停顿。

替代方案：改变全局 queue.maxsize 会在二进制 envelope/attachment 之间增加真正的 await，带来交错/取消风险；重写或 monkeypatch writer 扩大依赖和恢复面；只调整 ACK TTL 无法释放传输字节。均不采用。

## 不变量与范围

- 当前同一 Engine.IO queue 在首次 gate 排空旧积压后，最多一项未完成 writer accounting 的 JPEG event；单个 JPEG 仍 ≤16 MiB。
- 这不等于只持有一个 JPEG 对象：库 writer 的局部变量可能保留上一已完成图片。因此原始 JPEG payload 引用可覆盖上一完成项和当前项；不对 polling 编码副本、其它控制消息、aiohttp、OS/native、断开旧 client 做总内存上限承诺。
- queue.join 不是网络 flush、Signal receipt、Viewer load 或输入可见效果，也不是排他 drain-and-reserve。证明依赖应用仅一个 JPEG producer、替换 producer 也先 gate、现有无界 queue.put 不在完整二进制 emit 中间实际切换任务。
- 不改全局队列、库 writer、共享 accounting、自动重连、ACK TTL/window、profile/FPS、分辨率、质量及控制身份协议。

## 捕获 token 与完整校验

每次活动迭代捕获 token：当前 asyncio task、production generation、relayScope 的值拷贝、sio、eio、queue、write_loop_task。有效条件：enabled、非 suspended、有 viewer、self.task 和 current_task 均等于 token task；现有 _production_is_current（含 authority callback）成功；sio/eio/queue/writer 对象均相同；Socket.IO connected，EIO state='connected'，writer 存在且未 done；queue 有可调用 join。缺失或异常 fail closed。此 token 不输出日志，不引入新的授权。

一个旧 streamer 的 self.sio 本身不能证明 Host 当前 authority，必须保留原 callback。等待 gate、等待反馈、等待 worker 后，以及安装 inflight/开始整个 emit 前，均验证原 token；不能给旧捕获结果重新取一个新 token 来绕过检查。使用 token.sio.emit。

## 循环与失败行为

1. 保留暂停/authority 无效分支。可先 expire ACK metadata，但不能据此跳过 gate。
2. gate 以 `await asyncio.wait_for(queue.join(), timeout=0.25)` 等待，不 shield。Timeout 返回未准入；每次仅一个 join waiter，超时/取消均清除它。CancelledError 原样传播。无队列、writer 已退出等立即失败须 `await asyncio.sleep(0.25)`，避免忙循环；post-await 校验失败也保证让出 loop。
3. 成功 gate 后才 emit due feedback，随后完整校验；ACK window 的等待仍保留，等待结束回到循环头重新 gate。移除 ACK timeout 分支的直接反馈发送，避免每次重试向堵塞队列继续累积反馈。传输 gate 超时不进入 ACK timeout/profile 统计。
4. 校验→提交 worker→await 结果→完整校验→安装 inflight→完整校验→整个 emit。现有错误清理、JPEG 引用释放和 pacing 保留。
5. stop 取消 gate，不 task_done/清空共享队列；set_suspended 改 generation 后，最多下次 250ms gate 轮次看到暂停（事件循环调度延迟另计）。resume 与 replacement start 首帧同样 gate 旧 queue。旧 queue 的完成不能授权新 client，新的正常 client 不等旧 orphan queue。
6. writer 发送失败可能留下无法完成的 accounting；缺失/已死 writer 永不因 queue 空而放行。不强制重连，复用 poisoned queue 持续阻止媒体准入，既有 Host 连接恢复负责替换 client。等待全部队列流量可能在持续控制流量下延后 JPEG，接受此保守权衡。

## 验证与运行

测试使用实际 asyncio.Queue、实际 streamer 方法、fake capture；不启动浏览器/网络/原生捕获。覆盖 qsize=0 但取出未 task_done、多次 timeout、ACK expiry、feedback 不累积、stop/start/resume、client/queue/writer/task/authority 变化（包括 capture await 期间）、dead writer、取消 join waiter及健康路径。旧 FakeSio 补齐真实 queue/connected/writer 合约，生产不得绕过缺失属性。

另用已安装实际 AsyncClient 的 disconnected synthetic emit 验证 envelope+attachment 同轮入队，禁止 connect/writer/network/native import。若实际库行为与设计依赖不一致，停止该实现并修订方案，不放宽约束。

review 通过后受控同步并 Host-only reload，保留 tunnel/primary HEAD/index/用户修改。guarded short JPEG/TURN、暂停恢复及长会话独立记录。此前 FAIL 与输入→可见效果缺测保留。
