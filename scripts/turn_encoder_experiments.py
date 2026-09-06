"""Immutable contract and fail-closed validators for the preset-only matrix."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from types import MappingProxyType
from typing import Any, Mapping


RELAY_RESOLUTIONS = ((1152, 720), (1728, 1080))
CAP_BITRATES_BPS = MappingProxyType({"1152x720": 3_200_000, "1728x1080": 5_000_000})
REQUIRED_SCENARIOS = (
    ("static-text", 0, 65, (5,)),
    ("health-static", 0, 1201, ()),
    ("scrolling-text", 0, 300, (5, 200)),
    ("post-scroll-static", 300, 300, (305, 500)),
    ("safety-net", 0, 1226, ()),
)


def _x264_params(bitrate_bps: int, vbv_ms: int, periodic_idr_frames: int) -> str:
    gop = 1201 if periodic_idr_frames == 0 else periodic_idr_frames
    kbps = bitrate_bps // 1000
    vbv_kbits = max(120, bitrate_bps * vbv_ms // 1_000_000)
    return (
        f"keyint={gop}:min-keyint={gop}:scenecut=0:bframes=0:"
        "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
        "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
        f"forced-idr=1:vbv-maxrate={kbps}:vbv-bufsize={vbv_kbits}:"
        "vbv-init=0.4:nal-hrd=none"
    )


@dataclass(frozen=True)
class ExperimentConfig:
    """A data-only, frozen encoder configuration; it cannot load executable policy."""

    id: str
    preset: str
    codec: str
    profile: str
    fps: int
    bitrate_by_resolution: Mapping[str, int]
    vbv_ms: int
    periodic_idr_frames: int
    options: Mapping[str, str]
    options_digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "preset": self.preset,
            "codec": self.codec,
            "profile": self.profile,
            "fps": self.fps,
            "bitrateByResolution": dict(self.bitrate_by_resolution),
            "vbvMs": self.vbv_ms,
            "periodicIdrFrames": self.periodic_idr_frames,
            "options": dict(self.options),
            "optionsDigest": self.options_digest,
            "encoderParameterDigest": self.options_digest,
        }


def _config(config_id: str, preset: str) -> ExperimentConfig:
    options = MappingProxyType({
        "preset": preset,
        "tune": "zerolatency",
        "otherOptionsDigest": "threads=1;zerolatency;baseline;on-demand-cap",
    })
    canonical = json.dumps({
        "codec": "libx264", "preset": preset, "profile": "Baseline", "fps": 20,
        "bitrateByResolution": dict(CAP_BITRATES_BPS), "vbvMs": 200,
        "periodicIdrFrames": 0,
        "submittedOptionsByResolution": {
            key: {"preset": preset, "tune": "zerolatency", "x264-params": _x264_params(bitrate, 200, 0)}
            for key, bitrate in sorted(CAP_BITRATES_BPS.items())
        },
    }, sort_keys=True, separators=(",", ":"))
    return ExperimentConfig(
        id=config_id,
        preset=preset,
        codec="libx264",
        profile="Baseline",
        fps=20,
        bitrate_by_resolution=CAP_BITRATES_BPS,
        vbv_ms=200,
        periodic_idr_frames=0,
        options=options,
        options_digest=sha256(canonical.encode()).hexdigest(),
    )


def build_preset_experiments() -> tuple[ExperimentConfig, ExperimentConfig]:
    """Return exactly the fresh control and the single authorized candidate."""
    return (
        _config("on-demand-cap-vbv200-ultrafast", "ultrafast"),
        _config("on-demand-cap-vbv200-superfast", "superfast"),
    )


def submitted_options(config: ExperimentConfig, resolution: tuple[int, int]) -> dict[str, str]:
    """Return the exact options expected at one actual codec construction."""
    key = f"{resolution[0]}x{resolution[1]}"
    return {
        "preset": config.preset,
        "tune": "zerolatency",
        "x264-params": _x264_params(
            int(config.bitrate_by_resolution[key]), config.vbv_ms, config.periodic_idr_frames
        ),
    }


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _config_from_run(run: Mapping[str, Any]) -> Mapping[str, Any] | None:
    config = run.get("config")
    return config if isinstance(config, Mapping) else None


def _expected_config(config: ExperimentConfig) -> dict[str, Any]:
    return config.to_dict()


def _record_errors(
    scenario: Mapping[str, Any], config: ExperimentConfig, resolution: tuple[int, int]
) -> list[str]:
    scenario_id = str(scenario.get("scenarioId", ""))
    errors: list[str] = []
    records = scenario.get("codecCreationRecords")
    if not isinstance(records, list) or not records:
        return [f"{scenario_id}: missing codec creation record"]
    if scenario_id == "post-scroll-static":
        allowed_scenario_ids = {"scrolling-text"}
    else:
        allowed_scenario_ids = {scenario_id}
    for index, record in enumerate(records, start=1):
        if not isinstance(record, Mapping):
            errors.append(f"{scenario_id}: invalid codec creation record")
            continue
        if record.get("scenarioId") not in allowed_scenario_ids:
            errors.append(f"{scenario_id}: codec creation scenario drift")
        if tuple(record.get("resolution", ())) != resolution:
            errors.append(f"{scenario_id}: codec creation resolution drift")
        if record.get("creationIndex") != index:
            errors.append(f"{scenario_id}: codec creation index drift")
        if record.get("requestedPreset") != config.preset:
            errors.append(f"{scenario_id}: requested preset drift")
        if dict(record.get("submittedCodecOptions", {})) != submitted_options(config, resolution):
            errors.append(f"{scenario_id}: submitted codec options drift")
        if record.get("configuredProfile") != config.profile:
            errors.append(f"{scenario_id}: configured profile drift")
        if record.get("configuredFps") != config.fps:
            errors.append(f"{scenario_id}: configured fps drift")
        if record.get("configuredBitrateBps") != config.bitrate_by_resolution[f"{resolution[0]}x{resolution[1]}"]:
            errors.append(f"{scenario_id}: configured bitrate drift")
        if record.get("reopenReason") != "initial":
            errors.append(f"{scenario_id}: unexpected codec reopen")
    if len(records) != 1:
        errors.append(f"{scenario_id}: unexpected codec reopen")
    if dict(scenario.get("configuredOptions", {})) != submitted_options(config, resolution):
        errors.append(f"{scenario_id}: configured options drift")
    return errors


def _scenario_errors(
    scenario: Mapping[str, Any], config: ExperimentConfig, expected: tuple[str, int, int, tuple[int, ...]], resolution: tuple[int, int], *, enforce_quality: bool, enforce_cost: bool
) -> list[str]:
    expected_id, start, count, requests = expected
    errors: list[str] = []
    if scenario.get("scenarioId") != expected_id:
        return [f"missing scenario {expected_id}"]
    if scenario.get("phaseStartIndex") != start or scenario.get("frameCount") != count:
        errors.append(f"{expected_id}: scenario shape drift")
    frames = scenario.get("frames")
    if not isinstance(frames, list) or len(frames) != count:
        return errors + [f"{expected_id}: incomplete frame sequence"]
    expected_indices = list(range(start, start + count))
    if [frame.get("index") if isinstance(frame, Mapping) else None for frame in frames] != expected_indices:
        errors.append(f"{expected_id}: incomplete frame sequence")
    for phase_index, frame in enumerate(frames):
        if not isinstance(frame, Mapping):
            errors.append(f"{expected_id}: invalid frame")
            break
        if frame.get("phaseIndex") != phase_index:
            errors.append(f"{expected_id}: phase index drift")
        if not isinstance(frame.get("inputHash"), str) or not frame["inputHash"]:
            errors.append(f"{expected_id}: incomplete input hash")
        if frame.get("pts") != frame.get("index") * 4500:
            errors.append(f"{expected_id}: PTS drift")
        if frame.get("timeBase") != "1/90000":
            errors.append(f"{expected_id}: time base drift")
        if any(not _finite(frame.get(key)) for key in ("pts", "bytes", "psnr", "changeMAE", "encodeMs", "decodeMs")):
            errors.append(f"{expected_id}: non-finite frame result")
            break
        if not isinstance(frame.get("quality"), Mapping) or any(
            not _finite(frame["quality"].get(key)) for key in ("psnr", "changeMAE")
        ):
            errors.append(f"{expected_id}: incomplete quality result")
            break
        if frame.get("qp") is not None and not _finite(frame.get("qp")):
            errors.append(f"{expected_id}: invalid qp")
            break

    request_tokens = scenario.get("requestTokens")
    expected_tokens = [f"{expected_id}:{index}" for index in requests]
    if request_tokens != expected_tokens:
        errors.append(f"{expected_id}: request token drift")
    actual_idrs = [frame for frame in frames if isinstance(frame, Mapping) and frame.get("idr")]
    expected_idrs = {} if expected_id == "post-scroll-static" else {start: "initial"}
    expected_idrs.update({index: "on-demand" for index in requests})
    if expected_id == "safety-net":
        expected_idrs[1201] = "encoder-safety-net"
    observed_idrs = {frame.get("index"): frame.get("bitstreamIdrKind") for frame in actual_idrs}
    if observed_idrs != expected_idrs:
        if expected_id == "safety-net":
            errors.append("safety-net: missing or unexpected safety-net IDR")
        else:
            errors.append(f"{expected_id}: unexpected IDR")
    for frame in actual_idrs:
        index = frame.get("index")
        kind = frame.get("bitstreamIdrKind")
        if frame.get("idrKind") != kind:
            errors.append(f"{expected_id}: IDR kind drift")
        if kind == "on-demand":
            if frame.get("requestToken") != f"{expected_id}:{index}":
                errors.append(f"{expected_id}: request token drift")
            if enforce_quality and float(frame.get("psnr", 0)) < 28.0:
                errors.append(f"{expected_id}: on-demand IDR quality failure")
        elif frame.get("requestToken") is not None:
            errors.append(f"{expected_id}: unexpected request token")
        if expected_id == "safety-net" and kind == "encoder-safety-net":
            if enforce_quality and (float(frame.get("psnr", 0)) < 28.0 or float(frame.get("changeMAE", math.inf)) > 3.0):
                errors.append("safety-net: quality failure")
    errors.extend(_record_errors(scenario, config, resolution))
    cost = scenario.get("cost")
    budget = 25.0 if resolution == (1152, 720) else 45.0
    actual_p95 = sorted(float(frame["encodeMs"]) for frame in frames)[math.ceil(len(frames) * .95) - 1]
    cost_aggregate_valid = (
        isinstance(cost, Mapping)
        and _finite(cost.get("encodeMsP95"))
        and abs(cost["encodeMsP95"] - round(actual_p95, 3)) <= 1e-9
    )
    if not cost_aggregate_valid:
        errors.append(f"{expected_id}: scenario cost aggregate drift")
    elif enforce_cost and (cost.get("status") != "PASS" or actual_p95 > budget):
        errors.append(f"{expected_id}: scenario cost failure")
    if not isinstance(scenario.get("quality"), Mapping):
        errors.append(f"{expected_id}: missing scenario quality")
    actual_idr_bytes = [frame.get("bytes") for frame in actual_idrs]
    if any(
        frame.get("idrBytes") != frame.get("bytes")
        for frame in actual_idrs
    ):
        errors.append(f"{expected_id}: IDR bytes must match frame bytes")
    if (not isinstance(scenario.get("burst"), Mapping) or scenario["burst"].get("idrBytes") != actual_idr_bytes
            or not actual_idr_bytes
            or any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in actual_idr_bytes)):
        errors.append(f"{expected_id}: missing IDR byte evidence")
    return errors


def _run_errors(
    run: Mapping[str, Any], config: ExperimentConfig, *, enforce_quality: bool, enforce_cost: bool
) -> list[str]:
    resolution = tuple(run.get("resolution", ()))
    if resolution not in RELAY_RESOLUTIONS:
        return ["invalid resolution"]
    scenarios = run.get("scenarios")
    if not isinstance(scenarios, list):
        return [f"{resolution[0]}x{resolution[1]}: missing scenarios"]
    by_id = {scenario.get("scenarioId"): scenario for scenario in scenarios if isinstance(scenario, Mapping)}
    errors: list[str] = []
    if len(scenarios) != len(REQUIRED_SCENARIOS) or set(by_id) != {item[0] for item in REQUIRED_SCENARIOS}:
        errors.append(f"{resolution[0]}x{resolution[1]}: missing scenario")
    for expected in REQUIRED_SCENARIOS:
        scenario = by_id.get(expected[0])
        if scenario is None:
            continue
        errors.extend(_scenario_errors(
            scenario, config, expected, resolution,
            enforce_quality=enforce_quality, enforce_cost=enforce_cost,
        ))
    scrolling = by_id.get("scrolling-text")
    post = by_id.get("post-scroll-static")
    if isinstance(scrolling, Mapping) and isinstance(post, Mapping) and scrolling.get("sessionId") == post.get("sessionId"):
        pass
    elif post is not None:
        errors.append(f"{resolution[0]}x{resolution[1]}: post-scroll session discontinuity")
    return errors


def _evidence_errors(
    label: str,
    run: Mapping[str, Any],
    config: ExperimentConfig,
    *,
    enforce_quality: bool,
    enforce_cost: bool,
) -> list[str]:
    errors: list[str] = []
    actual_config = _config_from_run(run)
    if not isinstance(actual_config, Mapping) or actual_config.get("encoderParameterDigest") != config.options_digest:
        errors.append(f"{label}: encoder parameter digest drift")
    expected_config = _expected_config(config)
    if actual_config != expected_config:
        errors.append(f"{label}: immutable config drift")
    runs = run.get("runs") if isinstance(run, Mapping) else None
    if not isinstance(runs, list) or len(runs) != len(RELAY_RESOLUTIONS):
        return errors + [f"{label}: incomplete dual-resolution runs"]
    by_resolution = {tuple(item.get("resolution", ())): item for item in runs if isinstance(item, Mapping)}
    if set(by_resolution) != set(RELAY_RESOLUTIONS):
        return errors + [f"{label}: incomplete dual-resolution runs"]
    for resolution in RELAY_RESOLUTIONS:
        errors.extend(f"{label}: {error}" for error in _run_errors(
            by_resolution[resolution], config,
            enforce_quality=enforce_quality, enforce_cost=enforce_cost,
        ))
    return errors


def validate_control_integrity(base: Mapping[str, Any]) -> list[str]:
    """Reject an incomplete or drifting control without applying candidate gates to it."""
    control, _ = build_preset_experiments()
    return _evidence_errors(
        "base", base, control, enforce_quality=False, enforce_cost=False,
    )


def validate_comparison(base: Mapping[str, Any], candidate: Mapping[str, Any]) -> list[str]:
    """Reject incomplete, drifting or unsafe evidence before any offline selection."""
    control, proposed = build_preset_experiments()
    errors = validate_control_integrity(base)
    errors.extend(_evidence_errors(
        "candidate", candidate, proposed, enforce_quality=True, enforce_cost=True,
    ))
    if errors:
        return errors

    for key in ("input",):
        if base.get(key) != candidate.get(key):
            errors.append(f"candidate: {key} drift")
    for resolution in RELAY_RESOLUTIONS:
        base_resolution = next(run for run in base["runs"] if tuple(run["resolution"]) == resolution)
        candidate_resolution = next(run for run in candidate["runs"] if tuple(run["resolution"]) == resolution)
        base_scenarios = {scenario["scenarioId"]: scenario for scenario in base_resolution["scenarios"]}
        candidate_scenarios = {scenario["scenarioId"]: scenario for scenario in candidate_resolution["scenarios"]}
        for scenario_id, base_scenario in base_scenarios.items():
            for base_frame, candidate_frame in zip(
                base_scenario["frames"], candidate_scenarios[scenario_id]["frames"]
            ):
                if base_frame["inputHash"] != candidate_frame["inputHash"]:
                    errors.append(f"candidate: {scenario_id}: input hash drift")
                if base_frame["pts"] != candidate_frame["pts"]:
                    errors.append(f"candidate: {scenario_id}: PTS drift")
    return errors
