# 网页、入口与运行观测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让临时入口/资源错误可有界恢复，并使自动诊断能说明真实版本、事件时刻、耗时与资源状态，同时消除前端观测热路径的重复工作。

**Architecture:** 保留现有 Auth、classic-script 构建、ShellGuard、Socket/WebRTC 与 watcher 安全边界，增加小型有界请求、资产状态、探针截止和诊断存储模块。W 消费 M1 的唯一耗时快照和 C 的权威状态，不另建控制恢复或计时系统。共享文件按任务先后重新读取并串行修改。

**Tech Stack:** 现有 Node.js/CommonJS、浏览器 classic script、Node test runner、Python 标准库/unittest、Bash；不增加运行依赖。

**Spec:** [网页/入口/观测设计](../specs/2026-10-17-web-entry-observability-design.md)；实施前同时读[总设计](../specs/2026-10-17-reliability-latency-remediation-design.md)。

当前所有步骤均未执行。用户本轮授权是文档与复审；本文的测试、代码与提交命令只在后续获得实施授权后执行。不启动当前服务、生产 Viewer 或 watcher，不构建生产 dist。

## Global Constraints

以下内容须逐字复制到各执行计划的 Global Constraints：

1. 本轮仅诊断和文档；业务代码、运行配置、服务、tunnel 均不修改或重启。
2. 后续实施沿用严格单桌面 Viewer、控制租约和 fail-closed reset 屏障；不重放投递结果不确定的点击、文本或命令。
3. 不自动切换网络模式、TURN 节点或公网地址；保留 Quality Lock，不自动降低用户选择的分辨率。
4. 生产 Viewer 验收必须有明确维护窗口；普通检查不得创建会抢占用户控制的 Viewer。
5. 默认不增加运行依赖；纯函数、fake-clock 和模拟适配器测试不得启动真实抓屏、输入或公网连接。
6. 缺测使用 null/unavailable；不以 RTT/2、跨机 wall clock、frame_timing 到达或ACK冒充实际单向传输或可见效果。
7. 日志不保存键码、文本、剪贴板、坐标、token、完整URL或原始输入ID；仅保存有界关联摘要、状态和阶段耗时。
8. 不运行会重建生产dist的 npm test/pretest；定向使用 node --test、unittest 或已有独立临时构建入口。
9. 未做的真实公网、设备、光学或长时间验收必须标为 NOT RUN，不以单元测试通过替代。
10. 每个任务只提交该任务的文件或明确选择的改动，不夹带任务开始前的无关修改。

“仅诊断和文档”约束描述当前授权。计划中的代码步骤是后续获实施授权后执行的内容，不是本轮完成声明；本地部署和tunnel操作继续遵守runbook及用户直接授权。

---

## 文件结构与实施顺序

| 任务 | 定义/修改责任 |
|---|---|
| W1a | bounded-request.js、login.js；Auth结果分类和登录操作代次 |
| W1b | asset-loader.js；Terminal/deferred依赖状态，ShellGuard迟到处理 |
| W1c | build-web-client.js；manifest v2、历史 hash 保留和build身份 |
| W2a | wrd_deadline.py、wrd_watch_runtime.py；真实预算与恢复单一在途 |
| W2b | wrd_entry_health.py；分层、有界、脱敏的探针结果 |
| W3a | runtime-diagnostic.js、diagnostic-core/full、服务端redactor；消费M1 |
| W3b | diagnostic-store.js、input-trace schema v3；最新原始记录与有界摘要 |
| W3c | runtime_observability.py、wrd_resource_snapshot.py、Signal低频观测 |
| W4a | input-trace.js/input.js；ACK观测采样和增量字节预算 |
| W4b | chrome-layout.js/webrtc.js/input.js；先安全推进、再DOM去重 |

W1a→W1b→W1c、W2a→W2b、M1→W3a→W3b→W3c、C/M 前置→W4a→W4b。W3a 与 M1 合入后才动指标显示；W3c 消费 M3 queue.snapshot()，没有 hook 输出 null，不阻塞独立资源采样测试。W1b/W3a/W4b 对 webrtc.js 的适配不能同时合并。

各任务的测试 helper 必须加载真实被测模块；不得在测试里复制修复后的算法来证明自己。所有临时目录在测试 finally/t.after 清理，mock global/env 必须恢复。纯单元测试不绑定 8080，不发送远端输入；临时构建必须显式 outDir。

## W1a：认证错误分类与登录请求截止

**Files**
- Create: web-client/js/bounded-request.js、web-client/js/bounded-request.test.js、web-client/js/login.js、web-client/js/login.test.js。
- Modify: web-client/js/auth.js、web-client/js/auth.test.js、web-client/index.html。
- Modify: signal-server/scripts/web-asset-graph.js、signal-server/scripts/build-web-client.js，给登录页本地 bundle 加 build marker；Viewer 仍一条核心 script src。
- Test: signal-server/test/web-asset-build.test.js；不运行 package pretest。

**Interfaces**
- Produce: fetchJsonWithin(url, init, {timeoutMs=8000,fetchImpl=fetch,setTimer=setTimeout,clearTimer=clearTimeout}) → Promise<{status,ok,data}>；失败抛 code 为 timeout/network/invalid-response 的 Error。
- Produce: Auth.verifyToken() → Promise<AuthCheck>，三种 state 与 reason 完全按 spec §4.1；Auth.init() 仍 Promise<boolean>。
- Produce: createLoginController({fetchJson,storage,view,navigate})，submit(password) 与 dispose()；view.setPending(boolean)、view.showError(reason) 是唯一UI出口。
- Consume: RuntimeConfig.getApiBase()、现有 session/local token 存储；不改认证 wire 格式。

- [ ] **1. 增加真实 Auth 的 503/应用401 反例。** 在现有 loadAuth fixture 中给 context 注入 AbortController、setTimeout/clearTimeout，并使 response.json 可用：

