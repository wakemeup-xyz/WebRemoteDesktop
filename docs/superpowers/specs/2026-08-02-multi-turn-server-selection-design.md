# 多 TURN 节点目录 + 前端切换设计

日期：2026-08-02

## 1. Goal

在既有 TURN 全链路（`docs/superpowers/specs/2026-07-20-turn-integration-design.md`）之上，把本机秘密源 `~/.StockHub/turn.json` 从**单节点**升级为**多节点目录**，并在 Viewer 网络面板支持**手动切换 TURN 节点**。默认优先选中**阿里云节点**；Viewer 与 Host 必须对**同一会话**使用同一节点，否则 `relay` 永远选不出 pair。

## 2. Background

### 2.1 配置源现状（运维事实）

`~/.StockHub/turn.json` 已演化为数组形态（凭据不入库，此处仅示意结构）：

```json
{
  "turnServers": [
    {
      "host": "8.x.x.x",
      "port": 3478,
      "username": "...",
      "password": "...",
      "realm": "aliyun.stockhub.wiki",
      "transport": "udp",
      "remark": "阿里云节点"
    },
    {
      "host": "144.x.x.x",
      "port": 3478,
      "username": "...",
      "password": "...",
      "realm": "dedione.stockhub.wiki",
      "transport": "udp",
      "remark": "海外节点"
    }
  ]
}
```

### 2.2 代码事实（与文档冲突时以代码为准）

| 组件 | 现状 | 缺口 |
|---|---|---|
| `signal-server/lib/turn-config.js` | 只解析 `parsed.turnServer \|\| parsed` 单对象 | 忽略 `turnServers[]`；无 id / 目录 / 默认优选 |
| `scripts/lib-turn-env.sh` | 同样只读 `turnServer` | Host 注入只有一组 `TURN_*` |
| `GET /api/webrtc-config` | 下发单组 `iceServers` / 单 `turnFingerprint` | 无节点列表、无 selectedId |
| Viewer 网络面板 | 模式 radio +「测试 TURN」 | 无节点下拉；localStorage 仅 `wrdNetworkMode` |
| Host `build_ice_servers(mode)` | 会话级按 **mode** 决定是否含 TURN | 仍只有进程 env 一组凭据；`supportsSessionTurn=true` 仅表示 mode 作用域，**不是**多节点选择 |
| offer 载荷 | 已带 `networkMode` / `iceMode` | 无 `turnServerId` |

### 2.3 关键约束（继承 + 强化）

1. 公网入口与媒体路径解耦不变。
2. Strict STUN（`auto`/`stun`）仍不自动改写为 `relay`/`tunnel`。
3. TURN 凭据不得进 git、诊断明文、静态前端资源。
4. **Viewer 与 Host 对同一会话必须使用同一 TURN 节点**（id + fingerprint 一致）。
5. 一次会话只激活**一个** TURN 节点（不把多节点同时塞进 ICE 让浏览器“随便选”，避免 fp 语义混乱与不可预期 RTT）。
6. 未配置多节点时，行为与现网单节点完全兼容。

## 3. Confirmed Product Decisions

1. **配置形状**：权威源支持 `turnServers[]`；继续兼容遗留 `turnServer` 单对象。
2. **默认节点**：优先阿里云（见 §5.3 解析规则）；用户可在前端改选。
3. **切换粒度**：与网络模式独立——桌面 `relay`/`auto` 用当前选中节点；换节点需「应用并重连」。
4. **会话契约**：offer / 建 PC 路径携带 `turnServerId`；**signaling `forwardOffer` 必须白名单转发该字段**（今日实现只转发 offer/epoch/lease/networkMode 等，未知字段会被丢弃）；Host 按 id 从本机目录解析凭据建 ICE。
5. **Env 逃生舱**：显式 `TURN_URLS` + 凭据仍可覆盖，合成为 id=`env` 的单节点（或强制默认），便于临时运维。
6. **测试**：「测试 TURN」测**当前选中**节点；可选后续「测全部」不阻塞本阶段。
7. **Terminal `webrtc-turn`（若已启用）**：与桌面共用同一 `turnServerId`；本设计不强制完成 Terminal Phase 2。

## 4. Non-Goals

