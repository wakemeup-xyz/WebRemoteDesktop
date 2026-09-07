# 整体完成度审查与暂停恢复后输入失效诊断

日期：2026-09-07（Asia/Shanghai）。审查人：主线程本人。

范围：近期控制连续性、Terminal / Formal watch、手机/iPad输入、沉浸全屏的交付状态，以及媒体暂停/恢复与输入的交叉生命周期；同时核对已有TURN验收结论。不是全仓逐行审计。

本轮只读核对代码、Git、服务、已存在日志与验收产物，运行离线测试，新增本报告和脱敏证据。**没有修改生产代码、commit、push、重启服务、操作tunnel，或新建连接到运行服务的Viewer。** 保留已有`review-anchors.md`等无关工作区改动。

## 1. 结论

**整体不能判为“全部完成且测试闭环”。** 近期功能已经合入、推送并部署，但“功能落地”“自动化通过”“真实使用可用”是三个不同结论：

- 沉浸全屏整改、移动输入整改及两份早期整改的代码已在main；旧验收报告的未合并表述属于当时快照，README的相同表述则已滞后。
- 本轮重新执行Viewer全量，**718/718通过**；输入/媒体相关Python测试**34/34通过**。这些测试没有否定下面的新反例。
- **新确认P1：失焦/隐藏时，尚未完成ACK确认的鼠标手势被升级为surface不确定状态；该状态同时禁止后续鼠标点击与实体键盘，恢复画面和输入reset成功也不会自动解除。** 没有未发文本草稿也会发生。
- 真实手机/iPad、系统IME、Quartz输入效果、正式公网控制、Terminal真实多端流程、live watcher故障恢复等仍未完成对应验收。watcher进程正在运行，不等于其恢复行为经过验收。
- TURN已有真实本机selected-relay长跑，但720p/1080p FPS中位数**13/6**低于**18/15**门槛，结论是**FAIL**，不是NOT RUN；清晰度脉冲和下一轮优化仍未关闭。

对于本次用户故障：已经找到并稳定复现**足以产生同一症状的代码缺陷**，且运行服务正在提供含该逻辑的资产；日志也确认今天发生过自动暂停、恢复和连接异常。由于故障时浏览器没有留存surface/draft门禁快照，不能声称已排他证明每次现场失效都只有这一个原因。

## 2. Findings（按优先级）

### R1 / P1：surface不确定性扩散成整个桌面的输入锁，正常恢复链没有出口

代码事实：

1. 所有鼠标/笔点击都经过`_sendMobileSurfaceDown()`，并非仅手机软键盘。down发送被接受后，`_beginMobileSurfaceGesture()`将surface设为`pending`；up已发送也要等down/up ACK全部确认才回到`settled`（`web-client/js/input.js:291`、`:436`、`:1095`）。
2. `window.blur`和`visibilitychange(hidden)`会执行pointer释放以及keyboard reset/park（`input.js:584`、`:593`；`web-client/js/webrtc.js:3164`另有控制生命周期监听）。
3. `resetKeyboard()`和`parkKeyboard()`调用`_resetMobileSurfaceContext({preserveUncertainty:true})`。该方法把已有`pending`转为`uncertain`，**清掉正在等待的gesture与定时器**，并令移动编辑上下文进入`reacquire-required`；此处即使没有草稿也执行（`input.js:267`、`:756`、`:771`）。拖拽取消发送mouse reset也会将pending升级为uncertain（`:450`）。
4. 之后到达的正常down/up ACK因gesture已清空而无法settle；mouse reset ACK至多解除`_pendingMouseReset`，keyboard reset ACK也不解除surface否决（`:344`、`:505`）。这不需要丢包：**失焦比ACK早一点即可触发**。
5. `_isMobileEditingActionAllowed()`同时检查draft不确定性和surface必须为`settled`。它被普通桌面`document.keydown`和鼠标`pointerdown`共同调用，因此两种输入会一起被本地拒绝（`:390`、`:552`、`:1095`）。
6. 恢复画面只完成媒体gate；`rebindActiveKeyboardLease()`把原lease交还Input，`setControlLease()`只有lease真正改变才清surface上下文，同lease重绑不会清理此状态（`webrtc.js:2943`；`input.js:166`）。

最短故障链：

```text
一次点击的down/up已发送，ACK未齐（或拖拽尚未结束）
  → 失焦/隐藏：reset/park将surface置uncertain，并丢弃等待关联
  → 自动暂停/恢复：Host恢复、ACK与新帧到达、原控制lease仍有效
  → media=active，Input.isActive=true，keyboard=READY
  → surface仍uncertain / draftDeliveryUncertain=true
  → 新pointerdown和实体keydown在Viewer本地被拦截
```

