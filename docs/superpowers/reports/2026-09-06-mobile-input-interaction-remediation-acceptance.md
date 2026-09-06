# 手机 / iPad 输入交互整改验收

日期：2026-09-06。状态：**Task1–7开发、自动化及限定复审完成；主线程本人最终整分支review通过，无未解决P1/P2。代码整改完成，不代表真机/公网全链路验收或部署完成。**

- 分支：`codex/mobile-input-interaction-remediation`，从`main@195e0c6`隔离开发；生产整改提交至`bfc886d`，最终验收脚本至`f2e694a`（初版`0a346eb`、补强`efeb25e`、组合键覆盖恢复`f2e694a`）。
- [设计](../specs/2026-09-06-mobile-input-interaction-remediation-design.md)、[计划](../plans/2026-09-06-mobile-input-interaction-remediation-plan.md)、[原F1–F7问题与红态证据](2026-09-05-mobile-touch-keyboard-logic-review.md)、[方案审查及后续纠偏](2026-09-06-mobile-input-interaction-remediation-plan-review.md)。
- 开发/测试subagent：`gpt-5.6-luna / max`；各任务限定review与主线程独立复核分开记录，最终whole-branch review由主线程本人执行。
- 未合main、未push、未重启本地服务、未操作tunnel或改变公网地址。代码与文档在开发分支，不代表运行服务已加载。
- 收尾只读检查时main已由其他任务推进至`6c0c652`（TURN质量/运行时采集工作）；本分支与main的共同基点仍为`195e0c6`，`efeb25e`未包含在main中。本报告的测试只证明本分支，未验证与新main合并后的组合结果；未擅自rebase或混改其他子系统。

## 1. 按原问题编号的状态

| 编号 | 已实现的整改 | 当前模块自动化 | 完整集成 / 真机边界 |
|---|---|---|---|
| F1 | 门禁/连续帧不再抢焦点；明确用户动作及有条件返回焦点 | PASS，包含真实Input与媒体回调回归、离线DOM探针 | 非空composition内120帧门禁/焦点及后续编辑链PASS；系统IME/真机NOT RUN |
| F2 | ChromeLayout单点计算遮挡，managed布局取消重复高度扣除 | PASS；离线真实几何与原生按钮动作通过 | 完整44组合及每次重新测量的20帧稳定性PASS；系统键盘NOT RUN |
| F3 | 导航、modifier、实体键与modal接入已有编辑事务；surface down/up确认独立门禁 | PASS；ACK乱序、keyup安全释放、跨入口基线和显式重试回归 | 组合动作/内容及游标内存模型PASS；Quartz NOT RUN |
| F4 | down使用最初触点；几何变化取消旧工作；修复提示造成的自取消拖拽 | PASS；主线程真实DOM鼠标事件probe已由FAIL转PASS | 跨帧拖动、up/reset/第二指/lease隔离与ACK门禁PASS；真实触屏NOT RUN |
| F5 | 已接受前缀与本页未发草稿分离；有限删除、显式retry/discard、lease/generation隔离 | PASS；普通在途ACK仍允许正常连续输入 | 部分失败/显式重试/真实16步删除后取消PASS；真机NOT RUN |
| F6 | 按触控能力显示宽屏键栏；compact/ultra、safe-area与unsupported派生门禁 | PASS；保留可信已接受手势与安全释放 | 899/900跨界、More、收起恢复、Terminal与inset300恢复控件PASS；iPad NOT RUN |
| F7 | documentElement完整Viewer全屏、全局退出、API失败提示及编辑焦点保护 | PASS；UI11/11及原生按钮探针PASS | 全屏重入/窄屏/idle/Terminal/no-lease退出及失败回退PASS；iOS/Safari NOT RUN |

上述PASS均指离线自动化，不把实机缺失折算为通过；最终审查状态与执行结果分开记录。

## 2. 已实际运行的命令

主线程独立执行（隔离worktree，基础全套在已提交版本`0a346eb`；Task7修复后独立结果单列于下，不是agent报告的转述）：

