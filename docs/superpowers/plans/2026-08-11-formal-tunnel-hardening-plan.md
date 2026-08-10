# Formal Tunnel Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade formal `cloudflared` to ≥2026.7.3, add read-only edge/formal probes, and install a bounded formal-connector watcher that notifies and may restart only `wrd-tunnel` when `link.stockhub.wiki` is down while origin is healthy.

**Architecture:** Keep `fixed-tunnel-preflight.sh` read-only. Add a narrow formal restart script (no signal/host/quick-tunnel side effects), an upgrade wrapper that bounces only that connector, a read-only TCP 7844 + health classifier, and a LaunchAgent watcher with failure threshold / cooldown / restart budget. Docs update runbook semantics so “重启服务” still means local services only.

**Tech Stack:** bash, macOS `launchctl` / `osascript`, Homebrew `cloudflared`, existing Node `node:test` contract tests, optional reuse of `scripts/wrd_entry_health.py` for formal health JSON checks.

**Spec:** `docs/superpowers/specs/2026-08-11-formal-tunnel-hardening-design.md`

## Global Constraints

- Formal tunnel name: `wrd-tunnel`
- Formal launch label: `com.webremotedesktop.fixed-domain`
- Watch label: `com.webremotedesktop.fixed-watch`
- Config: `~/.cloudflared/config.yml` must contain `credentials-file`; never pass `--token` / `TUNNEL_TOKEN`
- Protocol default: `http2` (`WRD_FIXED_TUNNEL_PROTOCOL` may be `http2|quic`)
- cloudflared floor: **≥ 2026.7.3**
- Watch defaults: interval **60s**, fail threshold **180s**, max restarts **2 / 3600s**, cooldown **300s**
- Alert: macOS notification + `/tmp/wrd-fixed-watch.log`
- Never kill/restart: safe quick tunnel, `server.js`, `host.py`, StockHub
- Never print tokens/secrets
- `fixed-tunnel-preflight.sh` remains mutation-free

## File map

| File | Responsibility |
|------|----------------|
| `scripts/lib-fixed-domain.sh` | Shared helpers: config check, unset token, formal health, stop/start formal connector, version parse |
| `scripts/restart-fixed-domain-tunnel.sh` | Operator/watch entry: restart formal only + wait deliverable |
| `scripts/upgrade-cloudflared.sh` | brew upgrade gate + one formal restart |
| `scripts/probe-fixed-edge.sh` | Read-only origin/formal/7844 classification |
| `scripts/watch-fixed-domain.sh` | Loop/once tick: state machine + notify + bounded restart |
| `scripts/install-fixed-watch.sh` | Install/enable LaunchAgent |
| `launchd/com.webremotedesktop.fixed-watch.plist` | KeepAlive agent running watch script |
| `scripts/restart-fixed-domain-tunnel.test.js` | Contract tests for restart/lib safety |
| `scripts/upgrade-cloudflared.test.js` | Version gate + invokes restart once |
| `scripts/probe-fixed-edge.test.js` | Classification fixtures |
| `scripts/watch-fixed-domain.test.js` | State-machine fixtures |
| `docs/runbook-safe-startup.md` | Operator semantics |
| `README.md` | Short pointers |

---

### Task 1: Shared formal-domain library + restart script (TDD)

**Files:**
- Create: `scripts/lib-fixed-domain.sh`
- Create: `scripts/restart-fixed-domain-tunnel.sh`
- Create: `scripts/restart-fixed-domain-tunnel.test.js`

**Interfaces:**
- Consumes: `~/.cloudflared/config.yml`, `cloudflared` binary, `launchctl`, existing formal log path
- Produces:
  - `wrd_fixed_require_credentials_file "$config"`
  - `wrd_fixed_unset_tunnel_token`
  - `wrd_fixed_stop_connector`
  - `wrd_fixed_start_connector`
  - `wrd_fixed_formal_health_ok` → exit 0/1
  - `wrd_fixed_wait_formal_health` → exit 0/1
  - CLI: `./scripts/restart-fixed-domain-tunnel.sh`

- [ ] **Step 1: Write failing contract tests**