1. 不在本阶段实现 coturn REST 短期凭证轮换。
2. 不自动按 RTT 在多节点间热切换（可二期）。
3. 不把多节点同时作为 ICE 候选“并行竞选”。
4. 不改 Strict STUN 失败自动升 relay 的策略。
5. 不把凭据写入 localStorage 或诊断 snapshot。
6. 不要求用户手改 Host 环境变量才能换节点。

## 5. Configuration Model

### 5.1 Schema

```ts
type TurnServerEntry = {
  id?: string;           // 稳定 id；缺省由规则生成
  host: string;
  port?: number;         // 默认 3478
  username: string;
  password: string;      // 或 credential
  realm?: string;
  transport?: 'udp' | 'tcp';
  remark?: string;       // UI 展示名优先
  priority?: number;     // 越大越优先；缺省 0
  region?: string;       // 可选：cn | overseas | ...
  urls?: string;         // 可选额外 CSV URL，合并进该节点
};

type TurnJsonFile =
  | { turnServers: TurnServerEntry[]; defaultTurnServerId?: string; turnServer?: never }
  | { turnServer: TurnServerEntry; turnServers?: never; defaultTurnServerId?: string }
  | { turnServers: TurnServerEntry[]; turnServer?: TurnServerEntry; defaultTurnServerId?: string };
```

合并规则：

1. 若存在非空 `turnServers[]`，以其为目录主体。
2. 若同时存在遗留 `turnServer`，追加为目录一项（去重：同 host:port:username 合并），id 缺省 `legacy`。
3. 若仅有 `turnServer` 或“整文件就是单对象”，目录长度为 1（兼容旧文件与旧测试）。

### 5.2 稳定 id 生成

按顺序取第一个可用：

1. 显式 `id`（trim，`[a-zA-Z0-9._-]+`，最长 64）
2. `remark` 的 slug（小写；中文保留原样压缩空白为 `-`；若含「阿里云」→ 优先映射 `aliyun`；「海外」→ `overseas`）
3. `realm` 主机标签（如 `aliyun.stockhub.wiki` → `aliyun`）
4. `host` 字面（`.` → `-`）
5. 回退 `turn-{index}`（1-based）

冲突时：后者追加 `-{n}` 后缀保证目录内唯一。

### 5.3 默认节点选择（Default Resolution）

输入：目录 `servers[]`、文件 `defaultTurnServerId`、env。

顺序（命中且 **configured** 的第一项）：

1. `env.WRD_TURN_SERVER_ID` 或 `env.TURN_SERVER_ID`（若指向存在的 configured id）
2. 文件 `defaultTurnServerId`
3. **阿里云偏好**：`isPreferredAliyun(server)` 为真的项中 `priority` 最大者  
   - `region` ∈ {`cn`,`aliyun`,`china`}（大小写不敏感）  
   - 或 `remark` / `realm` / `id` 匹配 `/阿里云|aliyun|ali\.yun/i`
4. 全目录 `priority` 最大者（并列取目录顺序靠前）
5. 第一个 `configured` 项
6. 无 → `selectedId=''`，`turnConfigured=false`

`configured` 定义（与现网一致）：该节点规范化后 `urls.length > 0` 且 username 与 credential 均非空。

### 5.4 Env 覆盖策略

| 情况 | 行为 |
|---|---|
| 未设 `TURN_URLS` | 完全使用 json 目录 |
| 仅设部分凭据字段 | 字段级覆盖**默认节点**（保持现网 mixed 语义），不发明新节点 |
| 完整 `TURN_URLS`+user+cred | 注入合成节点 `{ id: 'env', remark: '环境变量', urls, ... }`；**默认选中 env**（运维显式优先于阿里云偏好）；json 其它节点仍可在 UI 列出供切换（若 Host 也能解析 json） |
| `WRD_TURN_SERVER_ID` | 只影响默认选中，不删除目录 |

说明：为让「前端切换」在 Host 侧成立，**Host 必须能读完整目录**（见 §6.2），不能只依赖单一 `TURN_*` 进程环境。`TURN_*` 仍作为默认/合成节点来源。

### 5.5 Fingerprint

- **节点 fingerprint**：`sha256(normalizedUrlsSorted + '|' + username)`，**不含 password**（与现网一致）。
- **会话 fingerprint**：等于当前 `selectedTurnServerId` 对应节点的 fingerprint。
- 目录级不再使用“把所有 URL 拼在一起”的单一 fp 作为双边契约。

