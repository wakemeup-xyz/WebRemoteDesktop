"""Fail-closed tests for peak-headroom ambient admissibility."""

from __future__ import annotations

import argparse
import io
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
from pathlib import Path


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
                "preflight": {"status": "PASS"}, "mysqld": {}, "forbidden": list(self.abort_reasons),
                "abortReasons": list(self.abort_reasons), "samples": []}


class PeakHeadroomMatrixCliTest(unittest.TestCase):
    def setUp(self):
        self.candidate = types.SimpleNamespace(
            id="on-demand-peak-headroom-v1",
            options_digest="candidate-digest",
            to_dict=lambda: {"id": "on-demand-peak-headroom-v1", "encoderParameterDigest": "candidate-digest"},
        )
        experiment = types.ModuleType("turn_encoder_peak_headroom_experiments")
        experiment.build_peak_headroom_candidate = lambda: self.candidate
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

    def test_final_hook_contamination_cannot_become_offline_pass(self):
        ambient = AmbientStub()
        MODULE._PeakAmbientSampler = lambda: ambient

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config): return {"config": config.to_dict(), "runs": []}
            def evaluate_peak_headroom_sentinel(self, *_args): return {"encodeMsMedian": 2.0, "encodeMsP95": 999.0}
            def evaluate_preset_scenario_matrix(self, _config, measurement_hook):
                measurement_hook("before", 1152, 720, "static")
                ambient.abort_reasons.append({"category": "CONTAMINATED", "reason": "non-allowlisted process present", "class": "pytest", "pid": 1, "cpuPercent": 0.0})
                return {"runs": []}

        result = MODULE.evaluate_peak_headroom_matrix(Probe())

        self.assertEqual(result["status"], "ABORTED_CONTAMINATED")
        self.assertFalse(result["candidate"]["eligible"])
        self.assertEqual(result["candidate"]["offline"]["status"], "NOT RUN")
        self.assertNotIn("OFFLINE_PASS_ONLY", json.dumps(result))

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


