import importlib.util
import io
import json
import os
import plistlib
import shlex
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("wrd_service.py")
SPEC = importlib.util.spec_from_file_location("wrd_service_under_test", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WrdServiceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wrd-service-fixture-")
        self.addCleanup(temporary.cleanup)
        self.fixture_root = Path(temporary.name)
        self.project = self.fixture_root / "project name"
        self.signal_dir = self.project / "signal-server"
        self.signal_dir.mkdir(parents=True)
        self.entry = self.signal_dir / "server.js"
        self.entry.write_text("// Isolated startup validation fixture.\n")
        self.node = self.fixture_root / "node executable"
        self.node.write_text("#!/bin/sh\nexit 0\n")
        self.node.chmod(0o700)
        node_patch = mock.patch.object(MODULE, "NODE_BIN", str(self.node))
        node_patch.start()
        self.addCleanup(node_patch.stop)

    def test_valid_executable_and_entry_pass_real_filesystem_validation(self):
        MODULE.validate_signal_launch_inputs(self.project)

    def test_unreadable_entry_keeps_old_signal_running(self):
        self.entry.chmod(0o000)
        if os.access(self.entry, os.R_OK):
            self.skipTest("Current user can read mode-000 files")
        with mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "probe_signal_bootstrap") as probe, \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "server.js must be a readable file"):
                MODULE.restart_signal(self.project)
        probe.assert_not_called()
        stop.assert_not_called()

    def test_invalid_launch_paths_never_probe_stop_or_attempt_fallback(self):
        cases = (
            ("missing-node", "NODE_BIN"),
            ("relative-node", "NODE_BIN"),
            ("directory-node", "NODE_BIN"),
            ("nonexecutable-node", "NODE_BIN"),
            ("missing-working-directory", "working directory"),
            ("missing-entry", "server.js"),
            ("directory-entry", "server.js"),
        )
        for case, expected in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="wrd-service-invalid-test-") as directory:
                root = Path(directory)
                project = root / "project"
                signal_dir = project / "signal-server"
                signal_dir.mkdir(parents=True)
                entry = signal_dir / "server.js"
                entry.write_text("// Fixture.\n")
                node = root / "node"
                node.write_text("#!/bin/sh\nexit 0\n")
                node.chmod(0o700)
                if case == "missing-node":
                    node.unlink()
                elif case == "relative-node":
                    node = Path("relative-node")
                elif case == "directory-node":
                    node.unlink()
                    node.mkdir()
                elif case == "nonexecutable-node":
                    node.chmod(0o600)
                elif case == "missing-working-directory":
                    entry.unlink()
                    signal_dir.rmdir()
                elif case == "missing-entry":
                    entry.unlink()
                elif case == "directory-entry":
                    entry.unlink()
                    entry.mkdir()
                with mock.patch.object(MODULE, "NODE_BIN", str(node)), \
                    mock.patch.object(MODULE, "current_safe_url", return_value=""), \
                    mock.patch.object(MODULE, "probe_signal_bootstrap") as probe, \
                    mock.patch.object(MODULE, "stop_existing_signal") as stop, \
                    mock.patch.object(MODULE, "launchctl_submit_signal") as legacy:
                    with self.assertRaisesRegex(RuntimeError, expected):
                        MODULE.restart_signal(project)
                probe.assert_not_called()
                stop.assert_not_called()
                legacy.assert_not_called()

    def test_signal_launch_configuration_uses_literal_arguments_and_interactive_type(self):
        project = Path("/tmp/project name; $(not-a-command)")
        node = "/tmp/node name'$(not-a-command)"
        with mock.patch.object(MODULE, "NODE_BIN", node):
            configuration = MODULE.signal_launch_configuration(project)
        self.assertEqual(configuration["ProgramArguments"], [node, "server.js"])
        self.assertEqual(configuration["WorkingDirectory"], str(project / "signal-server"))
        self.assertEqual(configuration["ProcessType"], "Interactive")
        self.assertEqual(configuration["RunAtLoad"], True)
        self.assertNotIn("KeepAlive", configuration)
        self.assertEqual(configuration["StandardOutPath"], str(MODULE.SIGNAL_LOG))
        self.assertEqual(configuration["StandardErrorPath"], str(MODULE.SIGNAL_LOG))

    def test_bootstrap_probe_is_private_unique_and_cleans_its_own_label(self):
        captured = []
        def fake_run(command, **kwargs):
            captured.append(command)
            if command[1] == "bootstrap":
                path = Path(command[-1])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                configuration = plistlib.loads(path.read_bytes())
                self.assertEqual(configuration["ProgramArguments"], ["/usr/bin/true"])
                self.assertEqual(configuration["ProcessType"], "Interactive")
                self.assertNotEqual(configuration["Label"], MODULE.SIGNAL_LABEL)
            return types.SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory(prefix="wrd-service-probe-test-") as directory, \
            mock.patch.object(MODULE, "run", side_effect=fake_run):
            MODULE.probe_signal_bootstrap(Path(directory))
        self.assertEqual(captured[0][1], "bootstrap")
        self.assertEqual(captured[1][1], "bootout")
        self.assertIn(MODULE.SIGNAL_LABEL + ".bootstrap-probe.", captured[1][-1])

    def test_probe_failure_keeps_old_signal_running(self):
        with mock.patch.object(MODULE, "current_safe_url", return_value="https://unchanged.invalid"), \
            mock.patch.object(MODULE, "probe_signal_bootstrap", side_effect=RuntimeError("probe rejected")), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop, \
            mock.patch.object(MODULE, "launchctl_submit_signal") as legacy:
            with self.assertRaisesRegex(RuntimeError, "probe rejected"):
                MODULE.restart_signal(self.project)
        stop.assert_not_called()
        legacy.assert_not_called()

    def test_probe_rejection_boots_out_only_its_unique_label(self):
        calls = []
        def fake_run(command, **kwargs):
            calls.append(command)
            return types.SimpleNamespace(returncode=5 if command[1] == "bootstrap" else 0)
        with tempfile.TemporaryDirectory(prefix="wrd-service-rejected-probe-test-") as directory, \
            mock.patch.object(MODULE, "run", side_effect=fake_run):
            with self.assertRaisesRegex(RuntimeError, "existing service was left running"):
                MODULE.probe_signal_bootstrap(Path(directory))
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1][-1].startswith(MODULE.launchctl_domain() + "/" + MODULE.SIGNAL_LABEL + ".bootstrap-probe."))

    def test_unconfirmed_probe_cleanup_keeps_old_signal_running(self):
        def fake_run(command, **kwargs):
            return types.SimpleNamespace(returncode=0 if command[1] == "bootstrap" else 5)
        with mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "run", side_effect=fake_run), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "probe cleanup failed; existing service was left running"):
                MODULE.restart_signal(self.project)
        stop.assert_not_called()

    def test_restart_bootstraps_interactive_after_probe_and_preserves_safe_url(self):
        order, loaded = [], []
        output = io.StringIO()
        def fake_run(command, **kwargs):
            self.assertEqual(command[:2], ["launchctl", "bootstrap"])
            path = Path(command[-1])
            loaded.append(plistlib.loads(path.read_bytes()))
            order.append("bootstrap")
            return types.SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory(prefix="wrd-service-restart-test-") as directory:
            safe_file = Path(directory) / "safe-url.txt"
            safe_file.write_text("https://unchanged.invalid\n")
            with mock.patch.object(MODULE, "SAFE_URL_FILE", safe_file), \
                mock.patch.object(MODULE, "probe_signal_bootstrap", side_effect=lambda _: order.append("probe")), \
                mock.patch.object(MODULE, "stop_existing_signal", side_effect=lambda _: order.append("stop")), \
                mock.patch.object(MODULE, "run", side_effect=fake_run), \
                mock.patch.object(MODULE, "wait_signal_pid", return_value="1234"), \
                mock.patch.object(MODULE, "wait_health", side_effect=lambda: order.append("health")), \
                mock.patch.object(MODULE, "launchctl_submit_signal") as legacy, \
                mock.patch("sys.stdout", output):
                self.assertEqual(MODULE.restart_signal(self.project), "1234")
            self.assertEqual(safe_file.read_text(), "https://unchanged.invalid\n")
        self.assertEqual(order, ["probe", "stop", "bootstrap", "health"])
        self.assertEqual(loaded[0]["ProcessType"], "Interactive")
        self.assertEqual(loaded[0]["Label"], MODULE.SIGNAL_LABEL)
        self.assertNotIn("KeepAlive", loaded[0])
        legacy.assert_not_called()
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["process_type"], "Interactive")
        self.assertEqual(payload["interactive_applied"], True)

    def test_failed_bootstrap_restores_legacy_and_reports_fallback_as_failure(self):
        errors = io.StringIO()
        with mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop, \
            mock.patch.object(MODULE, "run", side_effect=subprocess.CalledProcessError(5, ["launchctl", "bootstrap"])), \
            mock.patch.object(MODULE, "launchctl_submit_signal", return_value="5678") as legacy, \
            mock.patch.object(MODULE, "wait_health") as health, \
            mock.patch("sys.stderr", errors):
            with self.assertRaisesRegex(RuntimeError, "legacy fallback restored service without Interactive"):
                MODULE.restart_signal(self.project)
        self.assertEqual(stop.call_count, 2)
        legacy.assert_called_once_with(self.project)
        health.assert_called_once_with()
        evidence = json.loads(errors.getvalue())
        self.assertEqual(evidence["signal_pid"], "5678")
        self.assertEqual(evidence["process_type"], "legacy-fallback")
        self.assertEqual(evidence["interactive_applied"], False)

    def test_unhealthy_bootstrap_also_restores_previous_launch_mechanism(self):
        with mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop, \
            mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0)), \
            mock.patch.object(MODULE, "wait_signal_pid", return_value="1234"), \
            mock.patch.object(MODULE, "launchctl_submit_signal", return_value="5678") as legacy, \
            mock.patch.object(MODULE, "wait_health", side_effect=[RuntimeError("unhealthy"), None]), \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "legacy fallback restored"):
                MODULE.restart_signal(self.project)
        self.assertEqual(stop.call_count, 2)
        legacy.assert_called_once_with(self.project)

    def test_failed_legacy_recovery_never_claims_service_is_healthy(self):
        errors = io.StringIO()
        with mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=RuntimeError("bootstrap failed")), \
            mock.patch.object(MODULE, "launchctl_submit_signal", side_effect=RuntimeError("recovery failed")), \
            mock.patch("sys.stderr", errors):
            with self.assertRaisesRegex(RuntimeError, "startup and legacy recovery both failed"):
                MODULE.restart_signal(self.project)
        self.assertEqual(errors.getvalue(), "")

    def test_legacy_fallback_quotes_shell_paths_without_expanding_them(self):
        project = Path("/tmp/project name;$(not-a-command)")
        node = "/tmp/node '$(not-a-command)"
        with mock.patch.object(MODULE, "NODE_BIN", node), \
            mock.patch.object(MODULE, "run") as run, \
            mock.patch.object(MODULE, "wait_signal_pid", return_value="1234"):
            self.assertEqual(MODULE.launchctl_submit_signal(project), "1234")
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["launchctl", "submit", "-l", MODULE.SIGNAL_LABEL])
        shell_words = shlex.split(command[-1])
        self.assertEqual(shell_words[1], str(project / "signal-server"))
        self.assertEqual(shell_words[4], node)

    def test_reconcile_signal_pid_ignores_reused_stale_pid_file(self):
        pid_file = mock.Mock()
        with mock.patch.object(MODULE, "SAFE_SIGNAL_PID", pid_file), \
            mock.patch.object(MODULE, "find_signal_pid", return_value=""), \
            mock.patch.object(MODULE, "read_text", return_value="9999"), \
            mock.patch.object(MODULE, "pid_alive", return_value=True), \
            mock.patch.object(MODULE, "pid_matches_project", return_value=False), \
            mock.patch.object(MODULE, "write_text") as write_text:
            resolved = MODULE.reconcile_signal_pid(Path("/tmp/project"))

        self.assertEqual(resolved, "")
        pid_file.unlink.assert_called_once_with(missing_ok=True)
        write_text.assert_not_called()

    def test_stop_existing_signal_skips_kill_when_no_reconciled_pid(self):
        with mock.patch.object(MODULE, "reconcile_signal_pid", return_value=""), \
            mock.patch.object(MODULE, "subprocess") as subprocess_mock, \
            mock.patch.object(MODULE, "SAFE_SIGNAL_PID", mock.Mock()):
            subprocess_mock.run.return_value = types.SimpleNamespace(returncode=0, stdout="")
            MODULE.stop_existing_signal(Path("/tmp/project"))

        calls = [call.args[0] for call in subprocess_mock.run.call_args_list]
        self.assertEqual(calls, [["launchctl", "remove", "com.webremotedesktop.signal"]])

    def test_status_prefers_live_signal_pid_over_stale_pid_file(self):
        output = io.StringIO()
        host_pid = "5555"
        with mock.patch.object(MODULE, "inspect_signal_pid", return_value="4321"), \
            mock.patch.object(MODULE, "current_safe_url", return_value="https://example.trycloudflare.com"), \
            mock.patch.object(MODULE, "read_text", return_value=host_pid), \
            mock.patch.object(MODULE, "pid_alive", side_effect=lambda pid: pid in {"4321", host_pid}), \
            mock.patch.object(MODULE, "url_is_reachable", return_value=True), \
            mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout='{"hostOnline":true}')), \
            mock.patch("sys.stdout", output):
            MODULE.status(Path("/tmp/project"))

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["signal_pid"], "4321")
        self.assertEqual(payload["signal_alive"], True)
        self.assertEqual(payload["host_pid"], host_pid)
        self.assertEqual(payload["host_online"], True)

    def test_url_is_reachable_uses_canonical_entry_health_cli(self):
        completed = types.SimpleNamespace(returncode=0, stdout='{"deliverable":true}', stderr="")
        with mock.patch.object(MODULE, "run", return_value=completed) as run:
            reachable = MODULE.url_is_reachable("https://example.trycloudflare.com")

        self.assertTrue(reachable)
        command = run.call_args.args[0]
        self.assertEqual(command[0], MODULE.sys.executable)
        self.assertIn("wrd_entry_health.py", command[1])
        self.assertEqual(command[-2:], ["--url", "https://example.trycloudflare.com"])

    def test_status_does_not_reconcile_or_write_pid_files(self):
        output = io.StringIO()
        with mock.patch.object(MODULE, "inspect_signal_pid", return_value=""), \
            mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "read_text", return_value=""), \
            mock.patch.object(MODULE, "pid_alive", return_value=False), \
            mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=1, stdout="")), \
            mock.patch.object(MODULE, "write_text") as write_text, \
            mock.patch("sys.stdout", output):
            MODULE.status(Path("/tmp/project"))

        write_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
