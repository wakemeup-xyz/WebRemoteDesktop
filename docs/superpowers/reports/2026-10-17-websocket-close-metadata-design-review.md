# WebSocket 关闭元数据：最小只读设计与静态 review

日期：2026-10-17。状态：设计完成；未实施、未运行测试、未启动浏览器/Viewer、未发起网络请求、未修改服务、配置、源码或 Git index。本报告为私有临时设计产物，权限 0600。

## 结论

只扩展现有被动验收 observer 的 Engine close 事件 `ec`：合法时附带可选 `ws={code,wasClean}`。范围是 `scripts/passive_session_sampler.js` 的现有 close projector 与 `scripts/passive_session_soak.py` 的 `validate_event`。保留 schemaVersion=1、事件 cap 192 字节及现有采样/监听机制。无需修改生产网页、重新构建或重启服务。

不新增原生 WebSocket 包装器，不增加 listener、定时器、重连行为或诊断框架。`sd`、`mc`、`se`、`re` 不新增字段。旧记录中的缺测保持缺测；不修改历史证据，也不将 unknown 自动归因为网络断开。

## 已安装代码证据

本机安装版本为 engine.io-client 6.6.6、socket.io-client 4.8.3、socket.io 4.8.3。核对了模块源码，也核对了实际网页构建使用的浏览器发行文件：

| 位置（仓库相对路径） | 实际语义 |
|---|---|
| `signal-server/scripts/build-web-client.js:101`、`:106`、`:110` | 构建读取 Socket.IO server 包的 `client-dist/socket.io.min.js`，再与 desktop 脚本组成 bundle。因此不能只凭独立 engine.io-client 包推断网页行为。 |
| `signal-server/node_modules/socket.io/client-dist/socket.io.js:1391` | 实际发行文件的 `ws.onclose(closeEvent)` 调用 transport `onClose({description:'websocket connection closed',context:closeEvent})`。 |
| `signal-server/node_modules/engine.io-client/build/esm/transports/websocket.js:44` | 同样构造以上固定 description 和原生 CloseEvent context。 |
| `signal-server/node_modules/engine.io-client/build/esm/transport.js:106` | transport `onClose(details)` 原样发出 `close(details)`。 |
| `signal-server/node_modules/engine.io-client/build/esm/socket.js:205` | `setTransport` 将 transport close 转发为 `_onClose('transport close', details)`；其局部形参虽名为 reason，实际是该 details。 |
| 同文件 `:503`、`:531` | Engine 清理 transport/计时器后发出 `close(reason, description)`；第二参仍是同一个 details。当前 Engine listener 已足够取得元数据。 |
| `signal-server/node_modules/socket.io-client/build/esm/manager.js:302`；`socket.js:447` | Manager close、Socket disconnect 也转发第二参。本轮不扩展这些事件。 |

类型声明也将 CloseDetails.context 定义为 unknown；Engine close 第二参可能是 CloseDetails 或 Error，不能无条件当作原生关闭事件。

另有两个必须区分的路径：

- Engine `socket.js:138` 的浏览器 offline 路径使用 `transport close`，但 description 是固定 `network connection lost`，没有原生 CloseEvent context。
- `socket.js:487` 的错误路径是 `transport error`，可能附带 Error/TransportError。显式 transport.close 也可能不带 details（`transport.js:53`）。

因此 `transport-close` 本身不足以证明原生 WebSocket 关闭，更不能证明网络、Cloudflare、Signal 或 Host 是责任方。

## 最小字段契约

修改点为 `scripts/passive_session_sampler.js:112` 附近现有 Engine `close` projector：接收 `(value, details)`，完整保留现有 `r=reason(value,prefix)` 结果，然后进行一次有界、失败可忽略的投影。

仅当下列条件全部满足时添加 `ws`：

1. 原始 reason 严格等于 `transport close`。
2. details 是非 null 对象，且 `details.description === 'websocket connection closed'`。
3. details.context 是非 null 对象。
4. context.code 是真实整数，范围 1000..4999。
5. context.wasClean 是真实 boolean。

