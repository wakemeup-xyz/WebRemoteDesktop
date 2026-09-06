"""Proof-bound controlled-scene evidence for the isolated TURN laboratory.

This module intentionally contains no browser automation and no input
injection.  It validates the evidence an already-authorized Viewer/Host run
has produced.  A marker can establish what was visible in a decoded frame; it
cannot manufacture a Host acknowledgement or an RTP frame join.
"""

from __future__ import annotations

import binascii
import math
import statistics
from dataclasses import asdict, dataclass, field
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
_DRIVER_RESULT_SEAL = object()

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
    realm: str
    run_id: str

    def valid(self) -> bool:
        try:
            return (isinstance(self.run_nonce, int) and not isinstance(self.run_nonce, bool) and 0 <= self.run_nonce < 2**64
                    and isinstance(self.scene_id, int) and not isinstance(self.scene_id, bool) and 0 <= self.scene_id < 2**16
                    and isinstance(self.origin, str) and bool(self.origin) and isinstance(self.attempt_id, str)
                    and bool(self.attempt_id) and isinstance(self.generation, int) and not isinstance(self.generation, bool)
                    and self.generation >= 0 and isinstance(self.realm, str) and self.realm.startswith("lab-")
                    and isinstance(self.run_id, str) and bool(self.run_id))
        except (TypeError, ValueError):
            return False


def proof_matches_verified_lab_context(proof: ProducerProof, context: Any) -> bool:
    """Keep the producer realm/run scoped to the Signal-issued Lab context."""
    return (proof.valid() and context is not None
            and proof.origin == getattr(context, "origin", None)
            and proof.realm == getattr(context, "realm", None)
            and proof.run_id == getattr(context, "run_id", None))


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


@dataclass(frozen=True)
class FrameBuffer:
    """One declared grayscale decoded frame; stride may exceed visible width."""
    pixels: bytes | bytearray
    width: int
    height: int
    stride: int


@dataclass(frozen=True)
class ProducerActionEvent:
    input_id: str
    action_id: int
    tick: int
    run_nonce: int
    scene_id: int
    attempt_id: str
    generation: int
    stream_id: str = "video"
    focused: bool = True


@dataclass
class SceneResult:
    status: str
    execution_mode: str
    input_ids: list[str] = field(default_factory=list)
    ack_samples: list[dict[str, Any]] = field(default_factory=list)
    producer_samples: list[dict[str, Any]] = field(default_factory=list)
    visual_samples: list[dict[str, Any]] = field(default_factory=list)
    send_samples: list[dict[str, Any]] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    latencies: dict[str, list[float]] = field(default_factory=lambda: {"sendToAckMs": [], "sendToVisualMs": []})
    producer_proof: dict[str, Any] | None = None
    _driver_seal: object | None = field(default=None, repr=False, compare=False)

    @property
    def driver_generated(self) -> bool:
        return self._driver_seal is _DRIVER_RESULT_SEAL

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "executionMode": self.execution_mode,
            "inputIds": list(self.input_ids),
            "ackSamples": list(self.ack_samples),
            "producerSamples": list(self.producer_samples),
            "visualSamples": list(self.visual_samples),
            "sendSamples": list(self.send_samples),
            "failures": list(self.failures),
            "latencies": self.latencies,
            **({"producerProof": dict(self.producer_proof)} if self.producer_proof is not None else {}),
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


def _frame_layout(frame: bytes | bytearray | FrameBuffer, roi: tuple[int, int, int, int]) -> tuple[bytes | bytearray, int, int, int, str | None]:
    if not isinstance(roi, tuple) or len(roi) != 4 or not all(isinstance(value, int) for value in roi):
        return b"", 0, 0, 0, "roi-type"
    x, y, roi_width, roi_height = roi
    if isinstance(frame, FrameBuffer):
        pixels, width, height, stride = frame.pixels, frame.width, frame.height, frame.stride
    else:
        # Backward-compatible cropped ROI input is only valid for origin 0.
        pixels, width, height, stride = frame, roi_width, roi_height, roi_width
        if x != 0 or y != 0:
            return b"", 0, 0, 0, "full-frame-required"
    if not isinstance(pixels, (bytes, bytearray)) or not all(isinstance(value, int) for value in (width, height, stride)):
        return b"", 0, 0, 0, "frame-type"
    if width <= 0 or height <= 0 or stride < width or len(pixels) < stride * height:
        return b"", 0, 0, 0, "frame-geometry"
    if x < 0 or y < 0 or roi_width <= 0 or roi_height <= 0 or x + roi_width > width or y + roi_height > height:
        return b"", 0, 0, 0, "roi-oob"
    return pixels, width, height, stride, None


