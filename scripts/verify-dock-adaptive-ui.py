#!/usr/bin/env python3
"""End-to-end verification for dock button + adaptive resolution toggle + latency signals."""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8080"
OUT = Path("/tmp/wrd-feature-verify")
OUT.mkdir(parents=True, exist_ok=True)
HOST_LOG = Path("/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log")

env = {}
for line in Path("signal-server/.env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")
PASSWORD = env.get("VIEWER_ACCESS_PASSWORD") or env.get("ACCESS_PASSWORD") or ""


def tail_log_marker() -> int:
    if not HOST_LOG.exists():
        return 0
    return HOST_LOG.stat().st_size


def read_log_since(offset: int) -> str:
    if not HOST_LOG.exists():
        return ""
    data = HOST_LOG.read_bytes()
    return data[offset:].decode("utf-8", errors="ignore")


def main() -> int:
    result = {"ok": False, "steps": [], "errors": [], "checks": {}}
    log_offset = tail_log_marker()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        console = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))

        try:
            page.goto(f"{BASE}/", wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / "01-login.png"), full_page=True)

            pw = page.locator('input[type="password"]').first
            if pw.count():
                pw.fill(PASSWORD)
                page.locator('button[type="submit"], button:has-text("登录")').first.click()
                page.wait_for_timeout(1200)
                page.wait_for_load_state("networkidle")

            if "viewer" not in page.url:
                page.goto(f"{BASE}/viewer.html", wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / "02-viewer.png"), full_page=True)
            result["steps"].append({"step": "open-viewer", "url": page.url})

            # Force adaptive res default semantics in this profile
            page.evaluate("() => localStorage.removeItem('wrdAdaptiveResolution')")
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1000)

            # Start connection if needed
            start = page.locator("#startBtn")
            if start.count() and start.is_visible():
                start.click()
                page.wait_for_timeout(2500)

            # Request control if button present
            req = page.locator("#requestControlBtn")
            if req.count() and req.is_visible():
                text = req.inner_text()
                if "请求" in text or "控制" in text:
                    req.click()
                    page.wait_for_timeout(1500)
            result["steps"].append({
                "step": "control",
                "controlStatus": page.locator("#controlStatus").inner_text() if page.locator("#controlStatus").count() else None,
                "requestBtn": page.locator("#requestControlBtn").inner_text() if page.locator("#requestControlBtn").count() else None,
            })
            page.screenshot(path=str(OUT / "03-connected.png"), full_page=True)

            # --- Adaptive resolution toggle ---
            page.locator("#resolutionBtn").click()
            page.wait_for_selector("#resolutionModal:not(.hidden)", timeout=5000)
            page.wait_for_timeout(300)
            toggle = page.locator("#adaptiveResolutionToggle")
            assert toggle.count() == 1, "adaptiveResolutionToggle missing"
            checked = toggle.is_checked()
            storage = page.evaluate("() => localStorage.getItem('wrdAdaptiveResolution')")
            result["checks"]["adaptiveDefaultOff"] = (checked is False) and (storage in (None, "", "0"))
            page.screenshot(path=str(OUT / "04-resolution-modal.png"), full_page=True)

            # Turn on then off to verify persistence wiring
            toggle.check()
            page.wait_for_timeout(200)
            storage_on = page.evaluate("() => localStorage.getItem('wrdAdaptiveResolution')")
            # change event should fire from check()
            page.locator("#applyResolution").click()
            page.wait_for_timeout(500)
            # reopen
            page.locator("#resolutionBtn").click()
            page.wait_for_timeout(300)
            # ensure still reflects state
            checked_after = page.locator("#adaptiveResolutionToggle").is_checked()
            # set back to off (product default)
            if checked_after:
                page.locator("#adaptiveResolutionToggle").uncheck()
            page.locator("#applyResolution").click()
            page.wait_for_timeout(400)
            storage_off = page.evaluate("() => localStorage.getItem('wrdAdaptiveResolution')")
            result["checks"]["adaptiveTogglePersist"] = {
                "storageOn": storage_on,
                "checkedAfterApplyOn": checked_after,
                "storageOff": storage_off,
            }
            result["steps"].append({"step": "adaptive-toggle", "defaultChecked": checked, "storage": storage})

            # Apply 720p explicitly and ensure adaptive off
            page.locator("#resolutionBtn").click()
            page.wait_for_timeout(200)
            page.locator('input[name="resolution"][value="720p"]').check()
            page.locator("#adaptiveResolutionToggle").uncheck()
            page.locator("#applyResolution").click()
            page.wait_for_timeout(1200)
            res_text = page.locator("#resolutionDisplay").inner_text()
            result["checks"]["manual720p"] = res_text
            page.screenshot(path=str(OUT / "05-after-720p.png"), full_page=True)

            # Wait a bit and ensure host is not forced to 640x360 while adaptive off
            time.sleep(3)
            mid_log = read_log_since(log_offset)
            survival_after_lock = re.findall(
                r"WRD_MEDIA_PROFILE[^\n]*size=640x360",
                mid_log,
            )
            low_res_capture = re.findall(
                r"CAPTURE_STATS[^\n]*frame=640x360",
                mid_log,
            )
            result["checks"]["noSurvival640AfterLock"] = {
                "survivalProfileHits": len(survival_after_lock),
                "capture640Hits": len(low_res_capture),
                "sampleProfiles": re.findall(r"WRD_MEDIA_PROFILE[^\n]*", mid_log)[-5:],
            }

            # --- Show Dock ---
            dock_mark = tail_log_marker()
            dock_btn = page.locator('button.action-btn[data-action="showDock"]')
            assert dock_btn.count() >= 1, "showDock button missing"
            # ensure action bar visible
            page.evaluate("""() => {
              document.body.classList.remove('controls-hidden');
            }""")
            dock_btn.first.scroll_into_view_if_needed()
            dock_btn.first.click()
            page.wait_for_timeout(2000)
            page.screenshot(path=str(OUT / "06-after-showdock.png"), full_page=True)

            # click again
            dock_btn.first.click()
            page.wait_for_timeout(2000)

            dock_log = read_log_since(dock_mark)
            show_dock_lines = [ln for ln in dock_log.splitlines() if "Show dock" in ln or "showDock" in ln]
            left_near = any("left cursor near dock" in ln for ln in show_dock_lines)
            restored_far = any("restored cursor" in ln for ln in show_dock_lines)
            result["checks"]["showDock"] = {
                "logLines": show_dock_lines[-12:],
                "leftNearDock": left_near,
                "oldRestoreFarBehavior": restored_far,
                "received": any("action=showDock" in ln or 'action":"showDock"' in ln or "showDock" in ln for ln in dock_log.splitlines()),
            }
            result["steps"].append({"step": "showDock", "logCount": len(show_dock_lines)})

            # Latency snapshot from page
            latency = page.locator("#latencyDisplay").inner_text() if page.locator("#latencyDisplay").count() else ""
            fps = page.locator("#fpsDisplay").inner_text() if page.locator("#fpsDisplay").count() else ""
            candidate = page.locator("#candidateDisplay").inner_text() if page.locator("#candidateDisplay").count() else ""
            result["checks"]["liveStats"] = {
                "latency": latency,
                "fps": fps,
                "candidate": candidate,
                "adaptiveStorage": page.evaluate("() => localStorage.getItem('wrdAdaptiveResolution')"),
            }

            # Pass criteria
            ok = True
            if not result["checks"]["adaptiveDefaultOff"]:
                ok = False
                result["errors"].append("adaptive resolution not default off")
            if not result["checks"]["showDock"].get("received"):
                # might fail without control lease
                control = result["steps"][1] if len(result["steps"]) > 1 else {}
                result["errors"].append(f"showDock not received by host; control={control}")
                ok = False
            if result["checks"]["showDock"].get("oldRestoreFarBehavior"):
                ok = False
                result["errors"].append("old restore-far dock behavior still present")
            if not result["checks"]["showDock"].get("leftNearDock"):
                # soft fail if received but message missing (code not loaded)
                if result["checks"]["showDock"].get("received"):
                    ok = False
                    result["errors"].append("showDock executed but missing 'left cursor near dock' log")

            result["ok"] = ok
            result["console_tail"] = console[-25:]
        except Exception as exc:
            result["errors"].append(str(exc))
            try:
                page.screenshot(path=str(OUT / "fail.png"), full_page=True)
            except Exception:
                pass
            result["console_tail"] = console[-30:]
        finally:
            browser.close()

    Path(OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
