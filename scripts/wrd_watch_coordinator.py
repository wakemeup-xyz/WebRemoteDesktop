"""Single writer for fixed-entry observations and owned recovery operations.

The shell acquires the existing watcher lock and execs this coordinator with the
same PID. This coordinator never directly changes a connector: the pre-existing,
guarded restart script is the sole worker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import uuid

if __package__:
    from .wrd_deadline import Deadline, run_owned_probe
    from .wrd_watch_runtime import WatchRuntime
else:
    from wrd_deadline import Deadline, run_owned_probe
    from wrd_watch_runtime import WatchRuntime


def atomic_state(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp." + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_state(path):
    unknown = {"version": 1, "clockEpoch": "unknown", "recoveries": [0, 0]}
    try:
        if Path(path).stat().st_size > 65536:
            raise ValueError("state too large")
        state = json.loads(Path(path).read_text())
        if not isinstance(state, dict):
            raise ValueError("invalid state")
    except (OSError, ValueError):
        # Missing history is not proof this is the first installation. Keep
        # budget uncertainty across restart for a complete observation window.
        return unknown
    if "version" not in state:
        state = {**state, "version": 1, "recoveries": state.get("restarts", []), "clockEpoch": "legacy"}
    return state


class OwnedWatchLock:
    """Adopt the shell's lock after exec, retaining the exact same owner PID."""
    def __init__(self, directory, *, pid, start_identity, metadata_paths=None):
        self.directory = Path(directory)
        self.paths = {name: Path((metadata_paths or {}).get(name, self.directory/name)) for name in ("pid", "start", "signature")}
        self.expected = self._read()
        if (not start_identity or self.expected["pid"].strip() != str(pid)
                or self.expected["start"].strip() != start_identity):
            raise ValueError("watcher lock owner identity mismatch")

    def _read(self):
        values = {}
        for name, path in self.paths.items():
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 8192:
                raise ValueError("invalid watcher lock metadata")
            values[name] = path.read_text()
        return values

    def release(self):
        try:
            if self._read() != self.expected:
                return False
            for path in self.paths.values():
                path.unlink()
            self.directory.rmdir()  # Never remove foreign files recursively.
            return True
        except (OSError, ValueError):
            return False


