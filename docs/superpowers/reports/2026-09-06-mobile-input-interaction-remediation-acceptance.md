# 手机 / iPad 输入交互整改验收

日期：2026-09-06。状态：**Task1–6及追加拖拽修复已通过限定开发/测试/复审；Task7集成验收和主线程最终review进行中，本文尚非最终通过结论。**

- 分支：`codex/mobile-input-interaction-remediation`，从`main@195e0c6`隔离开发；当前生产整改提交至`bfc886d`。
- [设计](../specs/2026-09-06-mobile-input-interaction-remediation-design.md)、[计划](../plans/2026-09-06-mobile-input-interaction-remediation-plan.md)、[原F1–F7问题与红态证据](2026-09-05-mobile-touch-keyboard-logic-review.md)、[方案审查及后续纠偏](2026-09-06-mobile-input-interaction-remediation-plan-review.md)。
- 开发/测试subagent：`gpt-5.6-luna / max`；各任务限定review与主线程独立复核分开记录，最终whole-branch review由主线程本人执行。
- 未合main、未push、未重启本地服务、未操作tunnel或改变公网地址。代码与文档在开发分支，不代表运行服务已加载。

## 1. 按原问题编号的状态

| 编号 | 已实现的整改 | 当前模块自动化 | 完整集成 / 真机边界 |
|---|---|---|---|
| F1 | 门禁/连续帧不再抢焦点；明确用户动作及有条件返回焦点 | PASS，包含真实Input与媒体回调回归、离线DOM探针 | Task7进行中；系统IME/真机NOT RUN |
| F2 | ChromeLayout单点计算遮挡，managed布局取消重复高度扣除 | PASS；已提交版本8项离线几何/原生按钮探针PASS | 完整44组合/连续帧矩阵待Task7；系统键盘NOT RUN |
| F3 | 导航、modifier、实体键与modal接入已有编辑事务；surface down/up确认独立门禁 | PASS；ACK乱序、keyup安全释放、跨入口基线和显式重试回归 | Task7组合动作/内存模型继续补验；Quartz NOT RUN |
| F4 | down使用最初触点；几何变化取消旧工作；修复提示造成的自取消拖拽 | PASS；主线程真实DOM鼠标事件probe已由FAIL转PASS | 完整touch组合待Task7；真实触屏NOT RUN |
| F5 | 已接受前缀与本页未发草稿分离；有限删除、显式retry/discard、lease/generation隔离 | PASS；普通在途ACK仍允许正常连续输入 | Task7部分失败/模型/取消组合待完成；真机NOT RUN |
| F6 | 按触控能力显示宽屏键栏；compact/ultra、safe-area与unsupported派生门禁 | PASS；保留可信已接受手势与安全释放 | Task7宽度跨越/Terminal/完整矩阵待完成；iPad NOT RUN |
| F7 | documentElement完整Viewer全屏、全局退出、API失败提示及编辑焦点保护 | PASS；UI11/11、两类离线原生按钮探针PASS | Task7重入/Terminal/窄屏全组合待完成；iOS/Safari NOT RUN |

上述PASS指各任务已提交实现的自动化，不把Task7未完成项或实机缺失折算为通过。

## 2. 已实际运行的命令

主线程独立执行（在隔离worktree，生产提交`bfc886d`）：

| 工作目录 / 命令 | 退出码 | 结果 |
|---|---|---|
| 仓库根：`node --test web-client/js/*.test.js web-client/css/*.test.js` | 0 | 690/690，通过；无skip |
| 仓库根：`node --test web-client/js/touch-input-adapter.test.js` | 0 | 20/20，通过 |
| `signal-server`：`npm run build:web` | 0 | 构建完成；构建图包含现有移动模块、Input、ChromeLayout与UI |
| `signal-server`：`npm test` | 0 | 332/332；此独立运行在`5d18ae5`，后续`bfc886d`仅改Viewer提示及测试，Signal代码未变；Task7仍将按最终命令重跑 |
| 主线程临时离线`primary-drag-layout-probe.py` | 0 | `bfc886d`：布局稳定、down/up成对、无自触发reset；旧生产为exit1 |

Viewer输出包含既有离线WebRTC配置fetch缺失的fallback提示，未将输出描述为无警告。逐任务报告另记录RED→GREEN；追加拖拽修复的命名单测先0/1、后1/1，完整Input99/99，MobileTextInput/ChromeLayout/CSS89/89。这些子集与690全套有重叠，不相加制造总数。

Task7下列最终命令尚待完整结果，不预填PASS：

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

## 5. 待完成项与NOT RUN

| 范围 | 状态 / 原因 |
|---|---|
| Task7严格离线Chromium集成 | IN PROGRESS；完整动作、44组合矩阵与CLI契约尚未完成 |
| 主线程最终whole-branch review | PENDING；不会用各任务局部PASS替代 |
| WebKit引擎 | NOT RUN；当前环境缺可用运行时，最终CLI将按exit2记录；不自动安装 |
| Android Chrome / iPhone Safari / iPad Safari | NOT RUN；没有真实设备执行证据，桌面touch模拟不替代 |
| 系统软键盘 / 系统IME / 物理外接键盘 | NOT RUN；合成composition和DOM键事件不等于系统事件 |
| Host / Quartz实际输入效果 | NOT RUN；本轮未改Host，不操作真实桌面输入 |
| 正式公网Viewer / DataChannel或Socket真实会话 / live watcher | NOT RUN；未连接实际origin、Signal/Host或watcher |
| main merge / push / 服务重启 | NOT RUN；本轮计划不授权部署操作 |

`mobile_input_interaction_acceptance.py`是本轮新建的严格离线脚本；既有`mobile_viewer_acceptance.py --base-url ...`会连接操作者运行的origin，二者不能混称离线。结构化验收只保存场景名、状态、布尔检查与安全计数，文本/按键/坐标/剪贴板/凭据仅允许留在人工fixture内存，不输出到artifact或版本化正文。

最终完成门槛：F1–F7代码与必要自动化通过、Task7报告及主线程review无未解决P1/P2，才称代码整改完成。真实设备/公网仍NOT RUN时，不称移动端全链路验收完成。