这里的“鼠标失效”严格指点击、拖拽起始等受该gate控制的操作；**桌面hover移动可能仍能发送**，所以“光标能动但点击/键盘无效”也符合这个缺陷，不能把它描述成所有鼠标报文都必然停止。

**恢复入口问题：** 已有`mobileInputDiscardBtn`的handler会清surface状态并discard草稿（`input.js:1389`），但reset/park已经隐藏`mobileInputDock`（`:711`）。无触控能力的桌面还会隐藏移动键盘按钮（`:658`–`:667`）。因此“检查远端后放弃本地草稿”的恢复方案没有为普通桌面提供直接可见的入口；全屏隐藏chrome会让状态更不明显，但不是本轮缺陷的必要条件。

`git blame`将主要surface状态和跨入口门禁追溯到`b75a2844`（移动输入整改），不是仅在最后的全屏CSS提交中出现。问题涉及跨功能的状态组合，不能仅回滚全屏样式解释。

**与需求冲突：** `docs/需求文档/WebRemoteDesktop-需求文档.md:79`声明短暂失焦不得制造无法自动恢复的reset barrier。虽然本例keyboard transport自身已READY，但surface/draft的额外屏障仍使用户无法输入，实质上没有满足该要求。

### R2 / P2：诊断与“键盘就绪”没有反映最终生效的输入门禁

- `Input.updateKeyboardUI()`主要展示keyboard controller状态（`input.js:627`）；本反例中显示READY并不代表keydown会被接收。
- `WebRTC.canEnableDesktopInput()`只覆盖lease、媒体runtime、暂停原因和attempt readiness（`webrtc.js:296`）；它不含surface、draft、viewport等下游否决。
- `Input.getDiagnosticState()`没有surface状态、移动draft不确定性和最终editingAllowed；已有`pendingMouseReset`、`desktopWriteRecovery`又在`Diagnostic.sendLogs()`重组`inputState`时被丢弃（`input.js:785`；`web-client/js/diagnostic.js:281`）。Signal的白名单也没有surface字段（`signal-server/lib/diagnostic.js:23`）。

影响：现场可以同时表现为已连接、媒体active、键盘READY、输入仍无效；默认Host诊断仅保存摘要，无法从本次留存日志还原最终拒绝原因。建议补充有界状态、拒绝原因、当前epoch/attempt及恢复动作可用性，不记录key、文本、坐标、lease token等敏感原文。

### R3 / P2：当前状态文档与真实交付/验收状态混在一起

- `README.md:61`仍写移动整改“尚未合入main或重启服务”，与现在Git、服务启动时间和运行资产不符。
- 历史移动输入验收报告可保留当时的“未合main/未push”；不能把那一段当作当前状态，也不能把其“无未解决P1/P2”外推到本次新发现的组合场景。
- README/runbook部分TURN段落仍笼统说真实relay是NOT RUN；后续版本化报告已经有600s/300s本机selected-relay长跑，且明确FAIL。应区分“本机selected-relay已跑但不达标”与“正式公网/物理控制仍NOT RUN”。

本轮只在本报告给出最新状态，没有改写历史验收记录或把新发现混入旧报告的历史结论。

## 3. 本轮确定性复现

执行：

```bash
node docs/superpowers/reports/evidence/2026-09-07-resume-input-diagnosis/reproduce.cjs
```

使用当前真实`Input`、`KeyboardTransport`、`RemoteKeyboardController`、`MobileTextInput`、`WebRTC`和`MediaActivityRuntime`模块；DOM、传输、ACK和时钟在VM中模拟。没有网络、Host实例或Quartz操作。媒体恢复按真实runtime的匹配ACK和fresh-frame契约推进，但**不是浏览器渲染或真机5分钟后台试验**。

| 场景 | 结果 |
|---|---|
| 点击down/up均已ACK，再失焦恢复 | 后续实体keydown正常发送（对照） |
| 无在途手势，失焦恢复 | 后续mouse down正常发送（对照） |
| down/up均已发送，失焦先于ACK；随后所有ACK到齐 | 恢复后点击/keydown发送数均为0，复现 |
| 拖拽down已ACK，失焦取消；mouse/keyboard reset全部ACK | pendingMouseReset已解除，surface仍uncertain，复现 |
| 鼠标ACK超过3000ms，随后迟到ACK与恢复 | surface仍uncertain，复现 |
| 声明触控能力，执行hidden/visible两个真实监听链 | 恢复后仍被拒绝；直接调用现有discard handler可解除，本例未验证隐藏控件的实际点击可达性 |

