#!/usr/bin/env python3
"""Inspect or persist user LaunchAgents, without activating any service."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from xml.parsers.expat import ExpatError


PROJECT = Path(__file__).resolve().parents[1]
MANAGED_LABELS = frozenset(f"com.webremotedesktop.{name}" for name in
                           ("signal", "host", "fixed-domain", "awake", "fixed-watch"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_configurations(project_dir: Path, *, validate=True) -> dict:
    project_dir = project_dir.resolve()
    service = load_module("wrd_service_config", project_dir / "skills/webremote-service/scripts/wrd_service.py")
    formal = load_module("wrd_formal_config", project_dir / "scripts/wrd_fixed_launchagent.py")
    configs = {"com.webremotedesktop.signal": service.signal_launch_configuration(project_dir),
               "com.webremotedesktop.fixed-domain": formal.build_configuration(project_dir)}
    scripts = {"host": "run-host-launchctl.sh", "awake": "run-awake-keeper.sh",
               "fixed-watch": "watch-fixed-domain.sh"}
    for name, script in scripts.items():
        label = f"com.webremotedesktop.{name}"
        config = plistlib.loads((project_dir / "launchd" / f"{label}.plist").read_bytes())
        config["ProgramArguments"] = [str(project_dir / "scripts" / script)]
        if "WorkingDirectory" in config:
            config["WorkingDirectory"] = str(project_dir)
        configs[label] = config
        if validate:
            target = Path(config["ProgramArguments"][0])
            if not target.is_file() or not os.access(target, os.X_OK):
                raise ValueError(f"LaunchAgent wrapper must be executable: {target}")
    if validate:
        service.validate_signal_launch_inputs(project_dir)
        formal.validate_configuration(configs["com.webremotedesktop.fixed-domain"])
        if not (project_dir / "signal-server/.env").is_file():
            raise ValueError("signal-server/.env is required; no credentials are written to plist")
    return configs


def paths_for(configurations: dict, directory: Path):
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError("LaunchAgents directory must not be a symlink")
    paths = {}
    for label, config in configurations.items():
        if label not in MANAGED_LABELS or config.get("Label") != label:
            raise ValueError("unmanaged or mismatched LaunchAgent label")
        path = directory / f"{label}.plist"
        if path.is_symlink():
            raise ValueError(f"refusing symlink destination: {label}")
        if path.exists() and not path.is_file():
            raise ValueError(f"LaunchAgent destination is not a regular file: {label}")
        paths[label] = path
    return paths


def atomic_write(path: Path, data: bytes, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix=".wrd-plist-", suffix=".plist", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def install_configurations(configurations: dict, directory: Path):
    """All inputs/snapshots first. Only file writes; rollback across the set."""
    paths = paths_for(configurations, directory)
    desired = {label: plistlib.dumps(config) for label, config in configurations.items()}
    before = {label: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
              if path.exists() else None for label, path in paths.items()}
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    candidates = [label for label in paths if before[label] != (desired[label], 0o600)]
    if not candidates:
        return inspect_configurations(configurations, directory)
    # Preserve recovery material before replacing the first file. A failed
    # destination write must never prevent us from retaining the old bytes.
    backup = Path(tempfile.mkdtemp(prefix=".wrd-autostart-backup-", dir=directory.parent))
    try:
        metadata = {}
        for label in candidates:
            old = before[label]
            metadata[label] = {"existed": old is not None, "mode": old[1] if old else None}
            if old is not None:
                fd = os.open(backup / f"{label}.plist", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(old[0])
                    stream.flush()
                    os.fsync(stream.fileno())
        (backup / "modes.json").write_text(json.dumps(metadata))
        (backup / "modes.json").chmod(0o600)
    except Exception:
        shutil.rmtree(backup)
        raise
    changed = []
    try:
        for label, path in paths.items():
            if before[label] == (desired[label], 0o600):
                continue
            changed.append(label)
            atomic_write(path, desired[label])
    except Exception as error:
        failed = []
        for label in reversed(changed):
            try:
                if before[label] is None:
                    paths[label].unlink(missing_ok=True)
                else:
                    atomic_write(paths[label], *before[label])
            except Exception:
                failed.append(label)
        if failed:
            raise RuntimeError(f"configuration rollback incomplete; recovery files: {backup}") from error
        shutil.rmtree(backup)
        raise RuntimeError("configuration install failed; previous files restored") from error
    shutil.rmtree(backup)
    return inspect_configurations(configurations, directory)


def inspect_configurations(configurations: dict, directory: Path):
    rows = []
    for label, config in configurations.items():
        path = directory / f"{label}.plist"
        matches = False
        try:
            matches = not directory.is_symlink() and not directory.parent.is_symlink() and not path.is_symlink() and plistlib.loads(path.read_bytes()) == config
        except (OSError, ValueError, plistlib.InvalidFileException, ExpatError):
            pass
        rows.append({"label": label, "exists": path.exists(), "matches": matches})
    return rows


def runtime_snapshot():
    """Read only bounded launchd summaries; never return raw argv/environment."""
    domain = f"gui/{os.getuid()}"
    try:
        disabled = subprocess.run(["launchctl", "print-disabled", domain],
                                  capture_output=True, text=True, timeout=3)
        disabled_text = disabled.stdout if disabled.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        disabled_text = None
    jobs = []
    for label in sorted(MANAGED_LABELS):
        row = {"label": label, "loaded": None, "running": None, "disabled": None}
        if disabled_text is not None:
            match = re.search(r'"' + re.escape(label) + r'"\s*=>\s*([^\s,}]+)', disabled_text)
            row["disabled"] = ({"true": True, "disabled": True, "false": False, "enabled": False}.get(match.group(1))
                               if match else False)
        try:
            result = subprocess.run(["launchctl", "print", f"{domain}/{label}"],
                                    capture_output=True, text=True, timeout=3)
            row["loaded"] = result.returncode == 0
            row["running"] = result.returncode == 0 and bool(re.search(r"\bstate = running\b", result.stdout))
        except (OSError, subprocess.TimeoutExpired):
            pass
        jobs.append(row)
    health = {"health_ok": False, "host_online": False}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for endpoint, field, key, expected in (("health", "health_ok", "status", "ok"),
                                           ("api/status", "host_online", "hostOnline", True)):
        try:
            with opener.open(f"http://127.0.0.1:8080/{endpoint}", timeout=3) as response:
                data = json.loads(response.read(65537))
                health[field] = response.status == 200 and data.get(key) == expected
        except Exception:
            pass
    return {"jobs": jobs, **health}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="read-only configuration/runtime check (default)")
    mode.add_argument("--install", action="store_true", help="persist configs only; no enable/bootstrap/restart")
    args = parser.parse_args(argv)
    directory = Path.home() / "Library/LaunchAgents"
    try:
        configurations = build_configurations(PROJECT, validate=args.install)
        if args.install:
            rows = install_configurations(configurations, directory)
            result = {"configurations": rows, "activation": "NOT RUN",
                      "scope": "after macOS user login; files only; existing loaded jobs unchanged"}
        else:
            rows = inspect_configurations(configurations, directory)
            runtime = runtime_snapshot()
            ready = (all(row["matches"] for row in rows) and len(runtime["jobs"]) == len(MANAGED_LABELS)
                     and all(row["loaded"] and row["running"] and row["disabled"] is False for row in runtime["jobs"])
                     and runtime["health_ok"] and runtime["host_online"])
            result = {"configurations": rows, "runtime": runtime, "ready": ready,
                      "scope": "read-only configuration/local runtime; public entry and media not tested"}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if (all(row["matches"] for row in rows) if args.install else result["ready"]) else 1
    except Exception as error:
        print(json.dumps({"status": "failed", "reason": str(error), "activation": "NOT RUN"}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
