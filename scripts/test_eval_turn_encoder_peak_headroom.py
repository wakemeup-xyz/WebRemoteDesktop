"""Focused tests for peak-headroom project CPU telemetry and abort artifacts."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("eval-turn-encoder-quality.py")
SPEC = importlib.util.spec_from_file_location("eval_turn_encoder_quality_peak_headroom", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class AmbientStub:
    def __init__(self):
        self.abort_reasons = []
        self.stopped = False
        self.blocks = []

    def start(self): pass
    def stop(self): self.stopped = True
    def run_preflight(self): return not self.abort_reasons
    def begin_block(self, block_id): self.blocks.append(block_id)
    def end_block(self, block_id):
        return {"blockId": block_id, "startedMonotonicNs": 1, "endedMonotonicNs": 2, "sampleCount": 1}
    def verify_coverage(self): pass
    def abort_status(self):
        if any(reason["category"] == "CONTAMINATED" for reason in self.abort_reasons):
            return "ABORTED_CONTAMINATED"
        return "ABORTED_INCONCLUSIVE" if self.abort_reasons else None
    def evidence(self):
        return {"status": "CONTAMINATED" if self.abort_status() else "OBSERVED", "rawGatesUnchanged": True,
                "relativeOnly": True, "noLoadBaseline": None, "coverage": [], "missedTicks": 0,
                "preflight": {"status": "PASS"}, "abortReasons": list(self.abort_reasons), "samples": []}


class PeakHeadroomMatrixCliTest(unittest.TestCase):
    def setUp(self):
        self.candidate = types.SimpleNamespace(
            id="on-demand-peak-headroom-v1",
            options_digest="candidate-digest",
            to_dict=lambda: {"id": "on-demand-peak-headroom-v1", "encoderParameterDigest": "candidate-digest"},
        )
        experiment = types.ModuleType("turn_encoder_peak_headroom_experiments")
        experiment.build_peak_headroom_candidate = lambda: self.candidate
        self.sliced2_candidate = types.SimpleNamespace(
            id="on-demand-peak-headroom-sliced2-v1",
            options_digest="sliced2-digest",
            to_dict=lambda: {
                "id": "on-demand-peak-headroom-sliced2-v1",
                "encoderParameterDigest": "sliced2-digest",
                "inputContract": {"id": "production-screen-bgra-v1"},
            },
        )
        experiment.build_peak_headroom_sliced2_candidate = lambda: self.sliced2_candidate
        experiment.submitted_options = lambda _config, resolution: {"resolution": str(resolution)}
        experiment.validate_prescreen = lambda _evidence: []
        experiment.validate_full_matrix = lambda _evidence: []
        self.previous_experiment = sys.modules.get("turn_encoder_peak_headroom_experiments")
        sys.modules["turn_encoder_peak_headroom_experiments"] = experiment
        self.addCleanup(self._restore_experiment)
        self.previous_sampler = MODULE._PeakAmbientSampler
        self.addCleanup(lambda: setattr(MODULE, "_PeakAmbientSampler", self.previous_sampler))

    def _restore_experiment(self):
        if self.previous_experiment is None:
            sys.modules.pop("turn_encoder_peak_headroom_experiments", None)
        else:
            sys.modules["turn_encoder_peak_headroom_experiments"] = self.previous_experiment

    def test_failed_prescreen_is_archived_without_running_the_full_matrix(self):
        sys.modules["turn_encoder_peak_headroom_experiments"].validate_prescreen = lambda _evidence: ["safety-net: quality failure"]
        MODULE._PeakAmbientSampler = AmbientStub
        calls = []

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config):
                calls.append(("prescreen", config.id))
                return {"config": config.to_dict(), "input": {"fixed": True}, "runs": []}

            def evaluate_preset_scenario_matrix(self, _config, **_kwargs):
                calls.append(("full", _config.id))
                raise AssertionError("must not run full matrix")

        result = MODULE.evaluate_peak_headroom_matrix(Probe())
        self.assertEqual(calls, [("prescreen", self.candidate.id)])
        self.assertEqual(result["status"], "NO_QUALIFIED_CANDIDATE")
        self.assertEqual(result["candidate"]["execution"]["fullMatrix"], "NOT RUN")

    def test_viewer_contamination_cannot_become_offline_pass(self):
        ambient = AmbientStub()
        MODULE._PeakAmbientSampler = lambda: ambient

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config): return {"config": config.to_dict(), "runs": []}
            def evaluate_peak_headroom_sentinel(self, *_args): return {"encodeMsMedian": 2.0, "encodeMsP95": 999.0}
            def evaluate_preset_scenario_matrix(self, _config, measurement_hook):
                measurement_hook("before", 1152, 720, "static")
                measurement_hook("after", 1152, 720, "static")
                ambient.abort_reasons.append({"category": "CONTAMINATED", "reason": "viewer activity"})
                return {"runs": []}

        result = MODULE.evaluate_peak_headroom_matrix(Probe())
        self.assertEqual(result["status"], "ABORTED_CONTAMINATED")
        self.assertFalse(result["candidate"]["eligible"])
        self.assertEqual(result["candidate"]["offline"]["status"], "NOT RUN")

    def test_sentinel_p95_is_telemetry_and_not_a_raw_quality_gate(self):
        MODULE._PeakAmbientSampler = AmbientStub

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config): return {"config": config.to_dict(), "runs": []}
            def evaluate_peak_headroom_sentinel(self, *_args): return {"encodeMsMedian": 1.0, "encodeMsP95": 12345.0}
            def evaluate_preset_scenario_matrix(self, _config, measurement_hook):
                measurement_hook("before", 1152, 720, "static")
                measurement_hook("after", 1152, 720, "static")
                return {"runs": []}

        result = MODULE.evaluate_peak_headroom_matrix(Probe())
        self.assertEqual(result["status"], "OFFLINE_PASS_ONLY")
        self.assertEqual(result["candidate"]["offline"]["status"], "PASS")
        self.assertNotIn("adjusted", json.dumps(result))

    def test_sliced2_matrix_selects_only_the_versioned_sliced_candidate(self):
        MODULE._PeakAmbientSampler = AmbientStub
        seen = []

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config):
                seen.append(("prescreen", config.id))
                return {"config": config.to_dict(), "input": {"contract": config.to_dict()["inputContract"]}, "runs": []}

            def evaluate_peak_headroom_sentinel(self, *_args):
                return {"encodeMsMedian": 1.0, "encodeMsP95": 2.0}

            def evaluate_preset_scenario_matrix(self, config, measurement_hook):
                seen.append(("full", config.id))
                measurement_hook("before", 1152, 720, "static")
                measurement_hook("after", 1152, 720, "static")
                return {"config": config.to_dict(), "input": {"contract": config.to_dict()["inputContract"]}, "runs": []}

        result = MODULE.evaluate_peak_headroom_matrix(Probe(), sliced2=True)

        self.assertEqual(
            seen,
            [
                ("prescreen", "on-demand-peak-headroom-sliced2-v1"),
                ("full", "on-demand-peak-headroom-sliced2-v1"),
            ],
        )
        self.assertEqual(result["kind"], "relay-peak-headroom-sliced2-v1")
        self.assertEqual(result["candidate"]["id"], "on-demand-peak-headroom-sliced2-v1")


class PeakAmbientSamplerTest(unittest.TestCase):
    def _roots(self):
        main = Path("/repo/WebRemoteDesktop")
        return main, main / ".worktrees" / "turn-pulse-throughput-next"

    def _sampler(self, snapshot):
        return MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot, project_roots=self._roots())

    def test_records_only_this_project_cpu_without_external_admission(self):
        main_root, worktree_root = self._roots()
        own_pid = os.getpid()
        snapshot = {"processes": [
            {"pid": own_pid + 1, "ppid": own_pid, "rssKiB": 1, "cpuPercent": 3.0, "command": "/opt/python", "argv": "/opt/python matrix-helper"},
            {"pid": 101, "ppid": 1, "rssKiB": 2, "cpuPercent": 11.0, "command": "/opt/python", "argv": "/opt/python host.py", "cwd": str(main_root / "python-host")},
            {"pid": 105, "ppid": 101, "rssKiB": 2, "cpuPercent": 5.0, "command": "/opt/python", "argv": "/opt/python overlay_window.py"},
            {"pid": 102, "ppid": 1, "rssKiB": 3, "cpuPercent": 13.0, "command": "/opt/node", "argv": "/opt/node server.js", "cwd": str(worktree_root / "signal-server")},
            {"pid": 103, "ppid": 1, "rssKiB": 4, "cpuPercent": 97.0, "command": "/opt/python", "argv": "/opt/python host.py", "cwd": "/other/repo/python-host"},
            {"pid": 104, "ppid": 1, "rssKiB": 5, "cpuPercent": 98.0, "command": "/opt/python", "argv": "/opt/python -m pytest", "cwd": "/other/repo"},
        ], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}

        sampler = self._sampler(snapshot)
        sample = sampler._sample_once(phase="PREFLIGHT")

        self.assertIsNone(sampler.abort_status())
        self.assertEqual([item["pid"] for item in sample["projectProcesses"]], [own_pid + 1, 101, 105, 102])
        self.assertEqual(sample["projectCpuPercent"], 32.0)
        evidence = sampler.evidence()
        self.assertNotIn("mysqld", evidence)
        self.assertNotIn("externalProcessPolicy", evidence)
        self.assertEqual(evidence["projectCpuPercent"]["max"], 32.0)

    def test_project_service_requires_matching_repository_cwd_and_entrypoint(self):
        main_root, worktree_root = self._roots()
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        self.assertTrue(sampler._is_project_service_process({"argv": "/opt/python host.py", "cwd": str(main_root / "python-host")}))
        self.assertTrue(sampler._is_project_service_process({"argv": str(main_root / "python-host/host.py")}))
        self.assertTrue(sampler._is_project_service_process({"argv": "/opt/python host.py --foreground", "cwd": str(main_root / "python-host")}))
        self.assertTrue(sampler._is_project_service_process({"argv": f"/opt/node {worktree_root / 'signal-server/server.js'} --port 8080"}))
        self.assertTrue(sampler._is_project_service_process({"argv": "/opt/node server.js", "cwd": str(worktree_root / "signal-server")}))
        self.assertFalse(sampler._is_project_service_process({"argv": "/opt/node server.js", "cwd": str(main_root)}))
        self.assertFalse(sampler._is_project_service_process({"argv": "/opt/python host.py", "cwd": "/other/repo/python-host"}))
        self.assertFalse(sampler._is_project_service_process({"argv": "/other/repo/python-host/host.py --foreground"}))

    def test_mysqld_and_external_cpu_do_not_gate_sampling(self):
        snapshot = {"processes": [
            {"pid": 10, "ppid": 1, "rssKiB": 1, "cpuPercent": 99.0, "command": "/opt/mysql/mysqld", "argv": "/opt/mysql/mysqld"},
            {"pid": 11, "ppid": 1, "rssKiB": 1, "cpuPercent": 98.0, "command": "/opt/python", "argv": "/opt/python -m pytest"},
        ], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}
        sampler = self._sampler(snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        self.assertEqual(sampler.evidence()["projectCpuPercent"]["max"], 0.0)

    def test_viewer_activity_and_sampling_failures_remain_gates(self):
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 1, "relayViewerCount": 0}})
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        self.assertIn("viewer activity", [reason["reason"] for reason in sampler.abort_reasons])

        broken = MODULE._PeakAmbientSampler(snapshot_reader=lambda: (_ for _ in ()).throw(OSError("ps unavailable")), project_roots=self._roots())
        broken._sample_once(phase="PREFLIGHT")
        self.assertEqual(broken.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertEqual(broken.evidence()["health"]["status"], "FAILED")

    def test_sampling_health_stays_failed_after_a_later_recovery_sample(self):
        clean = {"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}
        snapshots = iter([OSError("ps unavailable"), clean])
        def reader():
            item = next(snapshots)
            if isinstance(item, Exception):
                raise item
            return item
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=reader, project_roots=self._roots())
        sampler._sample_once(phase="PREFLIGHT")
        sampler._sample_once(phase="RUNNING")
        self.assertFalse(sampler.healthy.is_set())
        self.assertEqual(sampler.evidence()["health"]["status"], "FAILED")

    def test_preflight_cadence_is_warning_only_when_late(self):
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        with mock.patch.object(MODULE.time, "monotonic_ns", side_effect=(1_000_000_000, 3_000_000_000)):
            sampler._sample_once(phase="PREFLIGHT")
            sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        self.assertEqual(sampler.evidence()["telemetryQuality"]["status"], "DEGRADED")
        self.assertIn("ambient preflight cadence outside bounds", [warning["reason"] for warning in sampler.evidence()["telemetryQuality"]["warnings"]])

    def test_scheduled_tick_lateness_is_warning_only(self):
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        with mock.patch.object(MODULE.time, "monotonic_ns", return_value=1_200_000_000):
            sampler._sample_once(phase="PREFLIGHT", scheduled_ns=1_000_000_000)

        self.assertIsNone(sampler.abort_status())
        evidence = sampler.evidence()
        self.assertEqual(evidence["telemetryQuality"]["status"], "DEGRADED")
        self.assertEqual(evidence["lateTicks"][0]["lateSeconds"], 0.2)
        self.assertIn("ambient sampling tick late", [warning["reason"] for warning in evidence["telemetryQuality"]["warnings"]])

    def test_preflight_keeps_telemetry_warnings_out_of_qualification_status(self):
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        sampler._preflight_samples = [{"monotonicNs": index} for index in range(sampler.PRE_FLIGHT_SAMPLES)]
        sampler.healthy.set()
        sampler._warn_telemetry("ambient sampling tick late", lateSeconds=0.2)

        sampler._finish_preflight_if_ready()

        self.assertEqual(sampler._preflight_status, "PASS")
        self.assertTrue(sampler._preflight_complete.is_set())
        self.assertIsNone(sampler.abort_status())

    def test_preflight_timeout_has_scheduling_grace_for_thirty_successful_samples(self):
        sampler = self._sampler({"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        sampler._preflight_samples = [{} for _ in range(sampler.PRE_FLIGHT_SAMPLES)]
        sampler._preflight_status = "PASS"
        sampler._preflight_complete.set()
        sampler.healthy.set()

        with mock.patch.object(sampler._preflight_complete, "wait", return_value=True) as wait:
            self.assertTrue(sampler.run_preflight())

        self.assertEqual(sampler.PRE_FLIGHT_SCHEDULING_GRACE_SECONDS, 30.0)
        self.assertEqual(
            wait.call_args.kwargs["timeout"],
            sampler.PRE_FLIGHT_SAMPLES * sampler._interval_seconds
            + sampler.PRE_FLIGHT_SCHEDULING_GRACE_SECONDS,
        )

    def test_cpu_lookup_targets_only_selected_project_pids(self):
        completed = types.SimpleNamespace(returncode=0, stdout="101 20 12.5\n102 30 7.5\n")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            cpu = MODULE._PeakAmbientSampler._read_project_cpu({102: "signal", 101: "host"})
        self.assertEqual(cpu[101]["cpuPercent"], 12.5)
        self.assertEqual(cpu[102]["rssKiB"], 30)
        self.assertEqual(run.call_args.args[0], ("ps", "-p", "101,102", "-o", "pid=,rss=,%cpu="))

    def test_service_cwd_lookup_batches_candidates_once(self):
        completed = types.SimpleNamespace(returncode=0, stdout="p101\nn/repo/python-host\np102\nn/repo/signal-server\n")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            cwds = MODULE._PeakAmbientSampler._process_cwds([101, 102])
        self.assertEqual(cwds, {101: "/repo/python-host", 102: "/repo/signal-server"})
        self.assertEqual(run.call_args.args[0], ("lsof", "-a", "-p", "101,102", "-d", "cwd", "-Fpn"))

    def test_boundary_samples_have_a_single_worker_owner(self):
        callers = []
        snapshot = {"processes": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: callers.append(threading.get_ident()) or snapshot, project_roots=self._roots())
        sampler.start()
        sampler.begin_block("sentinel")
        coverage = sampler.end_block("sentinel")
        sampler.stop()
        self.assertEqual(len(set(callers)), 1)
        self.assertGreaterEqual(coverage["sampleCount"], 2)


class AtomicAbortArtifactTest(unittest.TestCase):
    def test_peak_abort_schema_uses_project_cpu_policy(self):
        artifact = MODULE._peak_atomic_abort_artifact(RuntimeError("load"))
        self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")
        self.assertFalse(artifact["candidate"]["eligible"])
        self.assertEqual(artifact["ambientTelemetry"]["preflight"]["status"], "NOT STARTED")
        self.assertEqual(artifact["ambientTelemetry"]["telemetryQuality"]["status"], "NOT RUN")
        self.assertEqual(artifact["ambientTelemetry"]["projectCpuPolicy"]["version"], "webremotedesktop-project-cpu-v1")

    def test_main_writes_atomic_abort_artifact_when_probe_load_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "abort.json"
            previous_args, previous_loader = MODULE.parse_args, MODULE.load_probe_module
            self.addCleanup(lambda: setattr(MODULE, "parse_args", previous_args))
            self.addCleanup(lambda: setattr(MODULE, "load_probe_module", previous_loader))
            MODULE.parse_args = lambda: argparse.Namespace(policy=None, matrix="relay-peak-headroom-v1", output=output)
            MODULE.load_probe_module = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            MODULE.main()
            artifact = json.loads(output.read_text())
        self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")
        self.assertFalse(artifact["eligible"])
        self.assertEqual(artifact["candidate"]["offline"]["status"], "NOT RUN")
        self.assertIn("ambientTelemetry", artifact)

    def test_hook_exception_preserves_observed_partial_evidence_through_main(self):
        candidate = types.SimpleNamespace(id="on-demand-peak-headroom-v1", options_digest="candidate-digest", to_dict=lambda: {"id": "on-demand-peak-headroom-v1"})
        experiment = types.ModuleType("turn_encoder_peak_headroom_experiments")
        experiment.build_peak_headroom_candidate = lambda: candidate
        experiment.submitted_options = lambda _config, resolution: {"resolution": str(resolution)}
        experiment.validate_prescreen = lambda _evidence: []
        experiment.validate_full_matrix = lambda _evidence: []
        old_experiment, old_sampler = sys.modules.get("turn_encoder_peak_headroom_experiments"), MODULE._PeakAmbientSampler
        self.addCleanup(lambda: sys.modules.__setitem__("turn_encoder_peak_headroom_experiments", old_experiment) if old_experiment else sys.modules.pop("turn_encoder_peak_headroom_experiments", None))
        self.addCleanup(lambda: setattr(MODULE, "_PeakAmbientSampler", old_sampler))
        sys.modules["turn_encoder_peak_headroom_experiments"] = experiment
        MODULE._PeakAmbientSampler = AmbientStub

        class Probe:
            def evaluate_peak_headroom_prescreen(self, _config): return {"prescreen": "observed"}
            def evaluate_peak_headroom_sentinel(self, *_args): return {"encodeMsMedian": 1.0, "encodeMsP95": 2.0}
            def evaluate_preset_scenario_matrix(self, _config, measurement_hook):
                measurement_hook("before", 1152, 720, "static")
                raise RuntimeError("hook failure after sentinel")

        with self.assertRaises(MODULE._PeakEvaluationAbort) as raised:
            MODULE.evaluate_peak_headroom_matrix(Probe())
        preserved = raised.exception.evidence
        self.assertEqual(preserved["candidate"]["prescreen"]["evidence"], {"prescreen": "observed"})
        self.assertEqual(len(preserved["ambientTelemetry"]["sentinels"]), 1)
        self.assertEqual(preserved["ambientTelemetry"]["preflight"]["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
