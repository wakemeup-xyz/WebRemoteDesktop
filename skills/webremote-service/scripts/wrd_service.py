#!/usr/bin/env python3
"""WebRemoteDesktop service helper.

Local-only lifecycle control for signal-server and Host.
Never touches cloudflared or tunnel scripts.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_PROJECT_DIR = Path(__file__).resolve().parents[3]
SAFE_URL_FILE = Path("/tmp/wrd-safe-current-url.txt")
SAFE_SIGNAL_PID = Path("/tmp/wrd-safe-signal.pid")
SAFE_HOST_PID = Path("/tmp/wrd-safe-host.pid")
SIGNAL_LOG = Path("/tmp/signal-server.log")
HOST_LOG = DEFAULT_PROJECT_DIR / "back-debug.log"
NODE_BIN = os.environ.get("NODE_BIN") or "/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node"


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
    return subprocess.run(["curl", "-I", "-L", "--max-time", "10", url], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def launchctl_submit_signal(project_dir: Path) -> str:
    cmd = [
        "launchctl",
        "submit",
        "-l",
        "com.webremotedesktop.signal",
        "--",
        "/bin/bash",
        "-lc",
        f"cd {project_dir / 'signal-server'} && exec {NODE_BIN!r} server.js >> /tmp/signal-server.log 2>&1",
    ]
    run(cmd, cwd=project_dir)
    for _ in range(20):
        pid = find_signal_pid(project_dir)
        if pid_alive(pid):
            write_text(SAFE_SIGNAL_PID, pid)
            return pid
        time.sleep(1)
    raise RuntimeError("signal-server did not become healthy")


def find_signal_pid(project_dir: Path) -> str:
    try:
        result = run(["pgrep", "-f", "server\\.js"], check=False)
    except Exception:
        return ""
    for pid in result.stdout.split():
        cwd = subprocess.run(
            ["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"],
            check=False,
            text=True,
            capture_output=True,
        ).stdout
        if str(project_dir / "signal-server") in cwd:
            return pid
    return ""


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
    pid = launchctl_submit_signal(project_dir)
    wait_health()
    safe_url_after = current_safe_url()
    if safe_url_before and safe_url_after and safe_url_before != safe_url_after:
        raise RuntimeError(f"safe URL changed during local restart: {safe_url_before} -> {safe_url_after}")
    print(json.dumps({"signal_pid": pid, "safe_url": safe_url_after or safe_url_before}, ensure_ascii=False))
    return pid


def restart_host(project_dir: Path) -> str:
    result = run([str(project_dir / "scripts" / "restart-host.sh")], cwd=project_dir)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    pid = read_text(SAFE_HOST_PID)
    return pid


def status(project_dir: Path) -> None:
    safe_url = current_safe_url()
    signal_pid = read_text(SAFE_SIGNAL_PID)
    host_pid = read_text(SAFE_HOST_PID)
    health_ok = subprocess.run(
        ["curl", "-fsS", "http://127.0.0.1:8080/health"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0
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