输出仅包含这两个原语字段：`ws: {code: <integer>, wasClean: <boolean>}`。任一字段缺失、类型不符、超范围或读取抛错，省略整个 ws，继续保留原有 ec 事件。不得输出半个 ws，不得将缺失 wasClean 填为 false，不得将未知 code 填为 0。

读取须位于窄 try/catch 内：只读取固定 discriminator、context、code、wasClean；不枚举、展开或序列化原对象。不读原生 reason、target、URL、Error message/stack 或任意其他 context 字段。原生 CloseEvent 属性可以是原型上的 getter，不能用必须为 own-property 的规则拒绝它们；getter 抛错则按缺测处理。

不要复用 sampler 现有会四舍五入/截断的 `integer()`：关闭码不可经 coercion、round 或 clipping 后伪造为合法整数。字符串、boolean、NaN、Infinity、小数都应拒绝。

1000..4999 是观测字段的有界范围，**不是**发送 WebSocket close 帧的合法参数规则。若浏览器报告 1005、1006、1015，保留其真实值；不能套用发送端 close(code) 的限制将这些观测抹去。1006 不等于已证明网络故障，1000 或 wasClean=true 也不能确定由谁主动关闭。

### source 与归因

不增加独立 source 字符串。`k=ec` 加上上述严格 discriminator 才能产生的 ws，已表达元数据来源是 Engine 传递的原生 WebSocket close envelope。ws 缺失只表示未取得符合契约的数据；不推断 offline、network、server 或 cleanup。

保留 attribution 的 `cause='unknown'`。即使取得 code/wasClean，仍需结合现有客户端先后顺序与同一会话的服务端证据才能形成因果结论。

## 顺序、旧对象与首事件边界

保持对象身份标号、currentness、序号、采样边界和原有 firstDisconnectEvent 选择规则。已登记的旧 Engine 事件即使 `c=false` 也可以带合法 ws；不得为获取元数据而读取真实 socket ID 或丢弃该事件。

产品监听器先运行时，Socket/Manager 的 `sd` 或 `mc` 可能先于 observer 收到 ec。故 firstDisconnectEvent 可能不含 ws，但稍后的 ec 含有。只按现有序号关联和报告，不能用后来的 ec 覆盖首事件、伪造先后或补写旧 firstDisconnectEvent。如果 ec 未观测到或已不在有界事件环中，元数据继续为缺测。这是 ec-only 方案的明确限制。

现有 Engine close 回调已提供所需第二参；再挂原生 WebSocket/transport listener 会增加生命周期复杂度，并可能遇到 Engine 清理时移除 transport listeners。没有必要采用该路径。

## Python schema、隐私和兼容性

`scripts/passive_session_soak.py:422` 的 `validate_event` 当前先构造精确键集，再在 `:431` 调用 exact_keys；terminal 事件包含 o/c/r，最后在 `:452` 保持 byte_cap(event,192)。最小扩展：

- 只有 kind==ec 且记录确实含 ws 时，才将 ws 加入允许键集。
- ws 必须为精确对象 `{code,wasClean}`；禁止 null/list、缺键和多余字段。
- code 使用 `type(code) is int` 并验证 1000..4999；Python bool 不得作为整数接受。
- wasClean 使用 `type(value) is bool`。
- 其他事件种类出现 ws 必须拒绝。原有 reason allowlist、对象标签及 currentness 校验不变。

旧 schema 1、无 ws 的 ec 仍可通过新 reader。旧版 exact-key reader 会拒绝带 ws 的新记录，故这是**新 reader 向后兼容**，不是双向兼容；验收执行时 JS/Python 必须使用同一已审查版本。不得改写旧证据来“升级”。

`validate_attribution`（`:465`）已复用 validate_event；snapshot、delta、final 也已有事件传递路径，不需要新增存储通道。保留 event 192、delta 4096、final 32768 字节上限和现有事件数量上限。不得以新增字段为由扩大预算。

