#!/usr/bin/env python3
"""WebRemoteDesktop service helper.

Local-only lifecycle control for signal-server and Host.
Never touches cloudflared or tunnel scripts.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


DEFAULT_PROJECT_DIR = Path(__file__).resolve().parents[3]
SAFE_URL_FILE = Path("/tmp/wrd-safe-current-url.txt")
SAFE_SIGNAL_PID = Path("/tmp/wrd-safe-signal.pid")
SAFE_HOST_PID = Path("/tmp/wrd-safe-host.pid")
SIGNAL_LOG = Path("/tmp/signal-server.log")
HOST_LOG = DEFAULT_PROJECT_DIR / "back-debug.log"
ENTRY_HEALTH_SCRIPT = DEFAULT_PROJECT_DIR / "scripts" / "wrd_entry_health.py"
NODE_BIN = os.environ.get("NODE_BIN") or "/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node"
SIGNAL_LABEL = "com.webremotedesktop.signal"


def run(cmd, cwd=None, check=True):
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def read_text(path: Path) -> str:
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return ""


def write_text(path: Path, value: str) -> None:
    path.write_text(value + "\n")


def pid_alive(pid: str) -> bool:
    return bool(pid) and pid.isdecimal() and subprocess.run(["kill", "-0", pid], check=False).returncode == 0


def current_safe_url() -> str:
    return read_text(SAFE_URL_FILE)


def url_is_reachable(url: str) -> bool:
    if not url:
        return False
    result = run([sys.executable, str(ENTRY_HEALTH_SCRIPT), "--url", url], check=False)
    if result.returncode != 0:
        return False
    try:
        return json.loads(result.stdout).get("deliverable") is True
    except (AttributeError, json.JSONDecodeError):
        return False


def launchctl_submit_signal(project_dir: Path, node_bin: str | None = None) -> str:
    """Legacy recovery path; this does not apply Interactive scheduling."""
    cmd = [
        "launchctl",
        "submit",
        "-l",
        SIGNAL_LABEL,
        "--",
        "/bin/bash",
        "-lc",
        f"cd {shlex.quote(str(project_dir / 'signal-server'))} && exec {shlex.quote(node_bin or NODE_BIN)} server.js >> {shlex.quote(str(SIGNAL_LOG))} 2>&1",
    ]
    run(cmd, cwd=project_dir)
    return wait_signal_pid(project_dir)


def wait_signal_pid(project_dir: Path) -> str:
    for _ in range(20):
        pid = find_signal_pid(project_dir)
        if pid_alive(pid):
            write_text(SAFE_SIGNAL_PID, pid)
            return pid
        time.sleep(1)
    raise RuntimeError("signal-server did not become healthy")


def launchctl_domain() -> str:
    return f"gui/{os.getuid()}"


def signal_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{SIGNAL_LABEL}.plist"


def validate_signal_plist_target(path: Path) -> None:
    for candidate in (path, path.parent, path.parent.parent):
        if candidate.is_symlink():
            raise RuntimeError("Signal LaunchAgent path must not be a symlink; existing service was left running")
    if path.exists() and not path.is_file():
        raise RuntimeError("Signal LaunchAgent path must be a regular file; existing service was left running")


def atomic_signal_plist_write(path: Path, contents: bytes, mode: int = 0o600) -> None:
    """Stage privately beside the destination, then replace it in one operation."""
    validate_signal_plist_target(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as stream:
            staged = Path(stream.name)
            os.fchmod(stream.fileno(), mode)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        validate_signal_plist_target(path)
        os.replace(staged, path)
        staged = None
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def write_private_plist(path: Path, configuration: dict) -> None:
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        plistlib.dump(configuration, stream)


def probe_signal_bootstrap(directory: Path) -> None:
    """Prove registration works before removing a healthy production service."""
    label = f"{SIGNAL_LABEL}.bootstrap-probe.{uuid.uuid4().hex}"
    path = directory / "bootstrap-probe.plist"
    write_private_plist(path, {
        "Label": label,
        "ProgramArguments": ["/usr/bin/true"],
        "RunAtLoad": True,
        "ProcessType": "Interactive",
    })
    registered = False
    try:
        result = run(["launchctl", "bootstrap", launchctl_domain(), str(path)], check=False)
        if result.returncode != 0:
            raise RuntimeError("Signal bootstrap probe failed; existing service was left running")
        registered = True
    finally:
        cleanup = run(["launchctl", "bootout", f"{launchctl_domain()}/{label}"], check=False)
        if cleanup.returncode != 0:
            cleanup = run(["launchctl", "remove", label], check=False)
            if registered and cleanup.returncode != 0:
                raise RuntimeError("Signal bootstrap probe cleanup failed; existing service was left running")


def signal_launch_configuration(project_dir: Path) -> dict:
    return {
        "Label": SIGNAL_LABEL,
        "ProgramArguments": [NODE_BIN, str(project_dir / "signal-server" / "server.js")],
        "WorkingDirectory": str(project_dir / "signal-server"),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Interactive",
        "StandardOutPath": str(SIGNAL_LOG),
        "StandardErrorPath": str(SIGNAL_LOG),
    }


def validate_signal_launch_inputs(project_dir: Path) -> None:
    """Reject unusable executable/entry paths while the old service is healthy."""
    node = Path(NODE_BIN)
    if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
        raise RuntimeError("Signal NODE_BIN must be an absolute executable file; existing service was left running")
    signal_dir = project_dir / "signal-server"
    if not signal_dir.is_absolute() or not signal_dir.is_dir() or not os.access(signal_dir, os.X_OK):
        raise RuntimeError("Signal working directory must exist and be accessible; existing service was left running")
    entry = signal_dir / "server.js"
    if not entry.is_file() or not os.access(entry, os.R_OK):
        raise RuntimeError("Signal server.js must be a readable file; existing service was left running")


def pid_cwd_matches(pid: str, directory: Path) -> bool:
    if not pid:
        return False
    cwd = subprocess.run(
        ["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"],
        check=False,
        text=True,
        capture_output=True,
    ).stdout
    return f"n{directory.resolve()}" in cwd.splitlines()


def pid_matches_project(pid: str, project_dir: Path) -> bool:
    return pid_cwd_matches(pid, project_dir / "signal-server")


def signal_job_loaded(project_dir: Path) -> bool:
    """Refuse an exact-label registration unless its project owner is known."""
    result = run(["launchctl", "print", f"{launchctl_domain()}/{SIGNAL_LABEL}"], check=False)
    if result.returncode != 0:
        diagnostic = getattr(result, "stderr", "").lower()
        if result.returncode == 113 or "could not find service" in diagnostic:
            return False
        raise RuntimeError("Cannot establish Signal LaunchAgent ownership; existing service was left running")
    description = result.stdout
    pid_match = re.search(r"^\s*pid = (\d+)\s*$", description, re.MULTILINE)
    if pid_match:
        if pid_matches_project(pid_match.group(1), project_dir):
            return True
    else:
        directory_match = re.search(r"^\s*working directory = (.+?)\s*$", description, re.MULTILINE)
        entry = str(project_dir / "signal-server" / "server.js")
        has_entry = any(line.strip() in {"server.js", entry, "1 = server.js", f"1 = {entry}"}
                        for line in description.splitlines())
        if directory_match and directory_match.group(1) == str((project_dir / "signal-server").resolve()) and has_entry:
            return True
    raise RuntimeError("Signal LaunchAgent ownership is foreign or unknown; existing service was left running")


def signal_snapshot_node(arguments: list[str], project_dir: Path) -> str:
    """Admit only the literal Node job or this helper's former submit command."""
    directory = str(project_dir / "signal-server")
    entry = str(project_dir / "signal-server" / "server.js")
    if len(arguments) == 2 and arguments[1] in {"server.js", entry}:
        node = arguments[0]
    elif len(arguments) == 3 and arguments[:2] == ["/bin/bash", "-lc"]:
        try:
            words = shlex.split(arguments[2])
        except ValueError:
            words = []
        if len(words) != 9 or words[:4] != ["cd", directory, "&&", "exec"] or words[5:] != [
                "server.js", ">>", str(SIGNAL_LOG), "2>&1"]:
            raise RuntimeError("Cannot safely snapshot legacy Signal ownership; existing service was left running")
        node = words[4]
        expected = (f"cd {shlex.quote(directory)} && exec {shlex.quote(node)} "
                    f"server.js >> {shlex.quote(str(SIGNAL_LOG))} 2>&1")
        if arguments[2] != expected:
            raise RuntimeError("Cannot safely snapshot legacy Signal shell quoting; existing service was left running")
    else:
        raise RuntimeError("Cannot safely snapshot loaded Signal arguments; existing service was left running")
    executable = Path(node)
    if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("Loaded Signal snapshot executable is unavailable; existing service was left running")
    return node