~~~js
test('503 preserves the current token without redirect', async () => {
  const { Auth, storage, context } = loadAuth({
    fetch: async () => ({ ok: false, status: 503,
      json: async () => ({ error: 'unavailable' }) })
  });
  storage.set('wrd_token', 'fixture-token');
  assert.equal(await Auth.init(), false);
  assert.equal(storage.get('wrd_token'), 'fixture-token');
  assert.equal(context.window.location.href, 'viewer.html');
});
test('definitive application 401 clears the current token', async () => {
  const { Auth, storage, context } = loadAuth({
    fetch: async () => ({ ok: false, status: 401,
      json: async () => ({ valid: false, error: 'Invalid token' }) })
  });
  storage.set('wrd_token', 'fixture-token');
  await Auth.init();
  assert.equal(storage.has('wrd_token'), false);
  assert.equal(context.window.location.href, 'index.html');
});
~~~

- [ ] **2. 跑红：** node --test web-client/js/auth.test.js。当前 503 用例因 token 被删除而 FAIL；401继续PASS，防止全部失败都变成“保留登录”。

- [ ] **3. 实现截止 helper 和操作代次。** 将 timer 包在整个 fetch+json promise 外，而非只包 response headers。最小关键逻辑：

~~~js
const controller = new AbortController();
let timeout;
const operation = Promise.resolve().then(async () => {
  const response = await fetchImpl(url, { ...init, signal: controller.signal });
  return { ok: response.ok, status: response.status, data: await response.json() };
});
try {
  return await Promise.race([operation, new Promise((_, reject) => {
    timeout = setTimer(() => {
      controller.abort();
      reject(Object.assign(new Error('request deadline'), { code: 'timeout' }));
    }, timeoutMs);
  })]);
} finally { clearTimer(timeout); }
~~~

Auth 捕获 tokenAtStart/generation，结果回来时二者必须仍匹配；401/403还须 valid=false 和已知认证错误，proxy HTML、429、5xx不能logout。login.submit 每次使用独立 generation，旧 finally 不可解锁新按钮，旧成功不可覆盖新token。不存在“超时后自动重发密码”的分支。

- [ ] **4. 写并跑迟到/悬挂行为测试：** bounded-request.test.js 注入 setTimer(fn){fire=fn;return 1} 和永不返回 fetch；调用后 fire()，断言 code=timeout、signal.aborted=true。login.test.js 用两个 deferred fetch，先超时旧请求再开始新请求，最后让旧请求成功；断言 token/navigate 只有新请求一次。覆盖代理403坏JSON、明确401、无token及重复submit。命令：

~~~sh
node --test web-client/js/bounded-request.test.js web-client/js/auth.test.js web-client/js/login.test.js
~~~

预期所有通过；任何永不 settle、旧成功仍跳转、503清token均保持失败。

- [ ] **5. 接入登录 bundle 并 review/提交。** 用 buildWebClient({sourceDir,outDir:临时目录}) 验证登录脚本本地可交付；不运行 CLI 默认生产 outDir。独立 reviewer 核对密码/响应正文不进日志、bootstrap返回值兼容。只 stage 本任务文件/对应 hunks，提交建议：fix(web): preserve auth on transient failures and bound login requests。此处提交属于后续实施，不是本轮动作。

## W1b：Terminal/deferred 资源的独立状态与迟到隔离

**Files**
- Create: web-client/js/asset-loader.js、web-client/js/asset-loader.test.js。
- Modify: web-client/js/terminal-loader.js、web-client/js/terminal-loader.test.js、web-client/js/shell-guard.js、web-client/js/shell-guard.test.js。
- Modify: web-client/js/webrtc.js 的 loadDeferredDesktop；web-client/js/diagnostic.js 的 init/interval 注册。
- Modify: signal-server/scripts/web-asset-graph.js；Test: web-client/js/diagnostic.test.js。

**Interfaces**
- Produce: createAssetLoader({document,setTimer,clearTimer})，load({url,kind,timeoutMs=5000}) → Promise<void>、status(url) → idle/loading/loaded/error；同URL只有一个底层未决请求。
- Preserve: createTerminalLoader(...).load()/retry()/getState()；loader ready 的完整依赖是 CSS、JS、注册和 init。
- Consume: __WRD_ASSETS__；不创建新 Viewer，不改变 TerminalPanel 的远端会话状态。

- [ ] **1. 在真实 Terminal loader 测试补 CSS 单独失败反例：**

~~~js
test('retry repairs CSS without executing the JS bundle twice', async () => {
  const { factory } = loadFactory();
  let panel = null, css = 0, js = 0, init = 0;
  const loader = factory({
    assets: { terminalCss: '/fixture.css', terminalJs: '/fixture.js' },
    document: {}, getTerminalPanel: () => panel,
    loadStyle: async () => { if (++css === 1) throw Error('fixture CSS failure'); },
    loadScript: async () => { js++; panel = { init() { init++; } }; }
  });
  await assert.rejects(loader.load());
  await loader.retry();
  assert.equal(css, 2);
  assert.equal(js, 1);
  assert.equal(init, 1);
  assert.equal(loader.getState().state, 'ready');
});
~~~

- [ ] **2. 跑红：** node --test web-client/js/terminal-loader.test.js。当前 css=1，失败重试误报ready，断言必须FAIL。

- [ ] **3. 按资源保存完成状态并给操作加 generation。** 核心代码不以全局 panel 代替 CSS 状态：

~~~js
const needed = [];
if (cssState !== 'loaded') needed.push(loadCss(cssUrl).then(() => { cssState = 'loaded'; }));
if (jsState !== 'loaded') needed.push(loadJs(jsUrl).then(() => { jsState = 'loaded'; }));
await Promise.all(needed);
if (generation !== currentGeneration) return;
if (cssState !== 'loaded' || jsState !== 'loaded') throw Error('incomplete assets');
ensureInitialized();
~~~

底层 pending 超时后保持该请求引用，retry只开新的有界等待，不插入第二份classic script。已确认 error 才重新请求。迟到回调可更新资源缓存，但不得更改已过期操作的UI。Diagnostic把 interval句柄保存到自身，init重复调用不增加监听/interval；dispose取消其拥有的timer。

- [ ] **4. 验证 deadline 和迟到顺序。** 在 asset-loader.test.js 的 fake document 中记录 append次数和 onload/onerror；5000ms后令首操作失败，retry后再调用首节点onload，断言只有1个script且只有当前操作ready。另覆盖CSSerror→成功、未注册模块→刷新入口、dispose后late load。ShellGuard测试在deadline后才installCore，断言Start最多一次、retry隐藏、原始core-failed记录仍在。执行：