四个反例都出现：`mediaPhase=active`、`commonGate=true`、`isActive=true`、`keyboardState=READY`、`pendingMouseReset=false`、**`hasPendingDraft=false`、`surfaceState=uncertain`、`draftDeliveryUncertain=true`、`editingAllowed=false`**。

输出见[results.json](evidence/2026-09-07-resume-input-diagnosis/results.json)。脚本退出0表示六个场景准确验证了当前行为，其中四个是缺陷反例，**不是修复后验收PASS**。

为什么原测试通过：现有测试覆盖surface failure/timeout后继续拒绝文本、keyboard ACK不得越权清surface否决、discard恢复等（`input.test.js:1682`、`:1714`、`:1783`、`:2043`），也单独覆盖media gate不建keyboard reset barrier（`:2531`）。缺少的是“无草稿的普通桌面→失焦/暂停→reset全部确认→恢复→实际新点击与keydown成功”跨模块断言。局部安全条件成立不等于恢复能力完整。

## 4. 现场日志与运行事实

证据采集约15:24–15:35，时区为北京时间；只读脱敏摘要及采集时原文件SHA256见[runtime-log-summary.json](evidence/2026-09-07-resume-input-diagnosis/runtime-log-summary.json)。运行日志会轮转，后续调查以该快照为准。

- 13:03:12：`host_media_suspended`，原因`page-hidden`。
- 13:59:42：原attempt记录`host_media_resumed`，随后新attempt先`host_media_resume_failed(reason=closed)`；13:59:43.008日志记`Closing peer connection reason=new-offer`，13:59:43.244新attempt恢复成功。
- 13:59:42–14:01:42：留存可靠输入事件只有两次keyboard reset接收/处理；没有mouse down/up或keyboard key事件。它与前端拒绝相容，但没有用户尝试记录，**不能仅据事件缺失推断所有点击都曾被拒绝**。
- 14:09:44和14:59:20又记录`page-hidden`暂停；14:56:08、15:17:48诊断摘要分别有`ice-disconnected`、`dc-stuck`。15时段有39条unbound/stale DC警告，部分呈15秒节奏，可能来自keepalive；不能把这些警告全部算成人工输入丢失。
- 15:17:48后的重连窗口又有mouse down/up、keyboard key等接收/处理记录。因此不是“服务自启动后一直无法输入”；也不能用日志事件名`host_input_executed`直接证明Quartz效果，事件本身未保存ACK结果状态。

采样时服务检查：

- Signal PID **30999**、Host PID **31059**存活；进程启动时间分别为09-06 **21:50:54 / 21:51:05**。
- 本地`/health`正常，`/api/status.hostOnline=true`，有**1**个Viewer。没有为测试建立第二个Viewer，避免strict-single-viewer踢掉现有用户。
- 正式入口`https://link.stockhub.wiki/health`在本机探测为HTTP 200、`status=ok`。quick tunnel helper也报告已有地址可达。两者仅证明本机发起的HTTP入口检查，不证明手机、公网WebRTC或远端输入效果。
- 服务实际提供`desktop-core.d9b8835025941953.js`，内容与磁盘dist逐字节相同；SHA256为`d9b8835025941953d8a64c9cd987e35d3fdcf798adeab9c14216de3646fb124f`，包含surface gate。dist构建时间为09-06 21:50:55。
- Formal watcher的LaunchAgent为`running`，状态文件`lastStatus=healthy`。本次没有制造边缘故障、执行watch tick或restart，因此不能替代live watcher恢复验收。

本轮没有直接检查或操作故障浏览器的运行时对象，也没有验证macOS锁屏/Secure Input状态；它们不是已排除项。已知缺陷无需这些前提即可复现。

## 5. 真实完成度矩阵

| 工作线 | 代码 / 自动化 | 合并 / 运行 | 仍未闭环 |
|---|---|---|---|
| 控制连续性整改 | 已实现；历史Viewer572、Signal323、Host212通过 | 已在main；相关运行资产已加载 | 本次R1重新打开恢复连续性；真机、Quartz及正式公网输入验收 |
| Terminal / Formal watch整改 | 已实现；历史Terminal Viewer122、Signal164、脚本111通过 | 已在main；watcher当前running | 真实单/双端Terminal、detach/re-attach、PTY效果、watcher故障恢复/预算/长跑 |
| 手机/iPad输入整改 | Task1–7已实现；历史离线Chromium12场景通过 | `f2e694a`等提交已是main祖先 | 本次R1/R2；真实触屏、系统IME/软键盘、WebKit、Quartz |
| 沉浸全屏 | Task1–4及后续root/focus回归已实现；历史离线Chromium12场景通过，本轮Viewer718通过 | 已经合入并推送；当前dist在线 | 真实iOS/iPad/Safari和设备全屏入口/退出验收；不能借本项通过覆盖输入恢复缺陷 |
| Viewer启动 | 已存在合并后本机20冷+20暖，共40/40成功的产物 | 产物commit=`07c99dd`；本轮核验文件和摘要 | 正式公网与不同物理设备的同口径验收；启动成功不证明pause/resume后的输入效果 |
| TURN画质/吞吐 | 已有实现、自动化及真实本机selected-relay采样 | legacy策略运行；后续优化仅设计/计划 | 600s/300s长跑FPS未达标；清晰度脉冲、受控文本/输入、有限丢包、正式公网/物理端 |