def snapshot_signal_job(project_dir: Path) -> dict | None:
    """Snapshot admitted loaded argv independently of the possibly staged plist."""
    result = run(["launchctl", "print", f"{launchctl_domain()}/{SIGNAL_LABEL}"], check=False)
    if result.returncode != 0:
        diagnostic = getattr(result, "stderr", "").lower()
        if result.returncode == 113 or "could not find service" in diagnostic:
            return None
        raise RuntimeError("Cannot establish Signal LaunchAgent ownership; existing service was left running")
    description = result.stdout
    block = re.search(r"^\s*arguments = \{\s*\n(.*?)^\s*\}", description, re.MULTILINE | re.DOTALL)
    if block is None:
        raise RuntimeError("Cannot safely snapshot loaded Signal arguments; existing service was left running")
    arguments = [re.sub(r"^\d+ = ", "", line.strip())
                 for line in block.group(1).splitlines() if line.strip()]
    signal_snapshot_node(arguments, project_dir)
    program = re.search(r"^\s*program = (.+?)\s*$", description, re.MULTILINE)
    if program and program.group(1) != arguments[0]:
        raise RuntimeError("Loaded Signal program ownership is unknown; existing service was left running")
    directory = re.search(r"^\s*working directory = (.+?)\s*$", description, re.MULTILINE)
    if arguments[:2] != ["/bin/bash", "-lc"] and (
            directory is None or directory.group(1) != str((project_dir / "signal-server").resolve())):
        raise RuntimeError("Loaded Signal working directory ownership is unknown; existing service was left running")
    pid = re.search(r"^\s*pid = (\d+)\s*$", description, re.MULTILINE)
    if pid and not pid_matches_project(pid.group(1), project_dir):
        raise RuntimeError("Loaded Signal process ownership is unknown; existing service was left running")
    return dict(signal_launch_configuration(project_dir), ProgramArguments=arguments)