## 6. Architecture

```text
 ~/.StockHub/turn.json
        │
        ▼
 loadTurnCatalog()  →  servers[] + defaultId + source
        │
 ┌──────┴──────────────┐
 ▼                     ▼
signal-server          python-host
 /api/webrtc-config      load same catalog
 resolve(selectedId)     build_ice_servers(mode, turn_server_id)
 turn-selftest(id)
        │
        ▼
 Browser Viewer
  network panel: <select turnServerId>
  localStorage: wrdTurnServerId
  offer: { networkMode, turnServerId }
  iceServers: ONLY selected node (+ STUN by mode)
```

### 6.1 signal-server

扩展 `turn-config.js`：

| API | 职责 |
|---|---|
| `loadTurnCatalog({ env, jsonPath })` | 返回 `{ servers, defaultId, source, jsonPath, jsonError }` |
| `resolveTurnServer(catalog, turnServerId?)` | 解析选中节点；非法 id 回退 default |
| `toPublicTurnServer(server)` | UI 安全字段（无 password） |
| `toIceServers(server, stunUrls, mode)` | 既有 ice 组装 |
| `getTurnFingerprint(server)` | 单节点 |
| `mergeTurnConfig`（兼容） | **保留**：返回“默认选中节点”的扁平 `urls/username/credential/fingerprint/source`，避免一次改爆所有调用方 |

`loadConfig()`：

- 增加 `turnCatalog`（内部完整，含 credential）
- 扁平 TURN 字段 = 默认节点（启动日志仍只打默认）

`GET /api/webrtc-config`：

```json
{
  "stunUrls": ["..."],
  "iceServers": [ /* STUN + 当前选中 TURN（若 configured） */ ],
  "turnConfigured": true,
  "turnMisconfigured": false,
  "turnStatus": "configured",
  "turnSource": "json",
  "turnFingerprint": "<selected fp>",
  "turnUrls": ["turn:..."],
  "turnServers": [
    {
      "id": "aliyun",
      "label": "阿里云节点",
      "host": "8.x.x.x",
      "port": 3478,
      "transport": "udp",
      "realm": "aliyun.stockhub.wiki",
      "priority": 0,
      "preferred": true,
      "configured": true,
      "fingerprint": "..."
    }
  ],
  "selectedTurnServerId": "aliyun",
  "defaultTurnServerId": "aliyun",
  "hostTurnReady": true,
  "hostTurnFingerprint": "...",
  "hostTurnServerId": "aliyun",
  "hostSupportsSessionTurn": true,
  "hostSupportsMultiTurn": true
}
```

选择来源（请求级）：

1. Query `?turnServerId=`
2. 否则 Header `X-WRD-Turn-Server-Id`（可选）
3. 否则服务端 defaultId

`POST /api/turn-selftest` body 可含 `{ turnServerId, timeoutMs }`；探针与返回 fp 对应该节点。

### 6.2 python-host

1. 启动时（或首次需要时）用与 signal-server 同规则加载目录：
   - 优先读 `WRD_TURN_JSON` / `~/.StockHub/turn.json`
   - 合并 env 合成节点
2. `get_host_turn_capability()` 扩展：

```python
{
  "turnReady": bool,                 # 至少一节点 configured，或默认节点 configured
  "turnFingerprint": str,            # 默认节点 fp（启动摘要）
  "supportsSessionTurn": True,
  "supportsMultiTurn": True,
  "turnServerIds": ["aliyun", "overseas"],
  "defaultTurnServerId": "aliyun",
}
```

3. `build_ice_servers(mode, turn_server_id=None)`：
   - 解析 id → 节点凭据
   - 非法 / 缺失 → default
   - mode 策略不变（relay 强制含 TURN；lan/stun 不含；auto 遵 strict-stun）
4. `on_offer`（及重建 PC 路径）读取 offer 中的 `turnServerId`，写入本会话，建 ICE，并在 answer/能力刷新时带上 **会话级** `turnFingerprint` + `turnServerId`。
5. 日志只打 id / host / fp 短码，不打 password。

#### 6.2.1 signaling 转发（阻塞项）

`signal-server/websocket/signaling.js` 的 `forwardOffer` 今日为**白名单**构造 `forwarded`，不会透传 Viewer 多出来的字段。必须显式增加：

