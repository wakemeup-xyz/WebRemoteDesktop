# 多 TURN 节点目录 + 前端切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Track steps with `- [ ]`.

**Goal:** 支持 `~/.StockHub/turn.json` 的 `turnServers[]` 多节点；默认优先阿里云；Viewer 可切换节点并与 Host 会话级对齐；不回归单节点 / env 路径。

**Architecture:** 共享 catalog loader（Node + Python 对等规则）→ signal-server 按 `turnServerId` 下发 iceServers → Host 按 offer.`turnServerId` 建 ICE → Viewer select + `wrdTurnServerId` + 应用重连。扁平 `mergeTurnConfig` 继续暴露**默认节点**以兼容旧调用。

**Spec:** `docs/superpowers/specs/2026-08-02-multi-turn-server-selection-design.md`

**Tech Stack:** Node.js turn-config、Express `/api/webrtc-config`、python-host aiortc ICE、vanilla Viewer JS、既有 TurnSelfTest、bash `lib-turn-env.sh`（默认注入）。

**Truth Source:**

- 秘密配置：`WRD_TURN_JSON` / `~/.StockHub/turn.json`（多节点）或 env `TURN_*`（合成 `env`）
- 默认节点：§5.3（阿里云偏好）
- 会话节点：Viewer `wrdTurnServerId` + offer.`turnServerId`
- 能力：Host `supportsMultiTurn` + catalog ids

**Compatibility:**

- 旧 `turnServer` 单对象、纯 env、无 `turnServerId` 的旧客户端 → defaultId
- `wrdNetworkMode` 不变；新增 `wrdTurnServerId`
- 凭据不进 git / 公共 catalog 字段 / 诊断明文

**Impact Map:**

- **Config:** `signal-server/lib/turn-config.js`、`scripts/lib-turn-env.sh`、Host 侧 catalog 解析
- **API:** `server.js` webrtc-config / turn-selftest
- **Host:** `python-host/host.py` capability + `build_ice_servers` + offer
- **Frontend:** `viewer.html`、`webrtc.js`、`turn-selftest.js`
- **Tests:** turn-config / config / host / webrtc 相关
- **Docs:** README / runbook / `.env.example` 多节点示例

**Definition of Done:** Spec §12 Acceptance 全部勾选；相关单测绿；手动：双节点默认阿里云，切换海外后 fp 双边一致。

---

## File Structure

| 文件 | 动作 |
|---|---|
| `signal-server/lib/turn-config.js` | 扩展 catalog / resolve / public DTO |
| `signal-server/test/turn-config.test.js` | 多节点 + 阿里云默认 + 兼容 |
| `signal-server/lib/config.js` | 挂 catalog；扁平默认字段 |
| `signal-server/server.js` | webrtc-config / selftest 认 id |
| `signal-server/websocket/signaling.js` | **`forwardOffer` 白名单增加 `turnServerId`**（否则 Host 永远收不到） |
| `signal-server/websocket/signaling.test.js` | offer 转发带 turnServerId |
| `signal-server/test/config.test.js` | API 字段断言 |
| `signal-server/lib/turn-selftest.js` | 按 id 探针 |
| `scripts/lib-turn-env.sh` | 默认节点写入 `TURN_*`（尽量选阿里云） |
| `python-host/host.py` | catalog + session id ICE |
| `python-host/test_*.py` 或新增 `test_turn_catalog.py` | 解析与 build_ice |
| `web-client/viewer.html` | TURN 节点 select |
| `web-client/js/webrtc.js` | 选择 / 持久化 / offer / 文案 |
| `web-client/js/turn-selftest.js` | probe 带 id |
| `web-client/js/*.test.js` | 选择与回退 |
| `signal-server/.env.example`、README、runbook | 文档 |

---

## Task 0: 基线与样例夹具

**Files:** 测试夹具 only（不改生产配置文件进 git）

- [ ] **Step 1:** 确认本机 `~/.StockHub/turn.json` 为 `turnServers[]` 双节点（只读；**不要**把真实密码写进仓库或 spec 之外的新文件）。

- [ ] **Step 2:** 在 `signal-server/test/` 用 temp 文件构造：

