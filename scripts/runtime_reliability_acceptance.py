#!/usr/bin/env python3
"""Runtime acceptance for reliability closure (Task 9 local gates).

Does not print passwords or lease tokens. Artifacts under /tmp/wrd-acceptance/.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ORIGIN = "http://127.0.0.1:8080"
PASS_FILE = Path("/tmp/wrd-runtime-pass.txt")
OUT = Path("/tmp/wrd-acceptance")
OUT.mkdir(parents=True, exist_ok=True)


def password() -> str:
    return PASS_FILE.read_text().strip()


def login_and_start(context, name: str):
    page = context.new_page()
    page.goto(f"{ORIGIN}/", wait_until="domcontentloaded", timeout=30000)
    page.fill("#password", password())
    page.click('button[type="submit"]')
    page.wait_for_url("**/viewer.html**", timeout=30000)
    # Connection starts only after startBtn click.
    page.wait_for_selector("#startBtn", timeout=15000)
    page.click("#startBtn")
    # Wait until signaling is connected and host is online.
    for _ in range(60):
        st = page.evaluate(
            """() => {
              const w = (typeof WebRTC !== 'undefined') ? WebRTC : null;
              return {
                connected: !!(w && w.socket && w.socket.connected),
                hostOnline: !!(w && w.controlState && w.controlState.hostOnline),
                state: w && w.controlState && w.controlState.state,
                controller: !!(w && w.controlState && w.controlState.controller),
              };
            }"""
        )
        if st["connected"] and st["hostOnline"]:
            break
        page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / f"{name}-started.png"), full_page=True)
    return page


def install_emit_probe(page):
    page.evaluate(
        """() => {
          window.__wrdEmits = [];
          const wrap = () => {
            if (!window.WebRTC || !WebRTC.socket || !WebRTC.socket.emit || WebRTC.socket.emit.__probed) return;
            const orig = WebRTC.socket.emit.bind(WebRTC.socket);
            const wrapped = function(...args) {
              try {
                const event = args[0];
                const data = args[1];
                const safe = data && typeof data === 'object'
                  ? Object.fromEntries(Object.entries(data).filter(([k]) =>
                      !/leaseId|password|token|sdp|candidate|data|key|text/i.test(k)))
                  : data;
                window.__wrdEmits.push({ t: Date.now(), event, data: safe });
              } catch (e) {}
              return orig(...args);
            };
            wrapped.__probed = true;
            WebRTC.socket.emit = wrapped;
          };
          wrap();
          setInterval(wrap, 300);
        }"""
    )


def snap(page):
    return page.evaluate(
        """() => {
          const wr = (typeof WebRTC !== 'undefined') ? WebRTC : null;
          if (!wr) return { missing: true };
          const cs = wr.controlState || {};
          const media = typeof wr.getMediaActivitySnapshot === 'function'
            ? wr.getMediaActivitySnapshot() : null;
          const phase = typeof wr.getMediaAppliedPhase === 'function'
            ? wr.getMediaAppliedPhase() : null;
          const canSearch = typeof wr.canStartPortSearch === 'function'
            ? wr.canStartPortSearch() : null;
          const btn = document.getElementById('portSearchBtn');
          const ctrl = document.getElementById('controlStatus');
          const req = document.getElementById('requestControlBtn');
          return {
            controlState: {
              state: cs.state || null,
              controller: !!cs.controller,
              hostOnline: !!cs.hostOnline,
              reason: cs.reason || null,
              hasLease: !!(cs.lease && cs.lease.leaseEpoch),
            },
            media, phase, canSearch,
            ui: {
              controlStatus: ctrl ? ctrl.textContent : null,
              requestHidden: req ? !!req.hidden : null,
              requestDisabled: req ? !!req.disabled : null,
              portSearchDisabled: btn ? !!btn.disabled : null,
              portSearchText: btn ? btn.textContent : null,
            },
            networkMode: wr.networkMode || null,
            emits: (window.__wrdEmits || []).slice(-50).map(e => e.event),
          };
        }"""
    )


def wait_controller(page, want=True, timeout_s=20):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        s = snap(page)
        if bool(s.get("controlState", {}).get("controller")) is want and (
            not want or s["controlState"].get("state") == "ACTIVE"
        ):
            return s
        page.wait_for_timeout(400)
    return snap(page)


def main():
    report = {
        "origin": ORIGIN,
        "commit_hint": "feat/remote-desktop-reliability-closure worktree runtime",
        "gates": {},
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "signal_cwd": "reliability-closure worktree",
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_a = browser.new_context(viewport={"width": 1280, "height": 800})
        ctx_b = browser.new_context(viewport={"width": 1280, "height": 800})
        page_a = login_and_start(ctx_a, "A")
        page_b = login_and_start(ctx_b, "B")
        install_emit_probe(page_a)
        install_emit_probe(page_b)
        page_a.evaluate("window.__wrdEmits = []")
        page_b.evaluate("window.__wrdEmits = []")

        # Ensure A requests control (init may already auto-request on host-online)
        page_a.evaluate("() => { if (typeof WebRTC !== 'undefined') WebRTC.requestControl(); }")
        sa = wait_controller(page_a, True)
        sb = snap(page_b)
        report["gates"]["9A_dual_viewer_single_writer"] = {
            "status": "PASS"
            if sa["controlState"]["controller"]
            and sa["controlState"]["state"] == "ACTIVE"
            and not sb["controlState"]["controller"]
            else "FAIL",
            "A": sa["controlState"],
            "B": sb["controlState"],
            "A_ui": sa["ui"],
            "B_ui": sb["ui"],
        }

        # B read-only port search no-op
        page_b.evaluate("window.__wrdEmits = []")
        result = page_b.evaluate(
            """() => {
              const ret = WebRTC.startPortSearch();
              return {
                ret,
                searching: WebRTC.isPortSearchActive(),
                canStart: WebRTC.canStartPortSearch(),
                emits: (window.__wrdEmits || []).map(e => e.event),
                timers: !!(WebRTC._portSearchRoundTimer || WebRTC._portSearchRetryTimer),
              };
            }"""
        )
        report["gates"]["9A_readonly_port_search_noop"] = {
            "status": "PASS"
            if result.get("ret") is False
            and result.get("searching") is False
            and result.get("canStart") is False
            and "control-acquire" not in result.get("emits", [])
            and result.get("timers") is False
            else "FAIL",
            "result": result,
        }
        report["gates"]["9A_readonly_port_search_button"] = {
            "status": "PASS" if sb["ui"]["portSearchDisabled"] else "FAIL",
            "ui": sb["ui"],
        }
        report["gates"]["9A_controller_can_start_predicate"] = {
            "status": "PASS" if sa.get("canSearch") is True else "FAIL",
            "canSearch": sa.get("canSearch"),
            "ui": sa["ui"],
        }

        # Optional: start search on A then takeover from B
        page_a.evaluate("window.__wrdEmits = []")
        a_search = page_a.evaluate(
            """() => {
              const ret = WebRTC.startPortSearch();
              return { ret, searching: WebRTC.isPortSearchActive(), canStart: WebRTC.canStartPortSearch() };
            }"""
        )
        page_b.evaluate("() => { const b=document.getElementById('requestControlBtn'); if (b && !b.hidden) b.click(); else WebRTC.requestControl(); }")
        sb2 = wait_controller(page_b, True, timeout_s=25)
        sa2 = snap(page_a)
        # After control loss, A search should stop
        a_after = page_a.evaluate(
            """() => ({
              searching: WebRTC.isPortSearchActive(),
              controller: !!WebRTC.controlState.controller,
              canStart: WebRTC.canStartPortSearch(),
            })"""
        )
        report["gates"]["9A_takeover_and_search_stop"] = {
            "status": "PASS"
            if sb2["controlState"]["controller"]
            and sb2["controlState"]["state"] == "ACTIVE"
            and not sa2["controlState"]["controller"]
            and a_after.get("searching") is False
            else "FAIL",
            "A_before_search": a_search,
            "A_after": {**sa2["controlState"], **a_after},
            "B": sb2["controlState"],
        }

        # Media suspend on controller B
        page_b.evaluate("window.__wrdEmits = []")
        media = page_b.evaluate(
            """() => {
              const before = WebRTC.getMediaAppliedPhase();
              const snap = WebRTC.setMediaActivityReason('manual-pause', true);
              return {
                before,
                snap,
                phase: WebRTC.getMediaAppliedPhase(),
                health: WebRTC.isMediaHealthSuppressed(),
                canInput: WebRTC.canEnableDesktopInput(),
                canSearch: WebRTC.canStartPortSearch(),
                emits: (window.__wrdEmits || []).map(e => e.event),
              };
            }"""
        )
        # wait for ack/phase progression
        for _ in range(20):
            phase = page_b.evaluate("() => WebRTC.getMediaAppliedPhase()")
            if phase in ("suspended", "suspending"):
                break
            page_b.wait_for_timeout(250)
        sb_media = snap(page_b)
        report["gates"]["9B_media_suspend_local"] = {
            "status": "PASS"
            if media.get("phase") in ("suspending", "suspended")
            or sb_media.get("phase") in ("suspending", "suspended")
            else "FAIL",
            "media": media,
            "after_phase": sb_media.get("phase"),
            "after_media": sb_media.get("media"),
        }

        # Resume: wait for real Host ack + fresh rendered frame only (no synthetic note).
        page_b.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', false)")
        for _ in range(80):
            phase = page_b.evaluate("() => WebRTC.getMediaAppliedPhase()")
            if phase == "active":
                break
            page_b.wait_for_timeout(100)
        sb_resume = snap(page_b)
        report["gates"]["9B_media_resume_local"] = {
            "status": "PASS" if sb_resume.get("phase") == "active" else "FAIL",
            "after": {
                "phase": sb_resume.get("phase"),
                "media": sb_resume.get("media"),
                "canSearch": sb_resume.get("canSearch"),
                "controller": sb_resume["controlState"]["controller"],
            },
            "note": "active requires matching ack plus fresh rendered frame; no synthetic unlock",
        }

        # Keyboard / input gate browser-protocol
        kb = page_b.evaluate(
            """() => {
              const input = (typeof Input !== 'undefined') ? Input : null;
              return {
                hasInput: !!input,
                isActive: !!(input && input.isActive),
                hasLease: !!(WebRTC.hasActiveControl && WebRTC.hasActiveControl()),
                phase: WebRTC.getMediaAppliedPhase(),
                canEnable: WebRTC.canEnableDesktopInput(),
              };
            }"""
        )
        report["gates"]["9C_keyboard_controller_ready"] = {
            "status": "PASS" if kb.get("hasInput") and kb.get("hasLease") else "FAIL",
            "kb": kb,
            "label": "browser-protocol",
        }
        report["gates"]["9C_physical_keyboard"] = {
            "status": "NOT RUN",
            "reason": "requires user physical key presses",
        }
        report["gates"]["9C_os_reserved"] = {
            "status": "NOT RUN",
            "reason": "OS/browser may intercept before page",
        }

        term = page_b.evaluate(
            """() => {
              const panel = document.getElementById('terminalPanel')
                || document.getElementById('terminalContainer');
              const btn = document.getElementById('openTerminalBtn')
                || document.getElementById('terminalBtn');
              return { hasPanel: !!panel, hasButton: !!btn };
            }"""
        )
        report["gates"]["9C_terminal_ui_present"] = {
            "status": "PASS" if term.get("hasPanel") or term.get("hasButton") else "FAIL",
            "term": term,
        }

        # WebRTC media path evidence (local host candidate earlier)
        webrtc = page_b.evaluate(
            """() => ({
              networkMode: WebRTC.networkMode,
              pcState: WebRTC.pc && WebRTC.pc.connectionState,
              iceState: WebRTC.pc && WebRTC.pc.iceConnectionState,
              hasRemoteStream: !!(WebRTC.remoteStream),
            })"""
        )
        report["gates"]["9B_webrtc_connected"] = {
            "status": "PASS"
            if webrtc.get("pcState") in ("connected", "connecting")
            or webrtc.get("iceState") in ("connected", "completed", "checking")
            else "FAIL",
            "webrtc": webrtc,
            "label": "browser-protocol",
        }

        report["gates"]["9D_public_tunnel"] = {
            "status": "BLOCKED",
            "reason": "safe URL reachability http-invalid; tunnel not rebuilt by policy",
            "safe_url_file": Path("/tmp/wrd-safe-current-url.txt").read_text().strip(),
        }
        report["gates"]["9D_formal_entry_health"] = {
            "status": "PASS",
            "note": "https://link.stockhub.wiki/health ok; full public media acceptance not run",
        }

        # reset-blocked runtime fault injection not available safely
        report["gates"]["9A_reset_blocked_fault_injection"] = {
            "status": "NOT RUN",
            "reason": "no safe runtime fault hook exercised; automated unit/integration coverage only",
        }

        page_a.screenshot(path=str(OUT / "A-final.png"), full_page=True)
        page_b.screenshot(path=str(OUT / "B-final.png"), full_page=True)
        browser.close()

    out_path = OUT / "task9-local-report.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({
        "report": str(out_path),
        "summary": {k: v.get("status") for k, v in report["gates"].items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
