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


def test_geometry_checks_application_text_dock_without_claiming_system_keyboard():
    boxes = {
        "statusBar": {"left": 0, "top": 0, "right": 100, "bottom": 10, "visible": True},
        "viewerSurface": {"left": 0, "top": 10, "right": 100, "bottom": 60, "visible": True},
        "dock": {"left": 0, "top": 70, "right": 100, "bottom": 90, "visible": True},
        "applicationTextDock": {"left": 0, "top": 90, "right": 100, "bottom": 100, "visible": True},
        "fullscreen": {"left": 10, "top": 72, "right": 20, "bottom": 82, "visible": True},
    }
    assert HARNESS.validate_geometry(boxes) is None
    assert HARNESS.validate_geometry({**boxes, "applicationTextDock": {**boxes["applicationTextDock"], "visible": False}}) == "application-text-dock-not-visible"
    assert HARNESS.validate_geometry({**boxes, "viewerSurface": {**boxes["viewerSurface"], "top": 5}}) == "layout-overlap"


def test_system_keyboard_pass_requires_observed_viewport_contraction():
    baseline = {"innerHeight": 812, "visualViewportHeight": 812}
    unchanged = {"innerHeight": 812, "visualViewportHeight": 812}
    contracted = {"innerHeight": 812, "visualViewportHeight": 520}

    assert HARNESS.system_keyboard_geometry_status(baseline, unchanged) == ("NOT RUN", "system-keyboard-geometry-unavailable")
    assert HARNESS.system_keyboard_geometry_status(baseline, contracted) == ("PASS", None)