```js
const dual = {
  turnServers: [
    {
      host: '8.1.1.1', port: 3478, username: 'u1', password: 'p1',
      realm: 'aliyun.example', transport: 'udp', remark: '阿里云节点',
    },
    {
      host: '9.2.2.2', port: 3478, username: 'u2', password: 'p2',
      realm: 'overseas.example', transport: 'udp', remark: '海外节点',
    },
  ],
};
const legacy = {
  turnServer: {
    host: '1.1.1.1', port: 3478, username: 'u', password: 'p',
    transport: 'udp', remark: 'legacy',
  },
};
```

- [ ] **Step 3:** 记录当前单测基线：

```bash
node --test signal-server/test/turn-config.test.js signal-server/test/config.test.js
```

---

## Task 1: Node catalog loader（Phase A）

**Files:** `signal-server/lib/turn-config.js`, `signal-server/test/turn-config.test.js`

- [ ] **Step 1: 写失败测试**（可粘贴方向）

```js
test('loads turnServers array and prefers aliyun as default', () => {
  // writeTempTurnJson(dual)
  // const catalog = loadTurnCatalog({ env: { WRD_TURN_JSON: path }, jsonPath: path })
  // assert.equal(catalog.servers.length, 2)
  // assert.equal(catalog.defaultId, 'aliyun') // or stable id from remark
  // assert.equal(catalog.servers[0].configured, true)
  // public = catalog.servers.map(toPublicTurnServer)
  // assert.ok(public.every(s => !('password' in s) && !('credential' in s)))
});

test('legacy turnServer still yields one-server catalog', () => { /* ... */ });

test('resolveTurnServer unknown id falls back to default', () => { /* ... */ });

test('mergeTurnConfig flat fields track default selected server', () => {
  // urls/username/fingerprint === default server
});

test('explicit defaultTurnServerId and WRD_TURN_SERVER_ID win over aliyun heuristic', () => { /* ... */ });

test('full TURN_URLS env injects env server and selects it by default', () => { /* ... */ });
```

- [ ] **Step 2: RED**

```bash
node --test signal-server/test/turn-config.test.js
```

- [ ] **Step 3: 实现**

核心导出（名称可微调，但职责固定）：

- `loadTurnCatalog`
- `resolveTurnServer`
- `toPublicTurnServer`
- `assignStableTurnIds`
- `isPreferredAliyun`
- `pickDefaultTurnServerId`
- 保留并改编：`loadTurnFromJsonFile`（可改为返回 primary 或内部调用 catalog）、`mergeTurnConfig`、`getTurnFingerprint`、`describeTurnConfig`

实现要点：

1. 解析 `turnServers[]` + 遗留 `turnServer`
2. 每节点 `buildTurnUrl` + extra urls → `normalizeTurnUrls`
3. id 稳定生成（spec §5.2）；阿里云 remark → 优先 id `aliyun`
4. `mergeTurnConfig` = catalog + resolve(default) 的扁平投影
5. **永不**在 describe/public 中带 password

- [ ] **Step 4: GREEN** + 旧用例全过

```bash
node --test signal-server/test/turn-config.test.js
```

- [ ] **Step 5: Commit**（若用户要求再提交）

```text
feat(turn): load multi-server catalog with aliyun default
```

---

## Task 2: config + HTTP API（Phase B 前半）

**Files:** `signal-server/lib/config.js`, `signal-server/server.js`, `signal-server/lib/turn-selftest.js`, 对应 test

- [ ] **Step 1: 失败测试**

`/api/webrtc-config`：

- 双节点 → `turnServers.length === 2`，`selectedTurnServerId` 默认阿里云，`iceServers` TURN urls 仅默认节点
- `?turnServerId=<overseas>` → selected 与 iceServers 切换，fp 变
- public 列表无 password
- 旧字段 `turnConfigured` / `turnFingerprint` / `turnUrls` 仍表示**选中**节点

`POST /api/turn-selftest`：

- body `{ turnServerId }` 影响探针目标（可用 runner mock）

- [ ] **Step 2: RED**

```bash
node --test signal-server/test/config.test.js signal-server/test/turn-selftest.test.js
```

- [ ] **Step 3: 实现**

1. `loadConfig` 保存内部 catalog（注意：进程内 config 含 secret，仅服务端用）
2. `getTurnStatus(configLike, { turnServerId })` 可选按 id
3. webrtc-config handler：

```js
const requestedId = String(req.query.turnServerId || '').trim();
const resolved = resolveTurnServer(config.turnCatalog, requestedId);
// iceServers from stun + resolved
// turnServers: public list
// selectedTurnServerId, defaultTurnServerId
// host* from getHostCapabilities()
```

