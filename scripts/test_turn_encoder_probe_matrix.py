"""Session-boundary regression tests for the preset matrix probe."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import av
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
PROBE_PATH = ROOT / "docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py"
SPEC = importlib.util.spec_from_file_location("turn_encoder_probe_matrix", PROBE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = PROBE
SPEC.loader.exec_module(PROBE)

from turn_encoder_experiments import build_preset_experiments
from turn_encoder_peak_headroom_experiments import (
    build_peak_headroom_candidate,
    validate_prescreen,
)


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


class ProductionInputContractTest(unittest.TestCase):
    def test_peak_candidate_declares_versioned_production_bgra_input(self):
        candidate = build_peak_headroom_candidate()

        self.assertEqual(
            candidate.to_dict()["inputContract"],
            {
                "id": "production-screen-bgra-v1",
                "pixelFormat": "bgra",
                "referenceFormat": "rgb24",
                "colorConversionCost": "inside-direct-encoder-unless-a-candidate-records-it-separately",
            },
        )

    def test_production_bgra_contract_preserves_rendered_rgb_pixels(self):
        font, _metadata = PROBE.load_probe_font()
        rendered_rgb = PROBE.make_static_text_frame(64, 48, font)

        encoded_pixels, reference_rgb, contract = PROBE.prepare_probe_input(
            rendered_rgb, "production-screen-bgra-v1"
        )
        frame = av.VideoFrame.from_ndarray(encoded_pixels, format=contract["pixelFormat"])

        self.assertEqual(contract["pixelFormat"], "bgra")
        self.assertEqual(frame.format.name, "bgra")
        self.assertTrue(np.array_equal(reference_rgb, rendered_rgb))
        self.assertTrue(np.array_equal(frame.to_ndarray(format="rgb24"), rendered_rgb))

    def test_peak_prescreen_records_bgra_contract_without_rewriting_rgb_history(self):
        candidate = build_peak_headroom_candidate()
        original = PROBE._scenario_run
        original_font = PROBE.load_probe_font

        def fake_run(_width, _height, _font, **kwargs):
            return ({"scenarioId": kwargs["scenario_id"]}, object(), object())

        PROBE._scenario_run = fake_run
        PROBE.load_probe_font = lambda: (None, {"resolved": "fake"})
        self.addCleanup(setattr, PROBE, "_scenario_run", original)
        self.addCleanup(setattr, PROBE, "load_probe_font", original_font)

        evidence = PROBE.evaluate_peak_headroom_prescreen(candidate)

        self.assertEqual(evidence["input"]["contract"]["id"], "production-screen-bgra-v1")
        self.assertEqual(evidence["input"]["contract"]["pixelFormat"], "bgra")
        self.assertEqual(evidence["input"]["historicalRgbEvidence"], "preserved-not-requalified")

    def test_integer_quality_metrics_match_float_reference_for_random_rgb(self):
        rng = np.random.default_rng(20260909)
        reference = rng.integers(0, 256, size=(17, 19, 3), dtype=np.uint8)
        output = rng.integers(0, 256, size=(17, 19, 3), dtype=np.uint8)
        previous = rng.integers(0, 256, size=(17, 19, 3), dtype=np.uint8)

        _current, mse, mae = PROBE.uint8_rgb_quality_metrics(output, reference, previous)
        expected_mse = float(np.mean((output.astype(float) - reference.astype(float)) ** 2))
        expected_mae = float(np.mean(np.abs(output.astype(float) - previous.astype(float))))

        self.assertEqual(mse, expected_mse)
        self.assertEqual(mae, expected_mae)

    def test_peak_scenario_constructs_bgra_before_direct_encoder_timer(self):
        candidate = build_peak_headroom_candidate()
        case = self
        events = []
        original_video_frame = PROBE.av.VideoFrame
        original_perf_counter = PROBE.time.perf_counter
        original_settings = PROBE.encoder_settings_from_creation_records

        class FakeFrame:
            def __init__(self, pixels, pixel_format):
                self.pixels = pixels
                self.pixel_format = pixel_format
                self.pts = None
                self.time_base = None

        class FakeVideoFrame:
            @staticmethod
            def from_ndarray(pixels, format):
                events.append(("frame", format))
                return FakeFrame(pixels, format)

        class FakeEncoder:
            codec_creation_records = ()
            last_requested_keyframe_emitted = False

            def _encode_frame(self, frame, _force):
                self.frame = frame
                return [b"\x65"]

            def _packetize(self, _nals):
                return [b"packet"]

        class FakeDecoded:
            def __init__(self, encoder):
                self.encoder = encoder

            def to_ndarray(self, *, format):
                case.assertEqual(format, "rgb24")
                if self.encoder.frame.pixel_format == "bgra":
                    return self.encoder.frame.pixels[:, :, [2, 1, 0]]
                return self.encoder.frame.pixels

        class FakeDecoder:
            def __init__(self, encoder):
                self.encoder = encoder

            def decode(self, _packet):
                return [FakeDecoded(self.encoder)]

        encoder = FakeEncoder()
        values = iter(range(1, 7))

        def fake_perf_counter():
            events.append(("timer", None))
            return next(values)

        PROBE.av.VideoFrame = FakeVideoFrame
        PROBE.time.perf_counter = fake_perf_counter
        PROBE.encoder_settings_from_creation_records = lambda *_args, **_kwargs: {}
        self.addCleanup(setattr, PROBE.av, "VideoFrame", original_video_frame)
        self.addCleanup(setattr, PROBE.time, "perf_counter", original_perf_counter)
        self.addCleanup(
            setattr, PROBE, "encoder_settings_from_creation_records", original_settings
        )
        font, _metadata = PROBE.load_probe_font()

        PROBE._scenario_run(
            1152, 720, font, config=candidate, scenario_id="static-text",
            session_id="test", phase_start_index=0, frame_count=1,
            request_indices=(), encoder=encoder, decoder=FakeDecoder(encoder),
        )

        self.assertEqual(events[0], ("frame", "bgra"))
        self.assertEqual(events[1], ("timer", None))

    def test_peak_validator_rejects_evidence_without_the_frozen_input_contract(self):
        candidate = build_peak_headroom_candidate()

        self.assertEqual(
            validate_prescreen({"config": candidate.to_dict(), "input": {}, "runs": []}),
            ["input contract drift"],
        )


if __name__ == "__main__":
    unittest.main()
