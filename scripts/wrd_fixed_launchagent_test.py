"""Isolated formal connector tests: no real launchctl, tunnel or service calls."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("fixed_launchagent", Path(__file__).with_name("wrd_fixed_launchagent.py"))
fixed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixed)


class FixedLaunchAgentTests(unittest.TestCase):
    def setUp(self):
        self.original_run = subprocess.run
        self.process_guard = patch.object(fixed.subprocess, "run", side_effect=AssertionError("unmocked subprocess forbidden in formal connector tests"))
        self.process_guard.start()
        self.tmp = tempfile.TemporaryDirectory(prefix="wrd-fixed-test-")
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.project = self.root / "project with spaces $(touch NEVER)"
        (self.project / "scripts").mkdir(parents=True)
        self.wrapper = self.project / "scripts/run-fixed-domain-launchctl.sh"
        self.wrapper.write_text(Path(__file__).with_name("run-fixed-domain-launchctl.sh").read_text() if Path(__file__).with_name("run-fixed-domain-launchctl.sh").exists() else "#!/bin/bash\n")
        self.wrapper.chmod(0o755)
        self.binary = self.root / "cloudflared"
        self.binary.write_text("#!/bin/sh\nexit 0\n")
        self.binary.chmod(0o755)
        self.credentials = self.root / "credential with spaces.json"
        self.credentials.write_text(json.dumps({"AccountTag": "fixture", "TunnelID": "fixture-id", "TunnelSecret": "SECRET-CONTENT"}))
        self.config = self.root / "config.yml"
        self.config.write_text(f'tunnel: fixture-id\ncredentials-file: "{self.credentials}"\ningress:\n  - service: http_status:404\n')
        self.env = patch.dict(os.environ, {"HOME": str(self.home), "CLOUDFLARED": str(self.binary), "CLOUDFLARED_CONFIG": str(self.config), "WRD_FIXED_TUNNEL_PROTOCOL": "http2", "WRD_FIXED_TUNNEL_NAME": "wrd-tunnel", "WRD_FIXED_LABEL": "com.webremotedesktop.fixed-domain", "WRD_FIXED_DOMAIN_LOG": str(self.root / "formal.log"), "TUNNEL_TOKEN": "INHERITED-SECRET"}, clear=True)
        self.env.start()
        self.configuration = fixed.build_configuration(self.project)
        self.calls = []
        self.loaded = None
        self.processes = ""
        self.fail_probe = False
        self.fail_register = False
        self.fail_cleanup = False
        self.failed_once = False
        self.disabled = False
        self.fail_kickstart = False

    def tearDown(self):
        self.process_guard.stop()
        self.env.stop()
        self.tmp.cleanup()

    def runner(self, args, **kwargs):
        self.calls.append(list(args))
        stdout, code = "", 0
        if args[0] == "ps":
            stdout = self.processes
        elif args[1] == "print":
            if self.loaded is None:
                stdout, code = "Could not find service", 113
            else:
                stdout = "arguments = {\n" + "\n".join(self.loaded["ProgramArguments"]) + "\n}\nworking directory = " + str(self.project) + "\npid = 444\n"
        elif args[1] == "print-disabled":
            stdout = '{"com.webremotedesktop.fixed-domain" => ' + str(self.disabled).lower() + '}'
        elif args[1] == "enable":
            self.disabled = False
        elif args[1] == "disable":
            self.disabled = True
        elif args[1] == "kickstart" and self.fail_kickstart:
            code = 5
        elif args[1] == "bootstrap":
            document = plistlib.loads(Path(args[-1]).read_bytes())
            probe = ".bootstrap-probe." in document["Label"]
            if probe and self.fail_probe:
                code = 5
            elif not probe and self.fail_register and not self.failed_once:
                self.failed_once = True
                self.loaded = document  # partially registered failure
                code = 5
            elif not probe:
                self.loaded = document
        elif args[1] in ("bootout", "remove"):
            if ".bootstrap-probe." in args[-1]:
                if self.fail_cleanup:
                    code = 5
            else:
                self.loaded = None
                self.processes = ""
        return subprocess.CompletedProcess(args, code, stdout, "")

    def install_old(self):
        old = dict(self.configuration)
        old["ThrottleInterval"] = 30
        path = fixed.fixed_plist_path(self.configuration)
        path.parent.mkdir(parents=True)
        raw = plistlib.dumps(old)
        path.write_bytes(raw)
        self.loaded = old
        self.processes = f'444 {os.getuid()} ' + " ".join([str(self.binary), "tunnel", "--config", str(self.config), "--protocol", "http2", "run", "wrd-tunnel"]) + "\n"
        return path, raw

    def restart(self):
        with patch.object(fixed.subprocess, "run", side_effect=self.runner):
            fixed.restart_connector(self.configuration)

    def test_configuration_is_persistent_and_secret_free(self):
        config = self.configuration
        fixed.validate_configuration(config)
        self.assertTrue(config["RunAtLoad"])
        self.assertTrue(config["KeepAlive"])
        self.assertEqual(config["ThrottleInterval"], 10)
        self.assertEqual(fixed.fixed_plist_path(config), self.home / "Library/LaunchAgents/com.webremotedesktop.fixed-domain.plist")
        self.assertEqual(config["ProgramArguments"], ["/bin/bash", str(self.wrapper), str(self.binary), str(self.config), "http2", "wrd-tunnel"])
        self.assertNotIn(b"SECRET", plistlib.dumps(config))

    def test_defaults_read_existing_environment(self):
        os.environ["WRD_FIXED_TUNNEL_PROTOCOL"] = "quic"
        self.assertEqual(fixed.build_configuration(self.project)["ProgramArguments"][-2], "quic")

    def test_invalid_protocol_and_relative_binary_rejected(self):
        for key, value in [("WRD_FIXED_TUNNEL_PROTOCOL", "auto"), ("CLOUDFLARED", "cloudflared"), ("WRD_FIXED_LABEL", "com.other.service"), ("WRD_FIXED_TUNNEL_NAME", "--token")]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                with self.assertRaises(ValueError):
                    fixed.validate_configuration(fixed.build_configuration(self.project))

    def test_missing_credential_and_token_config_rejected(self):
        self.credentials.unlink()
        with self.assertRaises(ValueError):
            fixed.validate_configuration(self.configuration)
        self.config.write_text('token: DO-NOT-PRINT\ncredentials-file: /missing\n')
        with self.assertRaisesRegex(ValueError, "token") as error:
            fixed.validate_configuration(self.configuration)
        self.assertNotIn("DO-NOT-PRINT", str(error.exception))

    def test_unsupported_credential_yaml_is_explicitly_rejected(self):
        for content in ['credentials-file: &value /tmp/file\n', 'credentials-file: |\n  /tmp/file\n', 'credentials-file: relative.json\n', 'credentials-file: /one\ncredentials-file: /two\n', f'credentials-file: "{self.credentials}"\n? token\n: SECRET\n']:
            with self.subTest(content=content):
                self.config.write_text(content)
                with self.assertRaises(ValueError):
                    fixed.validate_configuration(self.configuration)

    def test_symlink_target_rejected_before_tools(self):
        path = fixed.fixed_plist_path(self.configuration)
        path.parent.mkdir(parents=True)
        path.symlink_to(self.root / "foreign")
        with self.assertRaises(ValueError):
            self.restart()
        self.assertEqual(self.calls, [])

    def test_restart_persists_configuration_and_reentry_uses_same_path(self):
        self.restart()
        path = fixed.fixed_plist_path(self.configuration)
        self.assertEqual(plistlib.loads(path.read_bytes()), self.configuration)
        self.calls.clear()
        self.restart()
        real = [call for call in self.calls if call[0] == "launchctl" and call[1] == "bootstrap" and ".bootstrap-probe." not in call[-1]]
        self.assertEqual(real, [["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)]])
        self.assertFalse(any("submit" in call or "pkill" in call for call in self.calls))

    def test_probe_failure_preserves_old_job_and_bytes(self):
        path, old = self.install_old()
        self.fail_probe = True
        with self.assertRaises(RuntimeError):
            self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertIsNotNone(self.loaded)
        self.assertFalse(any(call[1] == "bootout" and call[-1].endswith("/com.webremotedesktop.fixed-domain") for call in self.calls if len(call) > 1))

    def test_probe_cleanup_failure_preserves_old_job(self):
        path, old = self.install_old()
        self.fail_cleanup = True
        with self.assertRaises(RuntimeError):
            self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertIsNotNone(self.loaded)

    def test_probe_labels_are_unique_and_removed(self):
        self.restart()
        self.restart()
        probes = [call[-1] for call in self.calls if call[:2] == ["launchctl", "remove"] and ".bootstrap-probe." in call[-1]]
        bootstraps = [call[-1] for call in self.calls if call[:2] == ["launchctl", "bootstrap"] and ".bootstrap-probe." in call[-1]]
        self.assertEqual(len(set(bootstraps)), 2)
        self.assertTrue(all(not Path(path).exists() for path in bootstraps))

    def test_failed_registration_restores_old_job_and_bytes(self):
        path, old = self.install_old()
        self.fail_register = True
        with self.assertRaisesRegex(RuntimeError, "restored"):
            self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertEqual(self.loaded["ThrottleInterval"], 30)

    def staged_configuration(self):
        path, _ = self.install_old()
        old = dict(self.loaded)
        old["ProgramArguments"] = list(old["ProgramArguments"])
        old["ProgramArguments"][-2] = "quic"
        self.loaded = old
        path.write_bytes(plistlib.dumps(self.configuration))
        return path, old

    def test_staged_desired_file_can_activate_an_older_loaded_job(self):
        path, _ = self.staged_configuration()
        self.restart()
        self.assertEqual(self.loaded, self.configuration)
        self.assertEqual(plistlib.loads(path.read_bytes()), self.configuration)

    def test_staged_file_and_older_loaded_arguments_are_restored_separately(self):
        path, old = self.staged_configuration()
        staged_bytes = path.read_bytes()
        self.fail_register = True
        with self.assertRaisesRegex(RuntimeError, "restored"):
            self.restart()
        self.assertEqual(path.read_bytes(), staged_bytes)
        self.assertEqual(self.loaded["ProgramArguments"], old["ProgramArguments"])

    def test_first_registration_failure_removes_new_autostart(self):
        self.fail_register = True
        with self.assertRaises(RuntimeError):
            self.restart()
        self.assertFalse(fixed.fixed_plist_path(self.configuration).exists())
        self.assertIsNone(self.loaded)

    def test_kickstart_failure_restores_previous_job_and_disabled_state(self):
        path, old = self.install_old()
        self.disabled = True
        self.fail_kickstart = True
        with self.assertRaisesRegex(RuntimeError, "restored"):
            self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertEqual(self.loaded["ThrottleInterval"], 30)
        self.assertTrue(self.disabled)

    def test_launchctl_disabled_states_support_boolean_and_word_output(self):
        for value, expected in [("true", True), ("false", False), ("disabled", True), ("enabled", False)]:
            with self.subTest(value=value):
                result = subprocess.CompletedProcess([], 0, '{"com.webremotedesktop.fixed-domain" => ' + value + '}', '')
                with patch.object(fixed.subprocess, "run", return_value=result):
                    self.assertEqual(fixed._disabled(self.configuration), expected)

    def test_unknown_disabled_override_refuses_before_probe_or_replacement(self):
        def unknown_state(args, **kwargs):
            if args[:2] == ["launchctl", "print-disabled"]:
                self.calls.append(list(args))
                return subprocess.CompletedProcess(args, 0, '{"com.webremotedesktop.fixed-domain" => unknown}', '')
            return self.runner(args, **kwargs)
        with patch.object(fixed.subprocess, "run", side_effect=unknown_state):
            with self.assertRaisesRegex(RuntimeError, "disabled state"):
                fixed.restart_connector(self.configuration)
        self.assertFalse(any(call[1] in ("bootstrap", "bootout", "enable", "disable", "kickstart") for call in self.calls if len(call) > 1))

    def test_registration_does_not_kill_newly_started_connector_again(self):
        self.restart()
        kicks = [call for call in self.calls if call[:2] == ["launchctl", "kickstart"]]
        self.assertEqual(kicks, [["launchctl", "kickstart", f"gui/{os.getuid()}/com.webremotedesktop.fixed-domain"]])

    def test_failed_registration_preserves_unloaded_previous_file(self):
        path, old = self.install_old()
        self.loaded = None
        self.processes = ""
        self.fail_register = True
        with self.assertRaises(RuntimeError):
            self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertIsNone(self.loaded)

    def test_legacy_submit_migrates_only_exact_project_command(self):
        _, _, binary, config, protocol, name = self.configuration["ProgramArguments"]
        command = "unset TUNNEL_TOKEN; exec " + " ".join(shlex.quote(word) for word in [binary, "tunnel", "--config", config, "--protocol", protocol, "run", name]) + " >> " + shlex.quote(self.configuration["StandardOutPath"]) + " 2>&1"
        old_args = ["/bin/zsh", "-lc", command]
        self.loaded = {"ProgramArguments": old_args}
        self.processes = f'444 {os.getuid()} ' + " ".join([binary, "tunnel", "--config", config, "--protocol", protocol, "run", name]) + "\n"
        self.fail_register = True
        with self.assertRaisesRegex(RuntimeError, "restored"):
            self.restart()
        self.assertEqual(self.loaded["ProgramArguments"], old_args)
        self.assertNotIn("KeepAlive", self.loaded)
        self.assertFalse(fixed.fixed_plist_path(self.configuration).exists())

    def test_bootstrap_timeout_still_cleans_unique_probe(self):
        path, old = self.install_old()
        def timeout_probe(args, **kwargs):
            if args[:2] == ["launchctl", "bootstrap"]:
                self.calls.append(list(args))
                raise subprocess.TimeoutExpired(args, 10)
            return self.runner(args, **kwargs)
        with patch.object(fixed.subprocess, "run", side_effect=timeout_probe):
            with self.assertRaises(RuntimeError):
                fixed.restart_connector(self.configuration)
        self.assertEqual(path.read_bytes(), old)
        self.assertTrue(any(call[:2] == ["launchctl", "bootout"] and ".bootstrap-probe." in call[-1] for call in self.calls))

    def test_persistent_file_survives_removing_probe_directory(self):
        self.restart()
        bootstrap_paths = [Path(call[-1]) for call in self.calls if call[:2] == ["launchctl", "bootstrap"]]
        self.assertTrue(any(not path.exists() for path in bootstrap_paths))
        self.assertTrue(fixed.fixed_plist_path(self.configuration).is_file())

    def test_atomic_write_failure_keeps_old_registration(self):
        path, old = self.install_old()
        with patch.object(fixed.os, "replace", side_effect=OSError("fixture write failure")):
            with self.assertRaises(OSError):
                self.restart()
        self.assertEqual(path.read_bytes(), old)
        self.assertIsNotNone(self.loaded)

    def test_token_multiple_and_unmanaged_owners_refused_without_mutation(self):
        cases = [f'1 {os.getuid()} cloudflared tunnel run --token NEVER-PRINT\n',
                 f'1 {os.getuid()} cloudflared tunnel --config /a run other\n2 {os.getuid()} cloudflared tunnel --config /b run other\n',
                 f'1 {os.getuid()} cloudflared tunnel --config /a run other\n']
        for processes in cases:
            with self.subTest(processes=processes):
                self.processes = processes
                self.calls.clear()
                with self.assertRaises(ValueError) as error:
                    self.restart()
                self.assertNotIn("NEVER-PRINT", str(error.exception))
                self.assertFalse(any(call[0] == "launchctl" and call[1] in ("bootstrap", "bootout", "remove", "enable", "kickstart") for call in self.calls))

    def test_loaded_foreign_job_is_not_stopped(self):
        self.loaded = {"ProgramArguments": ["/bin/bash", "/other/project/runner.sh"]}
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.restart()
        self.assertFalse(any(call[1] == "bootout" for call in self.calls if len(call) > 1))

    def test_connector_pid_and_uid_must_match_the_owned_job(self):
        self.install_old()
        for pid, uid in [(445, os.getuid()), (444, os.getuid() + 1)]:
            with self.subTest(pid=pid, uid=uid):
                self.processes = f'{pid} {uid} cloudflared tunnel --config /fixture run wrd-tunnel\n'
                self.calls.clear()
                with self.assertRaisesRegex(ValueError, "ownership"):
                    self.restart()
                self.assertFalse(any(call[1] == "bootout" for call in self.calls if len(call) > 1))

    def test_readonly_admission_never_registers_or_writes(self):
        with patch.object(fixed.subprocess, "run", side_effect=self.runner):
            fixed.validate_runtime(self.configuration)
        self.assertFalse(fixed.fixed_plist_path(self.configuration).exists())
        self.assertFalse(any(call[1] in ("bootstrap", "bootout", "remove", "enable", "kickstart") for call in self.calls if len(call) > 1))

    def test_wrapper_uses_literal_arguments_and_clears_token(self):
        self.binary.write_text('#!/bin/sh\n[ -z "${TUNNEL_TOKEN:-}" ] || exit 9\nprintf "%s\\n" "$@"\n')
        self.assertTrue(self.wrapper.resolve().is_relative_to(self.root.resolve()))
        self.assertTrue(self.binary.resolve().is_relative_to(self.root.resolve()))
        result = self.original_run(self.configuration["ProgramArguments"], text=True, capture_output=True, env=os.environ, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["tunnel", "--config", str(self.config), "--protocol", "http2", "run", "wrd-tunnel"])
        self.assertFalse((self.project / "NEVER").exists())


if __name__ == "__main__":
    unittest.main()
