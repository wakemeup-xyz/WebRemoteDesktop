#!/usr/bin/env python3
"""Verify multi-TURN select UX on local viewer."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8080"
OUT = Path("/tmp/wrd-multi-turn-verify")
OUT.mkdir(parents=True, exist_ok=True)

# Load password from .env without printing it
env = {}
for line in Path("signal-server/.env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    env[key.strip()] = value.strip().strip('"').strip("'")
PASSWORD = env.get("VIEWER_ACCESS_PASSWORD") or env.get("ACCESS_PASSWORD") or ""


def main() -> int:
    result = {
        "ok": False,
        "steps": [],
        "errors": [],
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"{msg.type}: {msg.text}"))

        try:
            page.goto(f"{BASE}/", wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(OUT / "01-login.png"), full_page=True)

            # Login form
            password = page.locator('input[type="password"]').first
            if password.count() == 0:
                # maybe already on viewer
                if "viewer" not in page.url:
                    result["errors"].append("no password field and not on viewer")
                    page.screenshot(path=str(OUT / "fail-no-login.png"), full_page=True)
                    print(json.dumps(result, ensure_ascii=False, indent=2))
                    return 1
            else:
                password.fill(PASSWORD)
                # click login
                btn = page.locator('button[type="submit"], button:has-text("登录"), button:has-text("Login")').first
                btn.click()
                page.wait_for_timeout(1500)
                page.wait_for_load_state("networkidle")

            # Ensure viewer page
            if "viewer" not in page.url:
                page.goto(f"{BASE}/viewer.html", wait_until="networkidle", timeout=30000)
                page.wait_for_timeout(1000)

            page.screenshot(path=str(OUT / "02-viewer.png"), full_page=True)
            result["steps"].append({"step": "login", "url": page.url})

            # Open network modal
            mode_btn = page.locator("#networkModeBtn, button:has-text('网络')").first
            mode_btn.click()
            page.wait_for_selector("#networkModal:not(.hidden), #turnServerSelect", timeout=5000)
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / "03-network-modal.png"), full_page=True)

            select = page.locator("#turnServerSelect")
            assert select.count() == 1, "turnServerSelect missing"
            options = select.locator("option").all()
            option_data = []
            for opt in options:
                option_data.append({
                    "value": opt.get_attribute("value"),
                    "text": opt.inner_text().strip(),
                })
            result["steps"].append({"step": "options", "options": option_data, "selected": select.input_value()})

            values = [o["value"] for o in option_data if o["value"]]
            texts = " | ".join(o["text"] for o in option_data)
            assert "aliyun" in values or any("阿里云" in o["text"] for o in option_data), f"aliyun missing: {option_data}"
            assert "overseas" in values or any("海外" in o["text"] for o in option_data), f"overseas missing: {option_data}"
            # default should prefer aliyun
            selected = select.input_value()
            result["steps"].append({"step": "default-selected", "selected": selected})

            status = page.locator("#networkTurnStatus").inner_text()
            result["steps"].append({"step": "status-default", "text": status})
            assert "TURN" in status, status

            # Switch to overseas and apply
            if "overseas" in values:
                select.select_option("overseas")
            else:
                # pick by label
                for o in option_data:
                    if "海外" in o["text"]:
                        select.select_option(o["value"])
                        break

            # select relay mode too for meaningful ICE
            relay = page.locator('input[name="networkMode"][value="relay"]')
            if relay.count():
                relay.check()

            page.locator("#applyNetworkMode").click()
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUT / "04-after-apply-overseas.png"), full_page=True)

            # Reopen modal to read status/selection
            mode_btn.click()
            page.wait_for_timeout(800)
            selected2 = page.locator("#turnServerSelect").input_value()
            status2 = page.locator("#networkTurnStatus").inner_text()
            result["steps"].append({
                "step": "after-overseas",
                "selected": selected2,
                "status": status2,
                "localStorage": page.evaluate("() => localStorage.getItem('wrdTurnServerId')"),
            })
            assert selected2 == "overseas" or "海外" in status2, (selected2, status2)
            assert page.evaluate("() => localStorage.getItem('wrdTurnServerId')") in ("overseas", selected2)

            # Switch back to aliyun
            if "aliyun" in values:
                page.locator("#turnServerSelect").select_option("aliyun")
            page.locator("#applyNetworkMode").click()
            page.wait_for_timeout(2000)
            mode_btn.click()
            page.wait_for_timeout(500)
            selected3 = page.locator("#turnServerSelect").input_value()
            status3 = page.locator("#networkTurnStatus").inner_text()
            page.screenshot(path=str(OUT / "05-after-apply-aliyun.png"), full_page=True)
            result["steps"].append({
                "step": "after-aliyun",
                "selected": selected3,
                "status": status3,
                "localStorage": page.evaluate("() => localStorage.getItem('wrdTurnServerId')"),
            })

            # Optional: click test TURN briefly
            page.locator("#testTurnBtn").click()
            page.wait_for_timeout(6000)
            test_text = page.locator("#networkTurnTestResult").inner_text()
            page.screenshot(path=str(OUT / "06-turn-selftest.png"), full_page=True)
            result["steps"].append({"step": "selftest", "text": test_text[:500]})

            # Check host log for turn_server_id if available via API config host fields
            result["ok"] = True
            result["console_tail"] = console_logs[-20:]
        except Exception as exc:
            result["errors"].append(str(exc))
            try:
                page.screenshot(path=str(OUT / "fail.png"), full_page=True)
            except Exception:
                pass
            result["console_tail"] = console_logs[-30:]
        finally:
            browser.close()

    Path(OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
