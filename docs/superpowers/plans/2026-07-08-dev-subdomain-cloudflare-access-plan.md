# Dev Subdomain Cloudflare Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional `dev.link.stockhub.wiki -> 127.0.0.1:5173` support on the existing named tunnel, document a separate Cloudflare Access gate for it, and keep the formal `link.stockhub.wiki -> 8080` path stable and independent.

**Architecture:** Keep the fixed-domain tunnel as the single edge truth source, but extend it to support an optional second hostname for dev traffic. Preserve `8080` as the only required origin for formal service startup, and treat `5173` as a separate dev-origin contract validated independently through docs and checks rather than made a hard runtime dependency.

**Tech Stack:** Bash, Cloudflare Tunnel, Cloudflare Access, Node.js test runner, Markdown docs, Vite proxy/HMR contract

**Spec Coverage:** Full approved spec coverage for the first-stage design. This plan covers multi-host tunnel config generation, route setup, startup/status behavior, deploy/runbook truth-source updates, Access guidance, validation steps, and rollback docs. It does not automate Cloudflare Access API provisioning because that is explicitly out of scope in the spec.

**Truth Source:** `scripts/setup-cloudflare.sh` and generated `~/.cloudflared/config.yml` define the authoritative multi-host tunnel layout; `README.md` and deploy/runbook docs define the authoritative operator contract; `link.stockhub.wiki -> 8080` remains the formal runtime truth.

**Compatibility Notes:** `link.stockhub.wiki -> 8080` remains unchanged. The dev subdomain is optional and only rendered when `DEV_DOMAIN` and `DEV_LOCAL_ORIGIN` are configured. No new default backend CORS widening is allowed; cross-origin mode remains a documented fallback only.

**Impact Map:**
- **Truth Source:** The named tunnel config becomes the canonical source for both hostnames, with `8080` still the only mandatory origin.
- **Backend:** Not applicable for code-path changes; backend runtime stays on `8080`, and CORS defaults stay narrow.
- **Frontend:** Not applicable inside this repo for implementation; the `5173` app contract is documented as an external Vite proxy/HMR requirement.
- **Runtime Proof:** Generated `config.yml`, script tests, `curl -I` to main/dev domains, Access challenge on `dev`, and a manual HMR/API/socket validation pass through `dev.link.stockhub.wiki`.
- **Docs/Skills:** `README.md`, `docs/runbook-safe-startup.md`, `docs/superpowers/deploy/README.md`, and `docs/需求文档/WebRemoteDesktop-需求文档.md`.
- **Commit Boundary:** One focused infra/doc batch for dev subdomain support. No unrelated tunnel strategy, quick tunnel, or runtime feature work belongs in this batch.

**Definition of Done:**
- `scripts/setup-cloudflare.sh` can generate a named-tunnel config with or without an optional dev ingress, and tests cover both shapes.
- `scripts/start-fixed-domain.sh` and operator docs preserve `8080` as the only required runtime dependency while still surfacing the optional dev subdomain contract.
- The repo documents an exact Cloudflare Access configuration, multi-level-host certificate prerequisite, and Vite proxy/HMR contract that an operator can execute and verify end to end.

---

## File Structure

### Canonical truth and responsibility map

- `scripts/setup-cloudflare.sh`
  - Canonical generator for named-tunnel multi-host config and DNS routing
- `scripts/start-fixed-domain.sh`
  - Canonical fixed-domain startup script; must preserve main-service-first startup semantics
- `scripts/setup-cloudflare.test.js`
  - Canonical regression test for generated ingress shape and route commands
- `scripts/start-fixed-domain.test.js`
  - Canonical regression test for main-origin-only gating and dev-origin optionality
- `README.md`
  - Canonical top-level operator summary for fixed-domain plus optional dev subdomain behavior
- `docs/runbook-safe-startup.md`
  - Canonical operational truth for startup/restart/impact boundaries
- `docs/superpowers/deploy/README.md`
  - Canonical deployment guide for fixed domain, optional dev domain, and Access setup