Create `scripts/restart-fixed-domain-tunnel.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const restartPath = path.join(__dirname, 'restart-fixed-domain-tunnel.sh');
const libPath = path.join(__dirname, 'lib-fixed-domain.sh');

test('restart formal tunnel sources lib and never targets local app or quick tunnel', () => {
  const restart = fs.readFileSync(restartPath, 'utf8');
  const lib = fs.readFileSync(libPath, 'utf8');
  const all = restart + '\n' + lib;
  assert.match(restart, /lib-fixed-domain\.sh/);
  assert.match(all, /credentials-file/);
  assert.match(all, /unset\s+TUNNEL_TOKEN|wrd_fixed_unset_tunnel_token/);
  assert.match(all, /com\.webremotedesktop\.fixed-domain/);
  assert.match(all, /wrd-tunnel/);
  assert.doesNotMatch(all, /pkill\s+-f\s+'?node server\.js/);
  assert.doesNotMatch(all, /pkill\s+-f\s+'?python.*host\.py/);
  assert.doesNotMatch(all, /run-safe-quicktunnel|wrd-safe-quicktunnel|restart-safe-tunnel/);
  assert.doesNotMatch(all, /--token/);
});

test('lib exposes stop/start/wait helpers without token argv', () => {
  const lib = fs.readFileSync(libPath, 'utf8');
  assert.match(lib, /wrd_fixed_stop_connector\s*\(/);
  assert.match(lib, /wrd_fixed_start_connector\s*\(/);
  assert.match(lib, /wrd_fixed_wait_formal_health\s*\(/);
  assert.doesNotMatch(lib, /TUNNEL_TOKEN=| --token/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/restart-fixed-domain-tunnel.test.js`  
Expected: FAIL (files missing)

- [ ] **Step 3: Implement `scripts/lib-fixed-domain.sh`**

```bash
#!/bin/bash
# Shared formal named-tunnel helpers. Source only; do not exec.

WRD_FIXED_LABEL="${WRD_FIXED_LABEL:-com.webremotedesktop.fixed-domain}"
WRD_FIXED_TUNNEL_NAME="${WRD_FIXED_TUNNEL_NAME:-wrd-tunnel}"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
WRD_FIXED_TUNNEL_PROTOCOL="${WRD_FIXED_TUNNEL_PROTOCOL:-http2}"
WRD_FIXED_DOMAIN_LOG="${WRD_FIXED_DOMAIN_LOG:-/tmp/wrd-fixed-domain.log}"
WRD_FIXED_FORMAL_HEALTH_URL="${WRD_FIXED_FORMAL_HEALTH_URL:-https://link.stockhub.wiki/health}"
WRD_FIXED_ORIGIN_HEALTH_URL="${WRD_FIXED_ORIGIN_HEALTH_URL:-http://127.0.0.1:8080/health}"
WRD_FIXED_WAIT_SEC="${WRD_FIXED_WAIT_SEC:-45}"

wrd_fixed_unset_tunnel_token() {
  unset TUNNEL_TOKEN
}

wrd_fixed_require_credentials_file() {
  local config="${1:-$CLOUDFLARED_CONFIG}"
  if [ ! -f "$config" ]; then
    echo "missing cloudflared config: $config" >&2
    return 1
  fi
  if ! grep -Eq '^[[:space:]]*credentials-file[[:space:]]*:' "$config"; then
    echo "cloudflared config must define credentials-file: $config" >&2
    return 1
  fi
  return 0
}

wrd_fixed_origin_health_ok() {
  curl -fsS --max-time 3 "$WRD_FIXED_ORIGIN_HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" else 1)' 2>/dev/null
}

wrd_fixed_formal_health_ok() {
  # Prefer repo canonical checker when present.
  local checker
  checker="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/wrd_entry_health.py"
  if [ -f "$checker" ]; then
    python3 "$checker" --url "$WRD_FIXED_FORMAL_HEALTH_URL" 2>/dev/null \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("deliverable") else 1)'
    return $?
  fi
  curl -fsS --max-time 8 "$WRD_FIXED_FORMAL_HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" else 1)' 2>/dev/null
}

wrd_fixed_count_formal_owners() {
  ps -axo pid=,command= | awk '/[c]loudflared/ && /tunnel/ && /--config/ && / run / {count++} END {print count+0}'
}

wrd_fixed_stop_connector() {
  wrd_fixed_unset_tunnel_token
  launchctl remove "$WRD_FIXED_LABEL" 2>/dev/null || true
  # Only the named formal runner with config + run <name>
  pkill -f "cloudflared tunnel --config .* run ${WRD_FIXED_TUNNEL_NAME}" 2>/dev/null || true
  pkill -f "cloudflared tunnel --config .* --protocol .* run ${WRD_FIXED_TUNNEL_NAME}" 2>/dev/null || true
  sleep 1
}

wrd_fixed_start_connector() {
  local protocol="$WRD_FIXED_TUNNEL_PROTOCOL"
  case "$protocol" in
    http2|quic) ;;
    *) echo "WRD_FIXED_TUNNEL_PROTOCOL must be http2 or quic" >&2; return 1 ;;
  esac
  wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG" || return 1
  wrd_fixed_unset_tunnel_token
  launchctl submit -l "$WRD_FIXED_LABEL" -- /bin/zsh -lc \
    "unset TUNNEL_TOKEN; exec \"$CLOUDFLARED\" tunnel --config \"$CLOUDFLARED_CONFIG\" --protocol \"$protocol\" run \"$WRD_FIXED_TUNNEL_NAME\" >> \"$WRD_FIXED_DOMAIN_LOG\" 2>&1"
}

wrd_fixed_wait_formal_health() {
  local i
  for i in $(seq 1 "$WRD_FIXED_WAIT_SEC"); do
    if wrd_fixed_formal_health_ok; then
      return 0
    fi
    # Secondary signal while DNS/edge catches up
    if "$CLOUDFLARED" tunnel info "$WRD_FIXED_TUNNEL_NAME" 2>/dev/null | grep -qv 'does not have any active connection'; then
      if wrd_fixed_formal_health_ok; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}
```