def find_signal_pid(project_dir: Path) -> str:
    try:
        result = run(["pgrep", "-f", "server\\.js"], check=False)
    except Exception:
        return ""
    for pid in result.stdout.split():
        if pid_matches_project(pid, project_dir):
            return pid
    return ""


def reconcile_signal_pid(project_dir: Path) -> str:
    live_pid = find_signal_pid(project_dir)
    if live_pid and pid_alive(live_pid):
        write_text(SAFE_SIGNAL_PID, live_pid)
        return live_pid

    recorded_pid = read_text(SAFE_SIGNAL_PID)
    if recorded_pid and pid_alive(recorded_pid) and pid_matches_project(recorded_pid, project_dir):
        write_text(SAFE_SIGNAL_PID, recorded_pid)
        return recorded_pid

    SAFE_SIGNAL_PID.unlink(missing_ok=True)
    return ""


def inspect_signal_pid(project_dir: Path) -> str:
    live_pid = find_signal_pid(project_dir)
    if live_pid and pid_alive(live_pid):
        return live_pid
    return ""


def find_host_pid(project_dir: Path) -> str:
    result = run(["pgrep", "-f", "host\\.py"], check=False)
    for pid in result.stdout.split():
        if pid_cwd_matches(pid, project_dir / "python-host"):
            return pid
    return ""


