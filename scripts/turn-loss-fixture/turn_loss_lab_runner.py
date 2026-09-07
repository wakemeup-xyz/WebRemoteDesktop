#!/usr/bin/env python3
"""Concrete owner CLI for the disposable T6 lifecycle.

It intentionally stops before Compose when the live Lab/desktop precondition is
absent; it never substitutes synthetic media for the loss transaction.
"""
from __future__ import annotations
import argparse, json, secrets, socket, sys, time
from pathlib import Path
from typing import Any, Callable, Mapping

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from controller import (DockerRuntimeProbe, LabReceiverBridgeAuthority, LossFixtureManifest,
                        RuntimeBlocked, load_fixture_credentials, prepare_runtime,
                        run_isolated_loss_lifecycle)


def _collect_current_t3(*, lab: Any, adapter: Any, scope: Mapping[str, Any], selected_turn: Mapping[str, Any],
                        now: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    """Collect T3 from the already-open Lab, before any loss rule is applied."""
    import turn_t3_lab_collector as t3
    identity = lab.identity
    if identity is None:
        raise RuntimeBlocked("current Lab identity is unavailable for T3")
    expected = t3._read_live_viewer_session(adapter)
    if expected is None or {key: expected.get(key) for key in ("attemptId", "generation", "streamId")} != dict(scope):
        raise RuntimeBlocked("current Viewer scope is unavailable for T3")
    t3._install_viewer_trace_tap(adapter.viewer_page)
    log_path, offset = lab.runtime_dir() / "host.stderr.log", 0
    def sample(_index: int) -> dict[str, Any]:
        nonlocal offset
        offset, summaries = t3._drain_host_summaries(log_path, offset)
        batches, joins, diagnostics = t3._drain_viewer_trace_tap(adapter.viewer_page)
        viewer = t3._read_live_viewer_session(adapter)
        return {"scope": {key: viewer.get(key) for key in ("attemptId", "generation", "streamId")} if viewer else None,
                "viewerSession": viewer, "hostSummaries": summaries, "frameTraceBatches": batches,
                "rvfcJoins": joins, "viewerDiagnostics": diagnostics}
    artifact = t3.collect_fixed_60_seconds(
        identity={"runId": identity.run_id, "realm": identity.realm, "origin": identity.origin,
                  "epoch": identity.epoch, "selectedTurn": dict(selected_turn)}, sample=sample,
        verifier=lab.transcript_verifier(), now=now, expected_viewer_session=expected,
        wait=lambda seconds: adapter.viewer_page.wait_for_timeout(seconds * 1000))
    if (artifact.get("status") != "OBSERVED" or artifact.get("scope") != dict(scope)
            or not t3.verify_artifact(artifact, lab.transcript_verifier())):
        raise RuntimeBlocked("current Lab T3 evidence did not self-verify")
    return artifact


def seal_and_verify_live_bridge(*, manifest: LossFixtureManifest, authority: Any, fixture: Any,
                                seal_path: Path, transaction: Mapping[str, Any], timeline: Any,
                                t3: Mapping[str, Any], t5: Mapping[str, Any]) -> dict[str, Any]:
    """Use the Lab authority's one-shot seal before the controller's final verify.

    The testable owner path deliberately accepts raw stages, never an already
    assembled bridge; that prevents a harness from bypassing phase/tap output.
    """
    fields, events = timeline.as_bridge_fields(), transaction.get("events")
    if not isinstance(events, list) or not events or not isinstance(events[-1], Mapping):
        raise RuntimeBlocked("loss transaction has no cleared event")
    # The control reply contains response-only fields.  Seal the controller's
    # canonical cleared event so the authority's one-shot binding is exactly
    # the event final verification will present back over its Unix socket.
    last_event = getattr(fixture, "_last_event", None)
    event = dict(last_event) if isinstance(last_event, Mapping) else dict(events[-1])
    scope = transaction.get("scope")
    if not isinstance(scope, Mapping):
        raise RuntimeBlocked("loss transaction scope is unavailable")
    capture = transaction.get("receiverCapture")
    if not isinstance(capture, Mapping): raise RuntimeBlocked("fixture receiver capture is unavailable")
    # Test orchestration may provide a fixture observer result, but only the
    # Lab authority can attach the acceptance capability used by final verify.
    if not isinstance(capture.get("authoritySignature"), str): capture = authority.attest_capture(capture)
    bridge = {"schemaVersion": 1, "kind": "turn-loss-receiver-bridge", "t3": dict(t3), "t5": dict(t5),
              "loss": {"runId": manifest.run_id, "realm": manifest.realm, "sessionId": transaction.get("sessionId"),
                       "attemptId": scope.get("attemptId"), "generation": scope.get("generation"), "streamId": scope.get("streamId"),
                       "selectedTurn": manifest.selected_turn, "eventHandle": event.get("comment"),
                       "startedMonotonicNs": event.get("startedMonotonicNs"), "endedMonotonicNs": event.get("endedMonotonicNs"),
                       "receiverCapture": dict(capture)}, "timeline": fields["timeline"]}
    sealed = authority.seal(bridge, event)
    if sealed.get("status") != "SEALED":
        raise RuntimeBlocked("Lab authority did not seal the current bridge")
    seal_path.write_text(json.dumps({"sealId": sealed["sealId"], "signature": sealed["signature"]}), encoding="utf-8")
    from controller import UnixSealedReceiverEvidenceSource
    fixture._receiver_source = UnixSealedReceiverEvidenceSource(authority.socket_path, seal_path)
    final = fixture.verify_final_evidence(manifest.run_id)
    if final.get("status") != "PASS":
        raise RuntimeBlocked(f"sealed final loss verification did not pass: {final.get('reason', 'unknown')}")
    return final


def _collect_current_t5(*, lab: Any, adapter: Any, scope: Mapping[str, Any], selected_turn: Mapping[str, Any]) -> dict[str, Any]:
    """Run static and controlled-input T5 against the same live Lab/Viewer."""
    from turn_controlled_scene import ProducerProof, PASS
    from turn_controlled_scene_runtime import MarkerLayout, FixtureBroker, static_text_evidence
    from turn_controlled_scene_lab_runner import (ExecutableLabDriver, LabTranscript,
                                                   LoopbackFixtureReceiver)
    identity = lab.identity
    if identity is None:
        raise RuntimeBlocked("current Lab identity is unavailable for T5")
    visible, reason = adapter.producer_window_precondition()
    if not visible:
        raise RuntimeBlocked(f"T5 fixture precondition failed: {reason}")
    presentation = adapter.viewer_session_identity()
    if not isinstance(presentation, Mapping) or {key: presentation.get(key) for key in ("attemptId", "generation", "streamId")} != dict(scope):
        raise RuntimeBlocked("current Viewer scope is unavailable for T5")
    proof = ProducerProof(secrets.randbits(64), 1, identity.origin, str(scope["attemptId"]), int(scope["generation"]), identity.realm, identity.run_id)
    adapter.set_producer_proof(proof)
    roi = adapter.calibrate_marker_roi(source_width=int(presentation["sourceWidth"]), source_height=int(presentation["sourceHeight"]))
    layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                 source_width=int(presentation["sourceWidth"]), source_height=int(presentation["sourceHeight"]), roi=roi)
    adapter.configure_marker_roi(layout)
    static = static_text_evidence(proof, layout, adapter.static_frames(layout))
    if static.get("status") != PASS:
        raise RuntimeBlocked("T5 static evidence did not pass before loss")
    adapter.calibrate_fixture_input_geometry(source_width=layout.source_width, source_height=layout.source_height)
    broker = FixtureBroker(proof, layout)
    with LoopbackFixtureReceiver(broker) as receiver:
        lab.wait_host_turn_applied()
        lease = adapter.acquire_controlled_lease()
        if lease is None:
            raise RuntimeBlocked("T5 Viewer did not receive a controlled lease")
        fixture_id = f"fixture-{identity.run_id}"
        lab.arm_controlled_input(lease_id=lease["leaseId"], lease_epoch=lease["leaseEpoch"], fixture_id=fixture_id)
        adapter.install_input_ack_observer()
        adapter.configure_loopback_producer(endpoint=receiver.endpoint, proof=proof, layout=layout)
        automatic = ExecutableLabDriver(lab_run=lab, viewer=adapter, producer=adapter, broker=receiver, fixture_id=fixture_id).run()
    if automatic.get("status") != PASS:
        raise RuntimeBlocked("T5 controlled input evidence did not pass before loss")
    transcript_identity = {"origin": identity.origin, "realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch,
                           "scope": dict(scope), "selectedTurn": dict(selected_turn)}
    transcript = LabTranscript.create(verifier=lab.transcript_verifier(), identity=transcript_identity,
                                      static=static, automatic=automatic, receipts=automatic.get("receipts", [])).as_dict()
    if not __import__("turn_controlled_scene_lab_runner").verify_transcript(transcript, identity=transcript_identity, verifier=lab.transcript_verifier()):
        raise RuntimeBlocked("current Lab T5 transcript did not self-verify")
    return transcript