- [ ] **Step 4: Implement `scripts/restart-fixed-domain-tunnel.sh`**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-fixed-domain.sh
source "$SCRIPT_DIR/lib-fixed-domain.sh"

wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG"
wrd_fixed_unset_tunnel_token

owners="$(wrd_fixed_count_formal_owners || true)"
if [ "${owners:-0}" -gt 1 ]; then
  echo "refusing restart: multiple formal owners ($owners); run fixed-tunnel-preflight.sh" >&2
  exit 2
fi

echo "=== restarting formal connector $WRD_FIXED_TUNNEL_NAME ==="
wrd_fixed_stop_connector
wrd_fixed_start_connector

if wrd_fixed_wait_formal_health; then
  echo "formal health ok: $WRD_FIXED_FORMAL_HEALTH_URL"
  exit 0
fi

echo "formal health not deliverable after restart" >&2
tail -n 40 "$WRD_FIXED_DOMAIN_LOG" >&2 || true
exit 1
```

Make executable: `chmod +x scripts/restart-fixed-domain-tunnel.sh scripts/lib-fixed-domain.sh`

- [ ] **Step 5: Re-run tests**

Run: `node --test scripts/restart-fixed-domain-tunnel.test.js`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-fixed-domain.sh scripts/restart-fixed-domain-tunnel.sh scripts/restart-fixed-domain-tunnel.test.js
git commit -m "feat(tunnel): add formal-only restart helper"
```

---

### Task 2: Upgrade cloudflared script (TDD)

**Files:**
- Create: `scripts/upgrade-cloudflared.sh`
- Create: `scripts/upgrade-cloudflared.test.js`
- Modify: `scripts/lib-fixed-domain.sh` (add `wrd_fixed_cloudflared_version` / `wrd_fixed_version_ge`)

**Interfaces:**
- Consumes: `wrd_fixed_*` from Task 1; Homebrew `brew` / `cloudflared`
- Produces: `./scripts/upgrade-cloudflared.sh` exits 0 only when version ≥ 2026.7.3 and formal restart attempted/succeeded path as designed

- [ ] **Step 1: Write failing tests**

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const upgradePath = path.join(__dirname, 'upgrade-cloudflared.sh');
const libPath = path.join(__dirname, 'lib-fixed-domain.sh');

