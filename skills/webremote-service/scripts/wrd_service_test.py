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
    def test_failed_host_restart_preserves_script_diagnostics(self):
        output, errors = io.StringIO(), io.StringIO()
        failed = types.SimpleNamespace(returncode=1, stdout="preflight refused\n", stderr="registration rejected\n")
        with mock.patch.object(MODULE, "run", return_value=failed) as run, \
            mock.patch.object(MODULE, "read_text") as read_text, \
            mock.patch("sys.stdout", output), mock.patch("sys.stderr", errors):
            with self.assertRaisesRegex(RuntimeError, "Host restart failed"):
                MODULE.restart_host(Path("/tmp/fixture"))
        self.assertEqual(output.getvalue(), failed.stdout)
        self.assertEqual(errors.getvalue(), failed.stderr)
        self.assertFalse(run.call_args.kwargs["check"])
        read_text.assert_not_called()

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
        self.home = self.fixture_root / "home"
        self.home.mkdir()
        self.plist = self.home / "Library/LaunchAgents/com.webremotedesktop.signal.plist"
        self.original_job_loaded = getattr(MODULE, "signal_job_loaded", None)
        self.original_job_snapshot = getattr(MODULE, "snapshot_signal_job", None)
        patches = [
            mock.patch.dict(os.environ, {"HOME": str(self.home)}),
            mock.patch.object(MODULE, "NODE_BIN", str(self.node)),
            mock.patch.object(MODULE, "SAFE_URL_FILE", self.fixture_root / "safe-url"),
            mock.patch.object(MODULE, "SAFE_SIGNAL_PID", self.fixture_root / "signal.pid"),
            mock.patch.object(MODULE, "SAFE_HOST_PID", self.fixture_root / "host.pid"),
            mock.patch.object(MODULE, "SIGNAL_LOG", self.fixture_root / "signal.log"),
            mock.patch.object(MODULE, "signal_job_loaded", return_value=False, create=True),
            mock.patch.object(MODULE, "snapshot_signal_job", return_value=None, create=True),
            mock.patch.object(MODULE.subprocess, "run", side_effect=AssertionError("Unmocked process execution is forbidden")),
            mock.patch.object(MODULE.time, "sleep"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_valid_executable_and_entry_pass_real_filesystem_validation(self):
        MODULE.validate_signal_launch_inputs(self.project)

    def test_signal_plist_path_uses_persistent_user_launchagents_directory(self):
        self.assertEqual(MODULE.signal_plist_path(), self.plist)

    def seed_old_plist(self):
        configuration = MODULE.signal_launch_configuration(self.project)
        configuration["ThrottleInterval"] = 23
        self.plist.parent.mkdir(parents=True)
        previous = plistlib.dumps(configuration)
        self.plist.write_bytes(previous)
        self.plist.chmod(0o640)
        return previous

    def test_failed_probe_leaves_old_persistent_plist_unchanged(self):
        previous = self.seed_old_plist()
        with mock.patch.object(MODULE, "probe_signal_bootstrap", side_effect=RuntimeError("probe rejected")), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "probe rejected"):
                MODULE.restart_signal(self.project)
        stop.assert_not_called()
        self.assertEqual(self.plist.read_bytes(), previous)

    def test_failed_registration_restores_old_plist_and_loaded_job(self):
        previous = self.seed_old_plist()
        loaded_paths, loaded_bytes = [], []
        def fake_run(command, **kwargs):
            loaded_paths.append(Path(command[-1]))
            loaded_bytes.append(Path(command[-1]).read_bytes())
            if len(loaded_paths) == 1:
                raise subprocess.CalledProcessError(5, command)
            return types.SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE, "signal_job_loaded", return_value=True), \
            mock.patch.object(MODULE, "snapshot_signal_job", return_value=plistlib.loads(previous)), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=fake_run), \
            mock.patch.object(MODULE, "wait_signal_pid", return_value="5678"), \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch.object(MODULE, "launchctl_submit_signal") as legacy, \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "previous.*restored"):
                MODULE.restart_signal(self.project)
        self.assertEqual(loaded_paths, [self.plist, self.plist])
        self.assertNotEqual(loaded_bytes[0], previous)
        self.assertEqual(loaded_bytes[1], previous)
        self.assertEqual(self.plist.read_bytes(), previous)
        self.assertEqual(self.plist.stat().st_mode & 0o777, 0o640)
        legacy.assert_not_called()

    def test_staged_disk_configuration_and_loaded_argv_restore_independently(self):
        staged = self.seed_old_plist()
        old_node = self.fixture_root / "old node executable"
        old_node.write_text("#!/bin/sh\nexit 0\n")
        old_node.chmod(0o700)
        loaded = MODULE.signal_launch_configuration(self.project)
        loaded["ProgramArguments"] = [str(old_node), str(self.entry)]
        description = (f"program = {old_node}\nworking directory = {self.signal_dir.resolve()}\n"
                       f"pid = 42\narguments = {{\n{old_node}\n{self.entry}\n}}\n")
        for failure in ("bootstrap", "health"):
            registered, paths = [], []
            def fake_run(command, **kwargs):
                if command[1] == "print":
                    return types.SimpleNamespace(returncode=0, stdout=description)
                path = Path(command[-1])
                paths.append(path)
                registered.append(plistlib.loads(path.read_bytes()))
                if failure == "bootstrap" and len(registered) == 1:
                    raise subprocess.CalledProcessError(5, command)
                return types.SimpleNamespace(returncode=0)
            with self.subTest(failure=failure), \
                mock.patch.object(MODULE, "signal_job_loaded", return_value=True), \
                mock.patch.object(MODULE, "snapshot_signal_job", side_effect=self.original_job_snapshot), \
                mock.patch.object(MODULE, "pid_matches_project", return_value=True), \
                mock.patch.object(MODULE, "probe_signal_bootstrap"), \
                mock.patch.object(MODULE, "stop_existing_signal"), \
                mock.patch.object(MODULE, "run", side_effect=fake_run), \
                mock.patch.object(MODULE, "wait_signal_pid", return_value="5678"), \
                mock.patch.object(MODULE, "wait_health", side_effect=[RuntimeError("unhealthy"), None] if failure == "health" else None), \
                mock.patch.object(MODULE, "launchctl_submit_signal") as legacy, \
                mock.patch("sys.stderr", io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "previous.*restored"):
                    MODULE.restart_signal(self.project)
                self.assertEqual(registered[0]["ProgramArguments"][0], str(self.node))
                self.assertEqual(registered[1]["ProgramArguments"], loaded["ProgramArguments"])
                self.assertNotEqual(paths[1], self.plist)
                self.assertFalse(paths[1].exists())
                self.assertEqual(self.plist.read_bytes(), staged)
                self.assertEqual(self.plist.stat().st_mode & 0o777, 0o640)
                legacy.assert_not_called()

    def test_loaded_old_node_is_also_used_for_legacy_fallback(self):
        self.seed_old_plist()
        loaded = MODULE.signal_launch_configuration(self.project)
        old_node = self.fixture_root / "old node"
        old_node.write_text("#!/bin/sh\nexit 0\n")
        old_node.chmod(0o700)
        loaded["ProgramArguments"] = [str(old_node), str(self.entry)]
        with mock.patch.object(MODULE, "signal_job_loaded", return_value=True), \
            mock.patch.object(MODULE, "snapshot_signal_job", return_value=loaded), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=RuntimeError("bootstrap rejected")), \
            mock.patch.object(MODULE, "launchctl_submit_signal", return_value="5678") as legacy, \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "legacy fallback restored"):
                MODULE.restart_signal(self.project)
        legacy.assert_called_once_with(self.project, node_bin=loaded["ProgramArguments"][0])

    def test_job_snapshot_supports_literal_node_and_known_legacy_argv_only(self):
        self.assertIsNotNone(self.original_job_snapshot)
        old_node = self.fixture_root / "old node '$' executable"
        old_node.write_text("#!/bin/sh\nexit 0\n")
        old_node.chmod(0o700)
        command = (f"cd {shlex.quote(str(self.signal_dir))} && exec {shlex.quote(str(old_node))} "
                   f"server.js >> {shlex.quote(str(MODULE.SIGNAL_LOG))} 2>&1")
        direct = [str(old_node), str(self.entry)]
        legacy = ["/bin/bash", "-lc", command]
        for arguments in (direct, legacy):
            description = (f"program = {arguments[0]}\nworking directory = {self.signal_dir.resolve()}\n"
                           "pid = 42\narguments = {\n" + "\n".join(arguments) + "\n}\n")
            with self.subTest(arguments=arguments), \
                mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout=description)), \
                mock.patch.object(MODULE, "pid_matches_project", return_value=True):
                snapshot = self.original_job_snapshot(self.project)
                self.assertEqual(snapshot["ProgramArguments"], arguments)
        unknown = "program = /bin/bash\npid = 42\narguments = {\n/bin/bash\n-lc\nexec unknown-service\n}\n"
        with mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout=unknown)), \
            mock.patch.object(MODULE, "pid_matches_project", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "snapshot|ownership"):
                self.original_job_snapshot(self.project)

    def test_unadmitted_loaded_snapshot_leaves_disk_and_service_untouched(self):
        previous = self.seed_old_plist()
        with mock.patch.object(MODULE, "snapshot_signal_job", side_effect=RuntimeError("snapshot ownership unknown")), \
            mock.patch.object(MODULE, "probe_signal_bootstrap") as probe, \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "snapshot ownership unknown"):
                MODULE.restart_signal(self.project)
        self.assertEqual(self.plist.read_bytes(), previous)
        probe.assert_not_called()
        stop.assert_not_called()

    def test_legacy_snapshot_rejects_shell_expansion_in_an_existing_executable_path(self):
        node = self.fixture_root / "node$(unapproved-command)"
        node.write_text("#!/bin/sh\nexit 0\n")
        node.chmod(0o700)
        command = (f"cd {shlex.quote(str(self.signal_dir))} && exec {node} "
                   f"server.js >> {shlex.quote(str(MODULE.SIGNAL_LOG))} 2>&1")
        with self.assertRaisesRegex(RuntimeError, "shell quoting"):
            MODULE.signal_snapshot_node(["/bin/bash", "-lc", command], self.project)

    def test_loaded_job_without_persistent_file_restores_from_private_snapshot(self):
        loaded = MODULE.signal_launch_configuration(self.project)
        registered, paths = [], []
        def fake_run(command, **kwargs):
            path = Path(command[-1])
            paths.append(path)
            registered.append(plistlib.loads(path.read_bytes()))
            if len(paths) == 1:
                raise RuntimeError("candidate rejected")
            return types.SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE, "snapshot_signal_job", return_value=loaded), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=fake_run), \
            mock.patch.object(MODULE, "wait_signal_pid", return_value="5678"), \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch.object(MODULE, "launchctl_submit_signal") as legacy, \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "previous.*restored"):
                MODULE.restart_signal(self.project)
        self.assertFalse(self.plist.exists())
        self.assertNotEqual(paths[1], self.plist)
        self.assertFalse(paths[1].exists())
        self.assertEqual(registered[1], loaded)
        legacy.assert_not_called()

    def test_known_legacy_snapshot_restores_literal_old_shell_argv(self):
        staged = self.seed_old_plist()
        command = (f"cd {shlex.quote(str(self.signal_dir))} && exec {shlex.quote(str(self.node))} "
                   f"server.js >> {shlex.quote(str(MODULE.SIGNAL_LOG))} 2>&1")
        arguments = ["/bin/bash", "-lc", command]
        description = "program = /bin/bash\npid = 42\narguments = {\n" + "\n".join(arguments) + "\n}\n"
        restored = []
        def fake_run(command, **kwargs):
            if command[1] == "print":
                return types.SimpleNamespace(returncode=0, stdout=description)
            configuration = plistlib.loads(Path(command[-1]).read_bytes())
            if Path(command[-1]) == self.plist:
                raise RuntimeError("candidate rejected")
            restored.append(configuration)
            return types.SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE, "snapshot_signal_job", side_effect=self.original_job_snapshot), \
            mock.patch.object(MODULE, "pid_matches_project", return_value=True), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=fake_run), \
            mock.patch.object(MODULE, "wait_signal_pid", return_value="5678"), \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "previous.*restored"):
                MODULE.restart_signal(self.project)
        self.assertEqual(restored[0]["ProgramArguments"], arguments)
        self.assertEqual(self.plist.read_bytes(), staged)

    def test_first_failed_registration_leaves_no_broken_autostart(self):
        with mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal"), \
            mock.patch.object(MODULE, "run", side_effect=RuntimeError("bootstrap rejected")), \
            mock.patch.object(MODULE, "launchctl_submit_signal", return_value="5678"), \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "legacy fallback restored"):
                MODULE.restart_signal(self.project)
        self.assertFalse(self.plist.exists())

    def test_symlink_plist_is_rejected_without_stopping_service(self):
        self.plist.parent.mkdir(parents=True)
        canary = self.fixture_root / "canary.plist"
        canary.write_bytes(b"untouched")
        self.plist.symlink_to(canary)
        with mock.patch.object(MODULE, "probe_signal_bootstrap") as probe, \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                MODULE.restart_signal(self.project)
        probe.assert_not_called()
        stop.assert_not_called()
        self.assertEqual(canary.read_bytes(), b"untouched")

    def test_atomic_plist_replace_failure_keeps_old_service_and_configuration(self):
        previous = self.seed_old_plist()
        with mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE.os, "replace", side_effect=OSError("replace rejected")), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(OSError, "replace rejected"):
                MODULE.restart_signal(self.project)
        self.assertEqual(self.plist.read_bytes(), previous)
        stop.assert_not_called()
        self.assertEqual(list(self.plist.parent.iterdir()), [self.plist])

    def test_failed_old_job_recovery_uses_legacy_but_keeps_old_configuration(self):
        previous = self.seed_old_plist()
        errors = io.StringIO()
        with mock.patch.object(MODULE, "signal_job_loaded", return_value=True), \
            mock.patch.object(MODULE, "snapshot_signal_job", return_value=plistlib.loads(previous)), \
            mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal") as stop, \
            mock.patch.object(MODULE, "run", side_effect=RuntimeError("registration rejected")), \
            mock.patch.object(MODULE, "launchctl_submit_signal", return_value="5678") as legacy, \
            mock.patch.object(MODULE, "wait_health"), \
            mock.patch("sys.stderr", errors):
            with self.assertRaisesRegex(RuntimeError, "legacy fallback restored"):
                MODULE.restart_signal(self.project)
        self.assertEqual(self.plist.read_bytes(), previous)
        self.assertEqual(stop.call_count, 3)
        legacy.assert_called_once_with(self.project, node_bin=str(self.node))
        self.assertFalse(json.loads(errors.getvalue())["interactive_applied"])

    def test_failed_job_cleanup_still_restores_plist_and_never_starts_another_owner(self):
        previous = self.seed_old_plist()
        with mock.patch.object(MODULE, "probe_signal_bootstrap"), \
            mock.patch.object(MODULE, "stop_existing_signal", side_effect=[None, RuntimeError("ownership unknown")]), \
            mock.patch.object(MODULE, "run", side_effect=RuntimeError("registration rejected")), \
            mock.patch.object(MODULE, "launchctl_submit_signal") as legacy:
            with self.assertRaisesRegex(RuntimeError, "plist restored but job cleanup failed"):
                MODULE.restart_signal(self.project)
        self.assertEqual(self.plist.read_bytes(), previous)
        legacy.assert_not_called()

    def test_symlink_launchagents_directory_is_rejected_before_probe(self):
        self.plist.parent.parent.mkdir()
        target = self.fixture_root / "other-launchagents"
        target.mkdir()
        self.plist.parent.symlink_to(target, target_is_directory=True)
        with mock.patch.object(MODULE, "probe_signal_bootstrap") as probe, \
            mock.patch.object(MODULE, "stop_existing_signal") as stop:
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                MODULE.restart_signal(self.project)
        probe.assert_not_called()
        stop.assert_not_called()
        self.assertEqual(list(target.iterdir()), [])

    def test_local_health_and_host_wait_use_direct_bounded_curl(self):
        completed = types.SimpleNamespace(returncode=0, stdout='{"hostOnline":true}')
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            MODULE.wait_health()
            MODULE.wait_host_online()
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn("--noproxy", command)
            self.assertEqual(command[command.index("--noproxy") + 1], "*")
            self.assertEqual(command[command.index("--connect-timeout") + 1], "2")
            self.assertEqual(command[command.index("--max-time") + 1], "3")

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
        self.assertEqual(configuration["ProgramArguments"], [node, str(project / "signal-server/server.js")])
        self.assertEqual(configuration["WorkingDirectory"], str(project / "signal-server"))
        self.assertEqual(configuration["ProcessType"], "Interactive")
        self.assertEqual(configuration["RunAtLoad"], True)
        self.assertEqual(configuration["KeepAlive"], True)
        self.assertEqual(configuration["ThrottleInterval"], 10)
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
        self.assertEqual(loaded[0]["KeepAlive"], True)
        self.assertEqual(loaded[0]["ThrottleInterval"], 10)
        self.assertTrue(self.plist.is_file())
        self.assertEqual(plistlib.loads(self.plist.read_bytes()), loaded[0])
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
        self.assertEqual(calls, [])

    def test_stop_boots_out_only_the_owned_exact_signal_label(self):
        with mock.patch.object(MODULE, "signal_job_loaded", return_value=True), \
            mock.patch.object(MODULE, "reconcile_signal_pid", return_value=""), \
            mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
            MODULE.stop_existing_signal(self.project)
        self.assertEqual(run.call_args.args[0],
                         ["launchctl", "bootout", f"{MODULE.launchctl_domain()}/{MODULE.SIGNAL_LABEL}"])

    def test_stop_does_not_kill_a_pid_that_has_changed_project_owner(self):
        with mock.patch.object(MODULE, "reconcile_signal_pid", return_value="42"), \
            mock.patch.object(MODULE, "pid_alive", return_value=True), \
            mock.patch.object(MODULE, "pid_matches_project", return_value=False), \
            mock.patch.object(MODULE.subprocess, "run") as run:
            MODULE.stop_existing_signal(self.project)
        run.assert_not_called()

    def test_stop_reports_a_project_process_that_survives_termination(self):
        with mock.patch.object(MODULE, "reconcile_signal_pid", return_value="42"), \
            mock.patch.object(MODULE, "pid_alive", return_value=True), \
            mock.patch.object(MODULE, "pid_matches_project", return_value=True), \
            mock.patch.object(MODULE.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
            with self.assertRaisesRegex(RuntimeError, "did not stop"):
                MODULE.stop_existing_signal(self.project)
        self.assertEqual([call.args[0] for call in run.call_args_list], [["kill", "42"], ["kill", "-9", "42"]])

    def test_status_prefers_live_signal_pid_over_stale_pid_file(self):
        output = io.StringIO()
        host_pid = "5555"
        with mock.patch.object(MODULE, "inspect_signal_pid", return_value="4321"), \
            mock.patch.object(MODULE, "inspect_host_pid", return_value=host_pid), \
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

    def test_status_finds_host_after_reboot_without_pid_file(self):
        output = io.StringIO()
        with mock.patch.object(MODULE, "inspect_signal_pid", return_value="4321"), \
            mock.patch.object(MODULE, "inspect_host_pid", return_value="5555", create=True), \
            mock.patch.object(MODULE, "current_safe_url", return_value=""), \
            mock.patch.object(MODULE, "read_text", return_value=""), \
            mock.patch.object(MODULE, "pid_alive", return_value=True), \
            mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout='{"hostOnline": true}')) as run, \
            mock.patch("sys.stdout", output):
            MODULE.status(self.project)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["host_pid"], "5555")
        self.assertTrue(payload["host_alive"])
        self.assertTrue(payload["host_online"])
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn("--noproxy", command)
            self.assertIn("--max-time", command)

    def test_process_cwd_matching_is_exact(self):
        with mock.patch.object(MODULE.subprocess, "run", return_value=types.SimpleNamespace(
            stdout=f"p42\nn{self.signal_dir}-other-project\n")):
            self.assertFalse(MODULE.pid_matches_project("42", self.project))

    def test_host_process_discovery_filters_other_projects(self):
        completed = types.SimpleNamespace(returncode=0, stdout="41\n42\n")
        with mock.patch.object(MODULE, "run", return_value=completed) as run, \
            mock.patch.object(MODULE, "pid_cwd_matches", side_effect=[False, True]) as matches:
            self.assertEqual(MODULE.find_host_pid(self.project), "42")
        self.assertEqual(run.call_args.args[0], ["pgrep", "-f", "host\\.py"])
        self.assertEqual(matches.call_args.args, ("42", self.project / "python-host"))

    def test_inspection_does_not_trust_reused_host_or_signal_pid_files(self):
        with mock.patch.object(MODULE, "find_signal_pid", return_value=""), \
            mock.patch.object(MODULE, "find_host_pid", return_value=""), \
            mock.patch.object(MODULE, "read_text", return_value="9999") as read_text, \
            mock.patch.object(MODULE, "pid_alive", return_value=True):
            self.assertEqual(MODULE.inspect_signal_pid(self.project), "")
            self.assertEqual(MODULE.inspect_host_pid(self.project), "")
        read_text.assert_not_called()

    def test_loaded_signal_job_with_foreign_or_unknown_owner_is_refused(self):
        self.assertIsNotNone(self.original_job_loaded)
        for output in ("state = running\npid = 42\n", "working directory = /other/signal-server\n"):
            with self.subTest(output=output), \
                mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout=output)), \
                mock.patch.object(MODULE, "pid_matches_project", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "ownership"):
                    self.original_job_loaded(self.project)

    def test_loaded_signal_job_accepts_exact_project_owner_and_own_waiting_configuration(self):
        outputs = (
            "state = running\npid = 42\n",
            f"working directory = {self.signal_dir.resolve()}\narguments = {{\n{self.node}\n{self.entry}\n}}\n",
        )
        for output in outputs:
            with self.subTest(output=output), \
                mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=0, stdout=output)), \
                mock.patch.object(MODULE, "pid_matches_project", return_value=True):
                self.assertTrue(self.original_job_loaded(self.project))

    def test_missing_signal_job_is_distinct_from_failed_ownership_query(self):
        with mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=113, stderr="")):
            self.assertFalse(self.original_job_loaded(self.project))
        with mock.patch.object(MODULE, "run", return_value=types.SimpleNamespace(returncode=5, stderr="query denied")):
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                self.original_job_loaded(self.project)

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
            mock.patch.object(MODULE, "inspect_host_pid", return_value=""), \
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