class LossControlClient:
    """One authenticated control socket; it cannot submit observations."""
    def __init__(self, endpoint: str, token: str, *, timeout: float = 5) -> None:
        host, port = endpoint.rsplit(":", 1)
        self._socket = socket.create_connection((host, int(port)), timeout=timeout)
        self._reader = self._socket.makefile("rb")
        self._token = token
    def close(self) -> None:
        self._reader.close(); self._socket.close()
    def call(self, operation: str, **fields: Any) -> dict[str, Any]:
        self._socket.sendall((json.dumps({"operation": operation, "controlToken": self._token, **fields}, sort_keys=True) + "\n").encode())
        reply = json.loads(self._reader.readline(1_000_000))
        if not isinstance(reply, Mapping) or reply.get("status") == "ERROR":
            raise RuntimeBlocked(f"fixture control {operation} was refused")
        return dict(reply)


def _sample(adapter: Any, timeline: Any, *, now_ns: Callable[[], int] = time.monotonic_ns) -> dict[str, Any]:
    raw = adapter.sample_loss_lab_taps()
    if not isinstance(raw, Mapping):
        raise RuntimeBlocked("Viewer native loss taps are unavailable")
    timeline.ingest_viewer_tap(raw, runner_observed_ns=now_ns())
    return dict(raw)


