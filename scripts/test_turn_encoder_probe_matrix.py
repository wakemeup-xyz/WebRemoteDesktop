"""Session-boundary regression tests for the preset matrix probe."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
PROBE_PATH = ROOT / "docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py"
SPEC = importlib.util.spec_from_file_location("turn_encoder_probe_matrix", PROBE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = PROBE
SPEC.loader.exec_module(PROBE)

from turn_encoder_experiments import build_preset_experiments


class PresetScenarioSessionTest(unittest.TestCase):
    def test_post_scroll_reuses_scrolling_encoder_and_decoder_with_global_indices(self):
        config, _ = build_preset_experiments()
        calls = []
        original = PROBE._scenario_run
        original_font = PROBE.load_probe_font

        def fake_run(_width, _height, _font, **kwargs):
            encoder = kwargs.get("encoder") or object()
            decoder = kwargs.get("decoder") or object()
            calls.append({**kwargs, "encoder": encoder, "decoder": decoder})
            return ({"scenarioId": kwargs["scenario_id"], "sessionId": kwargs["session_id"]}, encoder, decoder)

        PROBE._scenario_run = fake_run
        PROBE.load_probe_font = lambda: (None, {"resolved": "fake"})
        self.addCleanup(setattr, PROBE, "_scenario_run", original)
        self.addCleanup(setattr, PROBE, "load_probe_font", original_font)

        PROBE.evaluate_preset_scenario_matrix(config)

        for resolution_calls in (calls[:5], calls[5:]):
            scrolling = next(call for call in resolution_calls if call["scenario_id"] == "scrolling-text")
            post = next(call for call in resolution_calls if call["scenario_id"] == "post-scroll-static")
            self.assertIs(post["encoder"], scrolling["encoder"])
            self.assertIs(post["decoder"], scrolling["decoder"])
            self.assertEqual((post["phase_start_index"], post["frame_count"]), (300, 300))
            self.assertEqual(post["request_indices"], (305, 500))


if __name__ == "__main__":
    unittest.main()