def _sample_cells(frame: bytes | bytearray | FrameBuffer, roi: tuple[int, int, int, int]) -> tuple[list[list[int]], str | None]:
    pixels, _frame_width, _frame_height, stride, layout_error = _frame_layout(frame, roi)
    if layout_error:
        return [], layout_error
    x, y, width, height = roi
    if width % GRID_WIDTH or height % GRID_HEIGHT:
        return [], "roi-size"
    cell_w, cell_h = width // GRID_WIDTH, height // GRID_HEIGHT
    if cell_w != cell_h or cell_w < 4:
        return [], "scale"
    values = []
    for gy in range(GRID_HEIGHT):
        row = []
        for gx in range(GRID_WIDTH):
            centre = []
            start_x = gx * cell_w + (cell_w - 4) // 2
            start_y = gy * cell_h + (cell_h - 4) // 2
            for py in range(start_y, start_y + 4):
                row_offset = (y + py) * stride + x + start_x
                centre.extend(pixels[row_offset:row_offset + 4])
            median = statistics.median(centre)
            if median <= 96:
                row.append(0)
            elif median >= 160:
                row.append(1)
            else:
                return [], "grey-zone"
        values.append(row)
    return values, None


def decode_marker(frame: bytes | bytearray | FrameBuffer, *, roi: tuple[int, int, int, int]) -> MarkerDecode:
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


def decode_marker_pair(first: bytes | bytearray | FrameBuffer, second: bytes | bytearray | FrameBuffer, *, roi: tuple[int, int, int, int]) -> MarkerDecode:
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

    def __init__(self, proof: ProducerProof, *, clock=lambda: 0) -> None:
        self.proof = proof
        self._clock = clock
        self.tick = 0
        self.action_id = 0
        self._events: dict[str, ProducerActionEvent] = {}

    def apply_action(self, _action: str, *, action_id: int, input_id: str = "producer-local") -> ProducerActionEvent:
        if not isinstance(input_id, str) or not input_id:
            raise ValueError("input_id is required")
        self.tick += 1
        self.action_id = int(action_id)
        event = ProducerActionEvent(input_id, self.action_id, self.tick, self.proof.run_nonce,
                                    self.proof.scene_id, self.proof.attempt_id, self.proof.generation)
        self._events[input_id] = event
        return event

    def render_marker(self) -> bytearray:
        return encode_marker(self.proof, tick=self.tick, action_id=self.action_id)

    def event_for(self, input_id: str) -> dict[str, Any] | None:
        event = self._events.get(input_id)
        if event is None:
            return None
        return {"inputId": event.input_id, "actionId": event.action_id, "tick": event.tick,
                "runNonce": event.run_nonce, "sceneId": event.scene_id, "attemptId": event.attempt_id,
                "generation": event.generation, "streamId": event.stream_id, "focused": event.focused}

    def assert_frozen_for(self, duration_ms: int, *, sample_every_ms: int) -> bytearray:
        if duration_ms < 0 or sample_every_ms <= 0:
            raise ValueError("invalid frozen scene duration")
        baseline = self.render_marker()
        for _elapsed in range(0, duration_ms + 1, sample_every_ms):
            self._clock()
            if self.render_marker() != baseline:
                raise RuntimeError("static marker changed without an action")
        return baseline


def _same_identity(sample: dict[str, Any], proof: ProducerProof, stream_id: str) -> bool:
    return (sample.get("attemptId") == proof.attempt_id
            and sample.get("generation") == proof.generation
            and sample.get("streamId") == stream_id)


