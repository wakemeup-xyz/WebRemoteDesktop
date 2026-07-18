import importlib.util
import io
import json
import types
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("wrd_service.py")
SPEC = importlib.util.spec_from_file_location("wrd_service_under_test", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WrdServiceTest(unittest.TestCase):
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