def _wait_and_sample(*, seconds: float, adapter: Any, timeline: Any,
                     wait: Callable[[float], None], now_ns: Callable[[], int] = time.monotonic_ns,
                     sample_interval: float = 1.0) -> None:
    """Hold the actual rule for its declared duration while draining taps."""
    remaining = float(seconds)
    while remaining > 0:
        step = min(sample_interval, remaining)
        wait(step); _sample(adapter, timeline, now_ns=now_ns); remaining -= step


def run_controlled_loss_transaction(*, manifest: LossFixtureManifest, endpoint: str, control_token: str,
                                    adapter: Any, timeline: Any, recovery_seconds: int = 10,
                                    wait: Callable[[float], None] = time.sleep,
                                    now_ns: Callable[[], int] = time.monotonic_ns) -> dict[str, Any]:
    """Drive control and consume only the concrete Viewer adapter tap API."""
    if recovery_seconds != 10 or adapter.arm_loss_lab_taps() is not True:
        raise RuntimeBlocked("Lab Viewer loss taps did not arm")
    client = LossControlClient(endpoint, control_token)
    try:
        if client.call("health").get("status") != "READY": raise RuntimeBlocked("fixture control health is not ready")
        scope = adapter.viewer_session_identity()
        if not isinstance(scope, Mapping): raise RuntimeBlocked("Viewer scope is unavailable for loss control")
        session_id = f"loss-{secrets.token_hex(8)}"
        client.call("open", runId=manifest.run_id, sessionId=session_id, attemptId=scope["attemptId"], streamId=scope["streamId"], generation=scope["generation"])
        client.call("confirm")  # real no-loss kernel-counter probe
        timeline.set_phase("before")
        baseline = _sample(adapter, timeline, now_ns=now_ns)
        if baseline["stats"]["inbound"]["packetsLost"] != 0: raise RuntimeBlocked("Viewer reports loss before fixture injection")
        events = []
        patterns = (("every_100th_for_30s", 30_000), ("all_for_200ms", 200))
        for index, (pattern, duration) in enumerate(patterns):
            if events:
                # Baselines are intentionally one-shot; re-observe the exact
                # selected leg before every separately enumerated injection.
                client.call("confirm")
            event = client.call("apply", runId=manifest.run_id, pattern=pattern, durationMs=duration)
            timeline.set_phase("during")
            _wait_and_sample(seconds=duration / 1000, adapter=adapter, timeline=timeline, wait=wait, now_ns=now_ns)
            client.call("collect")
            cleared = client.call("clear")
            clear_observed_ns = now_ns()
            if (cleared.get("cleared") is not True or cleared.get("comment") != event.get("comment")
                    or not isinstance(cleared.get("actualDropCount"), int) or cleared["actualDropCount"] <= 0):
                raise RuntimeBlocked("fixture loss rule did not clear")
            events.append({**cleared, "clearReplyObservedNs": clear_observed_ns})
            timeline.clear_barrier(event_handle=str(cleared.get("comment")), observed_ns=clear_observed_ns)
            # Sample each clear's 10s health window.  Keep the first window
            # distinct from the final after segment so a later loss cannot
            # make the sealed RTP sequence non-chronological.
            timeline.set_phase("after" if index == len(patterns) - 1 else "recovery")
            _wait_and_sample(seconds=recovery_seconds, adapter=adapter, timeline=timeline, wait=wait, now_ns=now_ns)
            if not any(row.get("eventHandle") == cleared.get("comment") for row in timeline.recovery):
                raise RuntimeBlocked("clear did not produce a fresh PLI/FIR, IDR, and rVFC recovery")
        result = {"sessionId": session_id, "scope": dict(scope), "events": events, "baseline": baseline}
        # The runner may only read a fixture-owned capture artifact; it never
        # supplies packet rows or derives gaps from Host diagnostics.
        reader = getattr(adapter, "read_receiver_capture", None)
        if callable(reader): result["receiverCapture"] = reader(manifest=manifest, event=events[-1])
        return result
    finally:
        client.close()


