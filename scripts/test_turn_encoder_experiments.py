"""Contract tests for the bounded offline relay preset experiment."""

from __future__ import annotations

import copy
import importlib.util
import math
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_encoder_experiments.py")
SPEC = importlib.util.spec_from_file_location("turn_encoder_experiments", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def finite_frame(index: int, *, idr_kind: str | None = None, token: str | None = None) -> dict:
    return {
        "index": index,
        "phaseIndex": index,
        "inputHash": f"input-{index}",
        "pts": index * 4500,
        "timeBase": "1/90000",
        "requestToken": token,
        "idr": idr_kind is not None,
        "bitstreamIdrKind": idr_kind,
        "idrKind": idr_kind,
        "psnr": 30.0,
        "changeMAE": 0.0,
        "encodeMs": 1.0,
        "bytes": 100,
        "idrBytes": 100 if idr_kind else 0,
        "decodeMs": 1.0,
        "quality": {"psnr": 30.0, "changeMAE": 0.0},
        "qp": None,
    }


def scenario(config, scenario_id: str, start: int, count: int, requests: tuple[int, ...] = (), resolution=(1152, 720)) -> dict:
    frames = []
    for offset in range(count):
        index = start + offset
        if index == start and scenario_id != "post-scroll-static":
            kind, token = "initial", None
        elif index in requests:
            kind, token = "on-demand", f"{scenario_id}:{index}"
        elif scenario_id == "safety-net" and index == 1201:
            kind, token = "encoder-safety-net", None
        else:
            kind, token = None, None
        frame = finite_frame(index, idr_kind=kind, token=token)
        frame["phaseIndex"] = offset
        frames.append(frame)
    return {
        "scenarioId": scenario_id,
        "sessionId": "session-scroll" if scenario_id in {"scrolling-text", "post-scroll-static"} else f"session-{scenario_id}",
        "phaseStartIndex": start,
        "frameCount": count,
        "requestTokens": [f"{scenario_id}:{index}" for index in requests],
        "codecCreationRecords": [{
            "scenarioId": "scrolling-text" if scenario_id == "post-scroll-static" else scenario_id,
            "resolution": list(resolution),
            "creationIndex": 1,
            "requestedPreset": config.preset,
            "submittedCodecOptions": MODULE.submitted_options(config, resolution),
            "generation": 1,
            "reopenReason": "initial",
            "configuredProfile": config.profile,
            "configuredFps": config.fps,
            "configuredBitrateBps": config.bitrate_by_resolution[f"{resolution[0]}x{resolution[1]}"],
        }],
        "configuredOptions": MODULE.submitted_options(config, resolution),
        "frames": frames,
        "quality": {"status": "PASS"},
        "cost": {"status": "PASS", "encodeMsP95": 1.0},
        "burst": {"status": "PASS", "idrBytes": [frame["idrBytes"] for frame in frames if frame["idr"]]},
    }


def complete_run(config) -> dict:
    return {
        "config": config.to_dict(),
        "input": {"randomSeed": 20260905, "frameRate": 20, "timeBase": "1/90000"},
        "runs": [{
            "resolution": [1152, 720],
            "scenarios": [
                scenario(config, "static-text", 0, 65, (5,)),
                scenario(config, "health-static", 0, 1201),
                scenario(config, "scrolling-text", 0, 300, (5, 200)),
                scenario(config, "post-scroll-static", 300, 300, (305, 500)),
                scenario(config, "safety-net", 0, 1226),
            ],
        }, {
            "resolution": [1728, 1080],
            "scenarios": [
                scenario(config, "static-text", 0, 65, (5,), (1728, 1080)),
                scenario(config, "health-static", 0, 1201, (), (1728, 1080)),
                scenario(config, "scrolling-text", 0, 300, (5, 200), (1728, 1080)),
                scenario(config, "post-scroll-static", 300, 300, (305, 500), (1728, 1080)),
                scenario(config, "safety-net", 0, 1226, (), (1728, 1080)),
            ],
        }],
    }


class PresetExperimentContractTest(unittest.TestCase):
    def setUp(self):
        self.base, self.candidate = MODULE.build_preset_experiments()
        self.base_run = complete_run(self.base)
        self.candidate_run = complete_run(self.candidate)

    def test_fixed_matrix_has_only_fresh_ultrafast_control_and_superfast_candidate(self):
        self.assertEqual(self.base.id, "on-demand-cap-vbv200-ultrafast")
        self.assertEqual(self.base.preset, "ultrafast")
        self.assertEqual(self.candidate.id, "on-demand-cap-vbv200-superfast")
        self.assertEqual(self.candidate.preset, "superfast")
        self.assertEqual(self.base.codec, self.candidate.codec)
        self.assertEqual(self.base.profile, self.candidate.profile)
        self.assertEqual(self.base.fps, self.candidate.fps)
        self.assertEqual(self.base.bitrate_by_resolution, self.candidate.bitrate_by_resolution)
        self.assertEqual(self.base.vbv_ms, self.candidate.vbv_ms)
        self.assertEqual(self.base.periodic_idr_frames, self.candidate.periodic_idr_frames)
        self.assertNotEqual(self.base.options_digest, self.candidate.options_digest)
        self.assertIn(
            "vbv-maxrate=5000",
            MODULE.submitted_options(self.candidate, (1728, 1080))["x264-params"],
        )
        with self.assertRaises((AttributeError, TypeError)):
            self.base.preset = "slow"

    def test_complete_control_with_failed_quality_still_allows_candidate_comparison(self):
        self.base_run["runs"][0]["scenarios"][0]["quality"] = {"status": "FAIL"}
        self.assertEqual(MODULE.validate_comparison(self.base_run, self.candidate_run), [])

    def test_comparison_rejects_actual_preset_drift_and_extra_codec_reopen(self):
        broken = copy.deepcopy(self.candidate_run)
        broken["runs"][0]["scenarios"][0]["codecCreationRecords"][0]["requestedPreset"] = "ultrafast"
        broken["runs"][0]["scenarios"][0]["configuredOptions"]["preset"] = "ultrafast"
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("requested preset drift" in error for error in errors), errors)

        broken = copy.deepcopy(self.candidate_run)
        broken["runs"][0]["scenarios"][0]["codecCreationRecords"].append(
            copy.deepcopy(broken["runs"][0]["scenarios"][0]["codecCreationRecords"][0])
        )
        broken["runs"][0]["scenarios"][0]["codecCreationRecords"][1]["creationIndex"] = 2
        broken["runs"][0]["scenarios"][0]["codecCreationRecords"][1]["reopenReason"] = "decoder-refresh"
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("unexpected codec reopen" in error for error in errors), errors)

    def test_comparison_fails_closed_for_missing_frame_nan_unexpected_idr_and_safety_net_drift(self):
        for mutate, expected in (
            (lambda run: run["runs"][0]["scenarios"].pop(), "missing scenario"),
            (lambda run: run["runs"][0]["scenarios"][2]["frames"].pop(), "incomplete frame sequence"),
            (lambda run: run["runs"][0]["scenarios"][0]["frames"][5].update(psnr=math.nan), "non-finite"),
            (lambda run: run["runs"][0]["scenarios"][1]["frames"][20].update(idr=True, idrKind="periodic", bitstreamIdrKind="periodic"), "unexpected IDR"),
            (lambda run: run["runs"][0]["scenarios"][4]["frames"][1201].update(idr=False, idrKind=None, bitstreamIdrKind=None), "safety-net"),
        ):
            with self.subTest(expected=expected):
                broken = copy.deepcopy(self.candidate_run)
                mutate(broken)
                errors = MODULE.validate_comparison(self.base_run, broken)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_comparison_rejects_input_hash_or_pts_identity_drift(self):
        for mutate, expected in (
            (lambda run: run["runs"][0]["scenarios"][0]["frames"][3].update(inputHash="other"), "input hash drift"),
            (lambda run: run["runs"][0]["scenarios"][0]["frames"][3].update(pts=999), "PTS drift"),
            (lambda run: run["runs"][0]["scenarios"][0]["frames"][3].update(timeBase="1/20"), "time base drift"),
        ):
            with self.subTest(expected=expected):
                broken = copy.deepcopy(self.candidate_run)
                mutate(broken)
                errors = MODULE.validate_comparison(self.base_run, broken)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_comparison_recomputes_cost_and_idr_byte_aggregates(self):
        broken = copy.deepcopy(self.candidate_run)
        for frame in broken["runs"][0]["scenarios"][0]["frames"]:
            frame["encodeMs"] = 100.0
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("scenario cost aggregate drift" in error for error in errors), errors)

        broken = copy.deepcopy(self.candidate_run)
        safety = broken["runs"][0]["scenarios"][4]
        safety["frames"][1201]["idrBytes"] = 0
        safety["burst"]["idrBytes"] = [100, 0]
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("IDR byte evidence" in error for error in errors), errors)

        broken = copy.deepcopy(self.candidate_run)
        safety = broken["runs"][0]["scenarios"][4]
        safety["frames"][1201]["idrBytes"] = 99
        safety["burst"]["idrBytes"] = [100, 99]
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("IDR bytes must match frame bytes" in error for error in errors), errors)

    def test_comparison_rejects_actual_profile_fps_bitrate_and_parameter_digest_drift(self):
        broken = copy.deepcopy(self.candidate_run)
        record = broken["runs"][1]["scenarios"][0]["codecCreationRecords"][0]
        record["configuredProfile"] = "High"
        record["configuredFps"] = 60
        record["configuredBitrateBps"] = 1
        broken["config"]["encoderParameterDigest"] = "wrong"
        errors = MODULE.validate_comparison(self.base_run, broken)
        self.assertTrue(any("configured profile drift" in error for error in errors), errors)
        self.assertTrue(any("configured fps drift" in error for error in errors), errors)
        self.assertTrue(any("configured bitrate drift" in error for error in errors), errors)
        self.assertTrue(any("encoder parameter digest drift" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
