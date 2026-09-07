#!/usr/bin/env python3
"""Concrete owner CLI for the disposable T6 lifecycle.

It intentionally stops before Compose when the live Lab/desktop precondition is
absent; it never substitutes synthetic media for the loss transaction.
"""
from __future__ import annotations
import argparse, json, secrets, socket, time
from pathlib import Path
from typing import Any, Callable, Mapping

from controller import (DockerRuntimeProbe, LabReceiverBridgeAuthority, LossFixtureManifest,
                        RuntimeBlocked, load_fixture_credentials, prepare_runtime,
                        run_isolated_loss_lifecycle)


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


def _sample(adapter: Any, timeline: Any) -> dict[str, Any]:
    raw = adapter.sample_loss_lab_taps()
    if not isinstance(raw, Mapping):
        raise RuntimeBlocked("Viewer native loss taps are unavailable")
    timeline.ingest_viewer_tap(raw)
    return dict(raw)


def run_controlled_loss_transaction(*, manifest: LossFixtureManifest, endpoint: str, control_token: str,
                                    adapter: Any, timeline: Any, recovery_seconds: int = 10,
                                    wait: Callable[[float], None] = time.sleep) -> dict[str, Any]:
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
        baseline = _sample(adapter, timeline)
        if baseline["stats"]["inbound"]["packetsLost"] != 0: raise RuntimeBlocked("Viewer reports loss before fixture injection")
        events = []
        for pattern, duration in (("every_100th_for_30s", 30_000), ("all_for_200ms", 200)):
            if events:
                # Baselines are intentionally one-shot; re-observe the exact
                # selected leg before every separately enumerated injection.
                client.call("confirm")
            event = client.call("apply", runId=manifest.run_id, pattern=pattern, durationMs=duration)
            client.call("collect")
            cleared = client.call("clear")
            if cleared.get("cleared") is not True or cleared.get("comment") != event.get("comment"):
                raise RuntimeBlocked("fixture loss rule did not clear")
            events.append(cleared)
        for _ in range(recovery_seconds):
            wait(1); _sample(adapter, timeline)
        return {"sessionId": session_id, "scope": dict(scope), "events": events, "baseline": baseline}
    finally:
        client.close()


def run_dedicated_desktop_lifecycle(*, manifest_path: Path, runtime: Path, viewer_token: str,
                                    t3_artifact: Path, t5_artifact: Path) -> dict[str, Any]:
    """Concrete Lab -> authority -> Compose -> control -> seal -> verify path."""
    from turn_lab import LabRun
    from turn_controlled_scene import ProducerProof
    from turn_controlled_scene_lab_runner import (PlaywrightLabViewerAdapter,
                                                   RawLossTimelineCollector,
                                                   seal_loss_bridge_after_clear)
    manifest = LossFixtureManifest.parse(json.loads(manifest_path.read_text()))
    lab = LabRun(viewer_token=viewer_token); adapter = None
    try:
        identity = lab.start("legacy"); lab.start_host()
        proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending", 0, identity.realm, identity.run_id)
        adapter = PlaywrightLabViewerAdapter.open(lab, proof, headed_producer=True)
        scope = adapter.viewer_session_identity()
        if not isinstance(scope, Mapping) or lab.selected_turn_identity() != manifest.selected_turn:
            raise RuntimeBlocked("Lab selected TURN does not bind the fixture manifest")
        resolved = DockerRuntimeProbe().resolve_fixture_images(manifest.image_digests)
        prepared = prepare_runtime(json.loads(manifest_path.read_text()), runtime, resolved_images=resolved)
        credentials = load_fixture_credentials(runtime / manifest.credentials_file, manifest.realm)
        authority = LabReceiverBridgeAuthority(manifest, verifier=lab.transcript_verifier(), socket_path=Path(prepared["bridgeSocket"]))
        timeline = RawLossTimelineCollector(started_ns=time.monotonic_ns(), ended_ns=time.monotonic_ns())
        def drive() -> Mapping[str, Any]:
            result = run_controlled_loss_transaction(manifest=manifest, endpoint=prepared["controlEndpoint"], control_token=credentials["controlToken"], adapter=adapter, timeline=timeline)
            fields = timeline.as_bridge_fields()
            last = result["events"][-1]
            bridge = {"schemaVersion": 1, "kind": "turn-loss-receiver-bridge",
                      "t3": json.loads(t3_artifact.read_text()), "t5": json.loads(t5_artifact.read_text()),
                      "loss": {"runId": manifest.run_id, "realm": manifest.realm, "sessionId": result["sessionId"],
                               "attemptId": result["scope"]["attemptId"], "generation": result["scope"]["generation"], "streamId": result["scope"]["streamId"],
                               "selectedTurn": manifest.selected_turn, "eventHandle": last["comment"], "startedMonotonicNs": last["startedMonotonicNs"],
                               "endedMonotonicNs": last["endedMonotonicNs"], "sequences": fields["sequences"]}, "timeline": fields["timeline"]}
            raw_path, event_path, seal_path = runtime / "raw-bridge.json", runtime / "cleared.json", runtime / manifest.receiver_bridge_file
            raw_path.write_text(json.dumps(bridge)); event_path.write_text(json.dumps(last))
            seal_loss_bridge_after_clear(manifest_path=manifest_path, socket_path=Path(prepared["bridgeSocket"]), raw_bridge_path=raw_path, cleared_event_path=event_path, seal_path=seal_path)
            verifier = LossControlClient(prepared["controlEndpoint"], credentials["controlToken"])
            try:
                final = verifier.call("verify", runId=manifest.run_id)
            finally:
                verifier.close()
            if final.get("status") != "PASS": raise RuntimeBlocked("sealed final loss verification did not pass")
            return {"transaction": result, "final": final}
        return run_isolated_loss_lifecycle(prepared=prepared, compose_file=Path(__file__).with_name("compose.yaml"), authority=authority,
                                           run=DockerRuntimeProbe._run_command, drive=drive)
    finally:
        if adapter is not None: adapter.close()
        lab.close()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--viewer-token-env", required=True)
    parser.add_argument("--t3-artifact", type=Path, required=True)
    parser.add_argument("--t5-artifact", type=Path, required=True)
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
        result = run_dedicated_desktop_lifecycle(manifest_path=args.manifest, runtime=args.runtime, viewer_token=viewer_token,
                                                 t3_artifact=args.t3_artifact, t5_artifact=args.t5_artifact)
        print(json.dumps({"status": "OBSERVED", "result": result}, sort_keys=True)); return 0
    except RuntimeBlocked as exc:
        print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":str(exc), "runId":manifest.run_id})); return 2
if __name__ == "__main__": raise SystemExit(main())