def _indexed(rows: Any, field: str, failures: set[str], *, invalid: str, duplicate: str) -> dict[Any, dict[str, Any]]:
    if not isinstance(rows, list):
        failures.add(invalid)
        return {}
    result: dict[Any, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or field not in row:
            failures.add(invalid)
            continue
        key = row[field]
        if not isinstance(key, str) or not key:
            failures.add(invalid)
            continue
        if key in result:
            failures.add(duplicate)
            continue
        result[key] = row
    return result


def _clock_delta(later: Any, earlier: Any) -> float | None:
    if isinstance(later, bool) or isinstance(earlier, bool):
        return None
    if not isinstance(later, (int, float)) or not isinstance(earlier, (int, float)):
        return None
    value = float(later) - float(earlier)
    return value if math.isfinite(value) and value >= 0 else None


def _uint(value: Any, *, minimum: int = 0, maximum: int = 0xFFFFFFFF) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _nonce(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**64:
        return value
    if isinstance(value, str) and value and value.isascii() and value.isdecimal() and str(int(value)) == value:
        parsed = int(value)
        return parsed if parsed < 2**64 else None
    return None


def _finite_clock(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _exact_row(row: Any, required: set[str]) -> bool:
    return isinstance(row, dict) and set(row) == required


_SEND_FIELDS = {"inputId", "viewerClockMs", "attemptId", "generation", "streamId"}
_ACK_FIELDS = {"inputId", "status", "viewerClockMs", "attemptId", "generation", "streamId"}
_PRODUCER_FIELDS = {"inputId", "runNonce", "sceneId", "actionId", "tick", "focused", "attemptId", "generation", "streamId"}
_VISUAL_FIELDS = {"marker", "viewerClockMs", "attemptId", "generation", "streamId", "rtpTimestamp", "wireTimestamp", "captureSeq", "rtpOrigin", "traceStatus"}


def _valid_identity(row: dict[str, Any], proof: ProducerProof, stream_id: str) -> bool:
    return (_same_identity(row, proof, stream_id)
            and isinstance(row.get("attemptId"), str) and bool(row["attemptId"])
            and _uint(row.get("generation"), maximum=2**31 - 1)
            and isinstance(row.get("streamId"), str) and bool(row["streamId"]))


def evaluate_scene_result(
    proof: ProducerProof, *, execution_mode: str, input_ids: list[str], ack_samples: list[dict[str, Any]],
    producer_samples: list[dict[str, Any]], visual_samples: list[dict[str, Any]], send_samples: list[dict[str, Any]] | None = None,
) -> SceneResult:
    safe_ids = list(input_ids) if isinstance(input_ids, list) else []
    result = SceneResult(NOT_RUN, execution_mode, safe_ids, list(ack_samples) if isinstance(ack_samples, list) else [],
                         list(producer_samples) if isinstance(producer_samples, list) else [],
                         list(visual_samples) if isinstance(visual_samples, list) else [],
                         send_samples=list(send_samples) if isinstance(send_samples, list) else [])
    if execution_mode not in REMOTE_EXECUTION_MODES | {PRODUCER_LOCAL}:
        result.status, result.failures = FAIL, ["unknown-execution-mode"]
        return result
    if execution_mode == PRODUCER_LOCAL:
        result.failures.append("producer-local-is-not-remote-input")
        return result
    if not proof.valid():
        result.status, result.failures = BLOCKED, ["invalid-producer-proof"]
        return result
    failures: set[str] = set()
    if not isinstance(input_ids, list) or not all(isinstance(value, str) and value for value in input_ids):
        failures.add("invalid-input-ids")
    seen_ids: set[str] = set()
    for value in safe_ids:
        if isinstance(value, str) and value:
            if value in seen_ids:
                failures.add("duplicate-input-id")
            seen_ids.add(value)
    if len(seen_ids) != len(safe_ids):
        failures.add("duplicate-input-id")
    required = seen_ids
    if not required:
        result.status, result.failures = (FAIL, sorted(failures)) if failures else (NOT_RUN, ["no-remote-input-samples"])
        return result
    sends = _indexed(send_samples, "inputId", failures, invalid="invalid-send-samples", duplicate="conflicting-input-id")
    acks = _indexed(ack_samples, "inputId", failures, invalid="invalid-ack-samples", duplicate="conflicting-input-id")
    producers = _indexed(producer_samples, "inputId", failures, invalid="invalid-producer-samples", duplicate="conflicting-input-id")
    # A marker object is unhashable; retain exactly one row per action ID while
    # treating duplicate or malformed action records as terminal evidence.
    visuals_by_action: dict[Any, dict[str, Any]] = {}
    for visual in visual_samples if isinstance(visual_samples, list) else []:
        marker = visual.get("marker") if isinstance(visual, dict) else None
        action_id = marker.get("actionId") if isinstance(marker, dict) else None
        if not isinstance(action_id, int):
            failures.add("invalid-marker-payload")
            continue
        if action_id in visuals_by_action:
            failures.add("conflicting-action-id")
        else:
            visuals_by_action[action_id] = visual
    stream_id: str | None = None
    for input_id in required:
        send, ack, producer = sends.get(input_id), acks.get(input_id), producers.get(input_id)
        if send is None:
            failures.add("missing-send-sample"); continue
        if not _exact_row(send, _SEND_FIELDS) or not _finite_clock(send.get("viewerClockMs")):
            failures.add("invalid-send-samples"); continue
        if not isinstance(send.get("streamId"), str) or not send["streamId"]:
            failures.add("invalid-stream-id"); continue
        stream_id = stream_id or send["streamId"]
        if stream_id != send["streamId"] or not _valid_identity(send, proof, stream_id):
            failures.add("attempt-generation-mismatch")
        if ack is None:
            failures.add("missing-applied-ack"); continue
        if (not _exact_row(ack, _ACK_FIELDS) or not _finite_clock(ack.get("viewerClockMs"))
                or ack.get("status") != "applied" or not _valid_identity(ack, proof, stream_id)):
            failures.add("invalid-ack-samples")
        if producer is None:
            failures.add("missing-producer-event"); continue
        if not _exact_row(producer, _PRODUCER_FIELDS):
            failures.add("invalid-producer-samples"); continue
        if producer.get("focused") is not True:
            failures.add("producer-focus")
        producer_nonce = _nonce(producer.get("runNonce"))
        if producer_nonce is None:
            failures.add("invalid-producer-nonce")
        elif producer_nonce != proof.run_nonce:
            failures.add("nonce-mismatch")
        if (not _uint(producer.get("sceneId"), maximum=2**16 - 1)
                or not _uint(producer.get("actionId")) or not _uint(producer.get("tick"))):
            failures.add("invalid-producer-action")
        if not _valid_identity(producer, proof, stream_id):
            failures.add("attempt-generation-mismatch")
        visual = visuals_by_action.get(producer.get("actionId"))
        if visual is None:
            failures.add("missing-decoded-marker"); continue
        if not _exact_row(visual, _VISUAL_FIELDS):
            failures.add("invalid-visual-samples"); continue
        marker = visual.get("marker")
        if not isinstance(marker, dict) or set(marker) != {"runNonce", "sceneId", "tick", "actionId"}:
            failures.add("invalid-marker-payload"); continue
        marker_nonce = _nonce(marker.get("runNonce"))
        if (marker_nonce is None
                or not _uint(marker.get("sceneId"), maximum=2**16 - 1)
                or not _uint(marker.get("tick")) or not _uint(marker.get("actionId"))):
            failures.add("invalid-marker-payload"); continue
        if (marker_nonce != proof.run_nonce or marker.get("sceneId") != proof.scene_id
                or marker.get("tick") != producer.get("tick") or marker.get("actionId") != producer.get("actionId")):
            failures.add("nonce-mismatch")
        if not _valid_identity(visual, proof, stream_id):
            failures.add("attempt-generation-mismatch")
        rtp_join = (_uint(visual.get("rtpTimestamp"), minimum=1)
                    and _uint(visual.get("wireTimestamp"), minimum=1)
                    and _uint(visual.get("captureSeq"))
                    and _uint(visual.get("rtpOrigin"), minimum=1)
                    and visual.get("traceStatus") == "matched"
                    and visual["rtpTimestamp"] == visual["wireTimestamp"])
        if not rtp_join:
            failures.add("wire-rtp-unaligned")
        ack_delta = _clock_delta(ack.get("viewerClockMs"), send.get("viewerClockMs"))
        visual_delta = _clock_delta(visual.get("viewerClockMs"), send.get("viewerClockMs")) if _finite_clock(visual.get("viewerClockMs")) else None
        if ack_delta is None or visual_delta is None:
            failures.add("viewer-clock-unavailable")
        else:
            result.latencies["sendToAckMs"].append(ack_delta)
            result.latencies["sendToVisualMs"].append(visual_delta)
    result.failures = sorted(failures)
    alignment_only = failures == {"wire-rtp-unaligned"}
    result.status = PASS if not failures else (UNALIGNED if alignment_only else FAIL)
    return result


def run_controlled_scenes(
    viewer: Any, producer: Any, proof: ProducerProof, *, execution_mode: str = AUTOMATIC_ISOLATED,
    operator_endpoint: str | None = "pre-authorized-loopback-forward", guard: Any | None = None,
    actions: list[dict[str, Any]] | None = None,
) -> SceneResult:
    """Run only the injected Viewer/Host/Producer interfaces, never OS input."""
    if execution_mode == OPERATOR_REMOTE and not operator_endpoint:
        return SceneResult(BLOCKED, execution_mode, failures=["independent-operator-endpoint-required"])
    if execution_mode == PRODUCER_LOCAL:
        return SceneResult(NOT_RUN, execution_mode, failures=["producer-local-is-not-remote-input"])
    if not proof.valid():
        return SceneResult(BLOCKED, execution_mode, failures=["invalid-producer-proof"])
    if execution_mode == AUTOMATIC_ISOLATED:
        from turn_lab_input_guard import LabInputGuard
        if not isinstance(guard, LabInputGuard) or not guard.installed:
            return SceneResult(BLOCKED, execution_mode, failures=["lab-input-guard-required"])
    if not isinstance(actions, list) or not actions:
        return SceneResult(NOT_RUN, execution_mode, failures=["no-declared-actions"])
    sends: list[dict[str, Any]] = []; acks: list[dict[str, Any]] = []; producer_events: list[dict[str, Any]] = []; visuals: list[dict[str, Any]] = []; input_ids: list[str] = []
    try:
        for action in actions:
            if not isinstance(action, dict):
                raise ValueError("invalid-action")
            if execution_mode == AUTOMATIC_ISOLATED:
                declared_input_id = action.get("inputId")
                if not isinstance(declared_input_id, str) or not guard.is_input_bound(declared_input_id):
                    raise ValueError("unbound-lab-input")
            sent = viewer.send_input(action, operator_endpoint=operator_endpoint)
            if not isinstance(sent, dict) or not isinstance(sent.get("inputId"), str) or not sent["inputId"]:
                raise ValueError("invalid-send-result")
            input_id = sent["inputId"]; input_ids.append(input_id); sends.append(sent)
            if execution_mode == AUTOMATIC_ISOLATED and input_id != action["inputId"]:
                raise ValueError("unbound-lab-input")
            # Viewer send is the sole input dispatch.  The automatic guard is
            # already installed around Lab Host's InputAdapter; both remote
            # modes wait for its actual Host acknowledgement afterwards.
            ack = viewer.wait_for_applied_ack(input_id)
            event = producer.event_for(input_id)
            visual = viewer.decoded_visual(input_id)
            if not all(isinstance(value, dict) for value in (ack, event, visual)):
                raise ValueError("incomplete-evidence")
            acks.append(ack); producer_events.append(event); visuals.append(visual)
    except Exception as error:
        return SceneResult(FAIL, execution_mode, input_ids, acks, producer_events, visuals, sends,
                           failures=[f"orchestration-failed:{type(error).__name__}"])
    result = evaluate_scene_result(proof, execution_mode=execution_mode, input_ids=input_ids,
                                   send_samples=sends, ack_samples=acks,
                                   producer_samples=producer_events, visual_samples=visuals)
    result._driver_seal = _DRIVER_RESULT_SEAL
    result.producer_proof = asdict(proof)
    return result


class ControlledSceneDriver:
    """Registered read/dispatch adapter for a lab-only controlled sequence.

    It owns no Quartz or browser automation.  Its Viewer dependency uses the
    existing remote input API exactly once per action; the Host-side guard is
    installed independently by ``LabWebRemoteHost``.
    """

    def __init__(self, *, viewer: Any, producer: Any, proof: ProducerProof, execution_mode: str,
                 guard: Any | None, actions: list[dict[str, Any]], operator_endpoint: str | None = None) -> None:
        self._viewer, self._producer, self._proof = viewer, producer, proof
        self._execution_mode, self._guard, self._actions = execution_mode, guard, actions
        self._operator_endpoint = operator_endpoint

    def run(self) -> SceneResult:
        return run_controlled_scenes(
            self._viewer, self._producer, self._proof, execution_mode=self._execution_mode,
            guard=self._guard, actions=self._actions, operator_endpoint=self._operator_endpoint,
        )


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
            roi_x, roi_y = 64, 48
            raw = np.full((height, width), BLACK, dtype=np.uint8)
            raw[roi_y:roi_y + 128, roi_x:roi_x + 256] = marker_array
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
            full = FrameBuffer(np.ascontiguousarray(pixels).tobytes(), width=int(width), height=int(height), stride=int(pixels.shape[1]))
            decoded = decode_marker(full, roi=(roi_x, roi_y, 256, 128))
            if decoded.status != PASS or decoded.payload is None or decoded.payload.run_nonce != proof.run_nonce:
                return {"status": FAIL, "reason": f"h264-marker-decode:{width}x{height}:{decoded.failure}"}
            corrupted = bytearray(full.pixels)
            # Flip one known payload-cell centre after full-frame H.264 decode.
            # Only copy A changes, so this has a decoder-observed failure.
            bit_index = 10
            grid_y, grid_x = divmod(bit_index, _INTERIOR_WIDTH)
            cell_x, cell_y = roi_x + (grid_x + 1) * 8 + 2, roi_y + (grid_y + 1) * 8 + 2
            source_value = corrupted[cell_y * full.stride + cell_x]
            replacement = BLACK if source_value >= 128 else WHITE
            for corrupt_y in range(cell_y, cell_y + 4):
                corrupted[corrupt_y * full.stride + cell_x:corrupt_y * full.stride + cell_x + 4] = bytes((replacement,)) * 4
            corruption = decode_marker(FrameBuffer(corrupted, full.width, full.height, full.stride), roi=(roi_x, roi_y, 256, 128))
            # Resample the decoded 256-pixel ROI to 255 pixels in the full
            # frame, then decode at that declared geometry.  This exercises a
            # true scaled visual vector rather than a metadata-only width.
            resampled = bytearray(full.pixels)
            source_columns = np.rint(np.linspace(0, 255, 255)).astype(int)
            for row in range(128):
                source_start = (roi_y + row) * full.stride + roi_x
                row_pixels = np.frombuffer(full.pixels[source_start:source_start + 256], dtype=np.uint8)
                resampled[source_start:source_start + 255] = row_pixels[source_columns].tobytes()
            scaled = decode_marker(FrameBuffer(resampled, full.width, full.height, full.stride), roi=(roi_x, roi_y, 255, 128))
            corruption_status, scale_status = corruption.status, scaled.status
            if corruption_status == PASS or scale_status == PASS:
                return {"status": FAIL, "reason": "h264-adversarial-vector-accepted"}
            decoded_resolutions.append([int(width), int(height)])
    except Exception as error:
        return {"status": FAIL, "reason": f"h264-roundtrip-error:{type(error).__name__}:{error}"}
    return {"status": PASS, "decodedResolutions": decoded_resolutions, "roi": [64, 48, 256, 128],
            "corruptionStatus": corruption_status, "corruptionFailure": corruption.failure,
            "scaleStatus": scale_status, "scaleFailure": scaled.failure}
