# 手机 / iPad 输入优化方案审查

日期：2026-09-06。范围：设计与实施计划，不是生产代码验收。

- [设计](../specs/2026-09-06-mobile-input-interaction-remediation-design.md)
- [实施计划](../plans/2026-09-06-mobile-input-interaction-remediation-plan.md)
- [F1–F7 原始问题与离线证据](2026-09-05-mobile-touch-keyboard-logic-review.md)
- 生产基线：`000547ff37dc1a05c3b5b953954af81e9ed7d43a`。
- 独立审查：`gpt-5.6-luna` / `xhigh`，只读；主线程负责文档修订与核对。

## 审查发现与修订

首轮结论为 **NEEDS REVISION**：1项P1、7项P2。原报告的7个产品问题是此次整改输入，不把它们重复算作方案新缺陷。

| 编号 | 级别 | 方案问题 | 修订位置与验收约束 |
|---|---|---|---|
| R1 | P1 | lease直接替换会清transport pending并回ready，但旧草稿未必失效 | spec§4.2 / Task3：setControlLease比较id/epoch，在controller.setLease之前reset('lease-changed')，清草稿/任务；直接替换、撤销再授予、相同lease幂等均测试 |
| R2 | P2 | textarea物理modifier被拦截，code单参数不足 | spec§5 / Task4：传四flags至sendControlKey/sendKey，Input转换既有sendChord的shift/ctrl/alt/meta布尔对象（不是数组）；完整平衡chord不另发modifier down/up；真实textarea Shift+Arrow及batch flags测试 |
| R3 | P2 | beforeGesture预检与实际down成功无法原子更新文本基线 | spec§5 / Task2、4：预检只读，commitGesture包装真实sendMouse，down接受后才清历史；延迟long-press期间草稿变化需重新核对 |
| R4 | P2 | failed down后PRESSED存活，后续move可能重试 | spec§6 / Task2：consume清timer/队列/pointer/capture，generation失效；失败reset接受也不能补发down |
| R5 | P2 | 几何更新中reset后，当前事件可能继续发旧move | spec§6 / Task2：固定签名、pre-map检查、map后generation检查、rAF/long-press检查；一次reset且无旧move |
| R6 | P2 | transport小写与controller大写状态桥接含糊 | spec§4 / Task3：Input唯一新增transport订阅，明确初始同步、unsubscribe、ACK刷新；controller READY仅用于isEnabled |
| R7 | P2 | 纯函数未规定CSS落点，旧flow/dvh/inset仍可能叠加 | spec§7.1 / Task5、7：managed固定坐标、五个CSS属性、safe-area probe；真实DOM top/bottom误差≤1px断言 |
| R8 | P2 | 单行compact未说明如何处理现有两行按钮DOM | spec§7.1 / Task5：两组保留DOM并排横滚，父高44px；末键可达、role保留、点击不重复发送 |

主线程另修订：offsetTop不增加可用高度、compact模式不依赖反馈高度、极小视口140+safeBottom降级、不用pending清空伪装投递确定、普通ACK刷新重试UI、退出全屏按钮静态移入全局状态栏且不受桌面lease门禁。

## 复审结论

此前独立复审结论：**PASS（规划层面）**，针对当时R1–R8。下述主线程复审已推翻其作为整份方案最终结论的效力，不应据此直接宣称全部边界闭环。

修订后首轮复审确认7项闭环，仅R2的modifier表示仍不符合现有controller接口。主线程检查remote-keyboard-controller.js的chordModifiers(value)后，将两文档同步为布尔对象，保留现有pressed合并；同时统一布局示例的clamp与归一化。最后一轮独立复审确认这两处已解决，才给出上述PASS。该PASS不表示生产代码或真机验收完成。

## 验证与边界

文档静态检查已验证：6条全局约束逐字同步、7个任务均存在、14个公开接口/门禁关键字在spec与plan对应、相对链接存在、无TBD/TODO/FIXME、git diff --check通过。

本轮没有修改生产JS/CSS/HTML，没有运行实现后的测试，也没有启动/重启服务、操作tunnel、merge或push。原报告151项单测及离线缺陷复现是带日期的历史基线，不是新方案已经实现的证据。

交付分层：设计/计划可审查；代码整改仍待实施；真实手机/iPad、系统键盘、Quartz、公网、live watcher仍为NOT RUN。后续必须按Task1–7逐项red→green和独立代码审查，不得把本报告当作产品验收PASS。

## 主线程追加复审与修订（2026-09-06）

主线程本人对照代码重新审查，运行隔离Node夹具确认3个遗漏，原结论改为NEEDS REVISION。用户随后授权修订文档并由luna/max实施测试，最终review仍由主线程本人完成。

| 编号 | 级别 | 证据与遗漏 | 已并入的实施契约 |
|---|---|---|---|
| R9 | P1 | 画面Shift down→移动框keyup被stopPropagation且document路径跳过，pressed=1、sendText=false；直接交还trackedKeyup后恢复 | spec§5 / Task4：releaseTrackedKey callback先释放已跟踪键，再去重，保留所有安全释放；新textarea chord不多发up |
| R10 | P1 | sendMouse down返回id后收到execution-failed，keyboard仍ready并接受文本；原计划只认传输接受 | spec§5.1 / Task4：Input surface确认门禁，手势结束且down/up成功ACK才settled；失败/超时uncertain、迟到无效，不跨系统混建队列 |
| R11 | P2 | 普通modal送X但mobile仍留abc基线，后续left/Y导致游标不一致 | spec§5.2 / Task4：modal开/提交接统一门禁，接受后失效历史，取消/失败保留 |

追加发现已写成具体接口、状态、超时与测试要求，尚须通过实施证据闭环；不再给仅文档修改标新的最终PASS。该复现只证明现有模块行为与计划遗漏，不是实机/Quartz/公网验证。
