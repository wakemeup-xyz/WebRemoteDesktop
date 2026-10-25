#!/usr/bin/env python3
"""Persistent, credentials-file-only formal connector management.

Configuration generation/validation is read-only. Only the explicit ``restart``
and ``preflight`` commands may register jobs; preflight registers /usr/bin/true.
No quick tunnel state, token daemon or unrelated process is managed here.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import uuid


DEFAULT_LABEL = "com.webremotedesktop.fixed-domain"


def build_configuration(project_dir: Path) -> dict:
    project_dir = Path(project_dir).absolute()
    return {
        "Label": os.environ.get("WRD_FIXED_LABEL", DEFAULT_LABEL),
        "ProgramArguments": [
            "/bin/bash", str(project_dir / "scripts/run-fixed-domain-launchctl.sh"),
            os.environ.get("CLOUDFLARED", "/Users/macstudio1/.homebrew/bin/cloudflared"),
            os.environ.get("CLOUDFLARED_CONFIG", str(Path.home() / ".cloudflared/config.yml")),
            os.environ.get("WRD_FIXED_TUNNEL_PROTOCOL", "http2"),
            os.environ.get("WRD_FIXED_TUNNEL_NAME", "wrd-tunnel"),
        ],
        "WorkingDirectory": str(project_dir),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": os.environ.get("WRD_FIXED_DOMAIN_LOG", "/tmp/wrd-fixed-domain.log"),
        "StandardErrorPath": os.environ.get("WRD_FIXED_DOMAIN_LOG", "/tmp/wrd-fixed-domain.log"),
    }


def fixed_plist_path(configuration: dict) -> Path:
    label = configuration.get("Label", "")
    if not isinstance(label, str) or not re.fullmatch(re.escape(DEFAULT_LABEL) + r"(?:\.[A-Za-z0-9_-]+)*", label):
        raise ValueError("formal label must belong to com.webremotedesktop.fixed-domain")
    return Path.home() / "Library/LaunchAgents" / (label + ".plist")


def _absolute_path(value, description: str) -> Path:
    if not isinstance(value, str) or not value or any(c in value for c in "\0\r\n") or not Path(value).is_absolute():
        raise ValueError(description + " must be an absolute path without control characters")
    return Path(value)


def _readable_file(value, description: str, executable=False) -> Path:
    path = _absolute_path(value, description)
    if not path.is_file() or not os.access(path, os.R_OK | (os.X_OK if executable else 0)):
        raise ValueError(description + " must be a readable" + (" executable" if executable else "") + " file")
    return path


def _yaml_scalar(value: str) -> str:
    """Parse only a single literal path; never interpret YAML tags or aliases."""
    value = value.strip()
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            raise ValueError("unsupported credentials-file YAML; use a single literal absolute path") from None
        if not isinstance(parsed, str):
            raise ValueError("unsupported credentials-file YAML")
        return parsed
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise ValueError("unsupported credentials-file YAML quoting")
        return value[1:-1].replace("''", "'")
    if not value or value[0] in "&*!|>{[" or re.search(r"\s+#", value):
        raise ValueError("unsupported credentials-file YAML; use a single literal absolute path")
    return value


def _validate_credentials(config_path: Path) -> None:
    try:
        text = config_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise ValueError("cannot read cloudflared config") from None
    # A token entry anywhere in the YAML is rejected, without quoting its value.
    if re.search(r"(?mi)^\s*['\"]?(?:token|tunnel-token|token-file)['\"]?\s*:", text):
        raise ValueError("token configuration is not supported; use credentials-file")
    if re.search(r"(?m)^\s*(?:[?{\[]|<<\s*:)|:\s*[&*!]|^\s*-\s*[&*!{\[]", text):
        raise ValueError("unsupported cloudflared YAML aliases, tags or complex mappings")
    values = []
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith("#") and not re.match(r"^[A-Za-z][A-Za-z0-9_-]*\s*:", line):
            raise ValueError("unsupported cloudflared YAML; use literal top-level keys")
        if re.match(r"^credentials-file\s*:", line):
            values.append(re.sub(r"^credentials-file\s*:\s*", "", line))
        elif re.match(r"^\s+credentials-file\s*:", line):
            raise ValueError("credentials-file must be a top-level literal YAML entry")
    if len(values) != 1:
        raise ValueError("config must define exactly one top-level credentials-file")
    credential = _readable_file(_yaml_scalar(values[0]), "credentials-file")
    try:
        data = json.loads(credential.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        raise ValueError("credentials-file must contain a valid named-tunnel JSON object") from None
    if not isinstance(data, dict) or any(not isinstance(data.get(key), str) or not data[key] for key in ("AccountTag", "TunnelID", "TunnelSecret")):
        raise ValueError("credentials-file is missing named-tunnel fields")


def validate_configuration(configuration: dict) -> None:
    if not isinstance(configuration, dict):
        raise ValueError("formal configuration must be a plist dictionary")
    allowed = {"Label", "ProgramArguments", "WorkingDirectory", "RunAtLoad", "KeepAlive", "ThrottleInterval", "StandardOutPath", "StandardErrorPath"}
    if set(configuration) != allowed:
        raise ValueError("formal configuration contains missing or unsupported fields")
    fixed_plist_path(configuration)
    project = _absolute_path(configuration["WorkingDirectory"], "project directory")
    args = configuration["ProgramArguments"]
    if not isinstance(args, list) or len(args) != 6 or args[0] != "/bin/bash" or args[1] != str(project / "scripts/run-fixed-domain-launchctl.sh"):
        raise ValueError("formal arguments must use this project's literal wrapper parameters")
    if not project.is_dir():
        raise ValueError("project directory is unavailable")
    _readable_file(args[1], "formal wrapper", executable=True)
    _readable_file(args[2], "cloudflared", executable=True)
    config = _readable_file(args[3], "cloudflared config")
    if args[4] not in ("http2", "quic"):
        raise ValueError("WRD_FIXED_TUNNEL_PROTOCOL must be http2 or quic")
    if not isinstance(args[5], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args[5]):
        raise ValueError("formal tunnel name must be a literal name or UUID")
    if configuration["RunAtLoad"] is not True or configuration["KeepAlive"] is not True or configuration["ThrottleInterval"] != 10:
        raise ValueError("formal LaunchAgent requires RunAtLoad/KeepAlive and ThrottleInterval=10")
    for key in ("StandardOutPath", "StandardErrorPath"):
        _absolute_path(configuration[key], "formal log")
    _validate_credentials(config)
    _check_target(fixed_plist_path(configuration))


def _check_target(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("refusing symlink formal plist target")
    if path.exists() and not path.is_file():
        raise ValueError("formal plist target must be a regular file")
    # Do not reject macOS's system /var -> /private/var alias. Only the
    # user-controlled destination directories must be literal directories.
    for parent in (path.parent, path.parent.parent):
        if parent.is_symlink():
            raise ValueError("refusing symlink formal plist directory")
        if parent.exists() and not parent.is_dir():
            raise ValueError("formal plist directory is not a directory")


def _run(args):
    try:
        return subprocess.run(args, text=True, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("formal tool invocation failed or timed out") from None


def _domain():
    return "gui/" + str(os.getuid())


def _print_arguments(output):
    match = re.search(r"(?m)^\s*arguments = \{\s*\n(.*?)^\s*\}", output, re.S)
    if not match:
        return None
    return [line.strip() for line in match[1].splitlines() if line.strip()]


def _owned_arguments(args, configuration):
    if args == configuration["ProgramArguments"]:
        return True
    # Previous persistent wrapper versions can be restored literally. Require
    # the same project wrapper and validated credentials, never a foreign path.
    if args and len(args) == 6 and args[:2] == configuration["ProgramArguments"][:2]:
        old = dict(configuration, ProgramArguments=args)
        try:
            validate_configuration(old)
            return True
        except ValueError:
            return False
    # Migration from the former submit helper is admitted only when its entire
    # command is exactly the known credentials-file invocation and redirection.
    if not args or len(args) != 3 or args[:2] != ["/bin/zsh", "-lc"]:
        return False
    try:
        words = shlex.split(args[2])
    except ValueError:
        return False
    _, _, binary, config, protocol, name = configuration["ProgramArguments"]
    prefix = ["unset", "TUNNEL_TOKEN;", "exec", binary, "tunnel", "--config", config]
    suffix = ["run", name, ">>", configuration["StandardOutPath"], "2>&1"]
    return words == prefix + ["--protocol", protocol] + suffix or words == prefix + suffix


def validate_runtime(configuration: dict) -> dict:
    """Read-only admission. Never writes a plist or starts even a probe job."""
    validate_configuration(configuration)
    process_result = _run(["ps", "-axo", "pid=,uid=,command="])
    if process_result.returncode:
        raise ValueError("refusing restart: unable to inspect cloudflared processes")
    connectors = []
    for line in process_result.stdout.splitlines():
        match = re.match(r"\s*(\d+)\s+(\d+)\s+(.+)", line)
        if not match:
            # Fail closed if a cloudflared line cannot be attributed to a UID.
            if re.search(r"(?:^|[/\s])cloudflared\s", line) and re.search(r"\btunnel\b", line):
                raise ValueError("refusing restart: unable to confirm connector process ownership")
            continue
        pid, uid, command = match.groups()
        if not re.search(r"(?:^|[/\s])cloudflared\s", command) or not re.search(r"\btunnel\b", command):
            continue
        if re.search(r"(?:^|\s)--token(?:-file)?(?:[=\s]|$)", command):
            raise ValueError("refusing restart: token connector detected")
        if re.search(r"(?:^|\s)run(?:\s|$)", command):
            connectors.append((int(pid), int(uid)))
    if len(connectors) > 1:
        raise ValueError("refusing restart: multiple formal owners")
    result = _run(["launchctl", "print", _domain() + "/" + configuration["Label"]])
    previous = None
    if result.returncode == 0:
        args = _print_arguments(result.stdout)
        if not _owned_arguments(args, configuration):
            raise ValueError("refusing restart: loaded job ownership cannot be confirmed")
        pid_match = re.search(r"(?m)^\s*pid = (\d+)\s*$", result.stdout)
        if connectors and (pid_match is None or connectors[0] != (int(pid_match[1]), os.getuid())):
            raise ValueError("refusing restart: unmanaged connector ownership cannot be confirmed")
        previous = dict(configuration, ProgramArguments=args) if args[:2] == configuration["ProgramArguments"][:2] else {
            "Label": configuration["Label"], "ProgramArguments": args,
            "WorkingDirectory": configuration["WorkingDirectory"], "RunAtLoad": True}
    elif result.returncode != 113 and not re.search(r"could not find service|service not found", result.stdout + result.stderr, re.I):
        raise ValueError("refusing restart: unable to inspect formal launchd ownership")
    elif connectors:
        raise ValueError("refusing restart: unmanaged connector ownership cannot be confirmed")
    path = fixed_plist_path(configuration)
    previous_bytes = path.read_bytes() if path.exists() else None
    # Installation may have staged the desired plist without reloading its
    # older job. Disk bytes and loaded argv are separate rollback sources.
    if previous_bytes is not None and previous is not None:
        try:
            document = plistlib.loads(previous_bytes)
        except Exception:
            raise ValueError("refusing restart: existing formal plist is invalid") from None
        if not isinstance(document, dict):
            raise ValueError("refusing restart: existing formal plist must be a dictionary")
        if document == configuration:
            pass  # Keep the independently admitted loaded-argv snapshot.
        elif document.get("Label") == configuration["Label"] and document.get("ProgramArguments") == previous["ProgramArguments"] and document.get("WorkingDirectory") == configuration["WorkingDirectory"]:
            previous = document
        else:
            raise ValueError("refusing restart: existing plist has unknown ownership")
    return {"previous": previous, "previous_bytes": previous_bytes}


def bootstrap_probe(configuration: dict) -> None:
    label = configuration["Label"] + ".bootstrap-probe." + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="wrd-fixed-probe-") as temporary:
        path = Path(temporary) / (label + ".plist")
        path.write_bytes(plistlib.dumps({"Label": label, "ProgramArguments": ["/usr/bin/true"], "RunAtLoad": True}))
        try:
            bootstrapped = _run(["launchctl", "bootstrap", _domain(), str(path)]).returncode == 0
        except RuntimeError:
            bootstrapped = False
        # Always clean a possibly partially registered probe, using only its
        # unique label. Never touch the connector from the cleanup path.
        try:
            cleaned = _run(["launchctl", "bootout", _domain() + "/" + label]).returncode == 0
        except RuntimeError:
            cleaned = False
        if not cleaned:
            try:
                cleaned = _run(["launchctl", "remove", label]).returncode == 0
            except RuntimeError:
                cleaned = False
        if not bootstrapped or not cleaned:
            raise RuntimeError("formal bootstrap probe failed; existing connector left untouched")


def atomic_write(path: Path, content: bytes) -> None:
    _check_target(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
        _check_target(path)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _required(args, message):
    if _run(args).returncode:
        raise RuntimeError(message)


def _disabled(configuration):
    result = _run(["launchctl", "print-disabled", _domain()])
    if result.returncode:
        raise RuntimeError("unable to inspect formal LaunchAgent disabled state")
    match = re.search(r'"' + re.escape(configuration["Label"]) + r'"\s*=>\s*([^\s,;}]+)', result.stdout)
    if match is None:
        return False  # A missing override means launchd's enabled default.
    if match[1] in ("true", "disabled"):
        return True
    if match[1] in ("false", "enabled"):
        return False
    raise RuntimeError("unable to interpret formal LaunchAgent disabled state")


def restart_connector(configuration: dict) -> None:
    snapshot = validate_runtime(configuration)
    was_disabled = _disabled(configuration)
    bootstrap_probe(configuration)
    # Recheck owners after the probe; a connector appearing concurrently must
    # not be taken over. Persistent bytes are replaced only after admission.
    current = validate_runtime(configuration)
    if current != snapshot:
        raise ValueError("refusing restart: formal ownership changed during preflight")
    path = fixed_plist_path(configuration)
    old_bytes = snapshot["previous_bytes"]
    previous = snapshot["previous"]
    atomic_write(path, plistlib.dumps(configuration))
    target = _domain() + "/" + configuration["Label"]
    try:
        if previous is not None:
            _required(["launchctl", "bootout", target], "failed to stop the owned formal connector")
        _required(["launchctl", "bootstrap", _domain(), str(path)], "failed to register persistent formal connector")
        _required(["launchctl", "enable", target], "failed to enable formal connector")
        # RunAtLoad already starts an enabled job. Omit -k so this assurance
        # does not immediately bounce the newly bootstrapped connector again.
        _required(["launchctl", "kickstart", target], "failed to start formal connector")
    except RuntimeError as failure:
        # A failed command or timeout can have partially changed launchd.
        # Clean only this previously admitted label before restoring its job.
        rollback_ok = True
        try:
            cleanup = _run(["launchctl", "bootout", target])
            if cleanup.returncode:
                check = _run(["launchctl", "print", target])
                rollback_ok = check.returncode == 113 or bool(re.search(r"could not find service|service not found", check.stdout + check.stderr, re.I))
        except RuntimeError:
            rollback_ok = False
        try:
            if old_bytes is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, old_bytes)
            if was_disabled:
                _required(["launchctl", "disable", target], "previous formal disabled state could not be restored")
            if previous is not None and rollback_ok:
                # Disk bytes may be a staged new configuration, so only use
                # that file when it represents the job being restored.
                if old_bytes is not None and plistlib.loads(old_bytes) == previous:
                    _required(["launchctl", "bootstrap", _domain(), str(path)], "previous formal registration failed")
                else:
                    with tempfile.TemporaryDirectory(prefix="wrd-fixed-rollback-") as temporary:
                        restore = Path(temporary) / (configuration["Label"] + ".plist")
                        restore.write_bytes(plistlib.dumps(previous))
                        _required(["launchctl", "bootstrap", _domain(), str(restore)], "previous formal registration failed")
        except (OSError, RuntimeError):
            rollback_ok = False
        raise RuntimeError(str(failure) + ("; previous formal configuration/job restored" if rollback_ok else "; formal rollback failed; inspect the persistent plist and job")) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "preflight", "restart"))
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    try:
        configuration = build_configuration(args.project_dir)
        if args.command == "restart":
            restart_connector(configuration)
            print("persistent formal connector registered")
        else:
            validate_runtime(configuration)
            if args.command == "preflight":
                bootstrap_probe(configuration)
            print("formal " + args.command + " passed")
        return 0
    except (OSError, ValueError, RuntimeError):
        # Error messages are curated above; never print subprocess argv, raw
        # cloudflared/launchctl output, config contents or credential values.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else "formal configuration file operation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
