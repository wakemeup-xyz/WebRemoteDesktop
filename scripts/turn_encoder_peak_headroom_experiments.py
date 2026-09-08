"""Frozen, single-candidate offline contract for peak-rate headroom."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from types import MappingProxyType
from typing import Any, Mapping


RELAY_RESOLUTIONS = ((1152, 720), (1728, 1080))
REQUIRED_SCENARIOS = (
    ("static-text", 0, 65, (5,)),
    ("health-static", 0, 1201, ()),
    ("scrolling-text", 0, 300, (5, 200)),
    ("post-scroll-static", 300, 300, (305, 500)),
    ("safety-net", 0, 1226, ()),
)
_AVERAGE = MappingProxyType({"1152x720": 3_200_000, "1728x1080": 5_000_000})
_MAXRATE = MappingProxyType({"1152x720": 4_800_000, "1728x1080": 7_200_000})
_BUFSIZE = MappingProxyType({"1152x720": 1_000, "1728x1080": 1_300})
PRODUCTION_BGRA_INPUT_CONTRACT = MappingProxyType({
    "id": "production-screen-bgra-v1",
    "pixelFormat": "bgra",
    "referenceFormat": "rgb24",
    "colorConversionCost": "inside-direct-encoder-unless-a-candidate-records-it-separately",
})


def _x264_params(*, maxrate_bps: int, bufsize_kbits: int) -> str:
    return (
        "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
        "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
        "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
        f"vbv-maxrate={maxrate_bps // 1000}:vbv-bufsize={bufsize_kbits}:"
        "vbv-init=1:nal-hrd=none"
    )


@dataclass(frozen=True)
class PeakHeadroomConfig:
    id: str
    preset: str
    codec: str
    profile: str
    fps: int
    bitrate_by_resolution: Mapping[str, int]
    vbv_maxrate_by_resolution: Mapping[str, int]
    vbv_bufsize_kbits_by_resolution: Mapping[str, int]
    vbv_init: float
    force_idr_option: bool
    # Kept only for the shared probe's policy adapter: explicit buffer wins.
    vbv_ms: int
    periodic_idr_frames: int
    input_contract: Mapping[str, str]
    options_digest: str

    def submitted_options(self, resolution: tuple[int, int]) -> dict[str, str]:
        key = f"{resolution[0]}x{resolution[1]}"
        return {
            "preset": self.preset,
            "tune": "zerolatency",
            "forced-idr": "1",
            "x264-params": _x264_params(
                maxrate_bps=int(self.vbv_maxrate_by_resolution[key]),
                bufsize_kbits=int(self.vbv_bufsize_kbits_by_resolution[key]),
            ),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "preset": self.preset,
            "codec": self.codec,
            "profile": self.profile,
            "fps": self.fps,
            "bitrateByResolution": dict(self.bitrate_by_resolution),
            "vbvMaxrateByResolution": dict(self.vbv_maxrate_by_resolution),
            "vbvBufsizeKbitsByResolution": dict(self.vbv_bufsize_kbits_by_resolution),
            "vbvInit": self.vbv_init,
            "forcedIdr": 1,
            "periodicIdrFrames": self.periodic_idr_frames,
            "inputContract": dict(self.input_contract),
            "optionsDigest": self.options_digest,
            "encoderParameterDigest": self.options_digest,
        }


def build_peak_headroom_candidate() -> PeakHeadroomConfig:
    canonical = {
        "id": "on-demand-peak-headroom-v1", "codec": "libx264", "preset": "superfast",
        "profile": "Baseline", "fps": 20, "averageBitrateBps": dict(_AVERAGE),
        "vbvMaxrateBps": dict(_MAXRATE), "vbvBufsizeKbits": dict(_BUFSIZE),
        "vbvInit": 1, "periodicIdrFrames": 0,
        "inputContract": dict(PRODUCTION_BGRA_INPUT_CONTRACT),
        "submittedOptionsByResolution": {
            key: {"preset": "superfast", "tune": "zerolatency", "forced-idr": "1", "x264-params": _x264_params(maxrate_bps=_MAXRATE[key], bufsize_kbits=_BUFSIZE[key])}
            for key in sorted(_AVERAGE)
        },
    }
    return PeakHeadroomConfig(
        id="on-demand-peak-headroom-v1", preset="superfast", codec="libx264", profile="Baseline", fps=20,
        bitrate_by_resolution=_AVERAGE, vbv_maxrate_by_resolution=_MAXRATE,
        vbv_bufsize_kbits_by_resolution=_BUFSIZE, vbv_init=1.0, force_idr_option=True, vbv_ms=1, periodic_idr_frames=0,
        input_contract=PRODUCTION_BGRA_INPUT_CONTRACT,
        options_digest=sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
    )


def submitted_options(config: PeakHeadroomConfig, resolution: tuple[int, int]) -> dict[str, str]:
    return config.submitted_options(resolution)


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _p95(frames: list[Mapping[str, Any]]) -> float:
    return sorted(float(frame["encodeMs"]) for frame in frames)[math.ceil(len(frames) * 0.95) - 1]


def _record_errors(scenario: Mapping[str, Any], config: PeakHeadroomConfig, resolution: tuple[int, int]) -> list[str]:
    records = scenario.get("codecCreationRecords")
    scenario_id = str(scenario.get("scenarioId", ""))
    if not isinstance(records, list) or len(records) != 1:
        return [f"{scenario_id}: unexpected codec reopen"]
    record = records[0]
    expected = submitted_options(config, resolution)
    errors: list[str] = []
    if not isinstance(record, Mapping):
        return [f"{scenario_id}: invalid codec creation record"]
    checks = (
        (record.get("creationIndex") == 1 and record.get("reopenReason") == "initial", "unexpected codec reopen"),
        (record.get("requestedPreset") == config.preset, "requested preset drift"),
        (dict(record.get("submittedCodecOptions", {})) == expected, "submitted codec options drift"),
        (record.get("configuredBitrateBps") == config.bitrate_by_resolution[f"{resolution[0]}x{resolution[1]}"], "average bitrate drift"),
        (record.get("configuredAverageBitrateBps") == config.bitrate_by_resolution[f"{resolution[0]}x{resolution[1]}"], "recorded average bitrate drift"),
        (str(record.get("submittedVbvMaxrateKbps")) == str(config.vbv_maxrate_by_resolution[f"{resolution[0]}x{resolution[1]}"] // 1000), "recorded maxrate drift"),
        (str(record.get("submittedVbvBufsizeKbits")) == str(config.vbv_bufsize_kbits_by_resolution[f"{resolution[0]}x{resolution[1]}"]), "recorded bufsize drift"),
        (str(record.get("submittedVbvInit")) == "1", "recorded vbv init drift"),
        (record.get("configuredRcMaxRateBps") is None, "conflicting context maxrate submission"),
        (record.get("configuredRcBufferSizeBits") is None, "conflicting context bufsize submission"),
    )
    errors.extend(f"{scenario_id}: {message}" for passed, message in checks if not passed)
    if dict(scenario.get("configuredOptions", {})) != expected:
        errors.append(f"{scenario_id}: configured options drift")
    return errors


def _scenario_errors(scenario: Mapping[str, Any], *, expected: tuple[str, int, int, tuple[int, ...]], config: PeakHeadroomConfig, resolution: tuple[int, int], require_initial_quality: bool) -> list[str]:
    scenario_id, start, count, requests = expected
    if scenario.get("scenarioId") != scenario_id:
        return [f"missing scenario {scenario_id}"]
    frames = scenario.get("frames")
    if not isinstance(frames, list) or len(frames) != count:
        return [f"{scenario_id}: incomplete frame sequence"]
    errors: list[str] = []
    for offset, frame in enumerate(frames):
        index = start + offset
        if not isinstance(frame, Mapping) or frame.get("index") != index or frame.get("phaseIndex") != offset:
            errors.append(f"{scenario_id}: frame sequence drift"); break
        if not isinstance(frame.get("inputHash"), str) or not frame["inputHash"] or frame.get("pts") != index * 4500 or frame.get("timeBase") != "1/90000":
            errors.append(f"{scenario_id}: input or PTS drift"); break
        if any(not _finite(frame.get(key)) for key in ("bytes", "psnr", "changeMAE", "encodeMs", "decodeMs")):
            errors.append(f"{scenario_id}: non-finite frame result"); break
    expected_idrs = {} if scenario_id == "post-scroll-static" else {start: "initial"}
    expected_idrs.update({index: "on-demand" for index in requests})
    if scenario_id == "safety-net":
        expected_idrs[1201] = "encoder-safety-net"
    idrs = {frame.get("index"): frame for frame in frames if isinstance(frame, Mapping) and frame.get("idr")}
    if {index: frame.get("bitstreamIdrKind") for index, frame in idrs.items()} != expected_idrs:
        errors.append(f"{scenario_id}: missing or unexpected actual bitstream IDR")
    for index, kind in expected_idrs.items():
        frame = idrs.get(index)
        if frame is None:
            continue
        if frame.get("idrKind") != kind or frame.get("idrBytes") != frame.get("bytes") or not isinstance(frame.get("bytes"), int) or frame["bytes"] <= 0:
            errors.append(f"{scenario_id}: IDR evidence drift")
        if kind == "on-demand":
            if float(frame.get("psnr", 0)) < 28.0:
                errors.append(f"{scenario_id}: quality failure")
        elif kind == "encoder-safety-net" or (require_initial_quality and kind == "initial"):
            if float(frame.get("psnr", 0)) < 28.0 or float(frame.get("changeMAE", math.inf)) > 3.0:
                errors.append(f"{scenario_id}: quality failure")
    if scenario.get("requestTokens") != [f"{scenario_id}:{index}" for index in requests]:
        errors.append(f"{scenario_id}: request token drift")
    actual_p95 = _p95(frames)
    cost = scenario.get("cost")
    budget = 25.0 if resolution == (1152, 720) else 45.0
    if not isinstance(cost, Mapping) or cost.get("encodeMsP95") != round(actual_p95, 3) or actual_p95 > budget:
        errors.append(f"{scenario_id}: scenario cost failure")
    burst = scenario.get("burst")
    if not isinstance(burst, Mapping) or burst.get("idrBytes") != [frame.get("bytes") for frame in idrs.values()]:
        errors.append(f"{scenario_id}: IDR byte evidence drift")
    errors.extend(_record_errors(scenario, config, resolution))
    return errors


def _validate(evidence: Mapping[str, Any], *, prescreen: bool) -> list[str]:
    config = build_peak_headroom_candidate()
    if not isinstance(evidence, Mapping) or evidence.get("config") != config.to_dict():
        return ["immutable config drift"]
    input_data = evidence.get("input")
    if not isinstance(input_data, Mapping) or input_data.get("contract") != dict(config.input_contract):
        return ["input contract drift"]
    runs = evidence.get("runs")
    if not isinstance(runs, list) or {tuple(run.get("resolution", ())) for run in runs if isinstance(run, Mapping)} != set(RELAY_RESOLUTIONS):
        return ["incomplete dual-resolution runs"]
    expected_specs = (("safety-net", 0, 1226, ()),) if prescreen else REQUIRED_SCENARIOS
    errors: list[str] = []
    for resolution in RELAY_RESOLUTIONS:
        run = next(run for run in runs if tuple(run.get("resolution", ())) == resolution)
        scenarios = run.get("scenarios")
        if not isinstance(scenarios, list) or len(scenarios) != len(expected_specs):
            errors.append(f"{resolution[0]}x{resolution[1]}: missing scenario"); continue
        by_id = {scenario.get("scenarioId"): scenario for scenario in scenarios if isinstance(scenario, Mapping)}
        for expected in expected_specs:
            scenario = by_id.get(expected[0])
            if scenario is None:
                errors.append(f"{resolution[0]}x{resolution[1]}: missing scenario {expected[0]}")
            else:
                errors.extend(f"{resolution[0]}x{resolution[1]}: {error}" for error in _scenario_errors(scenario, expected=expected, config=config, resolution=resolution, require_initial_quality=prescreen))
    return errors


def validate_prescreen(evidence: Mapping[str, Any]) -> list[str]:
    return _validate(evidence, prescreen=True)


def validate_full_matrix(evidence: Mapping[str, Any]) -> list[str]:
    return _validate(evidence, prescreen=False)