~~~sh
node --test web-client/js/asset-loader.test.js web-client/js/terminal-loader.test.js web-client/js/shell-guard.test.js web-client/js/diagnostic.test.js
~~~

- [ ] **5. 独立 review/提交。** reviewer 检查“移除标签”未被写成保证取消执行、重复const/interval风险及共享webrtc适配。预期仅相同资源缓存去重，不改变Desktop输入gate。提交建议：fix(web): recover lazy assets with bounded independent states。

## W1c：跨发布 hash 兼容与build身份

**Files**
- Modify: signal-server/scripts/build-web-client.js、signal-server/server.js（只限manifest/cache静态服务）、web-client/js/startup-telemetry.js。
- Create: signal-server/test/web-asset-retention.test.js。
- Test: web-client/js/startup-telemetry.test.js；维护时同步 README.md 的保留窗口，不写凭据。

**Interfaces**
- Extend: buildWebClient({sourceDir,outDir,now=Date.now,retention={maxReleases:3,maxAgeMs:259200000,maxBytes:67108864}})。
- Produce: manifest schemaVersion=2、buildId、builtAt、assets、retainedReleases；window.__WRD_BUILD__={id,builtAt}。
- Consume: W1b对manifest的8000ms以内版本查询；旧页面只能展示显式刷新入口。

- [ ] **1. 真实临时构建 A→B 反例。** 测试复制 sourceDir 到 os.tmpdir，filter 排除 dist；所有构建 outDir 显式指向测试目录，最终删除。改变 fixture 的 terminal.js 内容确保hash变更：

~~~js
const a = await buildWebClient({ sourceDir: fixtureSource, outDir: fixtureOut });
fs.appendFileSync(path.join(fixtureSource, 'js/terminal.js'),
  '\nglobalThis.__fixtureRelease = 2;\n');
const b = await buildWebClient({ sourceDir: fixtureSource, outDir: fixtureOut });
assert.notEqual(a.assets.terminalJs, b.assets.terminalJs);
assert.equal(fs.existsSync(path.join(fixtureOut, a.assets.terminalJs)), true);
assert.equal(fs.existsSync(path.join(fixtureOut, b.assets.terminalJs)), true);
~~~

fixtureSource/fixtureOut 在 test 开头用 fs.mkdtempSync 创建；用 fs.cpSync(source,fixtureSource,{recursive:true,filter:src=>!path.relative(source,src).split(path.sep).includes('dist')}) 复制真实源码，t.after 清理。禁止复用仓库 dist。

- [ ] **2. 跑红：** node --test signal-server/test/web-asset-retention.test.js。当前旧hash不存在，必须FAIL。

- [ ] **3. 实现 staging 保留与预算。** 读取可信前版 manifest，验证所有相对path严格落在assets目录，读取后校验filename hash；用Set按唯一hash计字节。先保新/上一版，再按时间倒序选最多一个可选历史release。预算不足保两版时抛错，绝不rename现网目录。示意：

~~~js
const required = [nextRelease, previousRelease].filter(Boolean);
const requiredBytes = uniqueAssetBytes(required);
if (requiredBytes > retention.maxBytes) throw Error('required asset retention exceeds budget');
const retained = selectOptionalHistory(required, history, retention, now());
copyVerifiedAssets(retained, staging);
validateAllManifestReferences(staging);
~~~

selectOptionalHistory、uniqueAssetBytes、copyVerifiedAssets 都在同文件定义并只处理已验证manifest；生产调用继续有rollback。buildId从规范化当前资产映射计算，不包括绝对路径或环境变量。

- [ ] **4. 跑绿并扩展实际文件行为。** A/B/C/D 四版在同一fixture验证最多3release、当前+上版不因TTL被删、可选旧版过期淘汰；文件path traversal/hash不匹配拒绝；预算极小发布失败后现版manifest/assets字节不变。测试HTML缓存和hash资源immutable的现有规则，startup只保存build和相对资产路径。命令：

~~~sh
node --test signal-server/test/web-asset-retention.test.js web-client/js/startup-telemetry.test.js
~~~

- [ ] **5. Review/提交。** 检查不存在“保留所有旧dist”无界增长、不宣称双rename零间隙。提交建议：fix(build): retain bounded previous hashed assets and publish build identity。

## W2a：真实等待上限、完成后冷却及在途采样

**Files**
- Create: scripts/wrd_deadline.py、scripts/test_wrd_deadline.py、scripts/wrd_watch_runtime.py、scripts/test_wrd_watch_runtime.py。
- Modify: scripts/lib-fixed-domain.sh、scripts/watch-fixed-domain.sh、scripts/restart-fixed-domain-tunnel.sh 的时间/采样适配。
- Test: scripts/watch-fixed-domain.test.js、scripts/restart-fixed-domain-tunnel.test.js；不执行脚本的真实恢复入口。

**Interfaces**
- Produce: Deadline(timeout_s,now=time.monotonic).remaining() / expired()。
- Produce: wait_formal_health(*,timeout_s,probe,info,now,sleep) → {outcome,elapsedMs,attempts}；probe/info必须接受 remaining_s，返回有限结果。
- Produce: WatchRuntime.tick(now_mono,observations)、begin_recovery(operation_id)、complete_recovery(operation_id,finished_mono,outcome)、snapshot()。
- Consume: 既有180s失败阈值、300s冷却、3600s最多2次预算及锁/owner/token安全检查。现有 --decide-only 保持可用，测试adapter全部fake。

- [ ] **1. 先写会击中循环次数错误的fake-clock行为：**

