import importlib.util
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "mobile_viewer_acceptance",
    Path(__file__).with_name("mobile_viewer_acceptance.py"),
)
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


def test_completion_requires_ack_safe_transport_and_clear_input_state():
    expected = (("mouse", "wheel"),)
    clean_state = {
        "pressedKeyCount": 0,
        "pressedMouseButtonCount": 0,
        "pendingMouseReset": False,
        "pendingKeyboard": 0,
        "keyboardState": "READY",
    }
    assert not HARNESS.completion_ok(clean_state, [{"type": "mouse", "action": "wheel", "transport": "socket", "ackStatus": None}], expected)
    assert not HARNESS.completion_ok({**clean_state, "pendingMouseReset": True}, [{"type": "mouse", "action": "wheel", "transport": "socket", "ackStatus": "applied"}], expected)
    assert HARNESS.completion_ok(clean_state, [{"type": "mouse", "action": "wheel", "transport": "socket", "ackStatus": "applied"}], expected)


def test_geometry_requires_keyboard_visible_and_all_non_containment_pairs_disjoint():
    boxes = {
        "statusBar": {"left": 0, "top": 0, "right": 100, "bottom": 10, "visible": True},
        "viewerSurface": {"left": 0, "top": 10, "right": 100, "bottom": 60, "visible": True},
        "dock": {"left": 0, "top": 70, "right": 100, "bottom": 90, "visible": True},
        "mobileKeyboard": {"left": 0, "top": 90, "right": 100, "bottom": 100, "visible": True},
        "fullscreen": {"left": 10, "top": 72, "right": 20, "bottom": 82, "visible": True},
    }
    assert HARNESS.validate_geometry(boxes) is None
    assert HARNESS.validate_geometry({**boxes, "mobileKeyboard": {**boxes["mobileKeyboard"], "visible": False}}) == "mobile-keyboard-not-visible"
    assert HARNESS.validate_geometry({**boxes, "viewerSurface": {**boxes["viewerSurface"], "top": 5}}) == "layout-overlap"
