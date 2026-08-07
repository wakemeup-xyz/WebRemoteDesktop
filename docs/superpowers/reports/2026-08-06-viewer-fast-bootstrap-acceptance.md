# Checklist closure (transport / HTML cache / diagnostics)

Date: 2026-08-07  
Tip: `fe500269a36073b28e068bc98125f7a354b36e83`

## 四项完成状态

| # | 要求 | 状态 |
|---|---|---|
| 1 | `tryAllTransports: true` + **真实 Socket.IO 客户端**集成测试（WS 拒绝→polling 成功；双失败预算内） | **已完成** |
| 2 | 撤销 HTML edge `max-age=60`（恢复 revalidate + CDN `no-store`） | **已完成**（选撤销，未做 N-1 保留方案） |
| 3 | pending diagnostics **按 attempt 去重** + **统一 cooldown** 发送/replay | **已完成** |
| 4 | 正式 cold 20 / warm 20 / fault injection 重跑 | **已跑**；**非 FULL PASS** |

未做：bundle 微调、Cloudflare Cache Everything 配置（按要求）。

## 自动化

- `signaling-transport-fallback.test.js`：真实 `socket.io-client` 对 polling-only 服务端回落 polling；双 transport 失败 ≤5.5s
- web-assets：HTML `no-cache, max-age=0` + CDN `no-store`
- diagnostic：enqueue 去重、cooldown 单测
- webrtc：options 含 `tryAllTransports: true`

## 运行时（commitSha = `fe500269…`）

### Local
- cold 5/5 PASS  
- deferred-abort ×1 PASS  

### Formal cold 20 — NOT FULL PASS
SHA `dbf5593e…4ae4`  
success **19/20**（bounded-wait-5s ×1）  
HTML P95 4764 / core P95 6019 / signal P95 2928 / non-black P95 5811  

### Formal warm 20 — NOT FULL PASS
SHA `286ecf3e…d343`  
success **18/20**  
HTML/core P95 被极端尾（~18s）拉爆；signal P95 3109  

## Judgment

- **代码清单 1–3：完成**
- **正式 FULL PASS：仍不成立**（路径 TTFB/偶发等待，非本次清单回归点）
