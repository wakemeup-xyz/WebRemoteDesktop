from __future__ import annotations

import json
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def load_env_password(name: str) -> str:
    env = ROOT / "signal-server" / ".env"
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return os.environ.get(name, "")


def run(origin: str, network_mode: str, seconds: int, output: str, offline_flap: bool = False) -> None:
    password = load_env_password("VIEWER_ACCESS_PASSWORD")
    if not password:
        raise RuntimeError("VIEWER_ACCESS_PASSWORD unavailable")
    result = {"origin": origin, "networkMode": network_mode, "startedAt": time.time()}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=False)
        page = context.new_page()
        console = []
        page.on("console", lambda msg: console.append({"type": msg.type, "text": msg.text}) if len(console) < 200 else None)
        page.on("pageerror", lambda exc: console.append({"type": "pageerror", "text": str(exc)}) if len(console) < 200 else None)
        page.goto(origin, wait_until="networkidle", timeout=30000)
        result["loginUrl"] = page.url
        page.locator("#password").fill(password)
        page.locator("#loginForm").dispatch_event("submit")
        page.wait_for_url("**/viewer.html", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        result["viewerUrl"] = page.url
        start = page.locator("#startBtn")
        if start.is_visible():
            start.click()
            page.wait_for_timeout(1500)
        page.locator("#networkModeBtn").wait_for(state="visible", timeout=30000)
        page.locator("#networkModeBtn").click()
        page.locator(f'input[name="networkMode"][value="{network_mode}"]').check()
        result["turnStatusBefore"] = page.locator("#networkTurnStatus").inner_text()
        page.locator("#applyNetworkMode").click()
        page.wait_for_timeout(1000)
        result["initial"] = {
            "connection": page.locator("#connectionStatus").inner_text(),
            "candidate": page.locator("#candidateDisplay").inner_text(),
            "fps": page.locator("#fpsDisplay").inner_text(),
            "control": page.locator("#controlStatus").inner_text(),
            "advisor": page.locator("#networkAdvisorState").inner_text(),
        }
        result["video"] = {"paused": page.locator("#remoteVideo").evaluate("e => e.paused"), "readyState": page.locator("#remoteVideo").evaluate("e => e.readyState")}
        if offline_flap:
            result["flap"] = {"started": time.time()}
            context.set_offline(True)
            page.wait_for_timeout(3000)
            result["flap"]["offline"] = {
                "connection": page.locator("#connectionStatus").inner_text(),
                "control": page.locator("#controlStatus").inner_text(),
            }
            context.set_offline(False)
            page.wait_for_timeout(8000)
            result["flap"]["online"] = {
                "connection": page.locator("#connectionStatus").inner_text(),
                "candidate": page.locator("#candidateDisplay").inner_text(),
                "fps": page.locator("#fpsDisplay").inner_text(),
                "control": page.locator("#controlStatus").inner_text(),
            }
        page.wait_for_timeout(max(1000, seconds * 1000))
        result["final"] = {
            "connection": page.locator("#connectionStatus").inner_text(),
            "candidate": page.locator("#candidateDisplay").inner_text(),
            "fps": page.locator("#fpsDisplay").inner_text(),
            "control": page.locator("#controlStatus").inner_text(),
            "advisor": page.locator("#networkAdvisorState").inner_text(),
            "video": {"paused": page.locator("#remoteVideo").evaluate("e => e.paused"), "readyState": page.locator("#remoteVideo").evaluate("e => e.readyState")},
        }
        result["screenshot"] = str(Path(output).with_suffix(".png"))
        page.screenshot(path=result["screenshot"], full_page=True)
        result["console"] = console
        browser.close()
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="http://127.0.0.1:8080")
    parser.add_argument("--network-mode", default="relay")
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--output", required=True)
    parser.add_argument("--offline-flap", action="store_true")
    args = parser.parse_args()
    run(args.origin, args.network_mode, args.seconds, args.output, args.offline_flap)