def inspect_host_pid(project_dir: Path) -> str:
    live_pid = find_host_pid(project_dir)
    if live_pid and pid_alive(live_pid):
        return live_pid
    return ""


def stop_existing_signal(project_dir: Path) -> None:
    loaded = signal_job_loaded(project_dir)
    old_pid = reconcile_signal_pid(project_dir)
    if loaded:
        removed = run(["launchctl", "bootout", f"{launchctl_domain()}/{SIGNAL_LABEL}"], check=False)
        if removed.returncode != 0:
            removed = run(["launchctl", "remove", SIGNAL_LABEL], check=False)
            if removed.returncode != 0 and signal_job_loaded(project_dir):
                raise RuntimeError("Signal LaunchAgent could not be stopped")
    if old_pid and pid_alive(old_pid) and pid_matches_project(old_pid, project_dir):
        subprocess.run(["kill", old_pid], check=False)
        for _ in range(10):
            if not pid_alive(old_pid):
                break
            time.sleep(0.5)
        if pid_alive(old_pid) and pid_matches_project(old_pid, project_dir):
            subprocess.run(["kill", "-9", old_pid], check=False)
            for _ in range(10):
                if not pid_alive(old_pid):
                    break
                time.sleep(0.5)
            if pid_alive(old_pid) and pid_matches_project(old_pid, project_dir):
                raise RuntimeError("Previous signal-server process did not stop")
    SAFE_SIGNAL_PID.unlink(missing_ok=True)


def local_curl(endpoint: str) -> list[str]:
    return ["curl", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "3",
            "-fsS", f"http://127.0.0.1:8080{endpoint}"]


def host_online_response(result) -> bool:
    if result.returncode != 0:
        return False
    try:
        return json.loads(result.stdout).get("hostOnline") is True
    except (AttributeError, json.JSONDecodeError):
        return False