test('upgrade script gates on 2026.7.3 and calls formal restart once', () => {
  const src = fs.readFileSync(upgradePath, 'utf8');
  assert.match(src, /2026\.7\.3/);
  assert.match(src, /restart-fixed-domain-tunnel\.sh/);
  assert.doesNotMatch(src, /start-fixed-domain\.sh/);
  assert.doesNotMatch(src, /pkill\s+-f\s+'?node server\.js/);
  assert.doesNotMatch(src, /restart-host\.sh/);
});

test('lib version compare treats 2026.7.3 as meeting floor', () => {
  const result = spawnSync('bash', ['-c', `
    source "${libPath}"
    wrd_fixed_version_ge 2026.7.3 2026.7.3 && \
    wrd_fixed_version_ge 2026.8.0 2026.7.3 && \
    ! wrd_fixed_version_ge 2026.3.0 2026.7.3
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test scripts/upgrade-cloudflared.test.js`

- [ ] **Step 3: Add version helpers to lib**

```bash
wrd_fixed_parse_cloudflared_version() {
  # stdin or arg: raw --version text → X.Y.Z
  local raw="${1:-}"
  if [ -z "$raw" ]; then
    raw="$("$CLOUDFLARED" --version 2>/dev/null || true)"
  fi
  printf '%s\n' "$raw" | awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }'
}

wrd_fixed_version_ge() {
  # usage: wrd_fixed_version_ge <have> <need>
  local have="$1" need="$2"
  printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1 | grep -qx "$need"
}
```

- [ ] **Step 4: Implement `scripts/upgrade-cloudflared.sh`**

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-fixed-domain.sh
source "$SCRIPT_DIR/lib-fixed-domain.sh"

NEED_VERSION="${WRD_CLOUDFLARED_MIN_VERSION:-2026.7.3}"
BREW_BIN="${BREW_BIN:-brew}"

wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG"
wrd_fixed_unset_tunnel_token

have="$(wrd_fixed_parse_cloudflared_version)"
echo "cloudflared current: ${have:-unknown}"

if [ -n "$have" ] && wrd_fixed_version_ge "$have" "$NEED_VERSION"; then
  echo "version already >= $NEED_VERSION; skipping brew upgrade"
else
  echo "upgrading cloudflared via Homebrew toward $NEED_VERSION"
  if ! "$BREW_BIN" upgrade cloudflared; then
    echo "brew upgrade cloudflared failed; leaving existing connector untouched" >&2
    exit 1
  fi
  # ensure link points at new cellar if brew left old symlink
  hash -r 2>/dev/null || true
  have="$(wrd_fixed_parse_cloudflared_version)"
  if [ -z "$have" ] || ! wrd_fixed_version_ge "$have" "$NEED_VERSION"; then
    echo "cloudflared still < $NEED_VERSION after upgrade (have=${have:-none})" >&2
    exit 1
  fi
fi

echo "restarting formal connector on $(command -v "$CLOUDFLARED" 2>/dev/null || echo "$CLOUDFLARED") ($have)"
"$SCRIPT_DIR/restart-fixed-domain-tunnel.sh"
```

`chmod +x scripts/upgrade-cloudflared.sh`

- [ ] **Step 5: Re-run tests — expect PASS**

Run: `node --test scripts/upgrade-cloudflared.test.js scripts/restart-fixed-domain-tunnel.test.js`

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-fixed-domain.sh scripts/upgrade-cloudflared.sh scripts/upgrade-cloudflared.test.js
git commit -m "feat(tunnel): add cloudflared upgrade path for formal connector"
```

---

### Task 3: Read-only edge / formal probe (TDD)

**Files:**
- Create: `scripts/probe-fixed-edge.sh`
- Create: `scripts/probe-fixed-edge.test.js`

**Interfaces:**
- Consumes: origin URL, formal URL, edge IP list / optional log path
- Produces: stdout summary + optional `/tmp/wrd-fixed-edge-probe.json` with `classification` in:
  `ok | origin-down | formal-down-local-ok | edge-blocked | edge-degraded`

Classification rules (normative):

1. If origin health fails → `origin-down`
2. Else if formal not deliverable AND majority of 7844 probes fail → `edge-blocked` (still implies formal down; primary label `edge-blocked`)
3. Else if formal not deliverable → `formal-down-local-ok`
4. Else if formal deliverable AND majority of 7844 probes fail → `edge-degraded`
5. Else → `ok`

- [ ] **Step 1: Write failing fixture tests**

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const probePath = path.join(__dirname, 'probe-fixed-edge.sh');

function runProbe(env) {
  return spawnSync('bash', [probePath], {
    encoding: 'utf8',
    env: { ...process.env, ...env, WRD_PROBE_SKIP_WRITE: '0' },
  });
}

test('probe is read-only and never mutates tunnels', () => {
  const src = fs.readFileSync(probePath, 'utf8');
  assert.doesNotMatch(src, /\b(kill|pkill|launchctl\s+(remove|submit|kickstart)|brew\s+upgrade)\b/);
  assert.doesNotMatch(src, /restart-fixed-domain-tunnel|run-safe-quicktunnel/);
});

test('probe classifies origin-down from fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'fail',
    WRD_PROBE_FORMAL_RESULT: 'ok',
    WRD_PROBE_EDGE_RESULTS: '1,1,1',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /classification:\s*origin-down/);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'origin-down');
});

test('probe classifies formal-down-local-ok when edges open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'ok',
    WRD_PROBE_FORMAL_RESULT: 'fail',
    WRD_PROBE_EDGE_RESULTS: '1,1,0',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'formal-down-local-ok');
});

