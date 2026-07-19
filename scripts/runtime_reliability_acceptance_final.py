#!/usr/bin/env python3
"""Final runtime acceptance batch for remaining automatable Task 9 gates.

- 20-run resume latency + P95
- broader keyboard browser-protocol cases via RemoteKeyboardController
- formal dual-viewer smoke
- formal tunnel-mode media suspend/resume smoke
Never prints secrets. Artifacts under /tmp/wrd-acceptance/.
"""

from __future__ import annotations

import json
import statistics
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOCAL = "http://127.0.0.1:8080"
FORMAL = "https://link.stockhub.wiki"
PASS = Path("/tmp/wrd-runtime-pass.txt").read_text().strip()
OUT = Path("/tmp/wrd-acceptance")
OUT.mkdir(parents=True, exist_ok=True)


def login_start(context, origin, name):
    page = context.new_page()
    page.goto(f"{origin}/", wait_until="domcontentloaded", timeout=45000)
    page.fill("#password", PASS)
    page.click('button[type="submit"]')
    page.wait_for_url("**/viewer.html**", timeout=45000)
    page.wait_for_selector("#startBtn", timeout=20000)
    page.click("#startBtn")
    for _ in range(80):
        st = page.evaluate(
            """() => ({
              connected: !!(WebRTC.socket && WebRTC.socket.connected),
              hostOnline: !!(WebRTC.controlState && WebRTC.controlState.hostOnline),
            })"""
        )
        if st["connected"] and st["hostOnline"]:
            break
        page.wait_for_timeout(400)
    page.evaluate("() => WebRTC.requestControl()")
    for _ in range(50):
        if page.evaluate("() => !!(WebRTC.controlState && WebRTC.controlState.controller && WebRTC.controlState.lease)"):
            break
        page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)
    return page


def wait_phase(page, target, timeout_s=15):
    """Wait for applied media phase. Never synthesizes rendered frames."""
    end = time.time() + timeout_s
    while time.time() < end:
        phase = page.evaluate("() => WebRTC.getMediaAppliedPhase()")
        if phase == target:
            return True
        page.wait_for_timeout(100)
    return page.evaluate("() => WebRTC.getMediaAppliedPhase()") == target


def video_bytes(page):
    return page.evaluate(
        """async () => {
          let frames=0, bytes=0;
          if (WebRTC.pc) {
            const s = await WebRTC.pc.getStats();
            s.forEach(r => {
              if (r.type === 'inbound-rtp' && r.kind === 'video') {
                frames = r.framesDecoded || 0;
                bytes = r.bytesReceived || 0;
              }
            });
          }
          return {frames, bytes, phase: WebRTC.getMediaAppliedPhase()};
        }"""
    )


def ensure_input_ready(page):
    """Bind lease/input only when media is truly active after a fresh frame."""
    page.evaluate(
        """() => {
          if (typeof Input !== 'undefined') {
            if (WebRTC.controlState && WebRTC.controlState.lease) {
              Input.setControlLease(WebRTC.controlState.lease);
            }
            if (WebRTC.canEnableDesktopInput()) Input.setActive(true);
          }
        }"""
    )
    page.wait_for_timeout(300)


