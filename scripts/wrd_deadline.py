"""Monotonic budgets and bounded, owned read-only probe subprocesses."""

from __future__ import annotations

import argparse
import json
import math
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path


class Deadline:
    def __init__(self, timeout_s, now=time.monotonic):
        if not isinstance(timeout_s, (int, float)) or not math.isfinite(timeout_s) or timeout_s < 0:
            raise ValueError("timeout must be a finite nonnegative duration")
        self.now = now
        self.ends_at = now() + timeout_s

    def remaining(self):
        return max(0.0, self.ends_at - self.now())

    def expired(self):
        return self.remaining() <= 0


def wait_formal_health(*, timeout_s, probe, info, now=time.monotonic, sleep=time.sleep):
    started = now()
    deadline = Deadline(timeout_s, now)
    attempts = 0
    while not deadline.expired():
        attempts += 1
        result = probe(remaining_s=min(10.0, deadline.remaining()))
        if deadline.expired():
            break
        if result.get("outcome") == "ok":
            return {"outcome": "ok", "elapsedMs": (now() - started) * 1000, "attempts": attempts}
        info(remaining_s=min(3.0, deadline.remaining()))
        if not deadline.expired():
            sleep(min(1.0, deadline.remaining()))
    return {"outcome": "timeout", "elapsedMs": (now() - started) * 1000, "attempts": attempts}


def run_owned_probe(command, *, deadline, allowed_executables, output_limit=65536):
    """Only caller-constructed probe commands are allowed; never a recovery worker.

    Pipes are drained incrementally. A timed-out/output-limited probe's private
    process group is terminated and reaped; no daemon or connector is targeted.
    """
    if not command or command[0] not in allowed_executables:
        raise ValueError("probe executable is not allowed")
    if output_limit <= 0 or output_limit > 65536:
        raise ValueError("invalid probe output limit")
    result = {"outcome": "timeout", "stdout": b"", "stderr": b"", "reaped": True, "returncode": None}
    if deadline.expired():
        return result
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
    except OSError:
        result["outcome"] = "spawn-failed"
        return result
    output = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    reap_reserve = min(0.25, deadline.remaining() / 2)
    selector = selectors.DefaultSelector()
    try:
        for name in output:
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map() and deadline.remaining() > reap_reserve:
            ready = selector.select(min(0.05, deadline.remaining() - reap_reserve))
            for key, _ in ready:
                chunk = os.read(key.fd, min(4096, output_limit - total))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                total += len(chunk)
                if total >= output_limit:
                    result["outcome"] = "output-limit"
                    break
            if result["outcome"] == "output-limit":
                break
        if not selector.get_map() and not deadline.expired():
            try:
                process.wait(timeout=max(0, deadline.remaining() - reap_reserve))
            except subprocess.TimeoutExpired:
                pass
            if not deadline.expired() and process.returncode is not None:
                result["outcome"] = "ok" if process.returncode == 0 else "failed"
        if result["outcome"] in {"timeout", "output-limit"}:
            # SIGKILL avoids unbounded cooperative cancellation. This group was
            # just created for a finite, read-only probe; never a service group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=deadline.remaining())
            result["reaped"] = True
        except subprocess.TimeoutExpired:
            result["reaped"] = False
        result["returncode"] = process.returncode
        result.update({key: bytes(value) for key, value in output.items()})
        return result
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--cloudflared", required=True)
    parser.add_argument("--tunnel-name", required=True)
    args = parser.parse_args(argv)
    checker = str(Path(__file__).with_name("wrd_entry_health.py"))
    def probe(remaining_s):
        result = run_owned_probe([sys.executable, checker, "--url", args.health_url,
                                  "--timeout", str(remaining_s)],
                                 deadline=Deadline(remaining_s), allowed_executables={sys.executable})
        if result["outcome"] == "ok":
            try:
                if json.loads(result["stdout"]).get("deliverable") is True:
                    return {"outcome": "ok"}
            except (ValueError, AttributeError):
                pass
        return {"outcome": "failed"}
    def info(remaining_s):
        # Only the read-only 'tunnel info' command is constructed here.
        return run_owned_probe([args.cloudflared, "tunnel", "info", args.tunnel_name],
                               deadline=Deadline(remaining_s), allowed_executables={args.cloudflared})
    result = wait_formal_health(timeout_s=args.timeout, probe=probe, info=info)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["outcome"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