4. selftest：`runFromConfig(config, { turnServerId, timeoutMs })`

- [ ] **Step 4: GREEN**

```bash
node --test signal-server/test/config.test.js signal-server/test/turn-selftest.test.js
```

- [ ] **Step 5: signaling `forwardOffer` 白名单（阻塞）**

**Files:** `signal-server/websocket/signaling.js`, `signaling.test.js`

```js
// forwardOffer:
const turnServerId = String(data.turnServerId || '').trim();
if (turnServerId) forwarded.turnServerId = turnServerId;
```

单测：fake viewer emit offer 含 `turnServerId: 'overseas'` → host 收到的 payload 含同一 id。  
**若本步缺失，Task 3/4 全部白做（Host 永远用默认节点）。**

```bash
node --test signal-server/websocket/signaling.test.js
```

---

## Task 3: Host catalog + session turnServerId（Phase B 后半）

**Files:** `python-host/host.py`, 新增/扩展测试, `scripts/lib-turn-env.sh`

- [ ] **Step 1: 失败测试（pytest）**

```python
def test_load_turn_catalog_prefers_aliyun(tmp_path):
    # write dual json; load; default id aliyun-like; len==2

def test_build_ice_servers_uses_turn_server_id(tmp_path, monkeypatch):
    # relay + overseas id → urls host 9.2.2.2
    # unknown id → default aliyun

def test_get_host_turn_capability_lists_ids(tmp_path, monkeypatch):
    # supportsMultiTurn True, turnServerIds contains both
```

- [ ] **Step 2: RED**

```bash
cd python-host && python -m pytest test_turn_catalog.py -q
# 或并入既有 test 文件名
```

- [ ] **Step 3: 实现**

1. Python 侧实现与 Node **同规则**的最小子集：load catalog、id、default、fingerprint、resolve（允许抽 `python-host/turn_catalog.py` 保持 host.py 精简）
2. `get_host_turn_capability()` 扩展字段
3. `build_ice_servers(mode, turn_server_id=None)`
4. offer 处理：

```python
turn_server_id = (offer_data or {}).get("turnServerId") or (offer_data or {}).get("turn_server_id")
config = RTCConfiguration(iceServers=build_ice_servers(network_mode, turn_server_id))
# 会话记录 selected id + fp，随 capability/answer 可观测
```

5. `lib-turn-env.sh`：若 json 为数组，**导出默认（阿里云优先）节点**到 `TURN_URLS/USERNAME/CREDENTIAL`，保证 LaunchAgent 冷启动仍有默认；完整切换仍靠 Host 读 json

- [ ] **Step 4: GREEN**

```bash
python -m pytest python-host/test_turn_catalog.py -q
# 及既有 host 相关测试若有
```

- [ ] **Step 5: 手工核对日志**（需用户启 Host 时）：启动应打印 multi-turn ids 与 default，无 password。

---

## Task 4: Viewer 选择 UX（Phase C）

**Files:** `web-client/viewer.html`, `web-client/js/webrtc.js`, `web-client/js/turn-selftest.js`, 相关 test

- [ ] **Step 1: UI**

在网络 modal 中 TURN 状态行附近增加：

```html
<label class="network-turn-select-label" for="turnServerSelect">TURN 节点</label>
<select id="turnServerSelect" class="network-turn-select"></select>
```

- [ ] **Step 2: 状态与加载**

```js
// localStorage key: wrdTurnServerId
loadServerConfig({ turnServerId = this.selectedTurnServerId } = {}) {
  // GET /api/webrtc-config?turnServerId=...
  // 刷新 turnServers 下拉；校正 selected
}

populateTurnServerSelect() { /* from serverConfig.turnServers */ }

applyNetworkModal() {
  // mode + turnServerSelect.value
  // persist wrdTurnServerId
  // setTurnServerId + setNetworkMode/refresh
}
```

- [ ] **Step 3: offer 契约**

```js
// createOffer / emit offer payload:
turnServerId: this.selectedTurnServerId || undefined,
```

- [ ] **Step 4: 文案与降级**

- `buildTurnStatusText` 含节点 label/id
- 若 `hostSupportsMultiTurn === false` 且所选 ≠ Host 唯一节点 → 警告并回退（避免必现 mismatch）
- `runTurnSelfTest`：reload config 带 id；server probe POST body 带 id

- [ ] **Step 5: 前端单测**