~~~python
class DeadlineTest(unittest.TestCase):
    def test_health_wait_cannot_spend_more_than_total_budget(self):
        clock = [0.0]
        budgets = []
        def probe(remaining_s):
            budgets.append(remaining_s)
            clock[0] += min(10.0, remaining_s)
            return {"outcome": "failed"}
        def info(remaining_s):
            clock[0] += min(10.0, remaining_s)
            return {"active": True}
        result = wait_formal_health(
            timeout_s=45, probe=probe, info=info, now=lambda: clock[0],
            sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        self.assertLessEqual(clock[0], 45.0)
        self.assertEqual(result["outcome"], "timeout")
        self.assertTrue(all(0 < budget <= 45 for budget in budgets))
~~~

在文件顶部 import unittest 及真实 scripts.wrd_deadline.wait_formal_health；不得在test里实现wait算法。

- [ ] **2. 跑红：** python3 -m unittest scripts.test_wrd_deadline scripts.test_wrd_watch_runtime。新增接口未实现时FAIL；将旧循环通过adapter跑同fixture则大于45秒，作为缺陷行为证据保留。

- [ ] **3. 实现单调预算和受控子命令。**

~~~python
deadline = Deadline(timeout_s, now)
while not deadline.expired():
    result = probe(remaining_s=min(10.0, deadline.remaining()))
    if deadline.expired():
        break
    if result["outcome"] == "ok":
        return {"outcome": "ok", "elapsedMs": (now() - started) * 1000, "attempts": attempts}
    info(remaining_s=min(3.0, deadline.remaining()))
    if not deadline.expired():
        sleep(min(1.0, deadline.remaining()))
return {"outcome": "timeout", "elapsedMs": (now() - started) * 1000, "attempts": attempts}
~~~

started在创建deadline前取now，attempts每次probe前递增。进程 adapter 只允许只读探针命令，使用 Popen 与增量管道读取，共享 deadline 且 stdout/stderr 合计最多 64 KiB。读到上限立即停止读取、终止并回收本次 owned probe，返回 output-limit；不能 capture_output 后再截断假装内存有界。probe 即使忽略 remaining_s 并迟到返回 ok，调用方也必须先检查 deadline 再接受成功。不要写“timeout后pkill cloudflared”。shell函数改为调用helper返回结果，不重新展开45轮。恢复 worker 由既有授权路径启动，单一 writer 持久化 operationId、worker PID/start identity、在途状态与预算。恢复互斥锁覆盖 worker 及其变更子命令的生命周期；超时只终止/回收本次 owned helper/probe，不能碰 connector。必须确认 worker 及变更子命令均结束，才将 finished 写入 terminal 并计算 cooldownUntil=finished+300；未能确认时保留 in-flight/unknown，阻断后续恢复，独立只读采样继续。迟到 result 丢弃不等于阻止旧 worker 副作用。

- [ ] **4. 检查真实原问题与并发边界。** fake recovery从100到430完成，now=498时不允许第二次，730才具备冷却条件；恢复期间tick持续写observations且禁止再次begin。旧 operation 完成不能清除当前 operation。新增以下 fake 行为用例：

- probe 忽略 remaining_s、将时钟推到 46 秒后返回 ok，45 秒预算结果仍为 timeout。
- owned probe 持续输出，累计只接受最多 64 KiB，结果 output-limit、已 terminate/reap；不依赖大量输出压测。
- worker 忽略取消并准备迟到变更时，deadline 后状态仍 in-flight/unknown；300 秒和 3600 秒后也不允许第二轮，直至确认 worker/子命令结束。
- watcher 重启读回已有 operationId/PID/start identity，先认领或标 unknown，不能启动第二 worker；PID 复用不视为同一 worker。
- 已耗尽 2 次预算后 boot/clock epoch 改变，保留已消耗状态，从首次确认未知起 300 秒仍不准恢复，完整 3600 秒后且无在途/unknown 才可重新获得预算；再次 watcher 重启不得缩短该保守等待。

覆盖 command timeout、通知超时、origin-down、token connector、multiple owner 及 budget 耗尽。定向命令：

~~~sh
python3 -m unittest scripts.test_wrd_deadline scripts.test_wrd_watch_runtime
node --test scripts/watch-fixed-domain.test.js scripts/restart-fixed-domain-tunnel.test.js
~~~

Node脚本测试中所有restart/launchctl/cloudflared调用必须指向fixtures，新增slow case使用fake-clock，不等待330秒或触碰当前进程。

- [ ] **5. Review/提交。** reviewer核对预算从完成算、后台恢复结果单writer、锁/保护未被绕过、采样仍有真实时间戳。提交建议：fix(watch): enforce monotonic deadlines and completion cooldown。

## W2b：保留分层探针信息，未知状态不自动升级恢复

**Files**
- Modify: scripts/wrd_entry_health.py、scripts/wrd_watch_runtime.py、scripts/watch-fixed-domain.sh。
- Create: scripts/test_entry_probe_layers.py（unittest）。
- Modify: docs/runbook-safe-startup.md 的指标/非授权边界，实施时只同步本任务段落。

**Interfaces**
- Extend: check_entry(...,deadline=None,proxy_mode='environment')；保持旧 deliverable 字段兼容，新增spec §5.1 ProbeResult。
- Produce: probe_layers({origin,formal,manifest}, *,deadline,fetch,now)；routeClass固定枚举，body读取上限health/HTML64KiB/core1MiB。
- Consume: W2a Deadline和WatchRuntime；接收已存在被动业务摘要，不发起认证/Viewer。

- [ ] **1. 写健康层与资源层不等价的反例：**

~~~python
class ProbeLayersTest(unittest.TestCase):
    def test_health_ok_and_core_missing_stay_separate(self):
        responses = {
            "origin-health": (200, b'{"status":"ok"}'),
            "formal-health": (200, b'{"status":"ok"}'),
            "viewer-html": (200, b'<html>fixture</html>'),
            "core-asset": (404, b"missing"),
        }
        def fetch(layer, **kwargs):
            return responses[layer]
        rows = probe_layers(
            {"origin": "fixture-origin", "formal": "fixture-formal",
             "manifest": {"desktopJs": "assets/desktop-core.0123456789abcdef.js"}},
            deadline=Deadline(15, lambda: 0), fetch=fetch, now=lambda: 0)
        by_layer = {row["layer"]: row for row in rows}
        self.assertEqual(by_layer["formal-health"]["outcome"], "ok")
        self.assertEqual(by_layer["core-asset"]["httpStatus"], 404)
        self.assertEqual(by_layer["core-asset"]["outcome"], "failed")
        self.assertNotIn("checked_url", by_layer["core-asset"])
~~~

fixture fetch只调用已配置层，缺login-html时标unknown，不向任何域名实际连接。

- [ ] **2. 跑红：** python3 -m unittest scripts.test_entry_probe_layers。旧布尔结果或缺接口必须FAIL；不能把404诊断转换成formal-down。

- [ ] **3. 实现有限结果与共同截止。** HTTPError保留status并分类headers；DNS/connect/TLS尽可能按实际异常分类，不能确定则unknown，不从字符串猜Cloudflare根因。default环境代理保持行为但记录proxyMode；direct只显式选择。每个stage都从同一deadline扣预算；DNS fallback所有IP尝试不各取10秒。保存JSON而非 stderr>/dev/null 抹掉原因；reason用枚举，原始异常和URL不落盘。

- [ ] **4. 跑绿：** 覆盖代理403 vs origin200、DNS失败、TLS失败、body悬挂、oversize、manifest跨origin/path traversal、资源probe排期5min、health排期60s和skip tick。注入fetch失败使passive-runtime无样本，assert unknown且WatchRuntime不恢复；仅配置允许的连续formal-health已知失败才消费既有策略。命令同第2步，全部网络adapter为fixture。

- [ ] **5. Review/提交。** 核对4032 probe、25 failure的历史记录不会被转换为可用性SLA，脚本测试不生成新Viewer。提交建议：feat(observability): retain layered bounded entry probe results。

## W3a：自动和手动共用RuntimeDiagnostic并消费M1

**Files**
- Create: web-client/js/runtime-diagnostic.js、web-client/js/runtime-diagnostic.test.js。
- Modify: web-client/js/diagnostic-core.js、web-client/js/diagnostic.js、web-client/js/diagnostic.test.js、web-client/viewer.html。
- Modify: signal-server/lib/diagnostic.js、signal-server/test/diagnostic.test.js、signal-server/scripts/web-asset-graph.js。
- Depends: M1 的 LatencyMonitor.snapshot 和 LATENCY_METRIC_NAMES 已可用；W1c提供build。

**Interfaces**
- Produce: Diagnostic.buildRuntimeDiagnostic({reason}) → RuntimeDiagnostic，内存schema精确见spec §6.2。
- Testable producer: createRuntimeDiagnosticBuilder({nowMs,wallNow,getScope,getBuild,getInput,getStartup,getResources,getLatency}) → ({reason}) => RuntimeDiagnostic。
- Consume: LatencyMonitor.snapshot({nowMs,scope})，不修改metrics；服务端通过 require('../../web-client/js/latency-monitor.js').LATENCY_METRIC_NAMES 校验同一白名单。
- Persisted latency scope只保存attemptHash/generation/leaseEpoch；M1原内部scope类型不改。
- Consume: takeClosedScopeSummaries({nowMs}) → {summaries:[{endedAtMs,snapshot}],dropped}，唯一消费点将最多4份/60秒/32KiB的final snapshot排入有界 scope-ended 事件队列，应用同一 redactor/幂等ID；不把旧 outcomes 相加到新 scope。W 事件队列同样最多4份/60秒/32KiB；RuntimeDiagnostic.scopeEnded携带{events:[{eventIdHash,endedAtMs,snapshot}],dropped}，发送成功只删除已确认事件ID，失败重试复用ID，由server幂等处理。

- [ ] **1. 写自动路径保留同一数值的反例。** 真实builder中注入M1 fake snapshot，autoSendFailure/sendLogs都调用该builder；以下是核心断言（fixture所有getter为纯函数）：

~~~js
const sample = {
  schemaVersion: 3, scope: null, windowMs: 5000,
  metrics: { inputAckRttMs: {
    last: 42, p50: 41, p95: 90, count: 3, available: true, lastSampleAgeMs: 7
  }},
  outcomes: { sent: 4, acked: 3, rejected: 0, timedOut: 1,
    late: 0, cancelled: 0, dropped: 0, unmatched: 0 }
};
const build = createRuntimeDiagnosticBuilder({
  nowMs: () => 100, wallNow: () => '2026-10-17T00:00:00Z',
  getScope: () => null, getBuild: () => ({ id: '0123456789abcdef', builtAt: null }),
  getInput: () => ({ inputState: {}, inputTrace: {} }),
  getStartup: () => ({}), getResources: () => null,
  getLatency: () => sample
});
const auto = build({ reason: 'input-ack-timeout' });
assert.deepEqual(auto.latency.metrics, sample.metrics);
assert.deepEqual(auto.latency.outcomes, sample.outcomes);
~~~

还要经过实际 Diagnostic.autoSendFailure 捕获其 sendConnectionDiagnostic payload，不能只证明builder独立可用；沿现有diagnostic.test.js VM harness stub sendConnectionDiagnostic，断言auto/manual均schema3且字段完整。

- [ ] **2. 跑红：** node --test web-client/js/runtime-diagnostic.test.js web-client/js/diagnostic.test.js。当前auto没有latency，必须FAIL。

- [ ] **3. 实现共同生成器并去重初始捕获。** core先定义builder和基本传输，full只增强panel。getLatency不存在返回null/collector-unavailable；manual只添加允许的UI上下文，不重新算同一指标。保存diagnosticId和captured，pending replay复用原始对象；仅发送元数据可标replayAge，不能替换故障latency。UI把inputRtt旧绑定替为inputAckRttMs并改标签，visible项只读inputToVisibleEffectMs.available；freshFrameAgeMs 只显示即时 last/availability，不显示其占位 p50/p95。scope-ended 事件单独持久化原 final snapshot，builder 将 drain 结果移交有界队列后才能结束；失败重试复用事件ID，不再向 M drain。同一队列上限内处理，溢出/过期明示 dropped。

- [ ] **4. 跑绿及隐私红线。** canary字段放进metric未知键、scope原ID、startup完整URL/query、原始输入内容，过真实server redactor+ingest后不可出现；合法null/lastSampleAgeMs/outcomes保持，schema不因大小裁剪消失。验证deferred未加载时auto可生成基本诊断且不启动script请求；同一failure重传diagnosticId一致。再注入两个旧 scope final summary（其中一个有 cancelled），模拟发送失败再成功：断言 M 原子 drain 仅一次、各事件只持久化一次、新 scope outcomes 未增加旧计数；超过4份/60秒/32KiB时 dropped 透传且范围缺口可见。命令：

~~~sh
node --test web-client/js/runtime-diagnostic.test.js web-client/js/diagnostic.test.js signal-server/test/diagnostic.test.js
~~~

- [ ] **5. Review/提交。** M reviewer核对LATENCY_METRIC_NAMES、scope、freshFrameAgeMs 的 gauge 语义和outcomes累计语义；C reviewer核对diagnostic failure不会动授权gate。提交建议：feat(diagnostics): unify bounded runtime snapshots for failure and manual reports。

## W3b：长会话时钟与有界诊断留存

**Files**
- Create: signal-server/lib/diagnostic-store.js、signal-server/test/diagnostic-store.test.js。
- Modify: signal-server/lib/diagnostic.js、web-client/js/input-trace.js、web-client/js/input-trace.test.js、web-client/js/diagnostic-core.js。
- Test: signal-server/test/diagnostic.test.js；依赖W3a schema。

**Interfaces**
- Produce: createDiagnosticStore({dir,now,retention}) → {write(report),listSummary({from,to}),cleanup()}；真实fs适配只在该模块；默认3/viewer、50 raw、7日summary、8MiB/10000行/日。
- Produce: inputTrace.snapshot() schema3，新增traceNowMs/bootIdHash；events.at为非负安全整数，不钳600000。W3a captured保留事件捕获与服务端receipt不同语义。
- Preserve: ingestDiagnosticPayload通过store写入；不让HTTP/Socket入口绕过同一redactor/限额。

- [ ] **1. 写真实临时目录留存回归，不能只测sort helper：**

~~~js
test('actual store retains newest three for the same viewer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-diag-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 17);
  const store = createDiagnosticStore({ dir, now: () => now,
    retention: { maxPerViewer: 3, maxTotal: 50 } });
  for (let i = 1; i <= 5; i++) {
    now += 1000;
    await store.write({ schemaVersion: 3, diagnosticId: 'fixture-' + i,
      viewerHash: 'fixture-viewer', receivedAt: new Date(now).toISOString(),
      reason: 'input-ack-timeout' });
  }
  const raw = fs.readdirSync(path.join(dir, 'raw')).filter(n => n.endsWith('.json'))
    .map(n => JSON.parse(fs.readFileSync(path.join(dir, 'raw', n), 'utf8')));
  assert.deepEqual(raw.map(r => r.diagnosticId).sort(),
    ['fixture-3', 'fixture-4', 'fixture-5']);
  assert.equal((await store.listSummary({from:0,to:now+1})).records.length, 5);
});
~~~