test('probe classifies edge-blocked when formal down and edges mostly closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'ok',
    WRD_PROBE_FORMAL_RESULT: 'fail',
    WRD_PROBE_EDGE_RESULTS: '0,0,0',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'edge-blocked');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test scripts/probe-fixed-edge.test.js`

- [ ] **Step 3: Implement `scripts/probe-fixed-edge.sh`**

Implement with:

- Default edge IPs (document as samples, overridable via `WRD_PROBE_EDGE_IPS=ip1,ip2`):
  `198.41.200.193,198.41.192.47,198.41.200.23,198.41.192.107`
- Real mode: `nc -z -G 3 "$ip" 7844` (or `bash /dev/tcp` fallback)
- Fixture mode: if `WRD_PROBE_ORIGIN_RESULT` / `WRD_PROBE_FORMAL_RESULT` / `WRD_PROBE_EDGE_RESULTS` set, skip network
- Write JSON to `WRD_PROBE_JSON_OUT` default `/tmp/wrd-fixed-edge-probe.json`
- Always print `classification: <enum>`
- Exit 0 on successful classification run even if unhealthy (probe is diagnostic); use exit 1 only for internal errors

Core classifier snippet:

```bash
classify() {
  local origin_ok="$1" formal_ok="$2" edge_open="$3" edge_total="$4"
  local edge_fail=$((edge_total - edge_open))
  if [ "$origin_ok" != 1 ]; then
    echo origin-down; return
  fi
  if [ "$formal_ok" != 1 ]; then
    if [ "$edge_total" -gt 0 ] && [ "$edge_fail" -gt "$edge_open" ]; then
      echo edge-blocked; return
    fi
    echo formal-down-local-ok; return
  fi
  if [ "$edge_total" -gt 0 ] && [ "$edge_fail" -gt "$edge_open" ]; then
    echo edge-degraded; return
  fi
  echo ok
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

Run: `node --test scripts/probe-fixed-edge.test.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-fixed-edge.sh scripts/probe-fixed-edge.test.js
git commit -m "feat(tunnel): add read-only formal edge probe"
```

---

### Task 4: Watch state machine + script (TDD)

**Files:**
- Create: `scripts/watch-fixed-domain.sh`
- Create: `scripts/watch-fixed-domain.test.js`
- Optionally extend: `scripts/lib-fixed-domain.sh` with `wrd_fixed_watch_decide` pure function in the watch script itself (keep decision logic in one file for fixture tests)

**Interfaces:**
- Consumes: origin/formal health, state JSON, `restart-fixed-domain-tunnel.sh`
- Produces: updated state file, log lines, optional osascript, maybe one restart

State JSON shape:

```json
{
  "failStartedAt": null,
  "lastRestartAt": null,
  "restarts": [],
  "lastStatus": "healthy|origin-down|formal-down|restarted|budget-exhausted",
  "lastAction": "none|notify|restart|skip"
}
```

Decision function (bash, fixture-friendly) inputs via env for tests:

- `NOW_EPOCH`
- `ORIGIN_OK` 0/1
- `FORMAL_OK` 0/1
- `STATE_JSON` path
- thresholds from Global Constraints

Rules:

1. `ORIGIN_OK=0` → action `none`, clear `failStartedAt`, status `origin-down`
2. `ORIGIN_OK=1` and `FORMAL_OK=1` → clear fail window, status `healthy`, action `none`
3. `ORIGIN_OK=1` and `FORMAL_OK=0`:
   - set `failStartedAt` if empty
   - if `NOW - failStartedAt < 180` → `none`
   - else if in cooldown (300s since lastRestartAt) → `none` (status formal-down)
   - else if restarts in last 3600s ≥ 2 → `notify` only / `budget-exhausted`
   - else → `restart` (+ notify)

- [ ] **Step 1: Write failing decision tests**

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const watchPath = path.join(__dirname, 'watch-fixed-domain.sh');

function decide(env, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const result = spawnSync('bash', [watchPath, '--decide-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRD_FIXED_WATCH_STATE: statePath,
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      WRD_FIXED_WATCH_FAIL_SEC: '180',
      WRD_FIXED_WATCH_COOLDOWN_SEC: '300',
      WRD_FIXED_WATCH_MAX_RESTARTS: '2',
      WRD_FIXED_WATCH_WINDOW_SEC: '3600',
      ...env,
    },
  });
  const out = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1));
  return { result, out, statePath };
}

