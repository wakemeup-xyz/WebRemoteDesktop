#!/usr/bin/env python3
"""Run the deterministic offline relay encoder baseline from repository root."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROBE_PATH = ROOT / "docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py"


def select_relay_candidate(candidates: list[dict]) -> dict:
    """Select the first offline winner without treating it as runtime acceptance."""
    for candidate in candidates:
        offline = candidate.get("offline", {})
        runtime = candidate.get("runtime", {})
        if offline.get("status") == "PASS" and runtime.get("status") == "NOT RUN":
            return {
                "status": "candidate-selected-for-runtime-validation",
                "candidateId": candidate["id"],
                "defaultPolicy": "relay-legacy-v1",
                "runtimeGateStatus": "NOT RUN",
            }
    return {
        "status": "stopped-at-legacy",
        "candidateId": None,
        "defaultPolicy": "relay-legacy-v1",
        "runtimeGateStatus": "NOT RUN",
    }


RELAY_RESOLUTIONS = ((1152, 720), (1728, 1080))
CURRENT_BITRATES_BPS = {"1152x720": 1_800_000, "1728x1080": 2_500_000}
CAP_BITRATES_BPS = {"1152x720": 3_200_000, "1728x1080": 5_000_000}
RUNTIME_GATES = {
    "viewerBufferAndDecodeContinuity": "NOT RUN",
    "hostEventLoopAndInputAck": "NOT RUN",
    "finiteLossRecovery": "NOT RUN",
}


def _candidate(
    candidate_id: str,
    *,
    periodic_idr_frames: int | None,
    vbv_buffer_ms: int,
    bitrates_bps: dict[str, int],
    changed_variable: str,
) -> dict:
    return {
        "id": candidate_id,
        "parameters": {
            "policyId": "relay-balanced-v2",
            "codec": "libx264",
            "periodicIdrFrames": periodic_idr_frames,
            "periodicIdrSeconds": (
                None if periodic_idr_frames is None else periodic_idr_frames / 20
            ),
            "vbvBufferMs": vbv_buffer_ms,
            "bitrateBpsByResolution": bitrates_bps,
            "changedVariable": changed_variable,
        },
        "offline": {"status": "NOT RUN"},
        "runtime": {"status": "NOT RUN", "gates": dict(RUNTIME_GATES)},
    }


def relay_matrix_candidates() -> list[dict]:
    """Return the fixed conservative path; later rows never inherit a failed row."""
    return [
        _candidate(
            "gop-2s-current-bitrate-vbv100",
            periodic_idr_frames=40,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
        ),
        _candidate(
            "gop-2s-current-bitrate-vbv150",
            periodic_idr_frames=40,
            vbv_buffer_ms=150,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="vbvBufferMs",
        ),
        _candidate(
            "gop-2s-cap-bitrate-vbv150",
            periodic_idr_frames=40,
            vbv_buffer_ms=150,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="targetBitrateBps",
        ),
        _candidate(
            "gop-2s-cap-bitrate-vbv200",
            periodic_idr_frames=40,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="vbvBufferMs",
        ),
        _candidate(
            "gop-4s-cap-bitrate-vbv200",
            periodic_idr_frames=80,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
        ),
        _candidate(
            "gop-10s-cap-bitrate-vbv200",
            periodic_idr_frames=200,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
        ),
        _candidate(
            "on-demand-cap-bitrate-vbv200",
            periodic_idr_frames=None,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
        ),
    ]


def _gate(status: bool, *, observed, threshold, note: str) -> dict:
    return {
        "status": "PASS" if status else "FAIL",
        "observed": observed,
        "threshold": threshold,
        "note": note,
    }


def _frame_count_for(periodic_idr_frames: int) -> int:
    # The initial IDR is frame zero. Include a further periodic IDR plus margin.
    return max(65, periodic_idr_frames + 25)


def _evaluate_resolution_gates(run: dict) -> dict:
    frames = run["frames"]
    periodic_idrs = [
        frame for frame in frames if frame.get("idrKind") == "periodic"
    ]
    pulse_indices = [
        int(frame["index"])
        for frame in periodic_idrs
        if 16 <= int(frame["index"]) <= 30
    ]
    periodic_change_mae = [float(frame["changeMAE"]) for frame in periodic_idrs]
    on_demand_psnr = [
        float(frame["psnr"])
        for frame in frames
        if frame.get("idrKind") == "on-demand-probe"
    ]
    encode_budget_ms = 25.0 if tuple(run["resolution"]) == (1152, 720) else 45.0
    return {
        "qualityPulse": _gate(
            not pulse_indices,
            observed={"periodicIdrFrames": [frame["index"] for frame in periodic_idrs], "pulseIndices": pulse_indices},
            threshold="no periodic IDR at 0.8-1.5 seconds (frames 16-30 at 20FPS)",
            note="Static synthetic frames only; this is not a Viewer paint observation.",
        ),
        "periodicIdrQuality": _gate(
            bool(periodic_change_mae) and max(periodic_change_mae) <= 3.0,
            observed=periodic_change_mae,
            threshold="every periodic IDR changeMAE <= 3.0",
            note="The run includes a periodic IDR after the initial frame.",
        ),
        "onDemandIdrPsnr": _gate(
            len(on_demand_psnr) == 1 and on_demand_psnr[0] >= 28.0,
            observed=on_demand_psnr,
            threshold="one direct on-demand encoder IDR PSNR >= 28dB",
            note="This invokes the encoder directly and does not simulate network loss.",
        ),
        "encodeBudget": _gate(
            float(run["summary"]["encodeMsP95"]) <= encode_budget_ms,
            observed=float(run["summary"]["encodeMsP95"]),
            threshold=f"p95 encode <= {encode_budget_ms:.0f}ms",
            note="Machine-local encoding time; Host event-loop and input-ack remain runtime gates.",
        ),
    }


def _evaluate_offline_candidate(probe, candidate: dict) -> dict:
    parameters = candidate["parameters"]
    periodic_idr_frames = int(parameters["periodicIdrFrames"])
    font, font_metadata = probe.load_probe_font()
    runs = []
    resolution_gates = {}
    for width, height in RELAY_RESOLUTIONS:
        resolution_key = f"{width}x{height}"
        run = probe.evaluate_resolution(
            width,
            height,
            font,
            policy_id=parameters["policyId"],
            periodic_idr_frames=periodic_idr_frames,
            vbv_buffer_ms=int(parameters["vbvBufferMs"]),
            target_bitrate_bps=int(parameters["bitrateBpsByResolution"][resolution_key]),
            frame_count=_frame_count_for(periodic_idr_frames),
            on_demand_idr_frame=5,
        )
        runs.append(run)
        resolution_gates[resolution_key] = _evaluate_resolution_gates(run)
    all_passed = all(
        gate["status"] == "PASS"
        for gates in resolution_gates.values()
        for gate in gates.values()
    )
    return {
        "status": "PASS" if all_passed else "FAIL",
        "scope": "offline synthetic static text; no desktop capture, Host startup, or network connection",
        "input": {
            "randomSeed": probe.RANDOM_SEED,
            "frameRate": probe.FRAME_RATE,
            "timeBase": "1/90000",
            "content": "fixed synthetic static text with one direct on-demand encoder request",
            "font": font_metadata,
        },
        "versions": {"pyav": probe.av.__version__, "aiortc": probe.aiortc.__version__},
        "machine": {
            "platform": probe.platform.platform(),
            "machine": probe.platform.machine(),
            "python": probe.platform.python_version(),
            "cpuCount": probe.os.cpu_count(),
        },
        "resolutionGates": resolution_gates,
        "runs": runs,
    }


def evaluate_relay_matrix(probe) -> dict:
    """Evaluate the fixed path and stop before a failed setting can be compounded."""
    candidates = relay_matrix_candidates()
    stop_reason = None
    for candidate in candidates:
        if stop_reason is not None:
            candidate["offline"] = {"status": "NOT RUN", "stopReason": stop_reason}
            continue
        if candidate["parameters"]["periodicIdrFrames"] is None:
            stop_reason = "on-demand IDR requires controlled finite-loss recovery, which offline evaluation cannot provide"
            candidate["offline"] = {"status": "NOT RUN", "stopReason": stop_reason}
            continue
        candidate["offline"] = _evaluate_offline_candidate(probe, candidate)
        if candidate["offline"]["status"] == "FAIL":
            stop_reason = f"{candidate['id']} failed an offline quality or encode gate; later parameter changes were not compounded"
        else:
            stop_reason = f"{candidate['id']} is the first offline winner; later parameters were not explored"

    return {
        "kind": "relay-encoder-quality-matrix",
        "scope": "offline synthetic encoder matrix only; it cannot prove TURN, packet loss, Viewer buffer, Host event-loop, or input acknowledgement gates",
        "defaultPolicy": "relay-legacy-v1",
        "candidates": candidates,
        "selection": select_relay_candidate(candidates),
    }


def load_probe_module():
    spec = importlib.util.spec_from_file_location("turn_encoder_probe", PROBE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load probe from {PROBE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--policy", choices=("relay-legacy-v1",))
    selection.add_argument("--matrix", choices=("relay",))
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    probe = load_probe_module()
    evidence = (
        probe.evaluate_legacy_policy()
        if args.policy == "relay-legacy-v1"
        else evaluate_relay_matrix(probe)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