再用旧cleanup函数+真实tmp files复现1/2/3/4删4，确保迁移前后行为被对照。新store路径先与原根目录兼容迁移：旧根JSON参与读取/清理，新文件写raw；只迁移本目录普通文件，禁止symlink。

- [ ] **2. 跑红：** node --test signal-server/test/diagnostic-store.test.js。当前保留最老以及先清后写应失败；未提供新store时导入失败也是接口红，但必须保留旧算法的实际删除反例。

- [ ] **3. 实现写摘要→原始原子发布→清理。** 同目录single writer，临时文件flush/close后rename；按合法receivedAt倒序选每viewer最新3，然后全局最新50。保留规则的核心：

~~~js
const ordered = entries.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
const kept = [], perViewer = new Map();
for (const entry of ordered) {
  const count = perViewer.get(entry.viewerHash) || 0;
  if (count >= maxPerViewer || kept.length >= maxTotal) continue;
  perViewer.set(entry.viewerHash, count + 1);
  kept.push(entry);
}
~~~

真实cleanup删除集合由entries减kept得出，不能仅删除sort当前行。摘要按diagnosticIdHash幂等；索引24小时/10000项，达到上限按spec明确记录覆盖缺口。摘要查重再按raw SHA合并，不能把重传和summary计两次。解析/写入失败不得输出saved=true。

