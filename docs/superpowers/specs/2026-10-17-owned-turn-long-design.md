# TURN 长会话进程归属与故障采样增量

已有私有supervisor在300s诊断窗口中完成301次连续采样，7个已登记测试身份自然退出，未触发sample。现将同一归属逻辑用于计划中的10800秒连续性验收，不改变生产helper/proof/媒体策略。

## 最小变更

- 现有300s诊断路径与2秒触发保持；新增明确的10800s TURN连续性路径，复用原helper的同身份、path、帧进展及5秒失败门槛。依旧单次proof，首次断开/身份变化由helper退出，无重连绕过。
- worker参数使用所选duration；独立supervisor上限为duration+300秒，清理预算仍外加有界1+3+2秒。只允许300、10800，不接受任意脚本/origin/mode；relay保持。
- 固定Host PID不再硬编码87412：由root显式传入正整数，并与两份现有PID文件、create_time核对；不自动选择/重启替代Host。Host身份变更拒绝sample。
- 10800s路径仅在已观测frameAge>=5000ms时启动一次sample；该样本已先满足原helper失败条件，所以后续栈扰动不把原本PASS变为FAIL。未触发sample且连续性/完整时长通过时，可报告被动TURN连续性PASS；仍不是原生输入/光学/端到端可见效果验收。触发后的长停顿幅度标记受采样影响，原始首次超限样本保持可审计。
- preflight明确kind与采样阈值，final明确是否实际启动sample；不得重写原helper/lifecycle结果。完美进程树退出仍不可证明，只报告已登记身份。
- 补旧review两项P3：所有合成临时文件留私有root且0600；fake execute覆盖worker cleanup期间sample10秒超时和sample子进程hard/soft8MiB/无core限制设置。
- 不修改生产源码、依赖、网络设置，不运行live测试。私有目录/样本原权限及字节上限不变。

## 验证

原10项回归、新300与10800参数/workerdeadline、动态Host拒绝/匹配、long4999不触发/5000触发且单次、short2000不触发/>2000触发、sample超时独立于worker清理、RLIMIT配置、original artifacts不改。独立复核后root在最终Host部署稳定且fresh zeroViewer时开始一次长会话。

## 后续增量：关闭码观测（Task 3）

新版本131.953秒窗口的首事件为客户端transport-close；五次ping均有pong，媒体正常推进。Cloudflare没有本会话关闭日志，已有reason不足以唯一归因。已安装Engine.IO及实际构建使用的Socket.IO bundle确认：原生ws.onclose事件经`{description:'websocket connection closed',context:closeEvent}`原样作为engine close第二参传递。

本增量仅允许修改验收工具`passive_session_sampler.js`的ec projector与`passive_session_soak.py`的严格事件验证，不改变页面业务、proof、启动、恢复或测量阈值。此前“原helper不改”约束对这项明确的诊断字段扩展更新：仅扩展数据schema的向后兼容可选字段，所有准入/连接行为仍原样；private supervisor必须在review后显式更新为新确切文件SHA，旧run及其hash不改。

ec仅在reason精确为`transport close`、details.description精确为固定字符串时读取details.context的code/wasClean。code必须非boolean整数1000..4999，wasClean必须真正布尔；两者完整且有效才记录可选`ws:{code,wasClean}`。缺失/类型错/getter抛错全部省略ws，不能填false/0。安全读取的异常不逃出监听器。只复制这两个原语，不记录CloseEvent.reason、error/message、URL/IP、payload或对象；不读取它们。已有r固定枚举保持。

schemaVersion1保留：旧ec无ws仍有效，新ws仅允许ec且恰有上述两个键，Python拒绝其他终态/未知键/非有限数值/boolean-code/string-bool；192B每event及全部ring/delta/final上限保持。元数据若出现在晚于sd/mc的ec，仅留在该ec，不能事后重写firstDisconnectEvent归因。code1006不证明具体网络节点，wasClean也不证明发起方，cause仍unknown。

仅合成Node事件/Python validator回归；无真实连接/生产重启。本次不新增原生WebSocket包装器、CDP或日志框架。等待人工实测期间不创建Viewer；下一次自动实验仍须fresh zeroViewer和一次性proof。
