# Entry Health and Operations Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not delegate because this session does not authorize subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entrypoint health truthful and read-only for observers, ensure only the tunnel publisher writes the safe URL, and repair the cwd-dependent Signal Server bootstrap tests.

**Architecture:** Introduce one standard-library Python `PublicEntryHealth` implementation with a JSON CLI. Shell and service helpers become thin adapters; status commands only inspect, while `run-safe-quicktunnel.sh` remains the sole publisher.

**Tech Stack:** Python 3.11 standard library, Bash, Node.js test runner, pytest, Markdown.

**Spec Coverage:** Batch A of `docs/superpowers/specs/2026-07-18-remote-desktop-reliability-latency-remediation-design.md`.

**Truth Source:** `scripts/wrd_entry_health.py` for delivery state; `/tmp/wrd-safe-current-url.txt` only after publisher validation.

**Compatibility Notes:** Preserve public DNS fallback and existing operator labels. Add `http-invalid` and `content-invalid`; stop status-time URL recovery.

**Impact Map:**
- **Truth Source:** One delivery check implementation and one URL publisher.
- **Backend:** `wrd_service.py` consumes the same health CLI.
- **Frontend:** Not applicable.
- **Runtime Proof:** 404 safe URL is unavailable; fixed/local `/health` is deliverable; status leaves URL inode/content unchanged.
- **Docs/Skills:** README, safe startup runbook, webremote-service rules.
- **Commit Boundary:** Entry health, status/publisher adapters, bootstrap test helper, and matching docs only.

**Definition of Done:**
- 404/429/5xx/non-JSON endpoints are never deliverable.
- `status-safe-wrd.sh` does not write any URL/PID file.
- `cd signal-server && npm test` passes bootstrap tests from the package cwd.

---

### Task 1: Define and test the `PublicEntryHealth` interface

**Files:**
- Create: `scripts/wrd_entry_health.py`
- Create: `scripts/test_wrd_entry_health.py`

- [x] **Step 1: Write failing tests for business delivery states**

```python
def test_health_200_json_ok_is_deliverable(http_server):
    result = check_entry(http_server.url, health_path="/health")
    assert result["state"] == "deliverable"
    assert result["deliverable"] is True

@pytest.mark.parametrize("status", [301, 404, 410, 429, 500, 530])
def test_non_2xx_is_http_invalid(http_server, status):
    http_server.reply(status=status, body={"status": "ok"})
    result = check_entry(http_server.url)
    assert result["state"] == "http-invalid"
    assert result["deliverable"] is False

def test_2xx_wrong_body_is_content_invalid(http_server):
    http_server.reply(status=200, body={"status": "wrong"})
    assert check_entry(http_server.url)["state"] == "content-invalid"
```

- [x] **Step 2: Run tests and observe the missing module failure**

Run: `python -m pytest scripts/test_wrd_entry_health.py -q`

Expected: FAIL because `scripts.wrd_entry_health` does not exist.

- [x] **Step 3: Implement the typed result and injectable resolver/opener**

```python
def check_entry(url, *, health_path="/health", timeout=10.0, opener=None):
    target = urllib.parse.urljoin(url.rstrip("/") + "/", health_path.lstrip("/"))
    request = urllib.request.Request(target, headers={"Accept": "application/json"})
    try:
        response = (opener or urllib.request.urlopen)(request, timeout=timeout)
        status = int(response.status)
        body = json.loads(response.read(64 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        return result("http-invalid", False, error.code, str(error.reason), target)
    except socket.gaierror as error:
        return result("dns-unresolved", False, None, str(error), target)
    except (TimeoutError, urllib.error.URLError) as error:
        return result("origin-unreachable", False, None, str(error), target)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return result("content-invalid", False, status, str(error), target)
    if not 200 <= status < 300:
        return result("http-invalid", False, status, "non-2xx", target)
    if body.get("status") != "ok":
        return result("content-invalid", False, status, "health-status-not-ok", target)
    return result("deliverable", True, status, "ok", target)
```

The CLI accepts `--url`, `--health-path`, `--timeout`, prints one JSON object, and exits 0 only for deliverable.

- [x] **Step 4: Add trycloudflare public-DNS fallback behind an internal adapter**

Keep the fallback private to the module. Tests inject resolved IPs and a TLS connection adapter so SNI remains the original hostname; no caller learns fallback details.

- [x] **Step 5: Run the focused tests**

Run: `python -m pytest scripts/test_wrd_entry_health.py -q`

