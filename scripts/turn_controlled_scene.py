"""Proof-bound controlled-scene evidence for the isolated TURN laboratory.

This module intentionally contains no browser automation and no input
injection.  It validates the evidence an already-authorized Viewer/Host run
has produced.  A marker can establish what was visible in a decoded frame; it
cannot manufacture a Host acknowledgement or an RTP frame join.
"""

from __future__ import annotations

import binascii
import statistics
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any, Iterable


PASS = "PASS"
FAIL = "FAIL"
NOT_RUN = "NOT_RUN"
BLOCKED = "BLOCKED"
UNALIGNED = "UNALIGNED"

AUTOMATIC_ISOLATED = "automatic-isolated"
OPERATOR_REMOTE = "operator-remote"
PRODUCER_LOCAL = "producer-local"
REMOTE_EXECUTION_MODES = frozenset((AUTOMATIC_ISOLATED, OPERATOR_REMOTE))

GRID_WIDTH = 32
GRID_HEIGHT = 16
DEFAULT_CELL_PIXELS = 8
BLACK = 32
WHITE = 224
PAYLOAD_BITS = 192
_INTERIOR_WIDTH = 30
_INTERIOR_HEIGHT = 14
_CALIBRATION_BITS = 36


@dataclass(frozen=True)
class ProducerProof:
    run_nonce: int
    scene_id: int
    origin: str
    attempt_id: str
    generation: int

    def valid(self) -> bool:
        return (0 <= int(self.run_nonce) < 2**64 and 0 <= int(self.scene_id) < 2**16
                and bool(self.origin) and bool(self.attempt_id) and int(self.generation) >= 0)


@dataclass(frozen=True)
class MarkerPayload:
    run_nonce: int
    scene_id: int
    tick: int
    action_id: int


@dataclass(frozen=True)
class MarkerDecode:
    status: str
    payload: MarkerPayload | None = None
    failure: str | None = None


@dataclass
class SceneResult:
    status: str
    execution_mode: str
    input_ids: list[str] = field(default_factory=list)
    ack_samples: list[dict[str, Any]] = field(default_factory=list)
    visual_samples: list[dict[str, Any]] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    latencies: dict[str, list[float]] = field(default_factory=lambda: {"sendToAckMs": [], "sendToVisualMs": []})

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "executionMode": self.execution_mode,
            "inputIds": list(self.input_ids),
            "ackSamples": list(self.ack_samples),
            "visualSamples": list(self.visual_samples),
            "failures": list(self.failures),
            "latencies": self.latencies,
        }


def _bits(raw: bytes) -> list[int]:
    return [(byte >> shift) & 1 for byte in raw for shift in range(7, -1, -1)]


def _from_bits(bits: Iterable[int]) -> bytes:
    values = list(bits)
    if len(values) % 8:
        raise ValueError("bit length must be byte aligned")
    return bytes(sum((int(values[offset + bit]) & 1) << (7 - bit) for bit in range(8))
                 for offset in range(0, len(values), 8))