## 既有测试的静态影响与后续最小验证项

以下仅为将来实施时的验证要求；本轮没有运行测试。

| 现有位置 | 需要保留/补充的验证 |
|---|---|
| `scripts/passive-session-sampler.test.js:216` | 已有“任意 getter 都抛错”的 description Proxy fixture。新增 projector 必须捕获读取异常，仍记录原 reason，不泄露 description/stack/URL/IP，不中断 emitter；cause 仍 unknown。 |
| 同文件 `:258` | 监听期间替换对象的 fixture 首事件为旧 Socket 的 sd。ec-only 方案不应改变该首事件；可另加已登记旧 Engine 的合法 ws 且 c=false fixture。 |
| 同文件 `:278` | detach/stop 后已复制回调不能继续追加事件的约束保持。 |
| 同文件 `:349` | 容量矩阵目前断言 terminal event 最大 79 字节。为 ws-bearing ec 加分支；保留无 ws 旧断言，新增事件继续严格小于等于 192，不把旧 79 字节上限错误套到新 ec。 |
| `scripts/test_passive_session_soak.py:831` | 增加合法 ec ws、旧 ec 无 ws，以及小数/string/bool/超范围、部分/额外键/null、ws 出现在其他事件上的拒绝案例。 |
| 同文件 `:883` | 已有真实 JS snapshot/delta 通过 Python validator 的桥接 fixture；增补 Engine close native envelope，核对 ws 在两种输出存活且私密 canary 不出现。 |

最小接受标准：合法原语被原样保存；缺失/异常严格省略；Python 拒绝超出白名单的任何输入；旧记录通过；首事件及 detach 行为不变；所有既有隐私/体积边界保持。无需公网 Viewer 运行才能验证上述纯观测格式规则；真实关闭元数据是否实际出现，仍需后续单独授权的运行证据。

## helper pin 与文档影响

- `/tmp/wrd-owned-turn-probe-private/supervisor.py:15` 声明 helper/sampler 路径及 EXPECTED_HELPER、EXPECTED_SAMPLER 两个 hash pin；`:209` 在运行前检查二者。未来修改两个源文件后，旧 supervisor 应 fail closed。仅在新版本完成审查后更新配对 pin，不绕过 hash check，不修改历史 preflight/supervisor 记录。
- `/tmp/wrd-media-lifecycle-private-HiqscA/media_lifecycle.py:123` 有 helper SHA pin；该文件还在 `:22` 嵌入旧 PASSIVE_JS，并在 `:478` 使用它。只更新 Python hash 不会升级该嵌入 observer。本轮不扩展或运行此无关 helper；未来若复用必须明确版本边界。
- `docs/superpowers/plans/2026-10-17-signal-close-observer-plan.md:59` 附近写有 sd/mc/ec 精确键且不准可选键的旧契约，并注明 79 字节。若将来实施，应只把 ec 可选 ws、兼容方向与新体积说明同步到此契约；保留历史执行报告的事实和旧 hash。

## 方案比较与 review 结论

选择现有 ec projector 的两字段投影：改动点最少，直接对应已验证的安装包参数，不改应用行为。只记录 ec 的代价是首个 sd/mc 可能没有该信息；报告如实保留这一缺口。

不选择同时扩展 sd/mc/ec：虽然可能让首事件带元数据，但超出当前已收敛范围，也增加重复记录和 schema 分支。不选择 raw WebSocket 包装器、新 framework、原始 reason/error 持久化或扩展 source 枚举：它们都不是得到本次最小事实所必需。

静态 review 结论：该 ec-only 设计可由主任务按既有开发授权实施；本只读子任务无实施权限，所有代码、测试、hash pin、服务及浏览器保持原状。当前缺少 close code/wasClean 的旧失败记录仍无法唯一归因，此设计不能追溯补全它们。
