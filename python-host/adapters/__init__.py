"""Host adapter boundaries. Implementations remain compatible with the legacy facade."""

from .capture import CaptureAdapter
from .input import InputAdapter
from .lifecycle import LifecycleCoordinator
from .media_sender import MediaSenderAdapter

__all__ = ["CaptureAdapter", "InputAdapter", "LifecycleCoordinator", "MediaSenderAdapter"]