```js
const turnServerId = String(data.turnServerId || '').trim();
if (turnServerId) forwarded.turnServerId = turnServerId;
```

并补 signaling 单测：viewer offer 含 `turnServerId` 时 host 收到同值。

> 兼容：若 Host 暂时读不到目录、仅有单组 `TURN_*`，则 `supportsMultiTurn=false`，目录对外长度为 0 或仅 `env`；Viewer 切换其它 id 时明确失败（见 §8）。

#### 6.2.2 会话级 Host fingerprint 与自检

启动 capability 的 `turnFingerprint` 仍表示**默认节点**摘要。用户切换节点并成功 offer 后：

1. Host 应更新“当前桌面会话”的 `turnServerId` / `turnFingerprint`（可通过再次 `host-capabilities` 或挂在 answer 旁路元数据；优先复用既有 capability fan-out，避免新协议若非必要）。
2. Viewer 自检「Host fp 匹配」在切换后必须与**会话选中节点**比，而不是死盯启动默认 fp。
3. 若 capability 暂时仍是默认 fp，自检可降级为：仅当 `hostTurnServerId` 缺失时用默认；有 `hostTurnServerId` 则按 id 对齐。

### 6.3 Viewer

1. **状态**
   - `selectedTurnServerId`：内存 + `localStorage.wrdTurnServerId`
   - 启动：`loadServerConfig()` 拉目录 → 若 localStorage id 仍在目录且 configured 则沿用，否则用 `defaultTurnServerId`
2. **UI**（网络模式 modal 内、TURN 状态行上方或下方）
   - `<label>TURN 节点</label> <select id="turnServerSelect">`
   - option text：`remark/label (host)`；preferred 标记「推荐」
   - 仅 1 个节点时 select 仍展示但可 disabled 样式弱化
   - 0 个：隐藏 select，文案保持“未配置”
3. **应用并重连**
   - 读取 mode + turnServerId
   - 持久化 localStorage
   - `loadServerConfig({ turnServerId })` 刷新 iceServers
   - `refresh()` / 重 offer，offer 带 `turnServerId`
4. **状态文案** `buildTurnStatusText()` 增加：`节点=阿里云节点(aliyun)`
5. **自检** `TurnSelfTest` / server probe 传入当前 id
6. **诊断 snapshot** 只含 id、label、fp、urls（无 password）

### 6.4 双边一致性状态机

```text
Viewer selectedId ──offer.turnServerId──► Host resolve
        │                                    │
        ▼                                    ▼
 viewer fp (from /api/webrtc-config)   host session fp
        │                                    │
        └──────── must equal ────────────────┘
```

失败码扩展：

| Code | Meaning | Next |
|---|---|---|
| `turn-server-unknown` | id 不在目录 | 回退 default 或提示重选 |
| `turn-server-not-configured` | id 存在但缺凭据 | 修 turn.json |
| `turn-host-multi-unsupported` | Host 无多节点，Viewer 选了非 Host 唯一节点 | 选 Host 支持的节点或升级 Host |
| `turn-fingerprint-mismatch` | 同 id 但 fp 不同（配置漂移） | 重启双侧 / 对配置 |
| （既有）`turn-allocate-failed` 等 | 不变 | 不变 |

## 7. Desktop Media Path Impact

| Mode | ICE | 使用选中 TURN？ |
|---|---|---|
| `lan` | 空 | 否 |
| `stun` | 仅 STUN | 否 |
| `auto` | STUN +（非 strict 时）选中 TURN 作候选 | 是（候选，不改 mode） |
| `relay` | 仅选中 TURN（`iceTransportPolicy:'relay'`） | **必须** |
| `tunnel` | 非 WebRTC | 否 |

换节点不改 mode；`relay` 成功判据仍为 selected candidate type=`relay` + FPS>0 + **会话 fp 一致**。

## 8. UX Copy（简体）

- 下拉标签：`TURN 节点`
- 推荐后缀：`（推荐）`
- 状态例：`TURN 已配置 · 节点 阿里云节点 · source=json · fp ab12cd…`
- Host 不支持多节点且用户选了其它：`当前 Host 仅装载单一 TURN，无法切换到「海外节点」。请重启 Host 以加载完整 turn.json，或改回默认节点。`
- 应用按钮：仍为「应用并重连」（同时应用 mode + 节点）

