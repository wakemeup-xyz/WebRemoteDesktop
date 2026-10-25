"""Offline tests: never install into the operator's HOME or run launchctl."""
import importlib.util
import os
import plistlib
import tempfile
import unittest
import subprocess
import urllib.request
import io
import json
import types
from pathlib import Path
from unittest import mock


ENTRY = Path(__file__).with_name("install-reboot-autostart.py")


class RebootAutostartTest(unittest.TestCase):
    def setUp(self):
        guard = mock.patch.object(subprocess, "run", side_effect=AssertionError("real subprocess forbidden in unit tests"))
        guard.start()
        self.addCleanup(guard.stop)
        network_guard = mock.patch.object(urllib.request.OpenerDirector, "open", side_effect=AssertionError("real network forbidden"))
        network_guard.start()
        self.addCleanup(network_guard.stop)
        spec = importlib.util.spec_from_file_location("reboot_autostart_under_test", ENTRY)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory(prefix="wrd-autostart-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.directory = self.root / "home name" / "Library" / "LaunchAgents"
        self.configs = {
            label: {"Label": label, "ProgramArguments": ["/usr/bin/true"],
                    "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10}
            for label in ("com.webremotedesktop.signal", "com.webremotedesktop.fixed-domain")
        }

    def test_install_persists_in_home_and_never_runs_tools(self):
        with mock.patch.object(self.module.subprocess, "run", side_effect=AssertionError("lifecycle forbidden")):
            installed = self.module.install_configurations(self.configs, self.directory)
        self.assertEqual(len(installed), 2)
        for label, expected in self.configs.items():
            path = self.directory / f"{label}.plist"
            self.assertEqual(plistlib.loads(path.read_bytes()), expected)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        # A fresh interpreter only needs durable files; no run directory/PID cache.
        self.assertTrue(all(row["matches"] for row in self.module.inspect_configurations(self.configs, self.directory)))

    def test_second_install_is_idempotent(self):
        self.module.install_configurations(self.configs, self.directory)
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.directory.iterdir()}
        self.module.install_configurations(self.configs, self.directory)
        after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.directory.iterdir()}
        self.assertEqual(before, after)

    def test_partial_write_failure_restores_previous_bytes_and_absence(self):
        self.directory.mkdir(parents=True)
        first = self.directory / "com.webremotedesktop.signal.plist"
        old = plistlib.dumps({"Label": "old-config"})
        first.write_bytes(old)
        first.chmod(0o640)
        real_write = self.module.atomic_write
        def fail_second(path, data, mode=0o600):
            if path.name == "com.webremotedesktop.fixed-domain.plist":
                raise OSError("fixture write failure")
            return real_write(path, data, mode)
        with mock.patch.object(self.module, "atomic_write", side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, "restored"):
                self.module.install_configurations(self.configs, self.directory)
        self.assertEqual(first.read_bytes(), old)
        self.assertEqual(first.stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.directory / "com.webremotedesktop.fixed-domain.plist").exists())

    def test_symlink_destination_rejected_before_any_write(self):
        self.directory.mkdir(parents=True)
        target = self.root / "untouched"
        target.write_text("sentinel")
        (self.directory / "com.webremotedesktop.fixed-domain.plist").symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.module.install_configurations(self.configs, self.directory)
        self.assertEqual(target.read_text(), "sentinel")
        self.assertFalse((self.directory / "com.webremotedesktop.signal.plist").exists())

    def test_check_is_read_only_even_for_malformed_or_missing_plist(self):
        with mock.patch.object(self.module.subprocess, "run", side_effect=AssertionError("tools forbidden")):
            rows = self.module.inspect_configurations(self.configs, self.directory)
        self.assertTrue(all(not row["matches"] for row in rows))
        self.assertFalse(self.directory.exists())
        self.directory.mkdir(parents=True)
        (self.directory / "com.webremotedesktop.signal.plist").write_text("malformed")
        self.assertFalse(self.module.inspect_configurations(self.configs, self.directory)[0]["matches"])

    def test_truncated_xml_does_not_abort_other_configuration_checks(self):
        self.directory.mkdir(parents=True)
        (self.directory / "com.webremotedesktop.signal.plist").write_text(
            '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key>')
        rows = self.module.inspect_configurations(self.configs, self.directory)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(not row["matches"] for row in rows))

    def test_persistent_write_failure_keeps_preexisting_private_recovery_copy(self):
        self.directory.mkdir(parents=True)
        first = self.directory / "com.webremotedesktop.signal.plist"
        before = plistlib.dumps({"Label": "old"})
        first.write_bytes(before)
        original = self.module.atomic_write
        count = 0
        def fail_after_first(path, data, mode=0o600):
            nonlocal count
            count += 1
            if count > 1:
                raise OSError("persistent simulated disk write failure")
            return original(path, data, mode)
        with mock.patch.object(self.module, "atomic_write", side_effect=fail_after_first):
            with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
                self.module.install_configurations(self.configs, self.directory)
        backups = list(self.directory.parent.glob('.wrd-autostart-backup-*'))
        self.assertEqual(len(backups), 1)
        saved = backups[0] / first.name
        self.assertEqual(saved.read_bytes(), before)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)

    def test_invalid_label_rejected_before_directory_creation(self):
        with self.assertRaises(ValueError):
            self.module.install_configurations({"../escape": {"Label": "../escape"}}, self.directory)
        self.assertFalse(self.directory.exists())

    def test_literal_parameters_round_trip_without_shell_expansion(self):
        sentinel = self.root / "must-not-exist"
        self.configs["com.webremotedesktop.signal"]["ProgramArguments"] = [
            "/tmp/node with spaces", f"$(touch {sentinel})", "quote'\"&<>"
        ]
        self.module.install_configurations(self.configs, self.directory)
        config = plistlib.loads((self.directory / "com.webremotedesktop.signal.plist").read_bytes())
        self.assertEqual(config, self.configs["com.webremotedesktop.signal"])
        self.assertFalse(sentinel.exists())

    def test_build_all_five_jobs_uses_the_current_checkout(self):
        project = Path(__file__).resolve().parents[1]
        configs = self.module.build_configurations(project, validate=False)
        self.assertEqual(set(configs), self.module.MANAGED_LABELS)
        for label, config in configs.items():
            self.assertEqual(config["Label"], label)
            self.assertTrue(config["RunAtLoad"])
            self.assertTrue(config["KeepAlive"])
            self.assertNotIn("TUNNEL_TOKEN", config.get("EnvironmentVariables", {}))
        self.assertEqual(configs["com.webremotedesktop.host"]["ProgramArguments"][0], str(project / "scripts/run-host-launchctl.sh"))
        self.assertEqual(configs["com.webremotedesktop.signal"]["WorkingDirectory"], str(project / "signal-server"))

    def test_runtime_disabled_accepts_both_macos_renderings_and_unknown_stays_unknown(self):
        for value, expected in (("disabled", True), ("enabled", False), ("true", True), ("false", False), ("new-format", None)):
            def fake_run(command, **kwargs):
                if command[1] == "print-disabled":
                    return types.SimpleNamespace(returncode=0, stdout=f'"com.webremotedesktop.signal" => {value}', stderr="")
                return types.SimpleNamespace(returncode=113, stdout="", stderr="missing")
            with self.subTest(value=value), mock.patch.object(self.module.subprocess, "run", side_effect=fake_run):
                snapshot = self.module.runtime_snapshot()
            row = next(row for row in snapshot["jobs"] if row["label"] == "com.webremotedesktop.signal")
            self.assertIs(row["disabled"], expected)
            self.assertFalse(row["loaded"])
            self.assertFalse(snapshot["health_ok"])

    def test_check_exit_status_does_not_claim_ready_when_runtime_is_down(self):
        output = io.StringIO()
        with mock.patch.object(self.module, "build_configurations", return_value=self.configs), \
             mock.patch.object(self.module, "inspect_configurations", return_value=[{"matches": True}]), \
             mock.patch.object(self.module, "runtime_snapshot", return_value={"jobs": [], "health_ok": False, "host_online": False}), \
             mock.patch("sys.stdout", output):
            self.assertEqual(self.module.main(["--check"]), 1)
        self.assertFalse(json.loads(output.getvalue())["ready"])


if __name__ == "__main__":
    unittest.main()