test('watch never references quick tunnel or local app killers', () => {
  const src = fs.readFileSync(watchPath, 'utf8');
  assert.doesNotMatch(src, /run-safe-quicktunnel|pkill\s+-f\s+'?node server\.js|restart-host\.sh/);
  assert.match(src, /restart-fixed-domain-tunnel\.sh/);
});

test('origin-down does not restart', () => {
  const { result, out } = decide(
    { NOW_EPOCH: '1000', ORIGIN_OK: '0', FORMAL_OK: '0' },
    { failStartedAt: 1, restarts: [], lastRestartAt: null },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(out.action, 'none');
  assert.equal(out.status, 'origin-down');
});

test('formal-down below threshold does not restart', () => {
  const { out } = decide(
    { NOW_EPOCH: '200', ORIGIN_OK: '1', FORMAL_OK: '0' },
    { failStartedAt: 100, restarts: [], lastRestartAt: null },
  );
  assert.equal(out.action, 'none');
  assert.equal(out.status, 'formal-down');
});

test('formal-down past threshold restarts when budget remains', () => {
  const { out } = decide(
    { NOW_EPOCH: '400', ORIGIN_OK: '1', FORMAL_OK: '0' },
    { failStartedAt: 100, restarts: [], lastRestartAt: null },
  );
  assert.equal(out.action, 'restart');
});

test('budget exhausted only notifies', () => {
  const { out } = decide(
    { NOW_EPOCH: '5000', ORIGIN_OK: '1', FORMAL_OK: '0' },
    {
      failStartedAt: 1000,
      lastRestartAt: 4700,
      restarts: [2000, 3000],
    },
  );
  assert.ok(out.action === 'notify' || out.status === 'budget-exhausted');
  assert.notEqual(out.action, 'restart');
});
```

Note: for the budget test, set `lastRestartAt` far enough that cooldown is clear **or** expect cooldown skip — align implementation so budget check uses rolling `restarts[]` and cooldown is independent. Prefer: if budget exhausted → never restart even if cooldown clear. Adjust fixture: `lastRestartAt: 1000` (cooldown clear at 5000), `restarts: [2000, 3000]`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test scripts/watch-fixed-domain.test.js`

- [ ] **Step 3: Implement `scripts/watch-fixed-domain.sh`**

Requirements:

- Support `--decide-only` (no sleep loop, no real health/restart; read ORIGIN_OK/FORMAL_OK/NOW_EPOCH; print one JSON decision line)
- Default mode: infinite loop `sleep "$INTERVAL"` unless `WRD_FIXED_WATCH_ONCE=1`
- Real health via `wrd_fixed_origin_health_ok` / `wrd_fixed_formal_health_ok`
- On action `restart`: best-effort osascript notify, append log, run `restart-fixed-domain-tunnel.sh`, push epoch into `restarts`, set `lastRestartAt`
- On action `notify`: osascript + log only
- Refuse restart if `wrd_fixed_count_formal_owners > 1` (treat as notify/skip)
- Lock file optional simple `mkdir /tmp/wrd-fixed-watch.lock` to avoid overlap

Notify helper:

```bash
wrd_fixed_notify() {
  local title="$1" body="$2"
  osascript -e "display notification \"${body//\"/\\\"}\" with title \"${title//\"/\\\"}\"" 2>/dev/null || true
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

Run: `node --test scripts/watch-fixed-domain.test.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/watch-fixed-domain.sh scripts/watch-fixed-domain.test.js scripts/lib-fixed-domain.sh
git commit -m "feat(tunnel): add bounded formal domain watcher"
```

---

### Task 5: LaunchAgent install for fixed-watch

**Files:**
- Create: `launchd/com.webremotedesktop.fixed-watch.plist`
- Create: `scripts/install-fixed-watch.sh`
- Create: `scripts/install-fixed-watch.test.js` (source/plist contract)

**Interfaces:**
- Consumes: `scripts/watch-fixed-domain.sh`
- Produces: user LaunchAgent `com.webremotedesktop.fixed-watch` KeepAlive

- [ ] **Step 1: Write failing plist/install tests**

```js
test('fixed-watch plist points at watch script and tmp logs only', () => {
  const plist = fs.readFileSync(path.join(__dirname, '..', 'launchd', 'com.webremotedesktop.fixed-watch.plist'), 'utf8');
  assert.match(plist, /com\.webremotedesktop\.fixed-watch/);
  assert.match(plist, /scripts\/watch-fixed-domain\.sh/);
  assert.match(plist, /\/tmp\/wrd-fixed-watch\.(launch\.)?log|\/tmp\/wrd-fixed-watch-launch\.log/);
  assert.match(plist, /KeepAlive/);
  assert.doesNotMatch(plist, /run-safe-quicktunnel|start-fixed-domain/);
});

test('install-fixed-watch bootstraps label without touching formal connector scripts beyond watch', () => {
  const src = fs.readFileSync(path.join(__dirname, 'install-fixed-watch.sh'), 'utf8');
  assert.match(src, /com\.webremotedesktop\.fixed-watch/);
  assert.match(src, /bootstrap|kickstart/);
  assert.doesNotMatch(src, /restart-fixed-domain-tunnel|brew upgrade|run-safe-quicktunnel/);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Create plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.webremotedesktop.fixed-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/watch-fixed-domain.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/macstudio1/AI/Claude/WebRemoteDesktop</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/wrd-fixed-watch-launch.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/wrd-fixed-watch-launch.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Create `scripts/install-fixed-watch.sh`** (mirror `install-awake-keeper.sh`)

```bash
#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.webremotedesktop.fixed-watch"
SRC="$PROJECT_DIR/launchd/$LABEL.plist"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

chmod +x "$PROJECT_DIR/scripts/watch-fixed-domain.sh"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DST"
launchctl bootout "$DOMAIN" "$DST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Installed and started $LABEL"
```

- [ ] **Step 5: Tests PASS + commit**

```bash
git add launchd/com.webremotedesktop.fixed-watch.plist scripts/install-fixed-watch.sh scripts/install-fixed-watch.test.js
git commit -m "feat(tunnel): install LaunchAgent for formal watch"
```

---

### Task 6: Docs + full test gate + manual rollout checklist

**Files:**
- Modify: `docs/runbook-safe-startup.md`
- Modify: `README.md`
- Optionally: `docs/superpowers/specs/2026-08-11-formal-tunnel-hardening-design.md` status → Implemented (only after execution)

**Doc content to add (runbook section “Formal tunnel hardening”):**

1. Upgrade: `./scripts/upgrade-cloudflared.sh` (bounces formal connector only)
2. Probe: `./scripts/probe-fixed-edge.sh` then `cat /tmp/wrd-fixed-edge-probe.json`
3. Manual formal restart: `./scripts/restart-fixed-domain-tunnel.sh`
4. Watch install: `./scripts/install-fixed-watch.sh`
5. Watch semantics table (180s / 2 per hour / origin-down no restart)
6. Explicit: 「重启服务」≠ formal tunnel restart; watcher is the only automation allowed to restart formal without extra prompt
7. Preflight remains read-only

README short bullets under startup/troubleshooting pointing to these scripts.

- [ ] **Step 1: Update docs**

- [ ] **Step 2: Run full related test suite**

```bash
node --test \
  scripts/restart-fixed-domain-tunnel.test.js \
  scripts/upgrade-cloudflared.test.js \
  scripts/probe-fixed-edge.test.js \
  scripts/watch-fixed-domain.test.js \
  scripts/install-fixed-watch.test.js \
  scripts/fixed-tunnel-preflight.test.js
```

Expected: all PASS; preflight still asserts no kill/pkill/launchctl remove in preflight source.

- [ ] **Step 3: Commit docs**

```bash
git add docs/runbook-safe-startup.md README.md
git commit -m "docs(tunnel): document formal tunnel hardening ops"
```

- [ ] **Step 4: Manual rollout (operator / executing agent with user present)**

Execute in order; stop on failure:

1. `./scripts/probe-fixed-edge.sh` — baseline classification (expect `ok` if currently healthy)
2. `./scripts/upgrade-cloudflared.sh` — version ≥ 2026.7.3; formal health 200
3. `cloudflared --version` and `curl -fsS https://link.stockhub.wiki/health`
4. `./scripts/install-fixed-watch.sh`
5. `launchctl print gui/$(id -u)/com.webremotedesktop.fixed-watch | head`
6. Confirm `/tmp/wrd-fixed-watch-state.json` appears within ~60s and **no** restart while healthy
7. `./scripts/fixed-tunnel-preflight.sh` — formal-health 200; note timeout-heavy may still reflect old log lines

Do **not** intentionally break production formal DNS in automation.

- [ ] **Step 5: Final commit only if doc status/report added**

If writing a short evidence note:

```bash
# optional
git add docs/superpowers/reports/2026-08-11-formal-tunnel-hardening-rollout.md
git commit -m "docs(tunnel): record formal hardening rollout evidence"
```

---

## Plan self-review (author)

### Spec coverage

| Spec requirement | Task |
|------------------|------|
| `restart-fixed-domain-tunnel.sh` formal-only | Task 1 |
| credentials-file + unset token | Task 1 |
| refuse multiple owners | Task 1 (+ Task 4) |
| upgrade ≥ 2026.7.3 + one restart | Task 2 |
| brew failure leaves connector | Task 2 |
| probe classifications + read-only | Task 3 |
| watch thresholds 180/60/2/300 | Task 4 |
| origin-down no restart | Task 4 |
| notify + log | Task 4 |
| LaunchAgent install | Task 5 |
| runbook/README semantics | Task 6 |
| preflight stays read-only | Task 6 regression tests |
| no quick tunnel / host / signal mutation | Tasks 1–5 contract tests |

### Placeholder scan

No TBD/TODO steps; classifier rules, state JSON, commands, and test code included.

### Consistency

- Label `com.webremotedesktop.fixed-domain` / watch `com.webremotedesktop.fixed-watch` consistent with spec
- Health deliverable definition aligned with `wrd_entry_health.py` when available
- Restart budget fixture note corrected: cooldown vs budget independent; budget-exhausted must not restart

### Residual risks (documented, not in scope to “fix” here)

- ISP-level intermittent `:7844` loss can still cause multi-minute outages until threshold fires
- `fixed-tunnel-preflight` timeout-heavy uses recent log tail and may lag reality after recovery
- `brew upgrade` requires network and may need operator permission outside sandbox

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-11-formal-tunnel-hardening-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with `executing-plans`, checkpoint reviews  

Which approach?