def run_dedicated_desktop_lifecycle(*, manifest_path: Path, runtime: Path, viewer_token: str) -> dict[str, Any]:
    """Fixture-first Lab lifecycle; no production TURN bootstrap is reachable."""
    from turn_lab import LabRun, LabTurnBootstrap
    from turn_controlled_scene import ProducerProof
    from turn_controlled_scene_lab_runner import PlaywrightLabViewerAdapter, RawLossTimelineCollector, turn_catalog
    manifest = LossFixtureManifest.parse(json.loads(manifest_path.read_text()))
    resolved = DockerRuntimeProbe().resolve_fixture_images(manifest.image_digests)
    prepared = prepare_runtime(json.loads(manifest_path.read_text()), runtime, resolved_images=resolved)
    credentials = load_fixture_credentials(runtime / manifest.credentials_file, manifest.realm)
    host, port = str(prepared["turnEndpoint"]).rsplit(":", 1)
    bootstrap = LabTurnBootstrap(manifest.selected_turn["id"], manifest.selected_turn["fingerprint"], (f"turn:{host}:{port}?transport=udp",), credentials["turnUsername"], credentials["turnPassword"])
    lab, holder = LabRun(viewer_token=viewer_token), {"adapter": None, "authority": None, "scope": None}
    try:
        def fixture_start() -> None:
            # Compose readiness was verified before this callback.  Signal,
            # Host, and Viewer receive only the generated fixture credential.
            identity = lab.start_fixture_turn(bootstrap); lab.start_host()
            proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending", 0, identity.realm, identity.run_id)
            adapter = PlaywrightLabViewerAdapter.open(lab, proof, headed_producer=True)
            scope, lab_turn = adapter.viewer_session_identity(), lab.selected_turn_identity()
            selected_leg = adapter.selected_relay_leg(turn_catalog(lab_turn))
            if (not isinstance(scope, Mapping) or selected_leg is None or {key: selected_leg.get(key) for key in ("id", "fingerprint", "digest")} != manifest.selected_turn or {key: lab_turn.get(key) for key in ("id", "fingerprint", "digest")} != manifest.selected_turn):
                adapter.close(); raise RuntimeBlocked("Lab selected TURN does not bind the ready fixture manifest")
            holder.update(adapter=adapter, scope=scope)
        def make_authority() -> Any:
            if lab.identity is None: raise RuntimeBlocked("fixture Lab did not start after TURN readiness")
            authority = LabReceiverBridgeAuthority(manifest, verifier=lab.transcript_verifier(), socket_path=Path(prepared["bridgeSocket"]))
            holder["authority"] = authority; return authority
        def drive() -> Mapping[str, Any]:
            adapter, scope, authority = holder["adapter"], holder["scope"], holder["authority"]
            if adapter is None or not isinstance(scope, Mapping) or authority is None: raise RuntimeBlocked("fixture peers or authority are unavailable")
            t5 = _collect_current_t5(lab=lab, adapter=adapter, scope=scope, selected_turn=manifest.selected_turn)
            t3 = _collect_current_t3(lab=lab, adapter=adapter, scope=scope, selected_turn=manifest.selected_turn)
            timeline = RawLossTimelineCollector(started_ns=time.monotonic_ns(), ended_ns=time.monotonic_ns())
            result = run_controlled_loss_transaction(manifest=manifest, endpoint=prepared["controlEndpoint"], control_token=credentials["controlToken"], adapter=adapter, timeline=timeline)
            capture_path = runtime / manifest.receiver_evidence_file
            try: result["receiverCapture"] = json.loads(capture_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError) as exc: raise RuntimeBlocked("fixture receiver-side RTP capture is unavailable") from exc
            fields, last = timeline.as_bridge_fields(), result["events"][-1]
            bridge = {"schemaVersion": 1, "kind": "turn-loss-receiver-bridge", "t3": t3, "t5": t5,
                      "loss": {"runId": manifest.run_id, "realm": manifest.realm, "sessionId": result["sessionId"],
                               "attemptId": result["scope"]["attemptId"], "generation": result["scope"]["generation"], "streamId": result["scope"]["streamId"],
                               "selectedTurn": manifest.selected_turn, "eventHandle": last["comment"], "startedMonotonicNs": last["startedMonotonicNs"], "endedMonotonicNs": last["endedMonotonicNs"], "receiverCapture": result["receiverCapture"]}, "timeline": fields["timeline"]}
            raw_path, event_path, seal_path = runtime / "raw-bridge.json", runtime / "cleared.json", runtime / manifest.receiver_bridge_file
            raw_path.write_text(json.dumps(bridge), encoding="utf-8"); event_path.write_text(json.dumps({key: value for key, value in last.items() if key != "clearReplyObservedNs"}), encoding="utf-8")
            from turn_controlled_scene_lab_runner import seal_loss_bridge_after_clear
            seal_loss_bridge_after_clear(manifest_path=manifest_path, socket_path=Path(prepared["bridgeSocket"]), raw_bridge_path=raw_path, cleared_event_path=event_path, seal_path=seal_path)
            verifier = LossControlClient(prepared["controlEndpoint"], credentials["controlToken"])
            try: final = verifier.call("verify", runId=manifest.run_id)
            finally: verifier.close()
            if final.get("status") != "PASS": raise RuntimeBlocked("sealed final loss verification did not pass")
            return {"transaction": result, "final": final}
        return run_isolated_loss_lifecycle(prepared=prepared, compose_file=Path(__file__).with_name("compose.yaml"), authority=None, authority_factory=make_authority, fixture_start=fixture_start, run=DockerRuntimeProbe._run_command, drive=drive)
    finally:
        adapter = holder.get("adapter")
        if adapter is not None: adapter.close()
        lab.close()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--viewer-token-env", required=True)
    parser.add_argument("--dedicated-desktop", action="store_true")
    args = parser.parse_args()
    manifest = LossFixtureManifest.parse(json.loads(args.manifest.read_text()))
    status = DockerRuntimeProbe().status()
    if status["status"] != "READY" or not args.dedicated_desktop:
        print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":"dedicated live Lab desktop is required", "runId":manifest.run_id}))
        return 2
    viewer_token = __import__("os").environ.get(args.viewer_token_env)
    if not viewer_token:
        print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":"Viewer token is required for dedicated Lab", "runId":manifest.run_id}))
        return 2
    try:
        result = run_dedicated_desktop_lifecycle(manifest_path=args.manifest, runtime=args.runtime, viewer_token=viewer_token)
        print(json.dumps({"status": "OBSERVED", "result": result}, sort_keys=True)); return 0
    except RuntimeBlocked as exc:
        print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":str(exc), "runId":manifest.run_id})); return 2
if __name__ == "__main__": raise SystemExit(main())
