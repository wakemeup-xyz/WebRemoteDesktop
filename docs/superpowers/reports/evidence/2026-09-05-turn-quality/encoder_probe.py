"""Deterministic, offline evidence probe for the current relay encoder policy.

The probe never captures a desktop, opens a network connection, or starts Host.
It exercises the repository's current H.264 encoder with a static synthetic text
frame so a forced-IDR quality pulse is observable in isolated evidence.
"""

from __future__ import annotations

import logging
import math
import os
import platform
import random
import statistics
import sys
import time
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Any

import aiortc
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont


REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
PYTHON_HOST = REPOSITORY_ROOT / "python-host"
if str(PYTHON_HOST) not in sys.path:
    sys.path.insert(0, str(PYTHON_HOST))

from h264_videotoolbox_encoder import (  # noqa: E402
    CodecCreationRecord,
    H264VideoToolboxEncoder,
    bitstream_contains_idr,
    periodic_idr_due,
)
from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy  # noqa: E402


RANDOM_SEED = 20260905
FRAME_COUNT = 65
FRAME_RATE = 20
LEGACY_GOP_FRAMES = 20
RESOLUTIONS = ((1152, 720), (1728, 1080))
TEXT = "const desktopFrame = captureLatest(); // TURN video 0123456789 abcdefghijklmnopqrstuvwxyz"
MENLO_FONT = Path("/System/Library/Fonts/Menlo.ttc")


def load_probe_font() -> tuple[ImageFont.ImageFont, dict[str, Any]]:
    """Use Menlo when present and report the deterministic Pillow fallback."""
    try:
        return ImageFont.truetype(str(MENLO_FONT), 15), {
            "requested": str(MENLO_FONT),
            "resolved": "Menlo 15",
            "fallback": False,
        }
    except OSError:
        return ImageFont.load_default(), {
            "requested": str(MENLO_FONT),
            "resolved": "Pillow default",
            "fallback": True,
        }


def make_static_text_frame(width: int, height: int, font: ImageFont.ImageFont) -> np.ndarray:
    """Build the fixed desktop-like input used for every encoded frame."""
    image = Image.new("RGB", (width, height), (246, 246, 246))
    draw = ImageDraw.Draw(image)
    for row, y in enumerate(range(10, height - 20, 22)):
        draw.text((12, y), f"{row:03}  {TEXT}", font=font, fill=(25, 40, 60))
    return np.array(image)


def serialize_codec_creation_record(record: CodecCreationRecord) -> dict[str, Any]:
    """Expose the immutable call-site record using the evidence schema names."""
    return {
        "scenarioId": record.scenario_id,
        "resolution": list(record.resolution),
        "creationIndex": record.creation_index,
        "requestedPreset": record.requested_preset,
        "submittedCodecOptions": dict(record.submitted_codec_options),
        "generation": record.generation,
        "reopenReason": record.reopen_reason,
    }