def wait_health() -> None:
    for _ in range(30):
        if subprocess.run(
            local_curl("/health"),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("signal-server health check failed")


def wait_host_online() -> None:
    for _ in range(30):
        result = subprocess.run(
            local_curl("/api/status"),
            check=False,
            text=True,
            capture_output=True,
        )
        if host_online_response(result):
            return
        time.sleep(1)
    raise RuntimeError("host did not reconnect")


def restart_signal(project_dir: Path) -> str:
    safe_url_before = current_safe_url()
    validate_signal_launch_inputs(project_dir)
    path = signal_plist_path()
    validate_signal_plist_target(path)
    previous = path.read_bytes() if path.exists() else None
    previous_mode = path.stat().st_mode & 0o777 if previous is not None else 0o600
    previous_job = snapshot_signal_job(project_dir)
    previous_document = None
    # Parse disk state only to select its restoration path. It never supplies
    # loaded configuration: an install-only run may have staged a newer job.
    if previous_job is not None and previous is not None:
        try:
            previous_document = plistlib.loads(previous)
        except Exception:
            pass
    configuration = plistlib.dumps(signal_launch_configuration(project_dir))
    with tempfile.TemporaryDirectory(prefix="wrd-signal-launch-") as directory:
        probe_signal_bootstrap(Path(directory))
        # Atomic installation must succeed while the old service is intact.
        atomic_signal_plist_write(path, configuration)
        try:
            stop_existing_signal(project_dir)
            run(["launchctl", "bootstrap", launchctl_domain(), str(path)])
            pid = wait_signal_pid(project_dir)
            wait_health()
        except Exception as startup_error:
            cleanup_error = None
            try:
                stop_existing_signal(project_dir)
            except Exception as error:
                cleanup_error = error
            # Never leave a failed candidate installed for the next login.
            try:
                if previous is None:
                    validate_signal_plist_target(path)
                    path.unlink(missing_ok=True)
                else:
                    atomic_signal_plist_write(path, previous, previous_mode)
            except Exception as rollback_error:
                raise RuntimeError("Interactive Signal startup failed and previous plist restoration failed") from rollback_error
            if cleanup_error is not None:
                raise RuntimeError("Interactive Signal startup failed; plist restored but job cleanup failed") from cleanup_error
            if previous_job is not None:
                try:
                    if previous_document == previous_job:
                        rollback_path = path
                    else:
                        rollback_path = Path(directory) / "signal-rollback.plist"
                        write_private_plist(rollback_path, previous_job)
                    run(["launchctl", "bootstrap", launchctl_domain(), str(rollback_path)])
                    recovered_pid = wait_signal_pid(project_dir)
                    wait_health()
                except Exception:
                    # A partial old-job bootstrap must be removed before submit.
                    try:
                        stop_existing_signal(project_dir)
                    except Exception as recovery_error:
                        raise RuntimeError("Interactive Signal startup failed; previous plist restored but recovery job cleanup failed") from recovery_error
                else:
                    print(json.dumps({"signal_pid": recovered_pid, "previous_job_restored": True,
                                      "configuration_applied": False, "health_ok": True}), file=sys.stderr)
                    raise RuntimeError("Interactive Signal startup failed; previous configuration and job restored") from startup_error
            try:
                if previous_job is None:
                    recovered_pid = launchctl_submit_signal(project_dir)
                else:
                    recovered_pid = launchctl_submit_signal(
                        project_dir, node_bin=signal_snapshot_node(previous_job["ProgramArguments"], project_dir))
                wait_health()
            except Exception as recovery_error:
                raise RuntimeError("Interactive Signal startup and legacy recovery both failed") from recovery_error
            print(json.dumps({
                "signal_pid": recovered_pid,
                "process_type": "legacy-fallback",
                "interactive_applied": False,
                "health_ok": True,
            }), file=sys.stderr)
            raise RuntimeError("Interactive Signal startup failed; legacy fallback restored service without Interactive scheduling") from startup_error
    safe_url_after = current_safe_url()
    if safe_url_before != safe_url_after:
        raise RuntimeError(f"safe URL changed during local restart: {safe_url_before} -> {safe_url_after}")
    print(json.dumps({"signal_pid": pid, "safe_url": safe_url_after or safe_url_before,
                      "process_type": "Interactive", "interactive_applied": True}, ensure_ascii=False))
    return pid


def restart_host(project_dir: Path) -> str:
    result = run([str(project_dir / "scripts" / "restart-host.sh")], cwd=project_dir, check=False)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        raise RuntimeError("Host restart failed; see the preserved restart-script output above")
    pid = read_text(SAFE_HOST_PID)
    return pid


def status(project_dir: Path) -> None:
    safe_url = current_safe_url()
    signal_pid = inspect_signal_pid(project_dir)
    host_pid = inspect_host_pid(project_dir)
    health_result = run(
        local_curl("/health"),
        check=False,
    )
    health_ok = health_result.returncode == 0
    api_result = run(local_curl("/api/status"), check=False)
    print(json.dumps({
        "signal_pid": signal_pid,
        "signal_alive": pid_alive(signal_pid),
        "host_pid": host_pid,
        "host_alive": pid_alive(host_pid),
        "safe_url": safe_url,
        "safe_url_reachable": url_is_reachable(safe_url) if safe_url else False,
        "health_ok": health_ok,
        "host_online": host_online_response(api_result),
    }, ensure_ascii=False))


def restart_local(project_dir: Path) -> None:
    safe_url_before = current_safe_url()
    restart_signal(project_dir)
    restart_host(project_dir)
    wait_host_online()
    safe_url_after = current_safe_url()
    if safe_url_before != safe_url_after:
        raise RuntimeError(f"safe URL changed during restart-local: {safe_url_before} -> {safe_url_after}")
    print(json.dumps({"safe_url": safe_url_after or safe_url_before, "host_online": True}, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "restart-local", "restart-signal", "restart-host"])
    parser.add_argument("--project-dir", default=str(DEFAULT_PROJECT_DIR))
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    if args.command == "status":
        status(project_dir)
        return 0
    if args.command == "restart-signal":
        restart_signal(project_dir)
        return 0
    if args.command == "restart-host":
        restart_host(project_dir)
        wait_host_online()
        return 0
    if args.command == "restart-local":
        restart_local(project_dir)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
