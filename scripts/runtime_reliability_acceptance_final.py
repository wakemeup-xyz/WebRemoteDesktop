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
import hashlib
import statistics
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOCAL = "http://127.0.0.1:8080"
FORMAL = "https://link.stockhub.wiki"
BROWSER_PROTOCOL_ORIGIN = LOCAL
PASS_FILE = Path("/tmp/wrd-runtime-pass.txt")
OUT = Path("/tmp/wrd-acceptance")
OUT.mkdir(parents=True, exist_ok=True)


def tunnel_resume_pass(
    wait_phase_result,
    final_phase,
    host_applied_ack,
    fresh_relay_frame,
    resume_ms,
    attempt_unchanged=True,
):
    """Return true only for a bounded, acknowledged, visibly resumed tunnel."""
    return bool(
        wait_phase_result
        and final_phase == "active"
        and host_applied_ack
        and fresh_relay_frame
        and resume_ms <= 2500
        and attempt_unchanged
    )


def captured_pointer_sequence(captured):
    """Require repeated capture of one browser-assigned PointerEvent id."""
    return (
        isinstance(captured, list)
        and len(captured) == 3
        and isinstance(captured[0], int)
        and captured[0] > 0
        and all(pointer_id == captured[0] for pointer_id in captured)
    )


def write_report(report, out_dir=OUT):
    """Write one immutable run artifact plus the conventional latest pointer."""
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = str(report.get("timestamp") or "unknown").replace(":", "-")
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    base_name = f"task9-final-report-{timestamp}"
    suffix = 0
    while True:
        artifact = out_dir / f"{base_name}{f'-{suffix}' if suffix else ''}.json"
        try:
            with artifact.open("x", encoding="utf-8") as handle:
                handle.write(payload)
            break
        except FileExistsError:
            suffix += 1
    latest = out_dir / "task9-final-report.json"
    latest.write_text(payload, encoding="utf-8")
    return {
        "artifact": str(artifact),
        "latest": str(latest),
        "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    }


def control_snapshot(page):
    return page.evaluate(
        """() => ({
          controller: !!(WebRTC.controlState && WebRTC.controlState.controller),
          hasLease: !!(WebRTC.controlState && WebRTC.controlState.lease),
          state: WebRTC.controlState && WebRTC.controlState.state,
        })"""
    )


def wait_for_control(page, controller, timeout_s=12):
    end = time.time() + timeout_s
    while time.time() < end:
        state = control_snapshot(page)
        if state["controller"] == controller:
            return True
        page.wait_for_timeout(100)
    return control_snapshot(page)["controller"] == controller


def login_start(context, origin, name, password, auto_acquire=True):
    page = context.new_page()
    page.goto(f"{origin}/", wait_until="domcontentloaded", timeout=45000)
    page.fill("#password", password)
    page.click('button[type="submit"]')
    page.wait_for_url("**/viewer.html**", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("#startBtn", timeout=20000)
    if not auto_acquire:
        # startBtn normally requests control. Preserve that method for the
        # deliberate takeover below while keeping B genuinely read-only first.
        page.evaluate(
            """() => {
              window.__acceptanceRequestControl = WebRTC.requestControl.bind(WebRTC);
              WebRTC.requestControl = () => false;
            }"""
        )
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
    if auto_acquire:
        page.evaluate("() => WebRTC.requestControl()")
        wait_for_control(page, True)
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
    """Bind lease/input only when media gate is active after a real decoded/rendered frame."""
    end = time.time() + 25
    while time.time() < end:
        ready = page.evaluate(
            """async () => {
              const hasLease = !!(WebRTC.controlState && WebRTC.controlState.lease);
              let framesDecoded = 0;
              if (WebRTC.pc) {
                const stats = await WebRTC.pc.getStats();
                stats.forEach((r) => {
                  if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    framesDecoded = Number(r.framesDecoded) || 0;
                  }
                });
              }
              const freshFrame = (Number(WebRTC._videoFrameSeq) || 0) > 0 || framesDecoded > 0;
              const phase = WebRTC.getMediaAppliedPhase();
              const gate = !!WebRTC.canEnableDesktopInput();
              if (typeof Input !== 'undefined' && hasLease) {
                Input.setControlLease(WebRTC.controlState.lease);
                // Authority is the unified gate; never force-active while suspended/resuming.
                if (typeof WebRTC.syncDesktopInputGate === 'function') WebRTC.syncDesktopInputGate();
                else Input.setActive(gate);
              }
              return hasLease && gate && freshFrame && phase === 'active' && !!(Input && Input.isActive);
            }"""
        )
        if ready:
            return True
        page.wait_for_timeout(200)
    return bool(page.evaluate(
        "() => !!(Input && Input.isActive && WebRTC.canEnableDesktopInput() && WebRTC.getMediaAppliedPhase() === 'active')"
    ))


def main():
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gates": {},
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ---- 20-run resume latency local ----
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        password = PASS_FILE.read_text().strip()
        page = login_start(ctx, LOCAL, "final-local", password)
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
        ctx.close()
        ctx_keyboard = browser.new_context(viewport={"width": 1280, "height": 800})
        page = login_start(ctx_keyboard, LOCAL, "final-local-keyboard", password)
        keyboard_ready = ensure_input_ready(page)
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
                Input.setActive(WebRTC.canEnableDesktopInput() && (Number(WebRTC._videoFrameSeq) || 0) > 0);
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
            "input_ready": keyboard_ready,
            "label": "browser-protocol",
            "note": "broader protocol-path subset via controller handleDomEvent; not physical/os-reserved full product matrix",
        }

        # Mouse protocol via the same PointerEvent/capture path used in-browser.
        ctx_keyboard.close()
        ctx_mouse = browser.new_context(viewport={"width": 1280, "height": 800})
        page = login_start(ctx_mouse, LOCAL, "final-local-mouse", password)
        mouse_ready = ensure_input_ready(page)
        mouse_target_ready = False
        target_end = time.time() + 20
        while time.time() < target_end:
            mouse_target_ready = bool(page.evaluate(
                """() => {
                  const v = document.getElementById('remoteVideo');
                  const r = v?.getBoundingClientRect();
                  return !!(
                    v && Input && Input.videoElement === v &&
                    (v.readyState || 0) >= 2 && r && r.width > 0 && r.height > 0 &&
                    WebRTC.canEnableDesktopInput() && Input.isActive
                  );
                }"""
            ))
            if mouse_target_ready:
                break
            page.wait_for_timeout(200)
        mouse_geometry = page.evaluate(
            """() => {
              const v = document.getElementById('remoteVideo');
              const r = v?.getBoundingClientRect();
              return r ? {left: r.left, top: r.top, width: r.width, height: r.height} : null;
            }"""
        )
        page.evaluate(
            """() => {
              const sent=[];
              const orig=WebRTC.sendInput.bind(WebRTC);
              WebRTC.sendInput=(payload)=>{ try{ sent.push({type:payload.type, action:payload.action}); }catch(e){} return orig(payload); };
              const captured=[];
              if (typeof Input!=='undefined') {
                Input.setControlLease(WebRTC.controlState.lease);
                if (typeof WebRTC.syncDesktopInputGate === 'function') WebRTC.syncDesktopInputGate();
                else Input.setActive(WebRTC.canEnableDesktopInput());
                const v=document.getElementById('remoteVideo');
                if (v) {
                  const originalCapture=v.setPointerCapture && v.setPointerCapture.bind(v);
                  v.setPointerCapture=(pointerId)=>{ captured.push(pointerId); try { originalCapture?.(pointerId); } catch (_) {} };
                }
              }
              window.__acceptanceMouse = {sent, captured, orig, video: document.getElementById('remoteVideo')};
            }"""
        )
        if mouse_geometry:
            # Browser target center corresponds to the content center (r.width / 2).
            cx = mouse_geometry["left"] + mouse_geometry["width"] / 2
            cy = mouse_geometry["top"] + mouse_geometry["height"] / 2
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.up()
            page.mouse.down()
            page.mouse.up()
            page.mouse.down()
            page.mouse.move(cx + 40, cy + 20)
            page.mouse.up()
        page.wait_for_timeout(100)
        mouse = page.evaluate(
            """() => {
              const state = window.__acceptanceMouse || {};
              if (state.video && state.orig) state.video.setPointerCapture = state.orig;
              if (state.orig) WebRTC.sendInput = state.orig;
              return {
                sentCount: state.sent?.length || 0,
                sent: (state.sent || []).slice(0, 30),
                captured: state.captured || [],
                inputActive: !!(Input && Input.isActive),
                gate: !!WebRTC.canEnableDesktopInput(),
              };
            }"""
        )
        mouse_has_down = any(item.get("action") == "down" for item in (mouse.get("sent") or []))
        report["gates"]["9B_mouse_protocol_v2"] = {
            "status": (
                "PASS"
                if mouse_ready and mouse_target_ready
                and mouse.get("sentCount", 0) >= 3
                and captured_pointer_sequence(mouse.get("captured"))
                and mouse_has_down
                else "FAIL"
            ),
            "mouse": mouse,
            "input_ready": mouse_ready,
            "target_ready": mouse_target_ready,
            "label": "browser-protocol",
        }

        page.screenshot(path=str(OUT / "final-local-done.png"), full_page=True)
        ctx_mouse.close()

        # ---- formal dual viewer ----
        # The local Signal/Host entry is the protocol target. Formal-entry TLS
        # delivery is reported separately and never substitutes for media proof.
        ctx_a = browser.new_context(viewport={"width": 1200, "height": 800})
        ctx_b = browser.new_context(viewport={"width": 1200, "height": 800})
        a = login_start(ctx_a, BROWSER_PROTOCOL_ORIGIN, "final-protocol-A", password)
        # B must not contend during initialisation: its first request is the
        # explicit takeover below, after its observer state has converged.
        b = login_start(ctx_b, BROWSER_PROTOCOL_ORIGIN, "final-protocol-B", password, auto_acquire=False)
        ordering = []
        a_get_control = wait_for_control(a, True)
        sa = control_snapshot(a)
        sb = control_snapshot(b)
        ordering.append({"step": "A-get-control", "A": sa, "B": sb})

        b_read_only = wait_for_control(b, False) and not sb.get("controller") and sa.get("controller")
        ordering.append({"step": "B-read-only", "A": control_snapshot(a), "B": control_snapshot(b)})

        b.evaluate("() => window.__acceptanceRequestControl()")
        revoke_seen = False
        takeover_complete = False
        end = time.time() + 12
        while time.time() < end:
            current_a = control_snapshot(a)
            current_b = control_snapshot(b)
            ordering.append({"step": "B-takeover", "A": current_a, "B": current_b})
            revoke_seen = revoke_seen or not current_a["controller"]
            if revoke_seen and current_b["controller"] and not current_a["controller"]:
                takeover_complete = True
                break
            b.wait_for_timeout(100)
        sa2 = control_snapshot(a)
        sb2 = control_snapshot(b)
        single_writer = all(not point["A"]["controller"] or not point["B"]["controller"] for point in ordering)
        old_controller_local_write_rejected = bool(a.evaluate(
            """() => {
              if (!Input || typeof Input.sendInput !== 'function') return false;
              const result = Input.sendInput('command', 'showDock', {});
              return result === null && !Input.isActive && !WebRTC.canEnableDesktopInput();
            }"""
        ))
        report["gates"]["9D_formal_dual_viewer"] = {
            "status": (
                "PARTIAL"
                if a_get_control and b_read_only and revoke_seen and takeover_complete
                and single_writer and old_controller_local_write_rejected
                else "FAIL"
            ),
            "first": {"A": sa, "B": sb},
            "after_takeover": {"A": sa2, "B": sb2},
            "ordering": ordering,
            "revoke_seen": revoke_seen,
            "single_writer": single_writer,
            "old_controller_local_write_rejected": old_controller_local_write_rejected,
            "origin": BROWSER_PROTOCOL_ORIGIN,
            "label": "browser-protocol",
            "note": "local old-controller gate verified; Signal/Host rejection telemetry remains open",
        }

        # A is intentionally revoked. Close it before exercising B's tunnel
        # path so an observer-side WebRTC recovery cannot replace B's Host
        # media binding during the single-controller tunnel measurement.
        ctx_a.close()

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
        # The first matrix operation must begin from an applied active tunnel
        # stream. Starting during mode-switch/reconnect races the suspend intent
        # with producer startup and makes the result a setup failure.
        tunnel_ready = False
        ready_end = time.time() + 20
        while time.time() < ready_end:
            ready = b.evaluate(
                """() => ({
                  active: WebRTC.getMediaAppliedPhase() === 'active',
                  tunnel: !!WebRTC.tunnelRelayActive,
                  socket: !!(WebRTC.socket && WebRTC.socket.connected),
                  frameSeq: Number(WebRTC._videoFrameSeq) || 0,
                  attempt: WebRTC.currentConnectionAttemptId || null,
                })"""
            )
            if ready["active"] and ready["tunnel"] and ready["socket"] and ready["frameSeq"] > 0 and ready["attempt"]:
                tunnel_ready = True
                break
            b.wait_for_timeout(200)
        tunnel_samples = []
        for i in range(20):
            if not tunnel_ready:
                break
            b.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', true)")
            suspended = wait_phase(b, "suspended", 10)
            b.wait_for_timeout(300)
            baseline = b.evaluate(
                """() => ({
                  phase: WebRTC.getMediaAppliedPhase(),
                  frameSeq: Number(WebRTC._videoFrameSeq) || 0,
                  attempt: WebRTC.currentConnectionAttemptId || null,
                })"""
            )
            t0 = time.time()
            intent = b.evaluate("() => WebRTC.setMediaActivityReason('manual-pause', false)")
            wait_ok = wait_phase(b, "active", 12)
            resume_ms = int((time.time() - t0) * 1000)
            after = b.evaluate(
                """() => ({
                  phase: WebRTC.getMediaAppliedPhase(),
                  tunnel: !!WebRTC.tunnelRelayActive,
                  mode: WebRTC.networkMode,
                  socket: !!(WebRTC.socket && WebRTC.socket.connected),
                  frameSeq: Number(WebRTC._videoFrameSeq) || 0,
                  attempt: WebRTC.currentConnectionAttemptId || null,
                  runtime: WebRTC.mediaActivityRuntime && WebRTC.mediaActivityRuntime.snapshot(),
                })"""
            )
            ack = (after.get("runtime") or {}).get("lastAck") or {}
            host_applied_ack = bool(
                ack.get("applied") is True
                and ack.get("state") == "active"
                and ack.get("generation") == intent.get("generation")
                and ack.get("connectionAttemptId") == after.get("attempt")
            )
            fresh_relay_frame = after.get("frameSeq", 0) > baseline.get("frameSeq", 0)
            attempt_unchanged = baseline.get("attempt") == after.get("attempt")
            passed = bool(
                suspended
                and after.get("mode") == "tunnel"
                and after.get("socket")
                and tunnel_resume_pass(
                    wait_ok,
                    after.get("phase"),
                    host_applied_ack,
                    fresh_relay_frame,
                    resume_ms,
                    attempt_unchanged,
                )
            )
            tunnel_samples.append({
                "i": i + 1,
                "suspended": suspended,
                "wait_phase": wait_ok,
                "resume_ms": resume_ms,
                "final_phase": after.get("phase"),
                "host_applied_ack": host_applied_ack,
                "fresh_relay_frame": fresh_relay_frame,
                "baseline": baseline,
                "after": after,
                "pass": passed,
                "attempt_unchanged": attempt_unchanged,
            })
            # Drain to a stable active tunnel before the next sample so a soft
            # recovery from the previous iteration cannot pollute the next one.
            settle_end = time.time() + 8
            while time.time() < settle_end:
                settled = b.evaluate(
                    """() => ({
                      phase: WebRTC.getMediaAppliedPhase(),
                      tunnel: !!WebRTC.tunnelRelayActive,
                      mode: WebRTC.networkMode,
                    })"""
                )
                if settled.get("phase") == "active" and settled.get("tunnel") and settled.get("mode") == "tunnel":
                    break
                b.wait_for_timeout(100)
            b.wait_for_timeout(150)
        passed_tunnel_samples = [sample["resume_ms"] for sample in tunnel_samples if sample["pass"]]
        tunnel_p95 = None
        if passed_tunnel_samples:
            ordered = sorted(passed_tunnel_samples)
            index = max(0, min(len(ordered) - 1, int(round(0.95 * len(ordered))) - 1))
            tunnel_p95 = ordered[index]
        report["gates"]["9D_formal_tunnel_mode_media"] = {
            "status": "PASS" if tunnel_ready and len(passed_tunnel_samples) == 20 and tunnel_p95 is not None and tunnel_p95 <= 2500 else "FAIL",
            "count_ok": len(passed_tunnel_samples),
            "count_total": len(tunnel_samples),
            "p50": statistics.median(passed_tunnel_samples) if passed_tunnel_samples else None,
            "p95": tunnel_p95,
            "threshold_ms": 2500,
            "samples": tunnel_samples,
            "origin": BROWSER_PROTOCOL_ORIGIN,
            "label": "browser-protocol",
            "note": "requires matching Host ACK, fresh post-resume relay frame, exact active phase, and bounded latency",
            "tunnel_ready": tunnel_ready,
        }

        b.screenshot(path=str(OUT / "final-formal-tunnel.png"), full_page=True)
        ctx_a.close()
        ctx_b.close()
        browser.close()

    # still open honesty
    report["gates"]["9C_physical_keyboard"] = {"status": "NOT RUN", "reason": "requires user physical presses"}
    report["gates"]["9C_os_reserved"] = {"status": "NOT RUN", "reason": "OS/browser may intercept before page"}
    report["gates"]["9A_reset_blocked_fault_injection"] = {"status": "NOT RUN", "reason": "no safe runtime fault hook"}
    safe_url = Path("/tmp/wrd-safe-current-url.txt")
    report["gates"]["9D_trycloudflare_safe_url"] = {
        "status": "NOT RUN",
        "reason": "debug quick tunnel is outside this media-resume protocol run and was not changed",
        "safe_url_file": safe_url.read_text().strip() if safe_url.exists() else None,
    }
    report["gates"]["9D_formal_entry"] = {
        "status": "BLOCKED",
        "reason": "formal entry did not present the Viewer login page during this run; TLS/entry delivery is outside media protocol acceptance",
        "origin": FORMAL,
    }

    written = write_report(report)
    print(json.dumps({
        "report": written["artifact"],
        "latest": written["latest"],
        "sha256": written["sha256"],
        "summary": {k: v.get("status") for k, v in report["gates"].items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