## 9. Security

1. `turn.json` 权限建议 `600`；路径 `WRD_TURN_JSON` 可覆盖。
2. `/api/webrtc-config` 的 `turnServers[]` **不得**含 password/credential；仅 selected 的 `iceServers` 在已登录 token 下含凭据（与现网一致）。
3. 自检、diag-logs、console 摘要脱敏；禁止打印 password。
4. id / remark / host 可出现在日志；username 可出现在 fp 材料但不建议完整刷屏。
5. 不因多节点扩大 CORS 或匿名可拉取 ICE 凭据的面。

## 10. Compatibility

1. 旧 `turnServer` 单对象文件：目录 length=1，UI 可切换但无实际分支，行为等同现网。
2. 旧客户端不发 `turnServerId`：服务端与 Host 使用 defaultId（阿里云优先）。
3. 旧 Host 无 `supportsMultiTurn`：Viewer 若 localStorage 指向非默认节点，应用时检测并提示；可强制回退 default 以免黑屏。
4. `wrdNetworkMode` 键不变；新增 `wrdTurnServerId`。
5. 既有单测以 `turnServer` 书写的继续通过；新增 `turnServers[]` 用例。

## 11. Phased Delivery

### Phase A — Catalog loader（必做）

- `turn-config.js` + bash/python 对等加载
- 兼容单/多；默认阿里云
- 扁平 `mergeTurnConfig` 仍指向默认节点
- 单测覆盖

### Phase B — API + Host session id（必做）

- `/api/webrtc-config` 目录字段 + query id
- Host 读目录；`build_ice_servers(mode, turn_server_id)`
- offer 携带 / 解析 `turnServerId`
- capability：`supportsMultiTurn`、ids、default

### Phase C — Viewer 选择 UX（必做）

- select + localStorage + 状态文案
- 应用并重连 + 自检绑 id
- Host 不支持时的降级提示

### Phase D — Docs / ops（随做）

- README / runbook / `.env.example`：多节点示例（无真实密码）
- 说明默认阿里云与切换步骤

## 12. Acceptance

- [ ] `turnServers` 双节点文件可被 signal-server 与 Host 解析为 2 条目录；默认 id 指向阿里云
- [ ] 旧 `turnServer` 单对象与纯 env 配置不回归
- [ ] Viewer 下拉可见两节点；默认选中阿里云；切换海外后「应用并重连」
- [ ] 切换后 `/api/webrtc-config?turnServerId=` 与 offer 的 Host ICE 使用同一节点；fp 一致；`relay` 可出画（在该节点网络可达时）
- [ ] 「测试 TURN」针对当前节点；失败码可区分 unknown / mismatch / allocate
- [ ] 凭据不出现在 git、目录 API 公共字段、诊断与控制台明文
- [ ] 无多节点时 UI/API 退化优雅

## 13. Open Follow-ups

1. 按 RTT / Allocate 成功率自动推荐节点（仍手动确认）
2. 「测试全部节点」矩阵
3. 每节点独立 username 的 REST 短期凭证
4. 节点健康后台探针缓存到 `/api/turn-status`

## 14. Spec Review Notes（设计自审）

| 风险 | 结论 | 缓解 |
|---|---|---|
| 只改前端 iceServers、Host 仍用旧 env | **致命**，必双边 | offer.turnServerId + Host 目录 |
| 多节点同时进 iceServers | fp/选路不可控 | 会话单活跃节点 |
| id 不稳定导致 localStorage 失效 | 体验差 | 显式 id + 稳定生成 + 失效回退 default |
| env 与 json 双源打架 | 运维困惑 | 完整 env → 合成 `env` 且默认选中；文档写清 |
| 阿里云启发式误判 | 可能选错默认 | 支持 `defaultTurnServerId` / `priority` / `WRD_TURN_SERVER_ID` 覆盖 |
| 凭据进 turnServers 列表 | 安全回归 | `toPublicTurnServer` 强制剥离 |
| bash `lib-turn-env.sh` 仍单节点 | Host 若只靠 env 无法切换 | Host 直接读 json 目录；bash 仅保证默认 `TURN_*` 仍注入 |
| 单测/旧 plan 假设单 fp |  assy | 兼容层 `mergeTurnConfig` 保持默认扁平字段 |
