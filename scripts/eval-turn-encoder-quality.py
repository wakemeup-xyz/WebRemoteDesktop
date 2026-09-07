#!/usr/bin/env python3
"""Run the deterministic offline relay encoder baseline from repository root."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROBE_PATH = ROOT / "docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py"
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))


def _execution_source_revision() -> str:
    """Return the repository revision recorded beside digest-bound matrix evidence."""
    completed = subprocess.run(
        ("git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD"),
        check=True,
        capture_output=True,
        text=True,
    )
    revision = completed.stdout.strip()
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise RuntimeError("matrix execution source revision is invalid")
    return revision


def select_relay_candidate(candidates: list[dict]) -> dict:
    """Separate offline choice from the runtime evidence that can change defaults."""
    first_offline_winner = None
    for candidate in candidates:
        offline = candidate.get("offline", {})
        runtime = candidate.get("runtime", {})
        if offline.get("status") != "PASS" or not candidate.get("eligible", True):
            continue
        runtime_gates = runtime.get("gates", {})
        runtime_passed = (
            runtime.get("status") == "PASS"
            and set(RUNTIME_GATES) <= set(runtime_gates)
            and all(runtime_gates[gate] == "PASS" for gate in RUNTIME_GATES)
        )
        if runtime_passed:
            return {
                "state": "validated",
                "candidateId": candidate["id"],
                "defaultPolicy": "relay-balanced-v2",
                "runtimeGateStatus": "PASS",
            }
        if first_offline_winner is None:
            first_offline_winner = candidate

    if first_offline_winner is not None:
        return {
            "state": "runtime-validation-candidate",
            "candidateId": first_offline_winner["id"],
            "defaultPolicy": "relay-legacy-v1",
            "runtimeGateStatus": "PENDING",
        }
    return {
        "state": "no-offline-winner",
        "candidateId": None,
        "defaultPolicy": "relay-legacy-v1",
        "runtimeGateStatus": "PENDING",
    }


RELAY_RESOLUTIONS = ((1152, 720), (1728, 1080))
CURRENT_BITRATES_BPS = {"1152x720": 1_800_000, "1728x1080": 2_500_000}
CAP_BITRATES_BPS = {"1152x720": 3_200_000, "1728x1080": 5_000_000}
REFINEMENT_FRAME_COUNT = 65
REFINEMENT_ON_DEMAND_IDR_FRAME = 5
REFINEMENT_INPUT = {
    "randomSeed": 20260905,
    "frameRate": 20,
    "timeBase": "1/90000",
    "content": "fixed synthetic static text with one direct on-demand encoder request",
}
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
    baseline: dict,
    dependencies: tuple[str, ...] = (),
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
            "baseline": baseline,
        },
        "offline": {"status": "NOT RUN"},
        "runtime": {"status": "NOT RUN", "gates": dict(RUNTIME_GATES)},
        "dependencies": list(dependencies),
        "eligible": False,
        "ineligibleReason": [],
    }


def relay_matrix_controls() -> list[dict]:
    """Measure each primitive change from the legacy baseline before combinations."""
    legacy_baseline = {
        "id": "relay-legacy-v1",
        "periodicIdrFrames": 20,
        "vbvBufferMs": 100,
        "bitrateBpsByResolution": dict(CURRENT_BITRATES_BPS),
    }
    return [
        _candidate(
            "control-gop-2s",
            periodic_idr_frames=40,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-gop-4s",
            periodic_idr_frames=80,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-gop-10s",
            periodic_idr_frames=200,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-gop-on-demand",
            periodic_idr_frames=None,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-vbv-150",
            periodic_idr_frames=20,
            vbv_buffer_ms=150,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-vbv-200",
            periodic_idr_frames=20,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=legacy_baseline,
        ),
        _candidate(
            "control-bitrate-cap",
            periodic_idr_frames=20,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="targetBitrateBps",
            baseline=legacy_baseline,
        ),
    ]


def relay_matrix_candidates() -> list[dict]:
    """Return independently constructed rows for the fixed conservative path."""
    legacy_baseline = {
        "id": "relay-legacy-v1",
        "periodicIdrFrames": 20,
        "vbvBufferMs": 100,
        "bitrateBpsByResolution": dict(CURRENT_BITRATES_BPS),
    }
    two_second_100 = {
        "id": "two-second-current-bitrate-vbv100",
        "periodicIdrFrames": 40,
        "vbvBufferMs": 100,
        "bitrateBpsByResolution": dict(CURRENT_BITRATES_BPS),
    }
    two_second_150 = {
        "id": "two-second-current-bitrate-vbv150",
        "periodicIdrFrames": 40,
        "vbvBufferMs": 150,
        "bitrateBpsByResolution": dict(CURRENT_BITRATES_BPS),
    }
    two_second_cap_150 = {
        "id": "two-second-cap-bitrate-vbv150",
        "periodicIdrFrames": 40,
        "vbvBufferMs": 150,
        "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
    }
    two_second_cap_200 = {
        "id": "two-second-cap-bitrate-vbv200",
        "periodicIdrFrames": 40,
        "vbvBufferMs": 200,
        "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
    }
    four_second_cap_200 = {
        "id": "four-second-cap-bitrate-vbv200",
        "periodicIdrFrames": 80,
        "vbvBufferMs": 200,
        "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
    }
    ten_second_cap_200 = {
        "id": "ten-second-cap-bitrate-vbv200",
        "periodicIdrFrames": 200,
        "vbvBufferMs": 200,
        "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
    }
    return [
        _candidate(
            "gop-2s-current-bitrate-vbv100",
            periodic_idr_frames=40,
            vbv_buffer_ms=100,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=legacy_baseline,
            dependencies=("control-gop-2s",),
        ),
        _candidate(
            "gop-2s-current-bitrate-vbv150",
            periodic_idr_frames=40,
            vbv_buffer_ms=150,
            bitrates_bps=dict(CURRENT_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=two_second_100,
            dependencies=("control-gop-2s", "control-vbv-150"),
        ),
        _candidate(
            "gop-2s-cap-bitrate-vbv150",
            periodic_idr_frames=40,
            vbv_buffer_ms=150,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="targetBitrateBps",
            baseline=two_second_150,
            dependencies=("control-gop-2s", "control-vbv-150", "control-bitrate-cap"),
        ),
        _candidate(
            "gop-2s-cap-bitrate-vbv200",
            periodic_idr_frames=40,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=two_second_cap_150,
            dependencies=("control-gop-2s", "control-vbv-200", "control-bitrate-cap"),
        ),
        _candidate(
            "gop-4s-cap-bitrate-vbv200",
            periodic_idr_frames=80,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=two_second_cap_200,
            dependencies=("control-gop-4s", "control-vbv-200", "control-bitrate-cap"),
        ),
        _candidate(
            "gop-10s-cap-bitrate-vbv200",
            periodic_idr_frames=200,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=four_second_cap_200,
            dependencies=("control-gop-10s", "control-vbv-200", "control-bitrate-cap"),
        ),
        _candidate(
            "on-demand-cap-bitrate-vbv200",
            periodic_idr_frames=None,
            vbv_buffer_ms=200,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="periodicIdrFrames",
            baseline=ten_second_cap_200,
            dependencies=("control-gop-on-demand", "control-vbv-200", "control-bitrate-cap"),
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


def _evaluate_resolution_gates(run: dict, *, on_demand_only: bool) -> dict:
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
    gates = {
        "qualityPulse": _gate(
            not pulse_indices,
            observed={"periodicIdrFrames": [frame["index"] for frame in periodic_idrs], "pulseIndices": pulse_indices},
            threshold="no periodic IDR at 0.8-1.5 seconds (frames 16-30 at 20FPS)",
            note="Static synthetic frames only; this is not a Viewer paint observation.",
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
    if on_demand_only:
        gates["periodicIdrQuality"] = _gate(
            not periodic_change_mae,
            observed=periodic_change_mae,
            threshold="no periodic application IDR in the encoded on-demand sample",
            note="The 60-second logical scheduling window is reported separately.",
        )
    else:
        gates["periodicIdrQuality"] = _gate(
            bool(periodic_change_mae) and max(periodic_change_mae) <= 3.0,
            observed=periodic_change_mae,
            threshold="every periodic IDR changeMAE <= 3.0",
            note="The run includes a periodic IDR after the initial frame.",
        )
    return gates


def _evaluate_offline_candidate(probe, candidate: dict) -> dict:
    parameters = candidate["parameters"]
    on_demand_only = parameters["periodicIdrFrames"] is None
    periodic_idr_frames = 0 if on_demand_only else int(parameters["periodicIdrFrames"])
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
            frame_count=(REFINEMENT_FRAME_COUNT if on_demand_only else _frame_count_for(periodic_idr_frames)),
            on_demand_idr_frame=REFINEMENT_ON_DEMAND_IDR_FRAME,
        )
        runs.append(run)
        resolution_gates[resolution_key] = _evaluate_resolution_gates(
            run, on_demand_only=on_demand_only
        )
    all_passed = all(
        gate["status"] == "PASS"
        for gates in resolution_gates.values()
        for gate in gates.values()
    )
    logical_health_window = None
    if on_demand_only:
        application_periodic_idrs = [
            frame_index
            for frame_index in range(1, 1_201)
            if probe.periodic_idr_due(frame_index, periodic_idr_frames)
        ]
        logical_health_window = {
            "seconds": 60,
            "framesAt20Fps": 1_200,
            "applicationPeriodicIdrFrames": application_periodic_idrs,
            "status": "PASS" if not application_periodic_idrs else "FAIL",
            "note": "Deterministic scheduler check; the encoder sample remains 65 frames to measure forced-IDR quality and bytes.",
        }
        all_passed = all_passed and logical_health_window["status"] == "PASS"
    result = {
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
        "encodedSample": {
            "frameCount": len(runs[0]["frames"]),
            "purpose": "measure direct forced-IDR quality, encode time, and encoded-byte burst size",
        },
    }
    if logical_health_window is not None:
        result["logicalHealthWindow"] = logical_health_window
    return result


def evaluate_relay_matrix(probe) -> dict:
    """Measure all rows while making selection depend only on passed primitives."""
    controls = relay_matrix_controls()
    for control in controls:
        control["offline"] = _evaluate_offline_candidate(probe, control)
        control["eligible"] = control["offline"]["status"] == "PASS"
        if not control["eligible"]:
            control["ineligibleReason"] = ["control failed offline gates"]

    control_by_id = {control["id"]: control for control in controls}
    candidates = relay_matrix_candidates()
    for candidate in candidates:
        candidate["offline"] = _evaluate_offline_candidate(probe, candidate)
        failed_dependencies = [
            dependency
            for dependency in candidate["dependencies"]
            if not control_by_id[dependency]["eligible"]
        ]
        reasons = []
        if candidate["offline"]["status"] != "PASS":
            reasons.append("candidate failed offline gates")
        reasons.extend(
            f"{dependency} failed offline gates" for dependency in failed_dependencies
        )
        candidate["eligible"] = not reasons
        candidate["ineligibleReason"] = reasons

    return {
        "kind": "relay-encoder-quality-matrix",
        "scope": "offline synthetic encoder matrix only; it cannot prove TURN, packet loss, Viewer buffer, Host event-loop, or input acknowledgement gates",
        "defaultPolicy": "relay-legacy-v1",
        "controls": controls,
        "candidates": candidates,
        "selection": select_relay_candidate(candidates),
    }


def relay_vbv_refinement_baseline() -> dict:
    """Return the fresh 200-ms on-demand reference for the bounded VBV ladder."""
    return _candidate(
        "on-demand-cap-bitrate-vbv200-baseline",
        periodic_idr_frames=None,
        vbv_buffer_ms=200,
        bitrates_bps=dict(CAP_BITRATES_BPS),
        changed_variable="freshMeasurement",
        baseline={
            "id": "on-demand-cap-bitrate-vbv200",
            "periodicIdrFrames": None,
            "vbvBufferMs": 200,
            "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
        },
    )


def relay_vbv_refinement_candidates() -> list[dict]:
    """Return the two bounded VBV candidates in required execution order."""
    fresh_baseline = {
        "id": "on-demand-cap-bitrate-vbv200-baseline",
        "periodicIdrFrames": None,
        "vbvBufferMs": 200,
        "bitrateBpsByResolution": dict(CAP_BITRATES_BPS),
    }
    return [
        _candidate(
            "on-demand-cap-bitrate-vbv225",
            periodic_idr_frames=None,
            vbv_buffer_ms=225,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=fresh_baseline,
        ),
        _candidate(
            "on-demand-cap-bitrate-vbv250",
            periodic_idr_frames=None,
            vbv_buffer_ms=250,
            bitrates_bps=dict(CAP_BITRATES_BPS),
            changed_variable="vbvBufferMs",
            baseline=fresh_baseline,
        ),
    ]


def _is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _refinement_measurement_errors(evidence: dict, candidate: dict) -> list[str]:
    """Check that a fresh run records finite dual-resolution encoder evidence."""
    errors = []
    for key in ("input", "versions", "runs"):
        if key not in evidence:
            errors.append(f"missing {key}")
    if errors:
        return errors
    input_data = evidence["input"]
    if not isinstance(input_data, dict):
        errors.append("invalid input")
    elif not input_data:
        errors.append("incomplete input")
    else:
        for key, expected in REFINEMENT_INPUT.items():
            if key not in input_data:
                errors.append("incomplete input")
                break
            if input_data[key] != expected:
                errors.append(f"input {key} drift")
                break
        font = input_data.get("font")
        if not isinstance(font, dict) or not all(
            isinstance(font.get(key), str) and font[key]
            for key in ("requested", "resolved")
        ) or not isinstance(font.get("fallback"), bool):
            errors.append("incomplete input")

    versions = evidence["versions"]
    if not isinstance(versions, dict):
        errors.append("invalid versions")
    elif not all(isinstance(versions.get(key), str) and versions[key] for key in ("pyav", "aiortc")):
        errors.append("incomplete versions")

    encoded_sample = evidence.get("encodedSample")
    if not isinstance(encoded_sample, dict) or encoded_sample.get("frameCount") != REFINEMENT_FRAME_COUNT:
        errors.append("invalid encodedSample")
    runs = evidence["runs"]
    if not isinstance(runs, list):
        return errors + ["invalid runs"]

    parameters = candidate["parameters"]
    runs_by_resolution = {
        tuple(run.get("resolution", ())): run
        for run in runs
        if isinstance(run, dict)
    }
    if len(runs) != len(RELAY_RESOLUTIONS) or set(runs_by_resolution) != set(RELAY_RESOLUTIONS):
        errors.append("incomplete dual-resolution runs")
    for width, height in RELAY_RESOLUTIONS:
        key = f"{width}x{height}"
        run = runs_by_resolution.get((width, height))
        if run is None:
            errors.append(f"missing {key} run")
            continue
        encoder = run.get("encoder")
        if not isinstance(encoder, dict):
            errors.append(f"missing {key} encoder")
            continue
        expected_encoder = {
            "codec": parameters["codec"],
            "preset": "ultrafast",
            "tune": "zerolatency",
            "profile": "Baseline",
            "targetFps": 20,
            "bitrateBps": parameters["bitrateBpsByResolution"][key],
            "gopFrames": 0,
            "vbvMs": parameters["vbvBufferMs"],
        }
        for field, expected in expected_encoder.items():
            if encoder.get(field) != expected:
                errors.append(f"{key} {field} drift")
        if not isinstance(encoder.get("x264Params"), str) or not encoder["x264Params"]:
            errors.append(f"missing {key} x264Params")
        else:
            bitrate_kbps = int(parameters["bitrateBpsByResolution"][key]) // 1000
            vbv_kbits = max(
                120,
                int(parameters["bitrateBpsByResolution"][key])
                * int(parameters["vbvBufferMs"])
                // 1_000_000,
            )
            expected_x264_options = (
                "keyint=1201", "min-keyint=1201", "scenecut=0", "bframes=0",
                "threads=1", "sliced-threads=0", "slices=1", "sync-lookahead=0",
                "rc-lookahead=0", "repeat-headers=1", "open-gop=0", "intra-refresh=0",
                "forced-idr=1", f"vbv-maxrate={bitrate_kbps}", f"vbv-bufsize={vbv_kbits}",
                "vbv-init=0.4", "nal-hrd=none",
            )
            if any(option not in encoder["x264Params"].split(":") for option in expected_x264_options):
                errors.append(f"{key} x264Params drift")
        frames = run.get("frames")
        if not isinstance(frames, list):
            errors.append(f"missing {key} frames")
            continue
        if len(frames) != REFINEMENT_FRAME_COUNT:
            errors.append(f"{key} incomplete frame sequence")
            continue
        if {frame.get("index") for frame in frames if isinstance(frame, dict)} != set(range(REFINEMENT_FRAME_COUNT)):
            errors.append(f"{key} incomplete frame sequence")
            continue
        for frame in frames:
            if not isinstance(frame, dict) or any(
                not _is_finite_number(frame.get(field))
                for field in ("index", "bytes", "psnr", "changeMAE", "encodeMs")
            ):
                errors.append(f"non-finite {key} frame result")
                break
        on_demand_frames = [
            frame for frame in frames if frame.get("idrKind") == "on-demand-probe"
        ]
        if len(on_demand_frames) != 1 or on_demand_frames[0].get("index") != REFINEMENT_ON_DEMAND_IDR_FRAME or not on_demand_frames[0].get("idr"):
            errors.append(f"invalid {key} on-demand IDR evidence")
        summary = run.get("summary")
        if not isinstance(summary, dict) or any(
            not _is_finite_number(summary.get(field))
            for field in ("encodeMsMedian", "encodeMsP95")
        ):
            errors.append(f"invalid {key} summary")
        elif not (
            isinstance(summary.get("onDemandIdrPsnr"), list)
            and len(summary["onDemandIdrPsnr"]) == 1
            and _is_finite_number(summary["onDemandIdrPsnr"][0])
            and isinstance(summary.get("frameBytes"), dict)
        ):
            errors.append(f"invalid {key} summary")
    return errors


def _normalized_x264_params(value: str) -> str:
    """Ignore only VBV buffer size when comparing the one-variable ladder."""
    return re.sub(r"(?:^|:)vbv-bufsize=[^:]*", "", value)


def _refinement_comparability_errors(baseline: dict, candidate: dict) -> list[str]:
    """Ensure candidate and fresh base differ only by their declared VBV value."""
    baseline_offline = baseline["offline"]
    candidate_offline = candidate["offline"]
    errors = _refinement_measurement_errors(baseline_offline, baseline)
    if errors:
        return [f"baseline measurement comparability failed: {error}" for error in errors]
    errors = _refinement_measurement_errors(candidate_offline, candidate)
    if errors:
        return [f"candidate measurement comparability failed: {error}" for error in errors]
    if baseline_offline["input"] != candidate_offline["input"]:
        return ["candidate measurement comparability failed: input drift"]
    if baseline_offline["versions"] != candidate_offline["versions"]:
        return ["candidate measurement comparability failed: version drift"]

    base_runs = {tuple(run["resolution"]): run for run in baseline_offline["runs"]}
    candidate_runs = {tuple(run["resolution"]): run for run in candidate_offline["runs"]}
    for resolution in RELAY_RESOLUTIONS:
        base_encoder = base_runs[resolution]["encoder"]
        candidate_encoder = candidate_runs[resolution]["encoder"]
        for field in ("codec", "preset", "tune", "profile", "targetFps", "bitrateBps", "gopFrames"):
            if base_encoder[field] != candidate_encoder[field]:
                return [
                    "candidate measurement comparability failed: "
                    f"{resolution[0]}x{resolution[1]} {field} drift"
                ]
        if _normalized_x264_params(base_encoder["x264Params"]) != _normalized_x264_params(candidate_encoder["x264Params"]):
            return [
                "candidate measurement comparability failed: "
                f"{resolution[0]}x{resolution[1]} x264Params drift"
            ]
    return []


def evaluate_relay_vbv_refinement(probe) -> dict:
    """Run the fresh 200/225/(if needed)250-ms offline-only VBV ladder."""
    baseline = relay_vbv_refinement_baseline()
    baseline["offline"] = _evaluate_offline_candidate(probe, baseline)
    baseline["eligible"] = False
    baseline_errors = _refinement_measurement_errors(baseline["offline"], baseline)
    baseline["ineligibleReason"] = (
        [f"baseline measurement invalid: {error}" for error in baseline_errors]
        if baseline_errors
        else ["measurement reference only; baseline quality outcome does not select a candidate"]
    )

    if baseline_errors:
        return {
            "kind": "relay-vbv-refinement",
            "scope": "offline synthetic encoder refinement only; it cannot prove TURN, packet loss, Viewer buffer, Host event-loop, or input acknowledgement gates",
            "defaultPolicy": "relay-legacy-v1",
            "baseline": baseline,
            "candidates": [],
            "selection": select_relay_candidate([]),
        }

    measured_candidates = []
    for candidate in relay_vbv_refinement_candidates():
        candidate["offline"] = _evaluate_offline_candidate(probe, candidate)
        reasons = []
        comparability_errors = _refinement_comparability_errors(baseline, candidate)
        reasons.extend(comparability_errors)
        if candidate["offline"]["status"] != "PASS":
            reasons.append("candidate failed offline gates")
        candidate["eligible"] = not reasons
        candidate["ineligibleReason"] = reasons
        measured_candidates.append(candidate)
        if comparability_errors or candidate["eligible"]:
            break

    return {
        "kind": "relay-vbv-refinement",
        "scope": "offline synthetic encoder refinement only; it cannot prove TURN, packet loss, Viewer buffer, Host event-loop, or input acknowledgement gates",
        "defaultPolicy": "relay-legacy-v1",
        "baseline": baseline,
        "candidates": measured_candidates,
        "selection": select_relay_candidate(measured_candidates),
    }


def evaluate_preset_matrix(probe) -> dict:
    """Run the sole fresh control/candidate pair and keep production on legacy."""
    from turn_encoder_experiments import (
        build_preset_experiments,
        submitted_options,
        validate_comparison,
        validate_control_integrity,
    )

    control, candidate = build_preset_experiments()
    execution_source_revision = _execution_source_revision()
    source_digests = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            Path(__file__).resolve(),
            PROBE_PATH,
            ROOT / "scripts/turn_encoder_experiments.py",
            ROOT / "python-host/h264_videotoolbox_encoder.py",
        )
    }
    base_evidence = probe.evaluate_preset_scenario_matrix(control)
    # A malformed control must stop before spending CPU on the only candidate.
    # Its measured quality/cost outcomes remain reference data, so only
    # reproducibility and structural integrity belong to this preflight.
    base_errors = validate_control_integrity(base_evidence)
    runtime = {"status": "NOT RUN", "gates": dict(RUNTIME_GATES)}
    if base_errors:
        declared_candidate_config = candidate.to_dict()
        declared_candidate_config["submittedCodecOptionsByResolution"] = {
            f"{width}x{height}": submitted_options(candidate, (width, height))
            for width, height in RELAY_RESOLUTIONS
        }
        base_stop_candidate = {
            "id": candidate.id,
            "declaredConfig": declared_candidate_config,
            "execution": {"status": "NOT RUN", "baseStopReasons": list(base_errors)},
            "offline": {"status": "NOT RUN"},
            "runtime": runtime,
            "eligible": False,
            "ineligibleReason": list(base_errors),
        }
        return {
            "kind": "relay-preset-refinement",
            "scope": "offline synthetic encoder experiment only; runtime gates remain NOT RUN",
            "defaultPolicy": "relay-legacy-v1",
            "base": {"config": control.to_dict(), "offline": base_evidence, "validationErrors": base_errors},
            "candidates": [base_stop_candidate],
            "offlineWinner": None,
            "runtime": runtime,
            "sourceDigests": source_digests,
            "executionSourceRevision": execution_source_revision,
            "inputDigest": hashlib.sha256(
                json.dumps(base_evidence.get("input", {}), sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
            "selection": select_relay_candidate([]),
        }

    candidate_evidence = probe.evaluate_preset_scenario_matrix(candidate)
    errors = validate_comparison(base_evidence, candidate_evidence)
    candidate_valid = not errors
    candidate_row = {
        "id": candidate.id,
        "parameters": candidate.to_dict(),
        "offline": {"status": "PASS" if candidate_valid else "FAIL", "evidence": candidate_evidence},
        "runtime": runtime,
        "eligible": candidate_valid,
        "ineligibleReason": errors,
    }
    selection = select_relay_candidate([candidate_row])
    result = {
        "kind": "relay-preset-refinement",
        "scope": "offline synthetic encoder experiment only; it cannot prove TURN, Viewer buffer, Host event loop, input acknowledgement, or loss recovery",
        "defaultPolicy": "relay-legacy-v1",
        "base": {"config": control.to_dict(), "offline": base_evidence, "validationErrors": []},
        "candidates": [candidate_row],
        "offlineWinner": candidate.id if candidate_valid else None,
        "runtime": runtime,
        "sourceDigests": source_digests,
        "executionSourceRevision": execution_source_revision,
        "inputDigest": hashlib.sha256(
            json.dumps(base_evidence.get("input", {}), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "selection": selection,
    }
    if candidate_valid:
        result["frozenManifest"] = {
            "candidateId": candidate.id,
            "encoderParameterDigest": candidate.options_digest,
            "sourceDigests": source_digests,
            "status": "OFFLINE_PASS_ONLY",
            "runtime": runtime,
        }
    return result


def evaluate_veryfast_matrix(probe) -> dict:
    """Run the sole fresh superfast/veryfast pair and keep production on legacy."""
    from turn_encoder_veryfast_experiments import (
        build_veryfast_experiments,
        submitted_options,
        validate_comparison,
        validate_control_integrity,
    )

    control, candidate = build_veryfast_experiments()
    execution_source_revision = _execution_source_revision()
    source_digests = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            Path(__file__).resolve(),
            PROBE_PATH,
            ROOT / "scripts/turn_encoder_experiments.py",
            ROOT / "scripts/turn_encoder_veryfast_experiments.py",
            ROOT / "python-host/h264_videotoolbox_encoder.py",
        )
    }
    base_evidence = probe.evaluate_preset_scenario_matrix(control)
    base_errors = validate_control_integrity(base_evidence)
    runtime = {"status": "NOT RUN", "gates": dict(RUNTIME_GATES)}
    if base_errors:
        declared_candidate_config = candidate.to_dict()
        declared_candidate_config["submittedCodecOptionsByResolution"] = {
            f"{width}x{height}": submitted_options(candidate, (width, height))
            for width, height in RELAY_RESOLUTIONS
        }
        base_stop_candidate = {
            "id": candidate.id,
            "declaredConfig": declared_candidate_config,
            "execution": {"status": "NOT RUN", "baseStopReasons": list(base_errors)},
            "offline": {"status": "NOT RUN"},
            "runtime": runtime,
            "eligible": False,
            "ineligibleReason": list(base_errors),
        }
        return {
            "kind": "relay-veryfast-refinement",
            "scope": "offline synthetic encoder experiment only; runtime gates remain NOT RUN",
            "defaultPolicy": "relay-legacy-v1",
            "base": {"config": control.to_dict(), "offline": base_evidence, "validationErrors": base_errors},
            "candidates": [base_stop_candidate],
            "offlineWinner": None,
            "runtime": runtime,
            "sourceDigests": source_digests,
            "executionSourceRevision": execution_source_revision,
            "inputDigest": hashlib.sha256(
                json.dumps(base_evidence.get("input", {}), sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
            "selection": select_relay_candidate([]),
        }

    candidate_evidence = probe.evaluate_preset_scenario_matrix(candidate)
    errors = validate_comparison(base_evidence, candidate_evidence)
    candidate_valid = not errors
    candidate_row = {
        "id": candidate.id,
        "parameters": candidate.to_dict(),
        "offline": {"status": "PASS" if candidate_valid else "FAIL", "evidence": candidate_evidence},
        "runtime": runtime,
        "eligible": candidate_valid,
        "ineligibleReason": errors,
    }
    result = {
        "kind": "relay-veryfast-refinement",
        "scope": "offline synthetic encoder experiment only; it cannot prove TURN, Viewer buffer, Host event loop, input acknowledgement, or loss recovery",
        "defaultPolicy": "relay-legacy-v1",
        "base": {"config": control.to_dict(), "offline": base_evidence, "validationErrors": []},
        "candidates": [candidate_row],
        "offlineWinner": candidate.id if candidate_valid else None,
        "runtime": runtime,
        "sourceDigests": source_digests,
        "executionSourceRevision": execution_source_revision,
        "inputDigest": hashlib.sha256(
            json.dumps(base_evidence.get("input", {}), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "selection": select_relay_candidate([candidate_row]),
    }
    if candidate_valid:
        result["frozenManifest"] = {
            "candidateId": candidate.id,
            "encoderParameterDigest": candidate.options_digest,
            "sourceDigests": source_digests,
            "status": "OFFLINE_PASS_ONLY",
            "runtime": runtime,
        }
    return result


def evaluate_peak_headroom_matrix(probe) -> dict:
    """Run exactly one frozen candidate, with a fail-closed safety prescreen."""
    from turn_encoder_peak_headroom_experiments import (
        build_peak_headroom_candidate,
        submitted_options,
        validate_full_matrix,
        validate_prescreen,
    )

    candidate = build_peak_headroom_candidate()
    execution_source_revision = _execution_source_revision()
    source_digests = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            Path(__file__).resolve(),
            PROBE_PATH,
            ROOT / "scripts/turn_encoder_experiments.py",
            ROOT / "scripts/turn_encoder_peak_headroom_experiments.py",
            ROOT / "python-host/h264_encoder_policy.py",
            ROOT / "python-host/h264_videotoolbox_encoder.py",
        )
    }
    runtime = {"status": "NOT RUN", "gates": dict(RUNTIME_GATES)}
    prescreen = probe.evaluate_peak_headroom_prescreen(candidate)
    prescreen_errors = validate_prescreen(prescreen)
    declared = candidate.to_dict()
    declared["submittedCodecOptionsByResolution"] = {
        f"{width}x{height}": submitted_options(candidate, (width, height))
        for width, height in RELAY_RESOLUTIONS
    }
    candidate_row = {
        "id": candidate.id,
        "parameters": declared,
        "prescreen": {"status": "PASS" if not prescreen_errors else "FAIL", "evidence": prescreen, "validationErrors": prescreen_errors},
        "runtime": runtime,
        "eligible": False,
        "ineligibleReason": [],
        "execution": {"prescreen": "COMPLETED", "fullMatrix": "NOT RUN"},
    }
    if prescreen_errors:
        candidate_row["offline"] = {"status": "NOT RUN"}
        candidate_row["ineligibleReason"] = list(prescreen_errors)
        return {
            "kind": "relay-peak-headroom-v1", "status": "NO_QUALIFIED_CANDIDATE",
            "scope": "one offline candidate; failed safety prescreen stopped the full matrix and runtime remains NOT RUN",
            "defaultPolicy": "relay-legacy-v1", "candidate": candidate_row, "runtime": runtime,
            "sourceDigests": source_digests, "executionSourceRevision": execution_source_revision,
            "selection": select_relay_candidate([]),
        }

    full = probe.evaluate_preset_scenario_matrix(candidate)
    full_errors = validate_full_matrix(full)
    candidate_row["execution"]["fullMatrix"] = "COMPLETED"
    candidate_row["offline"] = {"status": "PASS" if not full_errors else "FAIL", "evidence": full, "validationErrors": full_errors}
    candidate_row["eligible"] = not full_errors
    candidate_row["ineligibleReason"] = list(full_errors)
    return {
        "kind": "relay-peak-headroom-v1",
        "status": "OFFLINE_PASS_ONLY" if not full_errors else "NO_QUALIFIED_CANDIDATE",
        "scope": "one offline candidate; no runtime policy change, desktop capture, Host startup, Viewer, or network connection",
        "defaultPolicy": "relay-legacy-v1", "candidate": candidate_row, "runtime": runtime,
        "sourceDigests": source_digests, "executionSourceRevision": execution_source_revision,
        "selection": select_relay_candidate([candidate_row] if not full_errors else []),
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
    selection.add_argument("--matrix", choices=("relay", "relay-vbv-refinement", "relay-preset-refinement", "relay-veryfast-refinement", "relay-peak-headroom-v1"))
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    probe = load_probe_module()
    evidence = (
        probe.evaluate_legacy_policy()
        if args.policy == "relay-legacy-v1"
        else evaluate_relay_matrix(probe)
        if args.matrix == "relay"
        else evaluate_relay_vbv_refinement(probe)
        if args.matrix == "relay-vbv-refinement"
        else evaluate_preset_matrix(probe)
        if args.matrix == "relay-preset-refinement"
        else evaluate_veryfast_matrix(probe)
        if args.matrix == "relay-veryfast-refinement"
        else evaluate_peak_headroom_matrix(probe)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