| 工作目录 / 命令 | 退出码 | 结果 |
|---|---|---|
| 仓库根：`node --test web-client/js/*.test.js web-client/css/*.test.js` | 0 | 690/690，通过；无skip |
| 仓库根：`node --test scripts/mobile-input-interaction-acceptance.test.js` | 0 | 4/4，通过；含正常CLI、隐私、缺运行时及启动后失败分类 |
| 仓库根：`python3 scripts/mobile_input_interaction_acceptance.py --out /tmp/wrd-mobile-primary-final-chromium.json` | 0 | Chromium 12/12场景PASS；布局44组合、913检查 |
| 仓库根：`python3 scripts/mobile_input_interaction_acceptance.py --browser webkit --out /tmp/wrd-mobile-primary-final-webkit.json` | 2 | WebKit 12/12 NOT RUN：browser-runtime-missing |
| `signal-server`：`npm run build:web` | 0 | 构建完成；构建图包含现有移动模块、Input、ChromeLayout与UI |
| `signal-server`：`npm test` | 0 | 332/332，通过；无skip |
| 主线程临时离线`primary-drag-layout-probe.py` | 0 | `bfc886d`：布局稳定、down/up成对、无自触发reset；旧生产为exit1 |

Viewer输出包含既有离线WebRTC配置fetch缺失的fallback提示，未将输出描述为无警告。逐任务报告另记录RED→GREEN；追加拖拽修复的命名单测先0/1、后1/1，完整Input99/99，MobileTextInput/ChromeLayout/CSS89/89。这些子集与690全套有重叠，不相加制造总数。

Task7首次限定审查确认4项测试缺口：R11原断言只测已为false的pending，R12没有在门禁内实际OFF，R9没有真正切换焦点，外部几何变化没有放进正在执行的手势。主线程独立负向控制证实前两项原场景会容忍故意回归；这些是验收证据缺陷，不代表生产实现已被证明错误。`efeb25e`补齐4项，主线程在该提交独立执行：

| 命令（仓库根） | 退出码 | 结果 |
|---|---:|---|
| `python3 scripts/mobile_input_interaction_acceptance.py --out /tmp/wrd-mobile-primary-fix1-chromium.json` | 0 | 12/12 PASS；44布局组合、913检查；physical 8、surface 33、modal 23、virtual modifier 24项布尔检查全部通过 |
| `node --test scripts/mobile-input-interaction-acceptance.test.js` | 0 | 4/4 PASS；无skip |
| `python3 .superpowers/sdd/2026-09-06-mobile-input-interaction-remediation-plan/primary-task7-negative-controls.py` | 0 | 2/2故意回归被检出：禁用modal历史失效、禁止editing gate内virtual OFF；正常代码仍PASS |

负向控制为主线程保留在本worktree的临时诊断，不是版本化CLI依赖；只在离线页面内存替换对应行为，不改生产文件。修复只改Python验收脚本，Viewer/Signal源代码及测试未改变，因此保留上表690/332与构建证据，不把重复执行相加。开发agent同版本完成相同覆盖，并连续3次运行surface场景PASS。其修复期间曾有一次完整CLI仅双指滚动断言失败，随即重跑又通过；测试确认在resize后复用了旧坐标，改为等待2帧并重新测量当前位置，保留严格滚动断言。具体偶发丢失wheel的机制未单独证明，不将其写成生产根因；修正后agent和主线程的完整CLI与Node契约均通过。

`efeb25e`限定复审确认四项原finding全部ADDRESSED，但指出替换R9场景时移除了设计要求的textarea新Shift+Arrow之后keyup无额外up检查。主线程对照spec§5认可，`f2e694a`恢复独立native组合键分支并保留真实焦点转换；第二轮复审为Spec ADDRESSED / Quality Approved，无新增Critical/Important。主线程独立运行该提交的`scenario_physical_keyup`：exit0、15项检查PASS，tracked Shift down/up各1，textarea chord batch1、额外standalone key0，释放后及chord后显式文本各接受1次；随后完整运行`python3 scripts/mobile_input_interaction_acceptance.py --out /tmp/wrd-mobile-primary-fix2-chromium.json`，exit0、12/12 PASS、44/913布局矩阵通过。此次仅增加验收检查，生产代码未变。