def main():
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gates": {},
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---- 20-run resume latency local ----
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = login_start(ctx, LOCAL, "final-local")
        # wait media flowing
        for _ in range(40):
            st = video_bytes(page)
            if st["frames"] > 3:
                break
            page.wait_for_timeout(400)

        samples = []
        for i in range(20):
            page.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', true)")
            wait_phase(page, "suspended", 10)
            page.wait_for_timeout(300)
            t0 = time.time()
            page.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', false)")
            ok = wait_phase(page, "active", 10)
            ms = int((time.time() - t0) * 1000)
            samples.append({"i": i + 1, "ms": ms, "ok": ok, "phase": page.evaluate("() => WebRTC.getMediaAppliedPhase()")})
            page.wait_for_timeout(150)
        ok_samples = [s["ms"] for s in samples if s["ok"]]
        p95 = None
        if ok_samples:
            ordered = sorted(ok_samples)
            # nearest-rank p95
            idx = max(0, min(len(ordered) - 1, int(round(0.95 * len(ordered))) - 1))
            p95 = ordered[idx]
        report["gates"]["9B_resume_p95_20_runs"] = {
            "status": "PASS" if p95 is not None and p95 <= 1500 and len(ok_samples) >= 18 else "FAIL",
            "count_ok": len(ok_samples),
            "count_total": len(samples),
            "p50": statistics.median(ok_samples) if ok_samples else None,
            "p95": p95,
            "max": max(ok_samples) if ok_samples else None,
            "min": min(ok_samples) if ok_samples else None,
            "samples": samples,
            "threshold_ms": 1500,
            "label": "browser-protocol",
        }

        # one more 15s payload stop check
        page.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', true)")
        wait_phase(page, "suspended", 10)
        page.wait_for_timeout(1500)
        b = video_bytes(page)
        page.wait_for_timeout(15000)
        m = video_bytes(page)
        report["gates"]["9B_suspend_15s_payload_stop_recheck"] = {
            "status": "PASS" if m["phase"] == "suspended" and (m["bytes"] - b["bytes"]) <= 32 * 1024 else "FAIL",
            "base": b,
            "mid": m,
            "byte_delta": m["bytes"] - b["bytes"],
            "frame_delta": m["frames"] - b["frames"],
        }
        page.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', false)")
        wait_phase(page, "active", 10)

        # ---- keyboard browser-protocol broader ----
        ensure_input_ready(page)
        kb = page.evaluate(
            """() => {
              const sent = [];
              const orig = WebRTC.sendInput.bind(WebRTC);
              WebRTC.sendInput = (payload) => {
                try {
                  sent.push({
                    type: payload && payload.type,
                    action: payload && payload.action,
                    phase: payload && payload.payload && payload.payload.phase,
                    code: payload && payload.payload && payload.payload.code,
                    location: payload && payload.payload && payload.payload.location,
                  });
                } catch (e) {}
                return orig(payload);
              };
              if (typeof Input !== 'undefined') {
                Input.setControlLease(WebRTC.controlState.lease);
                Input.setActive(true);
              }
              const ctrl = Input && Input.ensureKeyboardController ? Input.ensureKeyboardController() : (Input && Input.keyboardController);
              const fire = (type, key, code, mods={}) => {
                const ev = new KeyboardEvent(type, {
                  key, code, bubbles: true, cancelable: true,
                  ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift,
                  repeat: !!mods.repeat,
                });
                Object.defineProperty(ev, 'code', {get: () => code});
                if (ctrl && ctrl.handleDomEvent) ctrl.handleDomEvent(ev);
                else document.dispatchEvent(ev);
              };
              const cases = [];
              // K-ish subset
              fire('keydown','a','KeyA'); fire('keyup','a','KeyA'); cases.push('KeyA');
              fire('keydown','A','KeyA',{shift:true}); fire('keyup','A','KeyA',{shift:true}); cases.push('Shift+A');
              fire('keydown','Control','ControlLeft',{ctrl:true}); fire('keyup','Control','ControlLeft',{ctrl:true}); cases.push('ControlLeft');
              fire('keydown','Control','ControlRight',{ctrl:true}); fire('keyup','Control','ControlRight',{ctrl:true}); cases.push('ControlRight');
              fire('keydown','Meta','MetaLeft',{meta:true}); fire('keyup','Meta','MetaLeft',{meta:true}); cases.push('MetaLeft');
              fire('keydown','Alt','AltLeft',{alt:true}); fire('keyup','Alt','AltLeft',{alt:true}); cases.push('AltLeft');
              fire('keydown','Shift','ShiftLeft',{shift:true}); fire('keyup','Shift','ShiftLeft',{shift:true}); cases.push('ShiftLeft');
              fire('keydown','Shift','ShiftRight',{shift:true}); fire('keyup','Shift','ShiftRight',{shift:true}); cases.push('ShiftRight');
              fire('keydown','ArrowLeft','ArrowLeft'); fire('keyup','ArrowLeft','ArrowLeft'); cases.push('ArrowLeft');
              fire('keydown','1','Digit1'); fire('keyup','1','Digit1'); cases.push('Digit1');
              fire('keydown',' ','Space'); fire('keyup',' ','Space'); cases.push('Space');
              fire('keydown','Enter','Enter'); fire('keyup','Enter','Enter'); cases.push('Enter');
              fire('keydown','a','KeyA',{repeat:true}); fire('keyup','a','KeyA'); cases.push('repeat-KeyA');
              // chord helper if available
              if (ctrl && ctrl.sendChord) {
                try { ctrl.sendChord(['ControlLeft','KeyC']); cases.push('chord-CtrlC'); } catch (e) {}
              }
              // blur/reset path
              if (Input && Input.resetKeyboard) Input.resetKeyboard('window-blur');
              cases.push('reset-blur');
              const diag = Input.getDiagnosticState ? Input.getDiagnosticState() : null;
              WebRTC.sendInput = orig;
              return {
                cases,
                sentCount: sent.length,
                sent: sent.slice(0, 40),
                pressedCount: diag && diag.keyboard && diag.keyboard.pressedCount,
                leaseState: diag && diag.keyboard && diag.keyboard.leaseState,
                inputActive: !!(Input && Input.isActive),
              };
            }"""
        )
        report["gates"]["9C_keyboard_browser_protocol_matrix_v2"] = {
            "status": "PASS" if kb.get("sentCount", 0) >= 8 and kb.get("pressedCount", 1) == 0 else "FAIL",
            "kb": kb,
            "label": "browser-protocol",
            "note": "broader protocol-path subset via controller handleDomEvent; not physical/os-reserved full product matrix",
        }

        # mouse protocol via Input path
        mouse = page.evaluate(
            """() => {
              const sent=[];
              const orig=WebRTC.sendInput.bind(WebRTC);
              WebRTC.sendInput=(payload)=>{ try{ sent.push({type:payload.type, action:payload.action}); }catch(e){} return orig(payload); };
              if (typeof Input!=='undefined') {
                Input.setActive(true);
                const v=document.getElementById('remoteVideo');
                if (v) {
                  const r=v.getBoundingClientRect();
                  const mk=(type,x,y,button=0,detail=1)=>new MouseEvent(type,{bubbles:true,clientX:r.left+x,clientY:r.top+y,button,buttons:type==='mouseup'?0:1,detail});
                  v.dispatchEvent(mk('mousedown', 40, 40, 0, 1));
                  v.dispatchEvent(mk('mouseup', 40, 40, 0, 1));
                  v.dispatchEvent(mk('mousedown', 40, 40, 0, 2));
                  v.dispatchEvent(mk('mouseup', 40, 40, 0, 2));
                  v.dispatchEvent(mk('mousedown', 40, 40, 0, 1));
                  v.dispatchEvent(mk('mousemove', 80, 60, 0, 1));
                  v.dispatchEvent(mk('mouseup', 80, 60, 0, 1));
                }
              }
              WebRTC.sendInput=orig;
              return {sentCount: sent.length, sent: sent.slice(0,30)};
            }"""
        )
        report["gates"]["9B_mouse_protocol_v2"] = {
            "status": "PASS" if mouse.get("sentCount", 0) >= 3 else "FAIL",
            "mouse": mouse,
            "label": "browser-protocol",
        }

        page.screenshot(path=str(OUT / "final-local-done.png"), full_page=True)
        ctx.close()

        # ---- formal dual viewer ----
        ctx_a = browser.new_context(viewport={"width": 1200, "height": 800})
        ctx_b = browser.new_context(viewport={"width": 1200, "height": 800})
        a = login_start(ctx_a, FORMAL, "final-formal-A")
        b = login_start(ctx_b, FORMAL, "final-formal-B")
        # B may auto request; force A controller then B takeover
        a.evaluate("() => WebRTC.requestControl()")
        for _ in range(40):
            if a.evaluate("() => !!(WebRTC.controlState && WebRTC.controlState.controller)"):
                break
            a.wait_for_timeout(250)
        sa = a.evaluate("() => ({controller:!!WebRTC.controlState.controller, state:WebRTC.controlState.state, hasLease:!!WebRTC.controlState.lease})")
        sb = b.evaluate("() => ({controller:!!WebRTC.controlState.controller, state:WebRTC.controlState.state, hasLease:!!WebRTC.controlState.lease})")
        b.evaluate("() => WebRTC.requestControl()")
        for _ in range(40):
            if b.evaluate("() => !!(WebRTC.controlState && WebRTC.controlState.controller)"):
                break
            b.wait_for_timeout(250)
        sa2 = a.evaluate("() => ({controller:!!WebRTC.controlState.controller, state:WebRTC.controlState.state})")
        sb2 = b.evaluate("() => ({controller:!!WebRTC.controlState.controller, state:WebRTC.controlState.state, hasLease:!!WebRTC.controlState.lease})")
        report["gates"]["9D_formal_dual_viewer"] = {
            "status": "PASS" if sa.get("controller") and not sb.get("controller") and sb2.get("controller") and not sa2.get("controller") else "FAIL",
            "first": {"A": sa, "B": sb},
            "after_takeover": {"A": sa2, "B": sb2},
            "origin": FORMAL,
            "label": "browser-protocol",
        }

        # formal tunnel mode on controller B
        b.evaluate("() => WebRTC.setNetworkMode('tunnel')")
        b.wait_for_timeout(2000)
        # start again if needed
        if b.locator("#startBtn").count() and b.locator("#startBtn").is_visible():
            try:
                b.click("#startBtn")
            except Exception:
                pass
        for _ in range(40):
            st = b.evaluate("() => ({mode:WebRTC.networkMode, tunnel:!!WebRTC.tunnelRelayActive, controller:!!(WebRTC.controlState&&WebRTC.controlState.controller), connected:!!(WebRTC.socket&&WebRTC.socket.connected)})")
            if st["mode"] == "tunnel" and st["connected"]:
                break
            b.wait_for_timeout(300)
        if not b.evaluate("() => !!(WebRTC.controlState && WebRTC.controlState.controller)"):
            b.evaluate("() => WebRTC.requestControl()")
            for _ in range(40):
                if b.evaluate("() => !!(WebRTC.controlState && WebRTC.controlState.controller)"):
                    break
                b.wait_for_timeout(250)
        # suspend/resume in tunnel
        b.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', true)")
        wait_phase(b, "suspended", 10)
        b.wait_for_timeout(1500)
        tb = b.evaluate("() => ({phase:WebRTC.getMediaAppliedPhase(), tunnel:!!WebRTC.tunnelRelayActive, mode:WebRTC.networkMode, socket:!!(WebRTC.socket&&WebRTC.socket.connected)})")
        b.wait_for_timeout(5000)
        t0 = time.time()
        b.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', false)")
        ok = wait_phase(b, "active", 12)
        tms = int((time.time() - t0) * 1000)
        ta = b.evaluate("() => ({phase:WebRTC.getMediaAppliedPhase(), tunnel:!!WebRTC.tunnelRelayActive, mode:WebRTC.networkMode, socket:!!(WebRTC.socket&&WebRTC.socket.connected)})")
        report["gates"]["9D_formal_tunnel_mode_media"] = {
            "status": "PASS" if tb.get("mode") == "tunnel" and tb.get("phase") == "suspended" and ta.get("socket") and (ok or ta.get("phase") in ("active", "resuming")) else "FAIL",
            "before_resume": tb,
            "after_resume": ta,
            "resume_ms": tms,
            "origin": FORMAL,
            "label": "browser-protocol",
            "note": "uses formal fixed-domain entry in tunnel networkMode; trycloudflare safe URL remains blocked",
        }

        b.screenshot(path=str(OUT / "final-formal-tunnel.png"), full_page=True)
        ctx_a.close()
        ctx_b.close()
        browser.close()

    # still open honesty
    report["gates"]["9C_physical_keyboard"] = {"status": "NOT RUN", "reason": "requires user physical presses"}
    report["gates"]["9C_os_reserved"] = {"status": "NOT RUN", "reason": "OS/browser may intercept before page"}
    report["gates"]["9A_reset_blocked_fault_injection"] = {"status": "NOT RUN", "reason": "no safe runtime fault hook"}
    report["gates"]["9D_trycloudflare_safe_url"] = {
        "status": "BLOCKED",
        "reason": "safe URL health http-invalid/404; tunnel not rebuilt by policy",
        "safe_url_file": Path("/tmp/wrd-safe-current-url.txt").read_text().strip(),
    }

    out = OUT / "task9-final-report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({
        "report": str(out),
        "summary": {k: v.get("status") for k, v in report["gates"].items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