- `docs/需求文档/WebRemoteDesktop-需求文档.md`
  - Canonical product-facing statement of the dev mapping constraint

### Compatibility boundary

- `link.stockhub.wiki -> 8080` remains the only formal entrypoint contract
- `dev.link.stockhub.wiki -> 5173` is optional and must not block main-site startup
- Cloudflare Access is documented and manually provisioned outside the repo

---

### Task 1: Make the named tunnel config support an optional dev hostname

**Files:**
- Modify: `scripts/setup-cloudflare.sh`
- Test: `scripts/setup-cloudflare.test.js`

- [ ] **Step 1: Write the failing test for single-host and dual-host config generation**

```js
// scripts/setup-cloudflare.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'setup-cloudflare.sh');

test('setup-cloudflare script supports optional dev hostname env contract', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /DEV_DOMAIN="\$\{DEV_DOMAIN:-dev\.link\.stockhub\.wiki\}"/);
  assert.match(source, /DEV_LOCAL_ORIGIN="\$\{DEV_LOCAL_ORIGIN:-http:\/\/127\.0\.0\.1:5173\}"/);
  assert.match(source, /ENABLE_DEV_SUBDOMAIN="\$\{ENABLE_DEV_SUBDOMAIN:-0\}"/);
});

test('setup-cloudflare script renders second ingress and second dns route only when enabled', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /hostname: \$DOMAIN/);
  assert.match(source, /service: \$LOCAL_ORIGIN/);
  assert.match(source, /if \[ \"\$ENABLE_DEV_SUBDOMAIN\" = \"1\" \]/);
  assert.match(source, /hostname: \$DEV_DOMAIN/);
  assert.match(source, /service: \$DEV_LOCAL_ORIGIN/);
  assert.match(source, /cloudflared tunnel route dns \"\$TUNNEL_NAME\" \"\$DEV_DOMAIN\"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test scripts/setup-cloudflare.test.js
```

Expected:

```text
FAIL missing DEV_DOMAIN / DEV_LOCAL_ORIGIN / ENABLE_DEV_SUBDOMAIN support
FAIL missing conditional second ingress or second route command
```

- [ ] **Step 3: Add explicit optional-dev envs and conditional ingress rendering**

```bash
# scripts/setup-cloudflare.sh
DEV_DOMAIN="${DEV_DOMAIN:-dev.link.stockhub.wiki}"
DEV_LOCAL_ORIGIN="${DEV_LOCAL_ORIGIN:-http://127.0.0.1:5173}"
ENABLE_DEV_SUBDOMAIN="${ENABLE_DEV_SUBDOMAIN:-0}"
```

```bash
# scripts/setup-cloudflare.sh
cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: ~/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: $LOCAL_ORIGIN
EOF

if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
cat >> ~/.cloudflared/config.yml << EOF
  - hostname: $DEV_DOMAIN
    service: $DEV_LOCAL_ORIGIN
EOF
fi

cat >> ~/.cloudflared/config.yml << EOF
  - service: http_status:404
EOF
```

- [ ] **Step 4: Add conditional second DNS route and operator output**

```bash
# scripts/setup-cloudflare.sh
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"

if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
  cloudflared tunnel route dns "$TUNNEL_NAME" "$DEV_DOMAIN"
fi

echo "Primary domain: https://$DOMAIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
  echo "Dev domain: https://$DEV_DOMAIN"
  echo "Dev origin: $DEV_LOCAL_ORIGIN"
fi
```

- [ ] **Step 5: Re-run the test and verify it passes**

Run:

```bash
node --test scripts/setup-cloudflare.test.js
```

Expected:

```text
ok 1 - setup-cloudflare script supports optional dev hostname env contract
ok 2 - setup-cloudflare script renders second ingress and second dns route only when enabled
```

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-cloudflare.sh scripts/setup-cloudflare.test.js
git commit -m "feat: support optional dev subdomain tunnel config"
```

---

### Task 2: Preserve main-site startup semantics while surfacing optional dev-domain behavior

**Files:**
- Modify: `scripts/start-fixed-domain.sh`
- Test: `scripts/start-fixed-domain.test.js`

- [ ] **Step 1: Write the failing test for main-origin-only gating**

```js
// scripts/start-fixed-domain.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'start-fixed-domain.sh');

