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
    return bool(pid) and subprocess.run(["kill", "-0", pid], check=False).returncode == 0


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


def launchctl_submit_signal(project_dir: Path) -> str:
    """Legacy recovery path; this does not apply Interactive scheduling."""
    cmd = [
        "launchctl",
        "submit",
        "-l",
        SIGNAL_LABEL,
        "--",
        "/bin/bash",
        "-lc",
        f"cd {shlex.quote(str(project_dir / 'signal-server'))} && exec {shlex.quote(NODE_BIN)} server.js >> {shlex.quote(str(SIGNAL_LOG))} 2>&1",
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
        "ProgramArguments": [NODE_BIN, "server.js"],
        "WorkingDirectory": str(project_dir / "signal-server"),
        "RunAtLoad": True,
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


def pid_matches_project(pid: str, project_dir: Path) -> bool:
    if not pid:
        return False
    cwd = subprocess.run(
        ["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"],
        check=False,
        text=True,
        capture_output=True,
    ).stdout
    return str(project_dir / "signal-server") in cwd


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
    recorded_pid = read_text(SAFE_SIGNAL_PID)
    if recorded_pid and pid_alive(recorded_pid) and pid_matches_project(recorded_pid, project_dir):
        return recorded_pid
    return ""


def stop_existing_signal(project_dir: Path) -> None:
    old_pid = reconcile_signal_pid(project_dir)
    subprocess.run(["launchctl", "remove", "com.webremotedesktop.signal"], check=False)
    if old_pid and pid_alive(old_pid):
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
    SAFE_SIGNAL_PID.unlink(missing_ok=True)


def wait_health() -> None:
    for _ in range(30):
        if subprocess.run(
            ["curl", "-fsS", "http://127.0.0.1:8080/health"],
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
            ["curl", "-fsS", "http://127.0.0.1:8080/api/status"],
            check=False,
            text=True,
            capture_output=True,
        )
        if result.returncode == 0 and '"hostOnline":true' in result.stdout:
            return
        time.sleep(1)
    raise RuntimeError("host did not reconnect")


def restart_signal(project_dir: Path) -> str:
    safe_url_before = current_safe_url()
    validate_signal_launch_inputs(project_dir)
    # Both the private configuration and registration preflight exist before
    # stopping the old service. launchd retains its loaded plist after cleanup.
    with tempfile.TemporaryDirectory(prefix="wrd-signal-launch-") as directory:
        directory = Path(directory)
        path = directory / "signal.plist"
        write_private_plist(path, signal_launch_configuration(project_dir))
        probe_signal_bootstrap(directory)
        stop_existing_signal(project_dir)
        try:
            run(["launchctl", "bootstrap", launchctl_domain(), str(path)])
            pid = wait_signal_pid(project_dir)
            wait_health()
        except Exception as startup_error:
            # A failed startup must not strand the user. Remove only this
            # Signal registration, then restore the previous launch mechanism.
            stop_existing_signal(project_dir)
            try:
                recovered_pid = launchctl_submit_signal(project_dir)
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
    if safe_url_before and safe_url_after and safe_url_before != safe_url_after:
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
    host_pid = read_text(SAFE_HOST_PID)
    health_result = run(
        ["curl", "-fsS", "http://127.0.0.1:8080/health"],
        check=False,
    )
    health_ok = health_result.returncode == 0
    api_result = run(["curl", "-fsS", "http://127.0.0.1:8080/api/status"], check=False)
    print(json.dumps({
        "signal_pid": signal_pid,
        "signal_alive": pid_alive(signal_pid),
        "host_pid": host_pid,
        "host_alive": pid_alive(host_pid),
        "safe_url": safe_url,
        "safe_url_reachable": url_is_reachable(safe_url) if safe_url else False,
        "health_ok": health_ok,
        "host_online": '"hostOnline":true' in api_result.stdout if api_result.returncode == 0 else False,
    }, ensure_ascii=False))


def restart_local(project_dir: Path) -> None:
    safe_url_before = current_safe_url()
    restart_signal(project_dir)
    restart_host(project_dir)
    wait_host_online()
    safe_url_after = current_safe_url()
    if safe_url_before and safe_url_after and safe_url_before != safe_url_after:
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