def encoder_settings_from_creation_records(
    records: tuple[CodecCreationRecord, ...],
    *,
    policy,
    scenario_id: str,
    resolution: tuple[int, int],
    bitrate_bps: int,
) -> dict[str, Any]:
    """Validate and report actual codec submissions without regenerating options."""
    if not records:
        raise RuntimeError("missing codec creation record")

    expected_resolution = tuple(map(int, resolution))
    for expected_index, record in enumerate(records, start=1):
        if record.scenario_id != scenario_id:
            raise RuntimeError("codec creation scenario mismatch")
        if record.resolution != expected_resolution:
            raise RuntimeError("codec creation resolution mismatch")
        if record.creation_index != expected_index:
            raise RuntimeError("codec creation index mismatch")
        if record.requested_preset != policy.preset:
            raise RuntimeError("codec creation requested preset mismatch")
        if record.generation != policy.generation:
            raise RuntimeError("codec creation generation mismatch")
        if record.reopen_reason != "initial":
            raise RuntimeError(f"unexpected codec reopen: {record.reopen_reason}")
        submitted = dict(record.submitted_codec_options)
        if submitted.get("preset") != policy.preset:
            raise RuntimeError("codec creation submitted preset mismatch")

    submitted_options = dict(records[-1].submitted_codec_options)
    x264_params = submitted_options.get("x264-params")
    if not isinstance(x264_params, str):
        raise RuntimeError("codec creation record is missing submitted x264 options")
    vbv_marker = "vbv-bufsize="
    vbv_value = x264_params.partition(vbv_marker)[2].partition(":")[0]
    if not vbv_value.isdigit():
        raise RuntimeError("codec creation record has invalid submitted vbv buffer")
    vbv_kbits = int(vbv_value)
    return {
        "codec": policy.codec_name,
        "preset": submitted_options["preset"],
        "tune": submitted_options["tune"],
        "profile": policy.profile,
        "targetFps": policy.target_fps,
        "bitrateBps": bitrate_bps,
        "gopFrames": policy.periodic_idr_frames,
        "vbvKbits": vbv_kbits,
        "vbvMs": round(vbv_kbits * 1000 / max(1, bitrate_bps // 1000), 3),
        "x264Params": x264_params,
    }


def percentile_95(values: list[float]) -> float:
    return sorted(values)[math.ceil(len(values) * 0.95) - 1]


def frame_byte_summary(frames: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe local encoded-frame burst size without inferring Viewer buffering."""
    def summarize(values: list[int]) -> dict[str, float | int]:
        return {
            "count": len(values),
            "avg": round(sum(values) / len(values), 3) if values else 0.0,
            "max": max(values) if values else 0,
        }

    idr = [int(frame["bytes"]) for frame in frames if frame["idr"]]
    p = [int(frame["bytes"]) for frame in frames if not frame["idr"]]
    idr_summary = summarize(idr)
    p_summary = summarize(p)
    p_average = float(p_summary["avg"])
    return {
        "p": p_summary,
        "idr": idr_summary,
        "idrToPAvgBurstRatio": (
            round(float(idr_summary["avg"]) / p_average, 3) if p_average else None
        ),
        "note": "Encoded bytes are not a Viewer playback-buffer measurement.",
    }


def evaluate_resolution(
    width: int,
    height: int,
    font: ImageFont.ImageFont,
    *,
    policy_id: str = "relay-legacy-v1",
    periodic_idr_frames: int | None = None,
    vbv_buffer_ms: int | None = None,
    target_bitrate_bps: int | None = None,
    frame_count: int = FRAME_COUNT,
    on_demand_idr_frame: int | None = None,
    preset: str = "ultrafast",
    scenario: str | None = None,
) -> dict[str, Any]:
    """Encode deterministic candidate parameters without any desktop or network path."""
    source = make_static_text_frame(width, height, font)
    policy = resolve_h264_policy(
        MediaSessionIntent("offline-probe", 1, "relay", width, height, FRAME_RATE, 0),
        policy_id,
    )
    policy = replace(
        policy,
        periodic_idr_frames=(
            policy.periodic_idr_frames
            if periodic_idr_frames is None
            else int(periodic_idr_frames)
        ),
        vbv_buffer_ms=(policy.vbv_buffer_ms if vbv_buffer_ms is None else int(vbv_buffer_ms)),
        target_bitrate_bps=(
            policy.target_bitrate_bps
            if target_bitrate_bps is None
            else int(target_bitrate_bps)
        ),
        preset=str(preset),
    )
    encoder = H264VideoToolboxEncoder(policy=policy, scenario_id=scenario)
    decoder = av.CodecContext.create("h264", "r")
    previous: np.ndarray | None = None
    frames: list[dict[str, Any]] = []

    for index in range(int(frame_count)):
        frame = av.VideoFrame.from_ndarray(source, format="rgb24")
        frame.pts = index * (90_000 // FRAME_RATE)
        frame.time_base = Fraction(1, 90_000)
        started = time.perf_counter()
        forced_by_probe = on_demand_idr_frame is not None and index == on_demand_idr_frame
        nals = list(encoder._encode_frame(frame, forced_by_probe))
        encode_ms = (time.perf_counter() - started) * 1000
        bitstream = b"".join(b"\x00\x00\x00\x01" + nal for nal in nals)
        decoded = decoder.decode(av.Packet(bitstream))
        if not decoded:
            raise RuntimeError(f"decoder produced no frame at index {index}")
        output = decoded[-1].to_ndarray(format="rgb24").astype(float)
        mse = float(np.mean((output - source.astype(float)) ** 2))
        change_mae = 0.0 if previous is None else float(np.mean(np.abs(output - previous)))
        frames.append(
            {
                "index": index,
                "bytes": len(bitstream),
                "idr": bitstream_contains_idr(bitstream),
                "psnr": round(10 * math.log10(255**2 / max(mse, 1e-9)), 3),
                "changeMAE": round(change_mae, 3),
                "encodeMs": round(encode_ms, 3),
                "idrKind": (
                    "on-demand-probe"
                    if forced_by_probe and bitstream_contains_idr(bitstream)
                    else "initial"
                    if index == 0 and bitstream_contains_idr(bitstream)
                    else "periodic"
                    if bitstream_contains_idr(bitstream)
                    else None
                ),
            }
        )
        previous = output

    warm_frames = frames[5:]
    creation_records = encoder.codec_creation_records
    expected_scenario = policy.connection_attempt_id if scenario is None else str(scenario)
    encoder_settings = encoder_settings_from_creation_records(
        creation_records,
        policy=policy,
        scenario_id=expected_scenario,
        resolution=(width, height),
        bitrate_bps=encoder.target_bitrate,
    )
    return {
        "resolution": [width, height],
        "encoder": encoder_settings,
        "codecCreationRecords": [
            serialize_codec_creation_record(record) for record in creation_records
        ],
        "frames": frames,
        "summary": {
            "encodeMsMedian": round(statistics.median(frame["encodeMs"] for frame in warm_frames), 3),
            "encodeMsP95": round(percentile_95([frame["encodeMs"] for frame in warm_frames]), 3),
            "idrFrames": [frame["index"] for frame in frames if frame["idr"]],
            "idrChangeMAE": [frame["changeMAE"] for frame in frames if frame["idr"]],
            "idrPsnr": [frame["psnr"] for frame in frames if frame["idr"]],
            "onDemandIdrPsnr": [
                frame["psnr"] for frame in frames if frame["idrKind"] == "on-demand-probe"
            ],
            "frameBytes": frame_byte_summary(frames),
        },
    }


def evaluate_legacy_policy() -> dict[str, Any]:
    """Return JSON-safe baseline evidence for relay-legacy-v1 only."""
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    logging.disable(logging.CRITICAL)
    font, font_metadata = load_probe_font()
    return {
        "policy": "relay-legacy-v1",
        "scope": "offline synthetic static text; no desktop capture, Host startup, or network connection",
        "input": {
            "randomSeed": RANDOM_SEED,
            "frameCount": FRAME_COUNT,
            "frameRate": FRAME_RATE,
            "timeBase": "1/90000",
            "content": "fixed synthetic static text",
            "font": font_metadata,
        },
        "versions": {"pyav": av.__version__, "aiortc": aiortc.__version__},
        "machine": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "cpuCount": os.cpu_count(),
        },
        "runs": [evaluate_resolution(width, height, font) for width, height in RESOLUTIONS],
    }