test('start-fixed-domain script keeps 8080 health as the only required gate', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /HEALTH_URL="\$\{HEALTH_URL:-\$\{LOCAL_ORIGIN\}\/health\}"/);
  assert.doesNotMatch(source, /5173.*health/i);
  assert.doesNotMatch(source, /DEV_LOCAL_ORIGIN.*curl/i);
});

test('start-fixed-domain script prints optional dev-domain guidance without making it mandatory', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /ENABLE_DEV_SUBDOMAIN="\$\{ENABLE_DEV_SUBDOMAIN:-0\}"/);
  assert.match(source, /echo "Domain: https:\/\/\$DOMAIN"/);
  assert.match(source, /echo "Dev domain: https:\/\/\$DEV_DOMAIN"/);
  assert.match(source, /echo "Dev origin is optional and not startup-blocking"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test scripts/start-fixed-domain.test.js
```

Expected:

```text
FAIL missing ENABLE_DEV_SUBDOMAIN or dev-domain operator output
```

- [ ] **Step 3: Add optional dev-domain envs and non-blocking operator output**

```bash
# scripts/start-fixed-domain.sh
DEV_DOMAIN="${DEV_DOMAIN:-dev.link.stockhub.wiki}"
DEV_LOCAL_ORIGIN="${DEV_LOCAL_ORIGIN:-http://127.0.0.1:5173}"
ENABLE_DEV_SUBDOMAIN="${ENABLE_DEV_SUBDOMAIN:-0}"
```

```bash
# scripts/start-fixed-domain.sh
printf '\n=== ready ===\n'
echo "Domain: https://$DOMAIN"
echo "Local origin: $LOCAL_ORIGIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
  echo "Dev domain: https://$DEV_DOMAIN"
  echo "Dev origin: $DEV_LOCAL_ORIGIN"
  echo "Dev origin is optional and not startup-blocking"
fi
curl -s "${LOCAL_ORIGIN}/api/status" || true
```

- [ ] **Step 4: Re-run the test and verify it passes**

Run:

```bash
node --test scripts/start-fixed-domain.test.js
```

Expected:

```text
ok 1 - start-fixed-domain script keeps 8080 health as the only required gate
ok 2 - start-fixed-domain script prints optional dev-domain guidance without making it mandatory
```

- [ ] **Step 5: Commit**

```bash
git add scripts/start-fixed-domain.sh scripts/start-fixed-domain.test.js
git commit -m "feat: expose optional dev-domain startup contract"
```

---

### Task 3: Update top-level docs and runbook truth sources

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/superpowers/deploy/README.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Add the fixed-domain plus optional dev-domain contract to the README**

```md
## 固定域名与开发子域

- 正式入口：`https://link.stockhub.wiki -> 127.0.0.1:8080`
- 可选开发入口：`https://dev.link.stockhub.wiki -> 127.0.0.1:5173`
- `dev` 子域必须单独受 Cloudflare Access 保护
- `5173` 不是当前仓库正式入口，也不是 fixed-domain 启动硬依赖
```

- [ ] **Step 2: Document restart-impact boundaries in the runbook**

```md
### 开发子域影响边界

- 重启 `5173`：只影响 `dev.link.stockhub.wiki`
- 重启 `8080`：影响主站与 dev 子域代理能力
- 重启 named tunnel：两个域名同时受影响
- 修改 Cloudflare Access：只影响 `dev` 子域的边缘准入
```

- [ ] **Step 3: Add a deploy section with exact Access and Vite contract**

```md
## `dev.link.stockhub.wiki` 配置

1. 生成 dual-host tunnel config：
   `ENABLE_DEV_SUBDOMAIN=1 DEV_DOMAIN=dev.link.stockhub.wiki DEV_LOCAL_ORIGIN=http://127.0.0.1:5173 ./scripts/setup-cloudflare.sh`
2. 在 Cloudflare Zero Trust 创建 Self-hosted Application：
   - Domain: `dev.link.stockhub.wiki`
   - Policy: default deny
   - Allow: 指定邮箱或 group
3. 先确认 `dev.link.stockhub.wiki` 的 Cloudflare 证书条件已满足
4. `5173` 应用需配置：
   - `/api -> http://127.0.0.1:8080`
   - `/socket.io -> http://127.0.0.1:8080` with `ws: true`
   - HMR host `dev.link.stockhub.wiki`, protocol `wss`, port `443`
```

- [ ] **Step 4: Update the demand doc so the 5173 mapping requirement points to the secured dev subdomain shape**

```md
- [x] 开发映射：本机 `http://localhost:5173/` 可通过 `https://dev.link.stockhub.wiki` 暴露，并由独立 Cloudflare Access 保护
- [x] 开发映射默认通过 Vite proxy 访问同一套 `8080` Terminal / API / Socket.IO 服务
- [ ] 如需运行时隔离，后续另行拆分 dev backend 与 Host
```

- [ ] **Step 5: Verify the docs contain no contradictory 5173 guidance**

Run:

```bash
rg -n "5173|dev.link.stockhub.wiki|Cloudflare Access" README.md docs/runbook-safe-startup.md docs/superpowers/deploy/README.md docs/需求文档/WebRemoteDesktop-需求文档.md
```

Expected:

```text
Matches show 5173 as an optional dev mapping, never as the formal default entrypoint
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/superpowers/deploy/README.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: define secured dev subdomain mapping"
```

---

### Task 4: Add an operator verification checklist for edge behavior

**Files:**
- Modify: `docs/superpowers/deploy/README.md`

- [ ] **Step 1: Add explicit validation commands for DNS, Access, main-site health, and dev-site health**

```md
## 验证步骤

命令：

    cloudflared tunnel info wrd-tunnel
    curl -I https://link.stockhub.wiki
    curl -I https://dev.link.stockhub.wiki

预期：

- `link.stockhub.wiki` 直接返回正常 HTTP
- `dev.link.stockhub.wiki` 在未授权时返回 Access challenge 或登录跳转
- Access 登录后，`dev` 页面静态资源可加载
- `dev.link.stockhub.wiki` 不出现证书错误
```

- [ ] **Step 2: Add manual dev-app verification for proxy, socket, and HMR**

```md
Access 通过后，在浏览器验证：

1. 打开 `https://dev.link.stockhub.wiki`
2. Network 中 `/api/*` 成功返回
3. `/socket.io/*` websocket 连接成功
4. 修改本地 `5173` 应用文件后，HMR 能通过 `wss://dev.link.stockhub.wiki` 生效
```

- [ ] **Step 3: Add rollback commands**

```md
## 回滚

1. 删除 `config.yml` 中的 `dev.link.stockhub.wiki` ingress
2. 在 Cloudflare Dashboard 或 Zero Trust 对应 DNS/hostname 配置中删除 `dev.link.stockhub.wiki` 记录
3. 停用 `dev` Access app
4. 保留 `link.stockhub.wiki` 原有配置不变
```

- [ ] **Step 4: Verify the final docs are internally consistent**

Run:

```bash
rg -n "quick tunnel|formal|dev.link.stockhub.wiki|Access|startup-blocking" docs/superpowers/deploy/README.md README.md docs/runbook-safe-startup.md
```

Expected:

```text
No text claims that 5173 is the formal entrypoint or required for fixed-domain startup
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/deploy/README.md
git commit -m "docs: add dev subdomain validation and rollback checklist"
```

---

## Self-Review Checklist

- [ ] Spec coverage confirmed against `docs/superpowers/specs/2026-07-08-dev-subdomain-cloudflare-access-design.md`
- [ ] No task widens backend CORS by default
- [ ] `8080` remains the only startup-blocking dependency
- [ ] Access provisioning is documented as manual infra, not hidden inside scripts
- [ ] Rollback preserves `link.stockhub.wiki -> 8080`
- [ ] No placeholder text remains in code snippets or commands

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-dev-subdomain-cloudflare-access-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
