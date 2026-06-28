# Host LaunchAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebRemoteDesktop host run under a dedicated macOS LaunchAgent so host restarts stay online in this execution environment and no longer depend on fragile `nohup` background shells.

**Architecture:** Add a repo-owned `com.webremotedesktop.host` LaunchAgent that runs the Python host in the foreground through a small wrapper script. Switch `restart-host.sh` and the safe startup/stop/status scripts from direct `nohup` management to `launchctl` lifecycle control while preserving the current signal server and safe quick tunnel behavior.

**Tech Stack:** bash, macOS `launchctl`, LaunchAgent plist, Node.js built-in test runner, existing repo shell helpers

---

### Task 1: Write the plan artifact and prepare launchd boundaries

**Files:**
- Create: `launchd/com.webremotedesktop.host.plist`
- Create: `scripts/lib-host-launchctl.sh`
- Modify: `scripts/run-host-launchctl.sh`
- Test: `scripts/*.test.js`

- [ ] **Step 1: Add static tests for the new host LaunchAgent contract**

Add assertions that:
- the host LaunchAgent plist exists and uses label `com.webremotedesktop.host`
- the LaunchAgent writes logs to `back-debug.log`
- host lifecycle scripts use `launchctl` instead of direct `nohup "$PYTHON_BIN" host.py`

- [ ] **Step 2: Run the new/updated script tests and verify they fail**

Run: `node --test scripts/*.test.js`
Expected: FAIL because the host LaunchAgent assets and `launchctl` integration do not exist yet.

- [ ] **Step 3: Add the LaunchAgent wrapper and plist**

Create a small shared shell helper that:
- installs the plist into `~/Library/LaunchAgents`
- bootstraps / bootouts / kickstarts the host label
- resolves the live host pid back into `/tmp/wrd-host.pid` or `/tmp/wrd-safe-host.pid`

Create a wrapper script that:
- sources `signal-server/.env`
- exports `SERVER_URL` and `PYTHONPATH`
- `exec`s `python-host/host.py` in the foreground for LaunchAgent supervision

- [ ] **Step 4: Re-run the script tests and verify the contract passes**

Run: `node --test scripts/*.test.js`
Expected: PASS for the new host LaunchAgent structure checks.

- [ ] **Step 5: Commit**

```bash
git add launchd/com.webremotedesktop.host.plist scripts/lib-host-launchctl.sh scripts/run-host-launchctl.sh scripts/*.test.js
git commit -m "feat: add host launchagent scaffolding"
```

### Task 2: Move host restart/start/stop onto launchctl

**Files:**
- Modify: `scripts/restart-host.sh`
- Modify: `scripts/start-safe-wrd.sh`
- Modify: `scripts/stop-safe-wrd.sh`
- Modify: `scripts/status-safe-wrd.sh`
- Modify: `scripts/lib-safe-wrd.sh`
- Test: `scripts/*.test.js`

- [ ] **Step 1: Extend tests for host lifecycle behavior**

Add assertions that:
- `restart-host.sh` manages `com.webremotedesktop.host` through `launchctl`
- `start-safe-wrd.sh` starts host through the shared launchctl helper instead of `nohup`
- `stop-safe-wrd.sh` stops the LaunchAgent rather than only killing the pid
- `status-safe-wrd.sh` remains repo-scoped and still reports host status through the existing pid/status flow

- [ ] **Step 2: Run the targeted tests and verify they fail for the old host lifecycle**

Run: `node --test scripts/*.test.js`
Expected: FAIL on assertions that still see direct `nohup` host startup or missing host LaunchAgent management.

- [ ] **Step 3: Implement the minimal shell changes**

Update the lifecycle scripts so that:
- `restart-host.sh` bootouts the current host LaunchAgent, re-bootstraps it, kicks it, then waits for a live `host.py` pid
- `start-safe-wrd.sh` reuses the same helper and writes `/tmp/wrd-safe-host.pid` from the live process
- `stop-safe-wrd.sh` disables / bootouts the host LaunchAgent before clearing pid files
- `status-safe-wrd.sh` and `lib-safe-wrd.sh` continue reconciling live `host.py` pids without relying on stale files

- [ ] **Step 4: Re-run the script tests and verify they pass**

Run: `node --test scripts/*.test.js`
Expected: PASS with the new host lifecycle contract.

- [ ] **Step 5: Commit**

```bash
git add scripts/restart-host.sh scripts/start-safe-wrd.sh scripts/stop-safe-wrd.sh scripts/status-safe-wrd.sh scripts/lib-safe-wrd.sh scripts/*.test.js
git commit -m "fix: move host lifecycle to launchctl"
```

### Task 3: Update runtime docs and verify host stability

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Test: runtime verification commands

- [ ] **Step 1: Document the new host lifecycle**

Update docs so they explicitly say:
- host restarts are handled through the LaunchAgent-backed `scripts/restart-host.sh`
- the safe quick tunnel URL is preserved while host restarts
- stop/status behavior now includes host LaunchAgent lifecycle

- [ ] **Step 2: Run static verification**

Run: `node --test scripts/*.test.js`
Expected: PASS

Run: `bash -n scripts/restart-host.sh scripts/start-safe-wrd.sh scripts/stop-safe-wrd.sh scripts/status-safe-wrd.sh scripts/run-host-launchctl.sh scripts/lib-host-launchctl.sh`
Expected: no output, exit 0

- [ ] **Step 3: Run runtime verification**

Run:

```bash
./scripts/restart-host.sh
curl -s http://127.0.0.1:8080/api/status
./scripts/status-safe-wrd.sh
```

Expected:
- `restart-host.sh` reports a live host pid
- `/api/status` includes `"hostOnline":true`
- existing safe quick tunnel URL stays unchanged if the tunnel is already running

- [ ] **Step 4: Record the observed result in docs if behavior differs from old runbook wording**

If any command wording or state-file behavior changed, align the docs before closing the task.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: document host launchagent lifecycle"
```