- [ ] **4. 长会话和故障注入跑绿。** fake clock先0、599999、600001、900000记录事件，断言at严格增大且snapshot.traceNowMs对应当前，同boot才能求年龄；新boot不能混。真实tmp测试第51条写完raw≤50、摘要先保留被淘汰raw、重复ID一次、时间边界/TTL/字节上限、损坏JSON、symlink不跟随、rename失败旧记录不丢。命令：

~~~sh
node --test signal-server/test/diagnostic-store.test.js signal-server/test/diagnostic.test.js web-client/js/input-trace.test.js
~~~

- [ ] **5. Review/提交。** 检查summary与raw都不保存原始输入ID/URL；去重TTL不被写成无限去重保证，receivedAt不充当incidentAt。提交建议：fix(diagnostics): retain newest reports and preserve bounded event chronology。

## W3c：实际资源、完整低频lag与Signal断开原因

**Files**
- Create: python-host/runtime_observability.py、python-host/test_runtime_observability.py、scripts/wrd_resource_snapshot.py、scripts/test_wrd_resource_snapshot.py。
- Create: signal-server/lib/observability/runtime.js、signal-server/test/runtime-observability.test.js。
- Modify: python-host/host.py 的 build_event_loop_lag_context/monitor_event_loop_lag 适配；signal-server/websocket/signaling.js 的 disconnect reason；signal-server/server.js 生命周期。
- Depends: M3 queue.snapshot()如已提供则接入，否则保持null；C对共享host.py/signaling.js的权威逻辑先落地。

**Interfaces**
- Produce: RuntimeObservability(now_ns,read_current_rss,read_peak_rss).observe_loop(scheduled_ns,observed_ns)、register_queue(name,snapshot)、snapshot(now_ns)。
- Consume: queue.snapshot() → {pendingCount,pendingBytes,inFlightCount,droppedCount,frozen}；name限inputReliable/inputUnordered/relayFrames。
- Produce: resource_delta(previous,current) → {elapsedMs,swapInBytesPerSec,swapOutBytesPerSec,currentRssMiB,peakRssMiB,memoryPressure}；首样本/回退计数输出null。
- Node createRuntimeObserver({now,sampleRss})输出现成摘要，start/stop由server生命周期管理；诊断回调不触发采样。

- [ ] **1. 写当前RSS与峰值、零值lag不被丢弃的行为测试：**