def _payload_bits(proof: ProducerProof, tick: int, action_id: int) -> list[int]:
    body = (bytes((1, 0)) + int(proof.run_nonce).to_bytes(8, "big")
            + int(proof.scene_id).to_bytes(2, "big") + int(tick).to_bytes(4, "big")
            + int(action_id).to_bytes(4, "big"))
    return _bits(body + (binascii.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big"))


def _parse_payload(bits: list[int]) -> MarkerDecode:
    if len(bits) != PAYLOAD_BITS:
        return MarkerDecode(FAIL, failure="payload-size")
    raw = _from_bits(bits)
    body, supplied = raw[:20], int.from_bytes(raw[20:], "big")
    if binascii.crc32(body) & 0xFFFFFFFF != supplied:
        return MarkerDecode(FAIL, failure="crc")
    if body[0] != 1 or body[1] != 0:
        return MarkerDecode(FAIL, failure="version")
    return MarkerDecode(PASS, MarkerPayload(
        run_nonce=int.from_bytes(body[2:10], "big"), scene_id=int.from_bytes(body[10:12], "big"),
        tick=int.from_bytes(body[12:16], "big"), action_id=int.from_bytes(body[16:20], "big"),
    ))


def _grid_for(proof: ProducerProof, tick: int, action_id: int) -> list[list[int]]:
    if not proof.valid():
        raise ValueError("invalid producer proof")
    grid = [[0 for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]
    # orientation / calibration border: TL/TR/BL/BR = 0/1/1/1.
    grid[0][0], grid[0][-1], grid[-1][0], grid[-1][-1] = 0, 1, 1, 1
    for x in range(1, GRID_WIDTH - 1):
        grid[0][x] = (x - 1) % 2
        grid[-1][x] = 0
    for y in range(1, GRID_HEIGHT - 1):
        grid[y][0] = grid[y][-1] = 1
    interior = _payload_bits(proof, tick, action_id) * 2 + [index % 2 for index in range(_CALIBRATION_BITS)]
    assert len(interior) == _INTERIOR_WIDTH * _INTERIOR_HEIGHT
    for index, value in enumerate(interior):
        y, x = divmod(index, _INTERIOR_WIDTH)
        grid[y + 1][x + 1] = value
    return grid


def encode_marker(proof: ProducerProof, *, tick: int, action_id: int, cell_pixels: int = DEFAULT_CELL_PIXELS) -> bytearray:
    """Render the exact marker pixels (one 8-bit grayscale byte per pixel)."""
    if int(cell_pixels) < 4:
        raise ValueError("cell_pixels must leave a 4x4 centre")
    width, height = GRID_WIDTH * int(cell_pixels), GRID_HEIGHT * int(cell_pixels)
    output = bytearray(width * height)
    for y, row in enumerate(_grid_for(proof, tick, action_id)):
        for x, bit in enumerate(row):
            value = WHITE if bit else BLACK
            for pixel_y in range(y * cell_pixels, (y + 1) * cell_pixels):
                start = pixel_y * width + x * cell_pixels
                output[start:start + cell_pixels] = bytes((value,)) * cell_pixels
    return output


def _sample_cells(frame: bytes | bytearray, roi: tuple[int, int, int, int]) -> tuple[list[list[int]], str | None]:
    # The isolated decoder receives a cropped single-plane ROI.  x/y are kept
    # in the contract to make a caller declare its pre-authorized ROI.
    _x, _y, width, height = roi
    if width <= 0 or height <= 0 or width % GRID_WIDTH or height % GRID_HEIGHT:
        return [], "roi-size"
    cell_w, cell_h = width // GRID_WIDTH, height // GRID_HEIGHT
    if cell_w != cell_h or cell_w < 4 or len(frame) != width * height:
        return [], "scale"
    values = []
    for gy in range(GRID_HEIGHT):
        row = []
        for gx in range(GRID_WIDTH):
            centre = []
            start_x = gx * cell_w + (cell_w - 4) // 2
            start_y = gy * cell_h + (cell_h - 4) // 2
            for py in range(start_y, start_y + 4):
                centre.extend(frame[py * width + start_x:py * width + start_x + 4])
            median = statistics.median(centre)
            if median <= 96:
                row.append(0)
            elif median >= 160:
                row.append(1)
            else:
                return [], "grey-zone"
        values.append(row)
    return values, None


def decode_marker(frame: bytes | bytearray, *, roi: tuple[int, int, int, int]) -> MarkerDecode:
    grid, error = _sample_cells(frame, roi)
    if error:
        return MarkerDecode(FAIL, failure=error)
    if (grid[0][0], grid[0][-1], grid[-1][0], grid[-1][-1]) != (0, 1, 1, 1):
        return MarkerDecode(FAIL, failure="border-corners")
    if any(grid[0][x] != (x - 1) % 2 or grid[-1][x] != 0 for x in range(1, GRID_WIDTH - 1)):
        return MarkerDecode(FAIL, failure="border-horizontal")
    if any(grid[y][0] != 1 or grid[y][-1] != 1 for y in range(1, GRID_HEIGHT - 1)):
        return MarkerDecode(FAIL, failure="border-vertical")
    interior = [grid[y][x] for y in range(1, GRID_HEIGHT - 1) for x in range(1, GRID_WIDTH - 1)]
    first, second, calibration = interior[:PAYLOAD_BITS], interior[PAYLOAD_BITS:PAYLOAD_BITS * 2], interior[PAYLOAD_BITS * 2:]
    if calibration != [index % 2 for index in range(_CALIBRATION_BITS)]:
        return MarkerDecode(FAIL, failure="calibration")
    if first != second:
        return MarkerDecode(UNALIGNED, failure="copies-disagree")
    return _parse_payload(first)


def decode_marker_pair(first: bytes | bytearray, second: bytes | bytearray, *, roi: tuple[int, int, int, int]) -> MarkerDecode:
    """Check each frame alone; deliberately never composes replicas across frames."""
    first_result, second_result = decode_marker(first, roi=roi), decode_marker(second, roi=roi)
    if first_result.status != PASS or second_result.status != PASS:
        return MarkerDecode(UNALIGNED, failure="frame-not-independently-decodable")
    if first_result.payload != second_result.payload:
        return MarkerDecode(UNALIGNED, failure="cross-frame-payload-difference")
    return first_result


def flip_payload_bit(frame: bytearray, *, copy_index: int, bit_index: int, cell_pixels: int = DEFAULT_CELL_PIXELS) -> None:
    """Test-vector utility: corrupt one payload cell without touching the other."""
    if copy_index not in (0, 1) or not 0 <= bit_index < PAYLOAD_BITS:
        raise ValueError("invalid payload position")
    index = copy_index * PAYLOAD_BITS + bit_index
    gy, gx = divmod(index, _INTERIOR_WIDTH)
    width = GRID_WIDTH * cell_pixels
    x, y = (gx + 1) * cell_pixels, (gy + 1) * cell_pixels
    value = WHITE if frame[y * width + x] == BLACK else BLACK
    for py in range(y, y + cell_pixels):
        frame[py * width + x:py * width + x + cell_pixels] = bytes((value,)) * cell_pixels


class ControlledProducer:
    """In-memory model shared by the HTML page's frozen-scene contract."""

    def __init__(self, proof: ProducerProof) -> None:
        self.proof = proof
        self.tick = 0
        self.action_id = 0

    def apply_action(self, _action: str, *, action_id: int) -> None:
        self.tick += 1
        self.action_id = int(action_id)

    def render_marker(self) -> bytearray:
        return encode_marker(self.proof, tick=self.tick, action_id=self.action_id)


def _same_identity(sample: dict[str, Any], proof: ProducerProof) -> bool:
    return sample.get("attemptId") == proof.attempt_id and int(sample.get("generation", -1)) == int(proof.generation)


def evaluate_scene_result(
    proof: ProducerProof, *, execution_mode: str, input_ids: list[str], ack_samples: list[dict[str, Any]],
    producer_samples: list[dict[str, Any]], visual_samples: list[dict[str, Any]],
) -> SceneResult:
    result = SceneResult(NOT_RUN, execution_mode, list(input_ids), list(ack_samples), list(visual_samples))
    if execution_mode not in REMOTE_EXECUTION_MODES | {PRODUCER_LOCAL}:
        result.status, result.failures = FAIL, ["unknown-execution-mode"]
        return result
    if execution_mode == PRODUCER_LOCAL:
        result.failures.append("producer-local-is-not-remote-input")
        return result
    if not proof.valid():
        result.status, result.failures = BLOCKED, ["invalid-producer-proof"]
        return result
    required = set(input_ids)
    if not required:
        result.status, result.failures = NOT_RUN, ["no-remote-input-samples"]
        return result
    acks = {row.get("inputId"): row for row in ack_samples if row.get("status") == "applied"}
    producers = {row.get("inputId"): row for row in producer_samples}
    visuals = {row.get("actionId"): row for row in visual_samples}
    failures: set[str] = set()
    for input_id in required:
        ack, producer = acks.get(input_id), producers.get(input_id)
        if ack is None:
            failures.add("missing-applied-ack"); continue
        if not _same_identity(ack, proof):
            failures.add("attempt-generation-mismatch")
        if producer is None:
            failures.add("missing-producer-event"); continue
        if not producer.get("focused"):
            failures.add("producer-focus")
        if int(producer.get("runNonce", -1)) != int(proof.run_nonce):
            failures.add("nonce-mismatch")
        if not _same_identity(producer, proof):
            failures.add("attempt-generation-mismatch")
        visual = visuals.get(producer.get("actionId"))
        if visual is None:
            failures.add("missing-decoded-marker"); continue
        if int(visual.get("runNonce", -1)) != int(proof.run_nonce) or visual.get("sceneId") != proof.scene_id:
            failures.add("nonce-mismatch")
        if not _same_identity(visual, proof):
            failures.add("attempt-generation-mismatch")
        rtp_join = (visual.get("rtpAligned") is True
                    and isinstance(visual.get("rtpTimestamp"), int)
                    and isinstance(visual.get("wireTimestamp"), int)
                    and isinstance(visual.get("captureSeq"), int)
                    and visual["rtpTimestamp"] == visual["wireTimestamp"])
        if not rtp_join:
            failures.add("wire-rtp-unaligned")
        if isinstance(ack.get("atMs"), (int, float)):
            result.latencies["sendToAckMs"].append(float(ack["atMs"]))
        if isinstance(visual.get("atMs"), (int, float)):
            result.latencies["sendToVisualMs"].append(float(visual["atMs"]))
    result.failures = sorted(failures)
    alignment_only = failures == {"wire-rtp-unaligned"}
    result.status = PASS if not failures else (UNALIGNED if alignment_only else FAIL)
    return result


def run_controlled_scenes(
    viewer: Any, producer: Any, proof: ProducerProof, *, execution_mode: str = AUTOMATIC_ISOLATED,
    operator_endpoint: str | None = "pre-authorized-loopback-forward",
) -> SceneResult:
    """Refuse before dispatch.  Execution is intentionally supplied by Lab code."""
    if execution_mode == OPERATOR_REMOTE and not operator_endpoint:
        return SceneResult(BLOCKED, execution_mode, failures=["independent-operator-endpoint-required"])
    if execution_mode == PRODUCER_LOCAL:
        return SceneResult(NOT_RUN, execution_mode, failures=["producer-local-is-not-remote-input"])
    if not proof.valid():
        return SceneResult(BLOCKED, execution_mode, failures=["invalid-producer-proof"])
    # The actual runner will be added only behind LabInputGuard.  Never infer
    # that a generic Viewer object is safe to drive merely because it has a
    # send_input method.
    return SceneResult(BLOCKED, execution_mode, failures=["lab-input-guard-required"])


def h264_marker_roundtrip(proof: ProducerProof, *, resolutions: list[tuple[int, int]]) -> dict[str, Any]:
    """Use the installed PyAV/libx264 path, never a synthetic compression stand-in."""
    try:
        import av  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        return {"status": BLOCKED, "reason": f"h264-dependency-unavailable:{error.name or 'unknown'}"}
    try:
        av.CodecContext.create("libx264", "w")
    except Exception as error:
        return {"status": BLOCKED, "reason": f"libx264-unavailable:{type(error).__name__}"}
    decoded_resolutions: list[list[int]] = []
    try:
        marker = encode_marker(proof, tick=4, action_id=13)
        marker_array = np.frombuffer(marker, dtype=np.uint8).reshape((128, 256))
        for width, height in resolutions:
            if width < 256 or height < 128:
                return {"status": FAIL, "reason": "resolution-smaller-than-marker"}
            raw = np.full((height, width), BLACK, dtype=np.uint8)
            raw[:128, :256] = marker_array
            encoder = av.CodecContext.create("libx264", "w")
            encoder.width, encoder.height, encoder.pix_fmt = int(width), int(height), "yuv420p"
            encoder.time_base = Fraction(1, 20)
            encoder.options = {"preset": "ultrafast", "tune": "zerolatency", "crf": "18", "g": "20"}
            encoder.open()
            source = av.VideoFrame.from_ndarray(raw, format="gray")
            source.pts, source.time_base = 0, Fraction(1, 20)
            packets = encoder.encode(source) + encoder.encode(None)
            decoder = av.CodecContext.create("h264", "r")
            frames = []
            for packet in packets:
                frames.extend(decoder.decode(packet))
            frames.extend(decoder.decode(None))
            if not frames:
                return {"status": FAIL, "reason": f"h264-decode-empty:{width}x{height}"}
            pixels = frames[0].to_ndarray(format="gray")
            decoded = decode_marker(np.ascontiguousarray(pixels[:128, :256]).tobytes(), roi=(0, 0, 256, 128))
            if decoded.status != PASS or decoded.payload is None or decoded.payload.run_nonce != proof.run_nonce:
                return {"status": FAIL, "reason": f"h264-marker-decode:{width}x{height}:{decoded.failure}"}
            decoded_resolutions.append([int(width), int(height)])
    except Exception as error:
        return {"status": FAIL, "reason": f"h264-roundtrip-error:{type(error).__name__}:{error}"}
    return {"status": PASS, "decodedResolutions": decoded_resolutions}