class PeakAmbientSamplerTest(unittest.TestCase):
    @staticmethod
    def _snapshot(pid=10, epoch="Mon Sep  8 12:00:00 2026", cpu=2.0):
        mysql = {"pid": pid, "rssKiB": 1, "cpuPercent": cpu, "command": "/opt/mysql/mysqld", "argv": "/opt/mysql/mysqld", "executablePath": "/opt/mysql/mysqld", "binaryPath": "/opt/mysql/mysqld", "startEpoch": epoch}
        framework_root = MODULE._PeakAmbientSampler._python_framework_root(os.path.realpath(sys.executable))
        assert framework_root is not None
        python_executable = f"{framework_root}/Resources/Python.app/Contents/MacOS/Python"
        sync = {"pid": 20, "rssKiB": 2, "cpuPercent": 1.0, "command": python_executable, "argv": f"{python_executable} -m backend.scripts.sync_worker", "executablePath": python_executable, "startEpoch": epoch}
        return {"processes": [mysql, sync], "mysqld": [mysql], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}

    def test_mysql_pid_drift_is_inconclusive(self):
        snapshots = iter([self._snapshot(pid=10), self._snapshot(pid=11)])
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: next(snapshots))
        sampler._sample_once(phase="PREFLIGHT")
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("mysqld identity changed", [item["reason"] for item in sampler.abort_reasons])

    def test_sync_worker_spoof_missing_and_identity_drift_fail_closed(self):
        good = self._snapshot()
        spoof = self._snapshot(); spoof["processes"][1]["argv"] = "/usr/bin/python3 -m backend.scripts.sync_worker_evil"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: spoof)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity unavailable", [x["reason"] for x in sampler.abort_reasons])
        changed = self._snapshot(); changed["processes"][1]["pid"] = 21
        snapshots = iter([good, changed]); sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: next(snapshots))
        sampler._sample_once(phase="PREFLIGHT"); sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity changed", [x["reason"] for x in sampler.abort_reasons])

    def test_sync_worker_extra_argv_and_pytest_in_argv_are_rejected(self):
        extra = self._snapshot(); extra["processes"][1]["argv"] += " --extra"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: extra); sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity unavailable", [x["reason"] for x in sampler.abort_reasons])
        pytest = self._snapshot(); pytest["processes"].append({"pid": 44, "rssKiB": 1, "cpuPercent": 2.0, "command": "/usr/bin/python3", "argv": "/usr/bin/python3 -m pytest"})
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: pytest); sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")

    def test_sync_worker_accepts_python_app_executable_from_matrix_framework(self):
        snapshot = self._snapshot()
        snapshot["processes"][1]["command"] = "/Users/macstudio"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        self.assertEqual(sampler.evidence()["syncWorker"]["identity"]["binaryPath"], snapshot["processes"][1]["executablePath"])

    def test_sync_worker_rejects_python_app_executable_outside_matrix_framework(self):
        snapshot = self._snapshot()
        worker = snapshot["processes"][1]
        root = MODULE._PeakAmbientSampler._python_framework_root(os.path.realpath(sys.executable))
        assert root is not None
        outside = f"{Path(root).parent}/999.0/Resources/Python.app/Contents/MacOS/Python"
        worker["argv"] = f"{outside} -m backend.scripts.sync_worker"
        worker["executablePath"] = outside
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_sync_worker_rejects_tmp_python_even_when_argv_shape_is_exact(self):
        snapshot = self._snapshot()
        process = snapshot["processes"][1]
        process["argv"] = "/tmp/python -m backend.scripts.sync_worker"
        process["executablePath"] = "/tmp/python"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_sync_worker_rejects_python_argv_when_kernel_executable_disagrees(self):
        snapshot = self._snapshot()
        process = snapshot["processes"][1]
        process["executablePath"] = "/tmp/not-python"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("sync_worker identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_mysqld_requires_kernel_executable_matching_argv0(self):
        snapshot = self._snapshot()
        snapshot["processes"][0]["executablePath"] = "/tmp/mysqld"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIn("mysqld identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_mysql_binary_and_start_epoch_drift_are_inconclusive(self):
        for changed in (self._snapshot(epoch="Tue Sep  9 12:00:00 2026"), {"processes": [{"pid": 10, "rssKiB": 1, "cpuPercent": 2.0, "command": "/usr/local/mysql-alt/bin/mysqld", "argv": "/usr/local/mysql-alt/bin/mysqld", "executablePath": "/usr/local/mysql-alt/bin/mysqld", "binaryPath": "/usr/local/mysql-alt/bin/mysqld", "startEpoch": "Mon Sep  8 12:00:00 2026"}, self._snapshot()["processes"][1]], "mysqld": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}}):
            with self.subTest(changed=changed["processes"][0]["command"]):
                snapshots = iter([self._snapshot(), changed])
                sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: next(snapshots))
                sampler._sample_once(phase="PREFLIGHT")
                sampler._sample_once(phase="PREFLIGHT")
                self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
                self.assertIn("mysqld identity changed", [item["reason"] for item in sampler.abort_reasons])

    def test_process_whose_command_only_contains_mysqld_is_not_allowlisted(self):
        process = {"pid": 10, "rssKiB": 1, "cpuPercent": 0.0, "command": "/usr/local/bin/mysqld-wrapper"}
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: {"processes": [process], "mysqld": [process], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("mysqld identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_zero_mysql_samples_fail_closed(self):
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: {"processes": [], "mysqld": [], "viewerStatus": {"viewerCount": 0, "relayViewerCount": 0}})
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIsNone(sampler.evidence()["mysqld"]["cpuPercent"]["p95"])

    def test_sampler_exception_is_inconclusive_and_ready(self):
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: (_ for _ in ()).throw(OSError("ps unavailable")))
        sampler._sample_once(phase="PREFLIGHT")
        self.assertTrue(sampler.health_ready.is_set())
        self.assertFalse(sampler.healthy.is_set())
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertEqual(sampler.abort_reasons[0]["reason"], "ambient sampling failure")

    def test_sampler_health_stays_failed_after_a_later_recovery_sample(self):
        snapshots = iter([OSError("ps unavailable"), self._snapshot()])
        def reader():
            item = next(snapshots)
            if isinstance(item, Exception):
                raise item
            return item
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=reader)
        sampler._sample_once(phase="PREFLIGHT")
        sampler._sample_once(phase="RUNNING")
        self.assertFalse(sampler.healthy.is_set())
        self.assertEqual(sampler.evidence()["health"]["status"], "FAILED")

    def test_unparseable_ps_command_line_is_retained_only_after_kernel_executable_lookup(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        ps_output = "31 1 42 99.0 /usr/local/bin/node unmatched'quote\n"
        ps_child = types.SimpleNamespace(pid=99, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        executable = os.path.realpath(sys.executable)
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=lambda _pid: executable)
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            snapshot = sampler._read_snapshot()
        self.assertEqual(snapshot["processes"], [{
            "pid": 31, "ppid": 1, "rssKiB": 42, "cpuPercent": 99.0,
            "command": executable, "argv": "/usr/local/bin/node unmatched'quote",
            "argvParseStatus": "UNPARSEABLE", "executablePath": executable,
            "canonicalExecutablePath": executable,
        }])

    def test_parseable_ps_command_lines_are_retained(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        ps_output = "10 1 1 2.0 /opt/mysql/mysqld\n20 1 2 1.0 /usr/bin/python3 -m backend.scripts.sync_worker\n"
        ps_child = types.SimpleNamespace(pid=99, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=lambda pid: "/opt/mysql/mysqld" if pid == 10 else os.path.realpath(sys.executable))
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            snapshot = sampler._read_snapshot()
        self.assertEqual([process["command"] for process in snapshot["processes"]], ["/opt/mysql/mysqld", "/usr/bin/python3"])
        self.assertEqual(snapshot["processes"][0]["canonicalExecutablePath"], "/opt/mysql/mysqld")
        self.assertEqual(snapshot["processes"][1]["canonicalExecutablePath"], os.path.realpath(sys.executable))
        self.assertEqual(snapshot["viewerStatus"], {"viewerCount": 0, "relayViewerCount": 0})

    def test_ps_child_pid_is_excluded_before_kernel_executable_lookup(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        ps_child_pid = 99
        ps_output = f"{ps_child_pid} 1 1 0.0 /bin/ps -axo pid=,ppid=,rss=,%cpu=,command=\n"
        ps_child = types.SimpleNamespace(pid=ps_child_pid, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        resolver = mock.Mock(side_effect=AssertionError("ps child must not reach proc_pidpath"))
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=resolver)
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            snapshot = sampler._read_snapshot()
        self.assertEqual(snapshot["processes"], [])
        resolver.assert_not_called()

    def test_matrix_own_ps_descendant_is_excluded_before_kernel_executable_lookup(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        own_child_pid = 98
        ps_child_pid = 99
        ps_output = (
            f"{own_child_pid} {os.getpid()} 1 99.0 /opt/matrix-helper\n"
            f"{ps_child_pid} 1 1 0.0 /bin/ps -axo pid=,ppid=,rss=,%cpu=,command=\n"
        )
        ps_child = types.SimpleNamespace(pid=ps_child_pid, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        resolver = mock.Mock(side_effect=AssertionError("matrix-own child must not reach proc_pidpath"))
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=resolver)
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            snapshot = sampler._read_snapshot()
        self.assertEqual(snapshot["processes"], [])
        resolver.assert_not_called()

    def test_non_ps_exited_pid_is_retained_as_unresolved_external(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        ps_child_pid = 99
        ps_output = "98 1 1 0.0 /opt/exited-worker\n" + f"{ps_child_pid} 1 1 0.0 /bin/ps -axo pid=,ppid=,rss=,%cpu=,command=\n"
        ps_child = types.SimpleNamespace(pid=ps_child_pid, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=lambda _pid: (_ for _ in ()).throw(OSError("proc_pidpath unavailable")))
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            snapshot = sampler._read_snapshot()
        self.assertEqual(snapshot["processes"], [{
            "pid": 98, "ppid": 1, "rssKiB": 1, "cpuPercent": 0.0,
            "command": "/opt/exited-worker", "argv": "/opt/exited-worker",
            "executableResolution": "unavailable",
        }])

    def test_unparseable_argv_without_a_kernel_executable_fails_sampling_closed(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.StringIO('{"viewerCount": 0, "relayViewerCount": 0}')
        ps_output = "10 1 1 2.0 /opt/mysql/mysqld unmatched'quote\n"
        ps_child = types.SimpleNamespace(pid=99, returncode=0, communicate=mock.Mock(return_value=(ps_output, "")))
        sampler = MODULE._PeakAmbientSampler(process_executable_resolver=lambda _pid: (_ for _ in ()).throw(OSError("proc_pidpath unavailable")))
        with mock.patch.object(MODULE.subprocess, "Popen", return_value=ps_child), mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response):
            sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("ambient sampling failure", [item["reason"] for item in sampler.abort_reasons])

    def test_forbidden_process_evidence_is_sanitized(self):
        snapshot = self._snapshot()
        snapshot["processes"].append({"pid": 42, "rssKiB": 2, "cpuPercent": 6.0, "command": "/usr/bin/pytest private-argument"})
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        self.assertEqual(sampler.evidence()["quiescentExternalProcesses"], [{"class": "pytest", "pid": 42, "cpuPercent": 6.0}])

    def test_quiescent_pytest_is_recorded_but_over_budget_processes_abort(self):
        quiet = self._snapshot(); quiet["processes"].append({"pid": 41, "rssKiB": 1, "cpuPercent": .5, "command": "/usr/bin/pytest", "argv": "pytest"})
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: quiet); sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        loud = self._snapshot(); loud["processes"].append({"pid": 42, "rssKiB": 1, "cpuPercent": 2.0, "command": "/usr/bin/pytest", "argv": "pytest"})
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: loud); sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")

    def test_midrun_external_spike_aborts_and_schema_declares_policy(self):
        quiet, spike = self._snapshot(), self._snapshot()
        spike["processes"].append({"pid": 55, "rssKiB": 1, "cpuPercent": 1.1, "command": "/usr/bin/pytest", "argv": "pytest"})
        snapshots = iter([quiet, spike]); sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: next(snapshots))
        sampler._sample_once(phase="PREFLIGHT"); sampler._sample_once(phase="RUNNING")
        evidence = sampler.evidence()
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        self.assertEqual(evidence["externalProcessPolicy"]["aggregateCpuPercentMaximum"], 1.0)

    def test_generic_node_aggregate_system_and_own_process_classification(self):
        node = self._snapshot(); node["processes"].append({"pid": 66, "rssKiB": 1, "cpuPercent": 99.0, "command": "/usr/local/bin/node", "argv": "node"})
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: node); sampler._sample_once(phase="RUNNING")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        aggregate = self._snapshot(); aggregate["processes"] += [{"pid": 67, "rssKiB": 1, "cpuPercent": .6, "command": "/opt/a", "argv": "a"}, {"pid": 68, "rssKiB": 1, "cpuPercent": .6, "command": "/opt/b", "argv": "b"}, {"pid": os.getpid(), "rssKiB": 1, "cpuPercent": 99.0, "command": "/opt/matrix", "argv": "matrix"}, {"pid": 69, "rssKiB": 1, "cpuPercent": 99.0, "command": "/System/Library/x", "argv": "x", "executablePath": "/System/Library/x"}]
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: aggregate); sampler._sample_once(phase="RUNNING")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        self.assertEqual(len(sampler.evidence()["quiescentExternalProcesses"]), 2)

    def test_matrix_child_and_macos_system_roots_are_excluded(self):
        snapshot = self._snapshot(); snapshot["processes"] += [{"pid": 77, "ppid": os.getpid(), "rssKiB": 1, "cpuPercent": 99.0, "command": "/bin/ps", "argv": "/bin/ps"}, {"pid": 78, "rssKiB": 1, "cpuPercent": 99.0, "command": "/usr/libexec/logd", "argv": "/usr/libexec/logd", "executablePath": "/usr/libexec/logd"}]
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot); sampler._sample_once(phase="RUNNING")
        self.assertIsNone(sampler.abort_status())
        aggregate = self._snapshot(); aggregate["processes"] += [{"pid": 43, "rssKiB": 1, "cpuPercent": .6, "command": "/usr/bin/pytest", "argv": "pytest"}, {"pid": 44, "rssKiB": 1, "cpuPercent": .6, "command": "/usr/bin/pytest", "argv": "pytest"}]
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: aggregate); sampler._sample_once(phase="RUNNING")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")

    def test_unresolved_external_is_recorded_and_never_skips_as_system(self):
        snapshot = self._snapshot()
        snapshot["processes"].append({
            "pid": 90, "ppid": 1, "rssKiB": 1, "cpuPercent": 0.5,
            "command": "/System/Library/short-lived", "argv": "/System/Library/short-lived",
            "executableResolution": "unavailable",
        })
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        self.assertEqual(sampler.evidence()["quiescentExternalProcesses"], [{
            "class": "external", "pid": 90, "cpuPercent": 0.5,
            "executableResolution": "unavailable",
        }])

    def test_unresolved_external_over_budget_aborts_contaminated(self):
        snapshot = self._snapshot()
        snapshot["processes"].append({
            "pid": 91, "ppid": 1, "rssKiB": 1, "cpuPercent": 99.0,
            "command": "/opt/short-lived", "argv": "/opt/short-lived",
            "executableResolution": "unavailable",
        })
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: snapshot)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")

    def test_unresolved_mysqld_or_sync_worker_remains_identity_inconclusive(self):
        mysql = self._snapshot()
        mysql["processes"][0] = {
            "pid": 10, "ppid": 1, "rssKiB": 1, "cpuPercent": 0.0,
            "command": "/opt/mysql/mysqld", "argv": "/opt/mysql/mysqld",
            "executableResolution": "unavailable",
        }
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: mysql)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("mysqld identity unavailable", [item["reason"] for item in sampler.abort_reasons])

        sync = self._snapshot()
        sync["processes"][1] = {
            "pid": 20, "ppid": 1, "rssKiB": 1, "cpuPercent": 0.0,
            "command": "/opt/python", "argv": "/opt/python -m backend.scripts.sync_worker",
            "executableResolution": "unavailable",
        }
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: sync)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("sync_worker identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_unparseable_generic_processes_are_budgeted_without_allowlist_privilege(self):
        executable = os.path.realpath(sys.executable)
        loud = self._snapshot()
        loud["processes"].append({
            "pid": 92, "ppid": 1, "rssKiB": 1, "cpuPercent": 99.0,
            "command": executable, "argv": "/usr/local/bin/node unmatched'quote",
            "argvParseStatus": "UNPARSEABLE", "executablePath": executable,
            "canonicalExecutablePath": executable,
        })
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: loud)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_CONTAMINATED")
        self.assertEqual(sampler.evidence()["quiescentExternalProcesses"], [{
            "class": "external", "pid": 92, "cpuPercent": 99.0,
            "argvParseStatus": "UNPARSEABLE",
        }])

        quiet = self._snapshot()
        quiet["processes"].append({
            "pid": 93, "ppid": 1, "rssKiB": 1, "cpuPercent": 0.5,
            "command": executable, "argv": "/usr/local/bin/node unmatched'quote",
            "argvParseStatus": "UNPARSEABLE", "executablePath": executable,
            "canonicalExecutablePath": executable,
        })
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: quiet)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertIsNone(sampler.abort_status())
        self.assertEqual(sampler.evidence()["quiescentExternalProcesses"], [{
            "class": "external", "pid": 93, "cpuPercent": 0.5,
            "argvParseStatus": "UNPARSEABLE",
        }])

    def test_unparseable_plausible_mysqld_or_sync_cannot_gain_allowlist_privilege(self):
        mysql = self._snapshot()
        mysql["processes"][0]["argv"] += " unmatched'quote"
        mysql["processes"][0]["argvParseStatus"] = "UNPARSEABLE"
        mysql["processes"][0]["cpuPercent"] = 0.5
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: mysql)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("mysqld identity unavailable", [item["reason"] for item in sampler.abort_reasons])

        sync = self._snapshot()
        sync["processes"][1]["argv"] += " unmatched'quote"
        sync["processes"][1]["argvParseStatus"] = "UNPARSEABLE"
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: sync)
        sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("sync_worker identity unavailable", [item["reason"] for item in sampler.abort_reasons])

    def test_boundary_samples_use_the_single_worker_owner(self):
        callers = []
        snapshot = self._snapshot()
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: callers.append(threading.get_ident()) or snapshot)
        sampler.start()
        sampler.begin_block("sentinel")
        coverage = sampler.end_block("sentinel")
        sampler.stop()
        self.assertEqual(len(set(callers)), 1)
        self.assertGreaterEqual(coverage["sampleCount"], 2)
        self.assertLess(coverage["startedMonotonicNs"], coverage["endedMonotonicNs"])

    def test_preflight_cadence_outside_narrow_bounds_is_inconclusive(self):
        sampler = MODULE._PeakAmbientSampler(snapshot_reader=lambda: self._snapshot())
        with mock.patch.object(MODULE.time, "monotonic_ns", side_effect=(1_000_000_000, 3_000_000_000)):
            sampler._sample_once(phase="PREFLIGHT")
            sampler._sample_once(phase="PREFLIGHT")
        self.assertEqual(sampler.abort_status(), "ABORTED_INCONCLUSIVE")
        self.assertIn("ambient preflight cadence outside bounds", [reason["reason"] for reason in sampler.abort_reasons])