class WatchCoordinator:
    def __init__(self, *, runtime, state_path, sample, preflight, start_worker,
                 now=time.monotonic, interval_s=60):
        self.runtime, self.state_path = runtime, state_path
        self.sample, self.preflight, self.start_worker = sample, preflight, start_worker
        self.now, self.interval = now, interval_s
        self.worker = None
        self.next_tick = now()
        operation = self.runtime.state.get("operation")
        if operation and operation.get("state") != "terminal":
            # Reusing a PID is not ownership. Without an owned process handle
            # and child-group termination proof, preserve the durable fence.
            operation["state"] = "unknown"
        self.persist()

    def persist(self):
        atomic_state(self.state_path, self.runtime.snapshot())

    def step(self, *, allow_recovery=True):
        now = self.now()
        if self.worker is not None:
            completion = self.worker.completion()
            if (not completion["terminated"] and completion["outcome"] == "timeout"
                    and self.runtime.state["operation"]["state"] != "unknown"):
                self.runtime.state["operation"]["state"] = "unknown"
                self.persist()
            if completion["terminated"]:
                operation = self.runtime.state["operation"]
                self.runtime.complete_recovery(operation["id"], now, completion["outcome"], terminated=True)
                self.worker = None
                self.persist()
        if now < self.next_tick:
            return self.runtime.snapshot()
        scheduled = self.next_tick
        skipped = max(0, int((now - scheduled) // self.interval))
        self.next_tick = scheduled + (skipped + 1) * self.interval
        try:
            observation = self.sample()
        except Exception:
            observation = {"origin": None, "formal": None}
        finished = self.now()
        # Jump over missed deadlines; never run accumulated probes in parallel.
        further = max(0, int((finished - self.next_tick) // self.interval) + 1) if finished >= self.next_tick else 0
        self.next_tick += further * self.interval
        state = self.runtime.tick(finished, observation)
        self.runtime.state["lastTick"] = {"scheduledAt": scheduled, "startedAt": now,
                                         "finishedAt": finished, "skippedTicks": skipped + further}
        self.persist()
        if allow_recovery and state["action"] == "restart" and self.preflight():
            operation_id = uuid.uuid4().hex
            if self.runtime.begin_recovery(operation_id):
                # Persist intent BEFORE starting a side-effecting worker. A
                # crash in this tiny interval fails closed on the next boot.
                self.persist()
                try:
                    self.worker = self.start_worker()
                except OSError:
                    self.runtime.complete_recovery(operation_id, self.now(), "failed", terminated=True)
                else:
                    self.runtime.state["operation"].update(workerPid=self.worker.pid,
                                                         workerStart=self.worker.start_identity)
                self.persist()
        return self.runtime.snapshot()


def process_start(pid):
    result = run_owned_probe(["/bin/ps", "-p", str(pid), "-o", "lstart="],
                             deadline=Deadline(1), allowed_executables={"/bin/ps"})
    if result["outcome"] != "ok":
        return None
    return result["stdout"].decode("ascii", errors="replace").strip()[:128] or None


class RecoveryWorker:
    def __init__(self, script):
        self.process = subprocess.Popen(["/bin/bash", str(script)], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.pid = self.process.pid
        self.start_identity = process_start(self.pid)
        self.started_at = time.monotonic()

    def completion(self):
        code = self.process.poll()
        if code is None:
            return {"terminated": False, "outcome": "timeout" if time.monotonic() - self.started_at >= 60 else "unknown"}
        try:
            os.killpg(self.pid, 0)  # Observation only; never signal the connector.
            empty = False
        except ProcessLookupError:
            empty = True
        except PermissionError:
            empty = False
        return {"terminated": empty, "outcome": "ok" if code == 0 else "failed"}


def notify_status(status, *, popen=subprocess.Popen):
    """Existing local notification, with a finite wait and no content payload."""
    messages = {"budget-exhausted": "Recovery budget exhausted; inspect the service.",
                "recovery-in-flight": "Recovery in progress; observations continue.",
                "clock-untrusted": "Recovery history needs a full observation window."}
    if status not in messages:
        return "ignored"
    try:
        process = popen(["/usr/bin/osascript", "-e", 'display notification "' + messages[status] + '" with title "WRD entry"'],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return "unavailable"
    try:
        process.wait(timeout=1)
        return "ok" if process.returncode == 0 else "failed"
    except subprocess.TimeoutExpired:
        process.kill()  # Only this owned notification helper, never a connector.
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            return "unknown"
        return "timeout"


def boot_epoch():
    linux_id = Path("/proc/sys/kernel/random/boot_id")
    if linux_id.is_file():
        raw = linux_id.read_bytes()[:128]
    else:
        result = run_owned_probe(["/usr/sbin/sysctl", "-n", "kern.boottime"],
                                 deadline=Deadline(1), allowed_executables={"/usr/sbin/sysctl"})
        if result["outcome"] != "ok":
            return "unknown-" + uuid.uuid4().hex
        raw = result["stdout"]
    return hashlib.sha256(raw).hexdigest()[:24]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    lock_directory = Path(os.environ.get("WRD_FIXED_WATCH_LOCK", "/tmp/wrd-fixed-watch.lock"))
    owned_lock = OwnedWatchLock(lock_directory, pid=os.getpid(), start_identity=process_start(os.getpid()),
        metadata_paths={name: os.environ.get(f"WRD_FIXED_WATCH_{name.upper()}_FILE", str(lock_directory/name))
                        for name in ("pid", "start", "signature")})
    directory = Path(__file__).resolve().parent
    state_path = Path(os.environ.get("WRD_FIXED_WATCH_STATE", "/tmp/wrd-fixed-watch-state.json"))
    log_path = Path(os.environ.get("WRD_FIXED_WATCH_LOG", "/tmp/wrd-fixed-watch.log"))
    state = load_state(state_path)
    runtime = WatchRuntime(state=state, clock_epoch=boot_epoch(),
        fail_s=float(os.environ.get("WRD_FIXED_WATCH_FAIL_SEC", 180)),
        cooldown_s=float(os.environ.get("WRD_FIXED_WATCH_COOLDOWN_SEC", 300)),
        window_s=float(os.environ.get("WRD_FIXED_WATCH_WINDOW_SEC", 3600)),
        max_recoveries=int(os.environ.get("WRD_FIXED_WATCH_MAX_RESTARTS", 2)))
    restart = directory / "restart-fixed-domain-tunnel.sh"
    def sample():
        deadline = Deadline(15)
        result = {}
        for key, target in (("origin", os.environ.get("WRD_FIXED_ORIGIN_HEALTH_URL", "http://127.0.0.1:8080/health")),
                            ("formal", os.environ.get("WRD_FIXED_FORMAL_HEALTH_URL", "https://link.stockhub.wiki/health"))):
            probe = run_owned_probe([sys.executable, str(directory / "wrd_entry_health.py"), "--url", target,
                                     "--timeout", str(min(6, deadline.remaining()))],
                                    deadline=Deadline(min(7, deadline.remaining())), allowed_executables={sys.executable})
            result[key] = None
            try:
                parsed = json.loads(probe["stdout"])
                if probe["outcome"] == "ok":
                    result[key] = parsed.get("deliverable") is True
                elif probe["outcome"] == "failed" and parsed.get("state") in {"http-invalid", "content-invalid", "origin-unreachable", "dns-unresolved"}:
                    result[key] = False
            except (ValueError, AttributeError):
                pass
        return result
    def preflight():
        return run_owned_probe(["/bin/bash", str(restart), "--preflight"], deadline=Deadline(5),
                               allowed_executables={"/bin/bash"})["outcome"] == "ok"
    coordinator = WatchCoordinator(runtime=runtime, state_path=state_path, sample=sample,
        preflight=preflight, start_worker=lambda: RecoveryWorker(restart),
        interval_s=max(1, float(os.environ.get("WRD_FIXED_WATCH_INTERVAL_SEC", 60))))
    stop = [False]
    def stopping(*_):
        stop[0] = True
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    last_notified = None
    while True:
        before_tick = runtime.state.get("lastTick")
        snapshot = coordinator.step(allow_recovery=not stop[0])
        if snapshot.get("lastTick") != before_tick:
            # Fixed fields only; never argv, credentials, request content or URL.
            record = {"at": time.time(), "status": snapshot.get("status"), "action": snapshot.get("action"),
                      "tick": snapshot.get("lastTick"), "observations": snapshot.get("observations"),
                      "inFlight": bool(coordinator.worker)}
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a") as stream:
                stream.write(json.dumps(record, separators=(",", ":")) + "\n")
            if snapshot.get("status") != last_notified:
                notify_status(snapshot.get("status"))
                last_notified = snapshot.get("status")
        # Keep the shell's lock until all owned worker-side mutations are done.
        if (stop[0] or args.once) and coordinator.worker is None:
            break
        if stop[0]:
            coordinator.next_tick = float("inf")
        time.sleep(min(0.25, max(0.01, coordinator.next_tick - time.monotonic())))
    owned_lock.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