~~~python
class RuntimeObservabilityTest(unittest.TestCase):
    def test_current_memory_and_complete_low_frequency_window(self):
        observer = RuntimeObservability(
            now_ns=lambda: 5_000_000_000,
            read_current_rss=lambda: 100.0, read_peak_rss=lambda: 900.0)
        for sec, lag_ms in [(1, 0), (2, 5), (3, 30), (4, 100)]:
            observer.observe_loop(sec * 1_000_000_000,
                                  sec * 1_000_000_000 + lag_ms * 1_000_000)
        result = observer.snapshot(5_000_000_000)
        self.assertEqual(result["currentRssMiB"], 100.0)
        self.assertEqual(result["peakRssMiB"], 900.0)
        self.assertEqual(result["eventLoop"]["count"], 4)
        self.assertEqual(result["eventLoop"]["last"], 100.0)
~~~

测试import新模块时不得import/启动host.py或真实MSS。RSSreader是测试fixture；生产reader异步缓存，不在observe/snapshot同步跑命令。

- [ ] **2. 跑红：** python3 -m unittest discover -s python-host -p test_runtime_observability.py；python3 -m unittest scripts.test_wrd_resource_snapshot。旧只有>20ms事件且rss为peak的结果不能通过该contract。

- [ ] **3. 实现有界资源采样与日志适配。** 使用collections.deque(maxlen=120)保留60秒全部1Hz观测，读取也过期；错过deadline只加missedSampleCount，不补0。系统采样worker每5秒/总预算1秒，以显式PID读取RSS缓存；macOS ru_maxrss单位按平台转换后仅叫peakRssMiB。swap用相邻计数和实际elapsedMs：

~~~python
def rate(previous_count, current_count, page_size, elapsed_ms):
    if (previous_count is None or current_count is None or
            current_count < previous_count or elapsed_ms <= 0):
        return None
    return (current_count - previous_count) * page_size * 1000 / elapsed_ms
~~~

read_current_rss失败返回None；memoryPressure无受支持来源unknown。Signal断开reason白名单只含协议已知枚举，未知记录other，不能日志输出任意对象。资源观测timer/worker在close时取消并等待已持有任务；不能产生孤儿进程。

- [ ] **4. 跑绿并覆盖资源采样不会阻塞输入。** fake worker pending时snapshot立即返回上一缓存+age；旧样本过期availability=false。counter reset、首样本、总预算超时、pageSize16384、2000ms差分、未登记PID拒绝、queue payload canary不泄漏；Node observer含0mslag样本且stop取消timer。执行：

~~~sh
python3 -m unittest discover -s python-host -p test_runtime_observability.py
python3 -m unittest scripts.test_wrd_resource_snapshot
node --test signal-server/test/runtime-observability.test.js signal-server/websocket/signaling.test.js
~~~

这些是future定向测试，不运行当前机器资源循环或大规模并发实验。

- [ ] **5. Review/提交。** M reviewer检查queue名称/五字段，C reviewer检查Host生命周期和Signal断开仅记录不改授权。提交建议：feat(observability): separate current resources and full sampled loop metrics。

## W4a：ACK观测采样与增量字节预算

**Files**
- Modify: web-client/js/input-trace.js；web-client/js/webrtc.js 的 Socket input-ack 与 DC ACK 真实接收入口；必要时适配 web-client/js/input.js 的 acceptMouseAck/acceptKeyboardAck 只读匹配摘要。
- Test: web-client/js/input-trace.test.js、web-client/js/input-recovery.test.js、web-client/js/webrtc.test.js。
- Depends: C/M ACK处理先定稿；不改变其处理顺序/成功判断。

**Interfaces**
- Preserve: InputTrace.create(...).record/snapshot与所有业务ACK入口。
- Extend: trace.record ACK内部meta带原action/可靠性及是否匹配可靠pending；不改wire envelope。
- Produce: snapshot counters中 sampledAckEvents，并在snapshot导出保留原limits；原input payload只在匹配时内存使用不落盘。

- [ ] **1. 写高频unordered ACK不挤掉可靠故障的反例：**

~~~js
test('unordered ack samples do not evict a reset timeout', () => {
  let now = 1;
  const trace = requireCollector().create({ now: () => now });
  trace.record('ack-timeout', { inputType:'mouse', action:'reset',
    reason:'input-ack-timeout', status:'timeout', reliable:true });
  for (let i = 0; i < 1000; i++) {
    now++;
    trace.record('ack', { inputType:'pointer', action:'move',
      status:'applied', accepted:false, reliable:false, matchedReliablePending:false });
  }
  const result = trace.snapshot();
  assert.equal(result.events.filter(e => e.stage === 'ack-timeout').length, 1);
  assert.equal(result.counters.sampledAckEvents, 1000);
});
~~~

还要在现有 webrtc.test.js harness 回放真实 Socket input-ack handler 与 DC message handler 各1000次，stub Input.acceptMouseAck/acceptKeyboardAck 和 LatencyMonitor.onInputAck 计数，断言各路业务均收到相同次数；不存在 Input.onInputAck 方法，不得测试虚构入口。先从 pending 只读截取原 action/可靠性/匹配摘要，再调用会删除 pending 的业务函数，最后将摘要交 trace；加入 reliable reset 已删除 pending 后仍被保留的反例。只测 trace 采样不足以证明业务未丢。

- [ ] **2. 跑红：** node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/webrtc.test.js。当前ACK action固定ack且缺计数，反例失败。

- [ ] **3. 先截取匹配摘要，完成业务 ACK 后再决定观测采样。** 仅明确unordered、成功、无可靠pending匹配的move/wheel ACK计数；未知/失败/迟到/可靠/有reset匹配全部保留。append只序列化当前entry，维护cachedBytes；hash完成更新该entry长度，若entry已淘汰不得重新插回：

~~~js
function replaceEntryBytes(entry, nextBytes) {
  if (!entry.live) return;
  totalBytes += nextBytes - entry.bytes;
  entry.bytes = nextBytes;
  evictUntilWithinBudget();
}
~~~

budget包括事件分隔符及固定header余量；snapshot最后全量检查，调整drop计数而不是输出超64KiB。队列里已有待确认记录不能因采样被提前删除。