class AtomicAbortArtifactTest(unittest.TestCase):
    def test_peak_abort_schema_covers_load_candidate_digest_and_hook_failures(self):
        for stage in ("load", "candidate", "digest", "hook"):
            with self.subTest(stage=stage):
                artifact = MODULE._peak_atomic_abort_artifact(RuntimeError(stage))
                self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")
                self.assertFalse(artifact["candidate"]["eligible"])
                self.assertIn("sourceDigests", artifact)
                self.assertEqual(artifact["ambientTelemetry"]["preflight"]["status"], "NOT STARTED")
                self.assertEqual(artifact["selection"]["state"], "no-offline-winner")
                self.assertEqual(artifact["ambientTelemetry"]["acceptedBackgroundProcesses"], ["mysqld", "sync_worker"])

    def test_peak_abort_schema_survives_source_digest_failure(self):
        with mock.patch.object(Path, "read_bytes", side_effect=OSError("digest unavailable")):
            artifact = MODULE._peak_atomic_abort_artifact(RuntimeError("digest"))
        self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")
        self.assertTrue(any(isinstance(value, dict) and value["status"] == "UNAVAILABLE" for value in artifact["sourceDigests"].values()))

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
        self.assertEqual(artifact["runtime"]["status"], "NOT RUN")
        self.assertEqual(artifact["selection"]["state"], "no-offline-winner")
        self.assertIn("ambientTelemetry", artifact)
        self.assertIn("sourceDigests", artifact)

    def test_main_writes_atomic_abort_artifact_when_matrix_hook_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "abort-hook.json"
            old_args, old_loader, old_evaluator = MODULE.parse_args, MODULE.load_probe_module, MODULE.evaluate_peak_headroom_matrix
            self.addCleanup(lambda: setattr(MODULE, "parse_args", old_args))
            self.addCleanup(lambda: setattr(MODULE, "load_probe_module", old_loader))
            self.addCleanup(lambda: setattr(MODULE, "evaluate_peak_headroom_matrix", old_evaluator))
            MODULE.parse_args = lambda: argparse.Namespace(policy=None, matrix="relay-peak-headroom-v1", output=output)
            MODULE.load_probe_module = lambda: object()
            MODULE.evaluate_peak_headroom_matrix = lambda _probe: (_ for _ in ()).throw(RuntimeError("sentinel hook failure"))
            MODULE.main()
            artifact = json.loads(output.read_text())
        self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")
        self.assertEqual(artifact["error"]["type"], "RuntimeError")

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

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "partial-hook.json"
            old_args, old_loader, old_evaluator = MODULE.parse_args, MODULE.load_probe_module, MODULE.evaluate_peak_headroom_matrix
            self.addCleanup(lambda: setattr(MODULE, "parse_args", old_args))
            self.addCleanup(lambda: setattr(MODULE, "load_probe_module", old_loader))
            self.addCleanup(lambda: setattr(MODULE, "evaluate_peak_headroom_matrix", old_evaluator))
            MODULE.parse_args = lambda: argparse.Namespace(policy=None, matrix="relay-peak-headroom-v1", output=output)
            MODULE.load_probe_module = lambda: object()
            MODULE.evaluate_peak_headroom_matrix = lambda _probe: (_ for _ in ()).throw(raised.exception)
            MODULE.main()
            artifact = json.loads(output.read_text())
        self.assertEqual(artifact["candidate"]["prescreen"]["evidence"], {"prescreen": "observed"})
        self.assertEqual(len(artifact["ambientTelemetry"]["sentinels"]), 1)
        self.assertEqual(artifact["status"], "ABORTED_INCONCLUSIVE")


if __name__ == "__main__":
    unittest.main()