开发agent分别完成计划命令：Viewer690/690、Signal332/332和构建通过；最终`f2e694a`的CLI契约4/4、Chromium12/12及两项负向控制检出通过；WebKit原执行exit2/12 NOT RUN，运行时仍缺失。最终agent Chromium artifact为`/tmp/wrd-mobile-interaction-chromium-fix2.json`，WebKit为`/tmp/wrd-mobile-interaction-webkit-final.json`。主线程独立执行的版本与结果分别见上文，不将重复运行相加制造测试总数。

```bash
# 仓库根目录
node --test web-client/js/*.test.js web-client/css/*.test.js
node --test scripts/mobile-input-interaction-acceptance.test.js
python3 scripts/mobile_input_interaction_acceptance.py --out /tmp/wrd-mobile-interaction-chromium.json
python3 scripts/mobile_input_interaction_acceptance.py --browser webkit --out /tmp/wrd-mobile-interaction-webkit.json
# 然后在signal-server目录分别执行
npm run build:web
npm test
```

## 3. 主线程发现的额外集成缺陷

移动文本Dock可见但无草稿时，mouse down使surface进入pending；旧UI把它显示为“有未发送内容”，新增提示撑高Dock、改变viewer几何，触发本用于外部尺寸变化的安全reset。离线真实浏览器鼠标事件跨多个rAF复现到down1/up0/reset1。

`6349aa7`补入设计/测试约束，`bfc886d`只移除空surface pending的错误提示显示条件。adapter确认状态、鼠标ACK、几何保护均保留；真实草稿/composition/uncertain/unsupported提示仍显示。开发agent及主线程分别重跑探针PASS，独立Luna/max限定review为Spec✅ / Quality Approved。该探针使用离线fixture，不等于物理pointer-capture或Quartz验收。

## 4. 本轮审查裁决

1. 普通modal与移动输入共用返回焦点安全检查；不改提交语义。若判断不符，需要调整关闭后的焦点恢复策略。
2. 普通ready状态的在途ACK不逐字符节流；已拒绝草稿才等待稳定并显式重试。若边界不符，需要重审retry契约，不能直接把正常打字改成逐次重试。
3. `hasVirtualModifiers()`只读controller真相，用于判断导航是否应失效本地历史，不新增modifier报文。若接口不适用，应撤回/调整该查询，而非建立第二套pressed状态。
4. 3000ms针对已发送未确认的down/up边，不是整次拖拽时长；只保留当前gesture最少确认元数据。若需要限制手势时长，须另行明确产品规则。
5. 虚拟modifier OFF沿既有controller发keyup；“不新增协议”不等于只清本地pressed。若释放契约需变更，必须连同Host状态验证，不能默留远端按下。
6. unsupported禁止新动作；可信已接受手势的move/up仍可继续，外部几何失效独立reset。若需全面冻结移动，应明确变更连续性规则，而非伪造buttons绕过门禁。
7. 实际矩形统一使用设计规定的≤1px误差，不单独给退出按钮发明0px门槛。若出现实际裁切或hittest失败，按新证据修复。
8. 全局退出必须无需滚动就完整可见；More内的全屏入口允许主动滚动后、点击前验证可达。若入口实际上不能靠用户滚动触达，则属于真实UI缺陷，需要修菜单，而非放宽退出门槛。本次纠正的是验收将退出要求误套到可滚动入口，并未修改生产代码。

其余实现细化：真正被接受的非modifier实体键通过现有事务失效移动历史，未发送/拒绝事件不清历史；空草稿surface pending不能引发布局反馈自取消手势。

## 5. 完成状态与NOT RUN