Expected: PASS for 2xx, status failures, content failures, DNS failure, timeout, redirect rejection, and public-DNS fallback.

### Task 2: Make shell and service status consumers read-only

**Files:**
- Modify: `scripts/lib-safe-wrd.sh`
- Modify: `scripts/status-safe-wrd.sh`
- Modify: `skills/webremote-service/scripts/wrd_service.py`
- Modify: `scripts/lib-safe-wrd.test.js`
- Modify: `scripts/status-safe-wrd.test.js`
- Modify: `skills/webremote-service/scripts/wrd_service_test.py`

- [x] **Step 1: Replace source-regex recovery assertions with behavior assertions**

Tests create a temporary URL file, run status with injected paths/health CLI, and assert content plus mtime are unchanged. A missing URL file must remain missing.

```python
before = url_file.stat().st_mtime_ns
status = get_status(url_file=url_file, health_checker=fake_http_invalid)
assert status["safe_url_reachable"] is False
assert url_file.read_text() == original
assert url_file.stat().st_mtime_ns == before
```

- [x] **Step 2: Run focused tests and verify old recovery behavior fails**

Run: `node --test scripts/lib-safe-wrd.test.js scripts/status-safe-wrd.test.js && python -m pytest skills/webremote-service/scripts/wrd_service_test.py -q`

Expected: FAIL because status still writes recovered URLs and curl exit status accepts 404.

- [x] **Step 3: Make adapters call the canonical CLI**

`wrd_safe_url_reachability_state()` maps the canonical CLI JSON state to existing labels. Remove `recover_safe_url_file()` and its call from status. `wrd_service.url_is_reachable()` invokes `wrd_entry_health.py` rather than `curl -I`. The shell helper remains a thin adapter and contains no independent HTTP/DNS business rules.

- [x] **Step 4: Run focused tests**

Expected: status is read-only and both adapters reject 404.

### Task 3: Restrict safe URL publication to the supervisor

**Files:**
- Modify: `scripts/run-safe-quicktunnel.sh`
- Modify: `scripts/run-safe-quicktunnel.test.js`
- Modify: `scripts/start-safe-wrd.sh`
- Modify: `scripts/start-safe-wrd.test.js`

- [x] **Step 1: Add failing tests for atomic publication after `/health` success**

Assert the script writes a temporary file and uses `mv`, and that health validation precedes both current and archive publication.

- [x] **Step 2: Implement `publish_safe_url()`**

```bash
publish_safe_url() {
  local url="$1"
  wrd_safe_url_is_reachable "$url" || return 1
  local tmp="${URL_FILE}.tmp.$$"
  printf '%s\n' "$url" > "$tmp"
  mv "$tmp" "$URL_FILE"
  printf '%s\n' "$url" > "${URL_ARCHIVE_FILE}.tmp.$$"
  mv "${URL_ARCHIVE_FILE}.tmp.$$" "$URL_ARCHIVE_FILE"
}
```

All existing direct writes are replaced by this function. Archive candidates may be republished only by the supervisor after fresh validation.

- [x] **Step 3: Run script tests**

Run: `node --test scripts/run-safe-quicktunnel.test.js scripts/start-safe-wrd.test.js scripts/status-safe-wrd.test.js scripts/lib-safe-wrd.test.js`

Expected: PASS.

### Task 4: Repair bootstrap test execution from the package cwd

**Files:**
- Modify: `signal-server/test/terminal-bootstrap.test.js`

- [x] **Step 1: Add child-exit-aware startup failure reporting**

Use `path.join(__dirname, '..', 'server.js')` and race health against child exit. Include captured stdout/stderr in the thrown error and kill a still-running child on failure.

- [x] **Step 2: Run the previously failing command**

Run: `cd signal-server && node --test test/terminal-bootstrap.test.js`

Expected: 3/3 PASS.

- [x] **Step 3: Run Signal Server full tests**

Run: `cd signal-server && npm test`

Expected: 67/67 PASS or a newer higher pass count with zero failures.

### Task 5: Synchronize operator documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `skills/webremote-service/references/service-rules.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [x] **Step 1: Document status/publisher ownership and 2xx content validation**

State that status never recovers/writes URL files, 404 is unavailable, and only the supervisor may publish after `/health` JSON success.

- [x] **Step 2: Run documentation and scope checks**

Run: `git diff --check && rg -n 'status.*recover|404.*reachable' README.md docs/runbook-safe-startup.md skills/webremote-service/references/service-rules.md`

Expected: no contradictory active guidance and no whitespace errors.