- 默认选中 preferred/default
- localStorage 失效 id 回退
- `getIceConfig` 仅含选中 TURN（mock serverConfig）

- [ ] **Step 6: 跑测**

```bash
# 项目既有 web-client 测试命令（以 package 脚本为准）
node --test web-client/js/turn-selftest.test.js
# 若 webrtc 有 test：
node --test web-client/js/webrtc.test.js
```

---

## Task 5: Docs / ops（Phase D）

**Files:** `README.md`（TURN 段）、`docs/runbook-safe-startup.md`（若有 TURN 段）、`signal-server/.env.example`、可选需求文档一句

- [ ] **Step 1:** 文档示例使用**假** host/密码；展示 `turnServers[]` + `defaultTurnServerId` 可选
- [ ] **Step 2:** 写明：默认阿里云；Viewer「网络」面板切换；Host 需能读同一 `turn.json`
- [ ] **Step 3:** 环境变量表增加 `WRD_TURN_SERVER_ID`

---

## Task 6: 端到端验收清单（手工）

> 服务由用户终端启动；agent 只列步骤与期望。

- [ ] **A. 配置**  
  本机 `turn.json` 为双节点；重启 signal-server 与 Host（Host 用 `scripts/restart-host.sh`）。

- [ ] **B. API**  
  登录后 `GET /api/webrtc-config`：两条 `turnServers`，`selectedTurnServerId` 为阿里云；`iceServers` TURN 指向阿里云 host。

- [ ] **C. 切换**  
  Viewer 选海外 → 应用并重连 → query/offer id 为海外；Host 日志 ICE urls 为海外；状态行 fp 与 Host 一致。

- [ ] **D. relay**  
  网络模式外网中继；有画面则 selected candidate 为 relay（或既有链路质量面板）。

- [ ] **E. 自检**  
  「测试 TURN」对当前节点 PASS/FAIL 明确。

- [ ] **F. 安全**  
  浏览器 Network 面板中 `turnServers` 无 password；diag 发送无 password。

- [ ] **G. 兼容**  
  临时改回单 `turnServer` 或仅 env：仍可连；UI 单选项或隐藏合理。

---

## Execution Order

```text
Task 0 夹具
  → Task 1 Node catalog
  → Task 2 API
  → Task 3 Host（可与 Task 2 部分并行，但 offer 契约需对齐字段名 turnServerId）
  → Task 4 Viewer
  → Task 5 Docs
  → Task 6 手工验收
```

## Risk Checklist（实施时回归）

| 风险 | 检查 |
|---|---|
| 只改 Viewer 忘 Host | offer 无 id 时必须 default；有 id 时 Host 日志必须变化 |
| 改了 offer 但忘 `forwardOffer` 白名单 | signaling 单测必盖；Host 抓包/日志无 turnServerId 即失败 |
| 切换节点后自检仍比启动默认 fp | Host 会话 capability 更新或自检按 hostTurnServerId |
| fingerprint 仍用“全目录拼接” | 禁止；会话 fp = 单节点 |
| public catalog 漏 password | 单测断言 |
| localStorage 脏 id | 回退 default，不抛 |
| bash 只导第一项且第一项是海外 | 导出逻辑必须跑同一套 default 选择 |
| auto 模式把两节点都塞进 ICE | 禁止 |
| 文档写入真实密码 | 禁止 |

## Plan Review Notes（计划自审）

1. **完整性：** Spec 的 Phase A–D 均有对应 Task；Acceptance 映射到 Task 6。
2. **TDD 序：** 每核心 Task 先 RED 再实现；与仓库既有 plan 风格一致。
3. **兼容层：** 明确保留扁平 `mergeTurnConfig`，降低一次性改爆面。
4. **最大坑：** Host 必须读目录——Task 3 不可省略；仅改 `lib-turn-env.sh` 不够。
5. **字段名：** 全链路统一 `turnServerId`（camelCase）；Python 读 offer 时兼容 snake_case 一次即可。
6. **范围控制：** 不做自动 RTT 切换、不做测全部、不动 Terminal Phase 2。
7. **提交策略：** 按 Task 1→4 逻辑提交更清晰；未要求则不提交。
8. **残留开放点：** Node/Python id 生成必须双端单测夹具对齐（同一 json → 同一 defaultId）；若实现时发现 slug 细则歧义，以 Node 为权威并在 Python 复制，或抽一份 JSON 向量测试表。
