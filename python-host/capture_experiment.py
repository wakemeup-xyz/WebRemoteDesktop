"""Immutable capture settings for an already-isolated lab process."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class CaptureExperiment:
    """The one capture variable fixed before a Lab Host starts."""

    capture_multiplier: float
    opencv_threads: int | None

    def __post_init__(self) -> None:
        if isinstance(self.capture_multiplier, bool) or not isinstance(self.capture_multiplier, (int, float)):
            raise TypeError("capture_multiplier must be a numeric experiment value")
        multiplier = float(self.capture_multiplier)
        if multiplier not in {1.0, 2.0}:
            raise ValueError("capture_multiplier must be exactly 1.0 or 2.0")
        if self.opencv_threads is not None and (
            isinstance(self.opencv_threads, bool) or type(self.opencv_threads) is not int or self.opencv_threads not in {0, 1}
        ):
            raise ValueError("opencv_threads must be None, 0, or 1")
        object.__setattr__(self, "capture_multiplier", multiplier)

    def capture_fps_for_target(self, target_fps: int) -> int:
        if isinstance(target_fps, bool) or type(target_fps) is not int:
            raise TypeError("target_fps must be an integer")
        if not 5 <= target_fps <= 30:
            raise ValueError("target_fps must be within the runtime range 5..30")
        return int(target_fps * self.capture_multiplier)

    def to_binding(self) -> dict[str, float | int | None]:
        return {"captureMultiplier": self.capture_multiplier, "opencvThreads": self.opencv_threads}

    @classmethod
    def from_binding(cls, raw: Mapping[str, Any]) -> "CaptureExperiment":
        if not isinstance(raw, Mapping) or set(raw) != {"captureMultiplier", "opencvThreads"}:
            raise ValueError("capture experiment binding has missing or unknown fields")
        return cls(raw["captureMultiplier"], raw["opencvThreads"])