- [ ] **4. 跑绿并检验算法成本。** 用注入的byteLength计数器记录一次append只测新event、hash变更只测对应event；不以机器耗时阈值做flaky测试。断言256events/64KiB/64hash/256pending上限仍成立，乱码UTF8、异步hash晚到、环淘汰、duplicate/late ACK和timeout都被覆盖。业务ACK调用次数与原输入相同。跑绿命令：node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/webrtc.test.js。

- [ ] **5. Review/提交。** reviewer重点核对accepted=false的unordered含义及采样发生在观测末端；不能让“减少事件”减少reset证据。提交建议：perf(trace): sample unordered ack observations and account bytes incrementally。

## W4b：稳定帧只更新必要状态，DOM按派生模型变化

**Files**
- Modify: web-client/js/chrome-layout.js、web-client/js/input.js 的 updateKeyboardUI、web-client/js/webrtc.js 的 markMediaAttemptReady/setUiPhase/observePaintFrame。
- Test: web-client/js/chrome-layout.test.js、web-client/js/webrtc.test.js、web-client/js/input-signaling-continuity.test.js。
- Depends: C媒体恢复/门禁、M帧关联、W1b loader状态已定稿。

**Interfaces**
- Preserve: ChromeLayout.applyCapabilities(snapshot,root)、Input.setActive、WebRTC fresh-frame路径。
- Produce: per-root render cache内部使用WeakMap；invalidate(root,reason)供node/viewport/theme/Terminal变化调用。
- UI model只包含派生可见性/disabled/aria/title/keyboard状态；不将整个pc/media对象JSON stringify作每帧比较。

- [ ] **1. 用真实 ChromeLayout + 计数 DOM 建立稳定状态反例。** 使用现有 capability-bound controls 测试的 root 结构，真实调用 applyCapabilities；只挂载 refreshBtn，避免同一个假节点被误认成所有布局/Terminal节点：

~~~js
const writes = [];
const node = {
  dataset: {},
  set disabled(v) { writes.push(['disabled', v]); },
  set hidden(v) { writes.push(['hidden', v]); },
  set title(v) { writes.push(['title', v]); },
  setAttribute(k, v) { writes.push([k, v]); },
  classList: { toggle(k,v) { writes.push([k,v]); },
    add(k) { writes.push(['add',k]); }, remove(k) { writes.push(['remove',k]); } }
};
const root = {
  getElementById: id => id === 'refreshBtn' ? node : null,
  querySelector: () => null, querySelectorAll: () => []
};
ChromeLayout.applyCapabilities({ uiPhase:'connected', streamReady:true, activeControl:true }, root);
const before = writes.length;
for (let i=0; i<200; i++)
  ChromeLayout.applyCapabilities({ uiPhase:'connected', streamReady:true, activeControl:true }, root);
assert.equal(writes.length, before);
~~~

上述 root 与同文件现有最小 capability 测试相同，不 stub applyCapabilities 或派生模型。另用既有 makeLayoutHarness 验证 mobile/viewport/Terminal 变化与失效路径，避免只在桌面最小节点通过。

- [ ] **2. 跑红：** node --test web-client/js/chrome-layout.test.js。当前第二次相同调用仍写属性，必FAIL；不按毫秒阈值判断。

- [ ] **3. 实现最后一层render去重，不跳过控制推进。** 每帧C/M时间戳、frame序号、ACK后fresh-frame屏障照常推进，UI model相同才跳过DOM。模型示意：

~~~js
const model = deriveChromeModel(snapshot, viewport, terminalState);
const previous = renderedByRoot.get(root);
if (previous && equalChromeModel(previous.model, model) &&
    sameMountedNodes(previous.nodes, nodes)) return capabilities;
applyChromeModel(model, nodes);
renderedByRoot.set(root, { model, nodes });
~~~

derive/equal/apply只针对固定字段，不包含性能时间戳；WeakMap在root释放后可回收。几何cache由ResizeObserver/visualViewport/fullscreen失效；需要时在下一次合法布局批次刷新，输入映射发现dirty不能默默用错坐标。

- [ ] **4. 跑绿并防状态冻结。** stable 200帧无额外DOM写；同active但leaseEpoch/recovery/draft/keyboard变化会重算model并更新相关控件；node替换需重写；旧attempt scheduled callback不能打开新门禁。连续rVFC仍推进frameSeq/真实M观察和resume barrier，不能为了通过DOM测试禁用rVFC。命令：

~~~sh
node --test web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js web-client/js/input-signaling-continuity.test.js
~~~

- [ ] **5. Review/提交。** C reviewer检查没有把 Input.setActive 同值调用中的恢复副作用跳过，M reviewer检查呈现时间/trace没有降采样。提交建议：perf(viewer): render chrome only when derived state changes。

## 最终集成检查与交付记录

- [ ] 逐项映射 spec §8 到上述行为测试；新增fixture验证只能标离线PASS，不能据此标公网或设备PASS。
- [ ] 从总spec逐字比对Global Constraints，并核对M1签名、LATENCY_METRIC_NAMES、outcomes累计语义以及M3队列五字段没有偏差。
- [ ] 对每个任务独立review，检查git diff只包含任务文件/选择的hunks；有实质问题先补反例再修。共享文件基于前置任务最新内容重读，不覆盖已有修改。
- [ ] 只在获实施授权后使用上述定向命令。禁用npm test/pretest，全部构建传临时outDir。当前生产dist、服务和tunnel保持不动。
- [ ] 将未运行项明确写 NOT RUN：真实公网冷启动P95、浏览器CPU/长任务profile、登录跨部署手工验收、手机设备、至少3小时Viewer、物理可见效果。维护窗口未授权时不创建Viewer。
- [ ] 后续维护验收记录build/boot/scope、实际入口/媒体/input路径、质量锁、FPS/codec、当前RSS/swap/采样间隔。单点200或少量fixture不得宣称整体性能达标。
- [ ] 实施完成后同步需求和runbook的真实状态，保留历史失败和证据限制；不把本文尚未执行的步骤改成“已修复”。

本轮文档交付不触发上述执行步骤，也不请求再次选择规划流程。主线完成各子项目交叉review后再统一纳入版本管理。