历史数量来自各工作线验收报告，**不是本轮全部重跑，也不相加计算总完成率**。参考：[控制连续性](2026-09-03-remote-desktop-control-continuity-acceptance.md)、[Terminal/watch](2026-09-05-terminal-formal-watch-task5-acceptance.md)、[移动输入](2026-09-06-mobile-input-interaction-remediation-acceptance.md)、[全屏设计状态](../specs/2026-09-06-immersive-fullscreen-chrome-design.md)、[TURN后续运行证据](2026-09-06-turn-pulse-followup-implementation.md)。

Viewer启动产物：`/tmp/wrd-main-viewer-bootstrap/viewer-bootstrap-20260906T135359.910055Z.json`，本机origin，40 attempts / 40 success / 0 failure；stable-non-black P95=977.3ms；SHA256=`44521b2ee2c3b5f54e18b325ffec25e8b5327319289143a632d49b1490b6431c`。本轮只核验已有产物，没有重新发起40次连接。

### Git核对

- 当前本地分支：`main`，HEAD=`39fa1eadc89b00546e2bf66f1ed1d1e6f892ca42`。
- 通过`git ls-remote --heads origin main`核对真实远端：`07c99dd6f62900c7cd870cba2f66e2c307cf9bf7`，也是全屏合并提交。
- 本地比远端**多1个后续TURN文档/方案自审提交**`39fa1ea`，共6个文档/证据文件，无生产代码差异。不是全屏或移动输入功能漏合并。
- 本轮新报告/证据保留未提交；未擅自推送该后续文档提交。

## 6. 本轮验证清单

| 检查 | 结果 / 边界 |
|---|---|
| `node --test web-client/js/*.test.js web-client/css/*.test.js` | exit0，718 passed，0 fail/skip，8.561s |
| `node --test --test-reporter=dot web-client/js/keyboard-transport.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/media-activity-runtime.test.js signal-server/websocket/signaling.test.js` | exit0；聚焦真实传输、controller、runtime及Signal契约，不含真机输入 |
| `python3 -m pytest -q python-host/test_remote_keyboard_state.py python-host/test_remote_desktop_write_state.py python-host/test_media_suspension.py` | exit0，34 passed，3.63s |
| 本报告`reproduce.cjs` | exit0；2个正常对照、4个失效反例，未修复 |
| service helper `status` / formal `/health` / dist字节校验 / Git remote | 均已实际只读执行，结果如上 |
| 浏览器接入现有服务、真机/Quartz输入、重新执行live watcher恢复 | 本轮NOT RUN，未用模拟结果替代 |

## 7. 修复方向与重新验收门槛（不是本轮实施）

1. 优先处理R1：把“本地文本草稿上下文不确定”与“允许用户发起新的桌面操作”分开；为当前lease的pointer/reset确认设计明确的恢复出口。没有草稿且安全释放已经确认的常规失焦恢复，不应永久冻结普通鼠标键盘。
2. 不能简单在恢复新帧、普通ready、迟到ACK或同lease重绑时无条件清全部uncertain；那会破坏原有防止草稿送往错误焦点的保护。新输入恢复、旧草稿保留/放弃、旧事件不重放需要分别验证。
3. 恢复按钮与最终拒绝原因应对桌面、手机、全屏都可达；不能只藏在已经收起的移动键盘Dock中。再补R2的端到端脱敏诊断字段。
4. 将本报告四个反例转成针对修复目标的正式回归：无草稿点击/拖拽+失焦、ACK在reset前/后到达、正常/断DC、长隐藏、同lease/新lease、失败reset、旧ACK、Terminal往返及全屏。必须实际断言恢复后的新mouse down/up与keydown/keyup成功，而非只看`active`、READY或出画。
5. 之后补真实浏览器与手机/iPad、Quartz效果和公网控制验收；TURN吞吐/画质和watcher故障恢复保持独立交付线，不用本次输入修复的PASS替它们关单。

**最终判定：功能代码已交付，但产品验收未全闭环；暂停恢复后的输入连续性存在本轮已确认的P1缺陷，应先修复并补交叉生命周期测试，再恢复“输入连续性完成”的声明。**