| 范围 | 状态 / 原因 |
|---|---|
| Task7严格离线Chromium集成 | PASS；四项原覆盖缺口及恢复的textarea组合键检查已闭合；限定复审通过，主线程最终提交独立12/12 PASS |
| 主线程最终whole-branch review | COMPLETE；本人检查实现、跨模块关系、证据与文档，无未解决P1/P2；两项非阻塞维护项见§6 |
| WebKit引擎 | NOT RUN；当前环境缺可用运行时，最终CLI已按exit2记录；未自动安装 |
| Android Chrome / iPhone Safari / iPad Safari | NOT RUN；没有真实设备执行证据，桌面touch模拟不替代 |
| 系统软键盘 / 系统IME / 物理外接键盘 | NOT RUN；合成composition和DOM键事件不等于系统事件 |
| Host / Quartz实际输入效果 | NOT RUN；本轮未改Host，不操作真实桌面输入 |
| 正式公网Viewer / DataChannel或Socket真实会话 / live watcher | NOT RUN；未连接实际origin、Signal/Host或watcher |
| main merge / push / 服务重启 | NOT RUN；本轮计划不授权部署操作 |
| 与外部已推进的main组合后的集成 | NOT RUN；当前分支基点195e0c6，收尾main为6c0c652，未自行合并或rebase |

`mobile_input_interaction_acceptance.py`是本轮新建的严格离线脚本；既有`mobile_viewer_acceptance.py --base-url ...`会连接操作者运行的origin，二者不能混称离线。结构化验收只保存场景名、状态、布尔检查与安全计数；运行中的草稿、原始事件与远端模型值仅留在离线页面内存，不输出到artifact或文档。固定的人工测试输入位于测试源码，并非真实用户数据；本轮未读取用户文本、剪贴板或凭据。

最终完成门槛：F1–F7代码与必要自动化通过、Task7报告及主线程review无未解决P1/P2，才称代码整改完成。真实设备/公网仍NOT RUN时，不称移动端全链路验收完成。

## 6. 主线程本人整分支审查

审查基点`195e0c6`，代码/验收终点`f2e694a`；分阶段审查生产实现，对照完整分支差异并逐项复查最后79行验收修正、装配和文档。不是仅转述Luna的结论。最终结论：**本整改分支无未解决Critical/Important（P1/P2）；限定复审发现的覆盖问题全部修复。与新main合并、部署及真实设备/公网仍未验证。**

- F1/F5：媒体门禁不再强制聚焦；普通在途ACK与拒绝草稿分开处理；局部成功前缀、generation/lease失效、16步删除取消和显式重试均有实现与测试对应。
- F3/F4：沿既有controller/transport发送，surface只保留当前手势最少确认元数据；键盘reset不掩盖surface不确定性；modifier OFF、已跟踪keyup、旧几何reset与新手势恢复保持安全路径。主线程发现的空提示拖拽自取消已通过修复及真实离线DOM回归。
- F2/F6/F7：ChromeLayout单点布局，不新增第二套inset扣除；按钮原DOM保留，完整documentElement全屏及不依赖lease的全局退出；44组合固定点和native入口/退出/失败路径通过。
- 验收可信度：四项Task7覆盖缺口已在最终代码逐项核对，主线程正常CLI与两项故意回归对照都实际执行；不以长度相等、已为false的pending、disabled按钮手工事件或缺失运行时冒充通过。构建产物装配移动模块和全局退出；Host/Signal/Terminal/tunnel生产范围未扩大。

限定审查递交的两项Minor经主线程重新裁定为非阻塞，明确保留：

| 位置 | 维护问题 | 本轮判断与后续方向 |
|---|---|---|
| `web-client/js/ui.js:124-134`、`web-client/js/webrtc.js:1304-1306` | fullscreenchange存在重复布局测量 | 幂等CSS写入、RAF合并及固定点矩阵未显示双扣或振荡；保留当前生命周期职责，以后集中合并测量触发，不作为本轮功能阻塞 |
| `scripts/mobile_input_interaction_acceptance.py`（2994行） | 独立脚本集中fixture、模型与场景，文件较长 | 已有具名helper和场景边界，但维护成本仍在；可后续纯组织性拆分，必须保留相同断言及负向控制检出，不混入此次修复 |

后续集成需要基于届时main重新验证共享Viewer/WebRTC及完整构建；部署和真机运行门槛不由本报告自动授权或取消。
