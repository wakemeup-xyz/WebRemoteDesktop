#!/usr/bin/env python3
"""Create a bounded, read-only incident summary from WebRemoteDesktop logs.

The command never starts/stops services and never reads credentials.  It is
intended to freeze Phase 0 evidence before changing media or recovery code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


EVENT_REASONS = (
    "dc-error",
    "dc-stuck",
    "pc-failed",
    "pc-disconnected",
    "ice-disconnected",
    "input-ack-timeout",
    "control_reset_blocked",
)


def _safe_example(line: str, reason: str) -> str:
    """Return an evidence marker without copying arbitrary log payloads."""
    # Keep only the conventional logger timestamp prefix.  Do not include the
    # matched line: future log fields may contain credentials or input data.
    prefix = line[:32].strip()
    return f"{prefix} event={reason}" if prefix else f"event={reason}"


def _file_summary(path: Path) -> dict:
    result = {"path": str(path), "exists": path.exists(), "sha256": None, "bytes": 0}
    if not path.is_file():
        return result
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            result["bytes"] += len(chunk)
    result["sha256"] = digest.hexdigest()
    return result


def summarize(paths: list[Path], *, now: datetime | None = None) -> dict:
    counts = Counter()
    examples: dict[str, list[str]] = {key: [] for key in EVENT_REASONS}
    setter_count = 0
    no_op_count = 0
    reopen_count = 0
    lag_critical = 0
    lag_max_ms = 0.0
    attempt_ids: set[str] = set()
    for path in paths:
        if not path.is_file():
            continue
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for raw in stream:
                line = raw.rstrip("\n")
                for reason in EVENT_REASONS:
                    if reason in line:
                        counts[reason] += 1
                        if len(examples[reason]) < 3:
                            examples[reason].append(_safe_example(line, reason))
                if "WRD_ENCODER_RATE" in line:
                    setter_count += 1
                    if "applyMode=no-op" in line:
                        no_op_count += 1
                    if "reopen-required" in line:
                        reopen_count += 1
                if "host_event_loop_lag" in line:
                    match = re.search(r'"?maxLagMs"?\s*[:=]\s*([0-9.]+)', line)
                    if match:
                        lag_max_ms = max(lag_max_ms, float(match.group(1)))
                    if '"severity":"critical"' in line or "severity=critical" in line:
                        lag_critical += 1
                for match in re.finditer(r"(?:connectionAttemptId|attemptId)[=:]\s*[\"']?([A-Za-z0-9._:-]+)", line):
                    attempt_ids.add(match.group(1))
    generated = (now or datetime.now(timezone.utc)).astimezone().isoformat()
    return {
        "schemaVersion": 1,
        "generatedAt": generated,
        "timezone": datetime.now().astimezone().tzname() or "unknown",
        "files": [_file_summary(path) for path in paths],
        "attemptIds": sorted(attempt_ids)[:100],
        "counts": dict(sorted(counts.items())),
        "mediaApply": {
            "setterLogLines": setter_count,
            "noOpLogLines": no_op_count,
            "reopenRequiredLogLines": reopen_count,
        },
        "eventLoop": {"criticalCount": lag_critical, "maxLagMs": round(lag_max_ms, 3)},
        "examples": examples,
        "acceptance": {
            "publicEntry": "NOT RUN",
            "realTurn": "NOT RUN",
            "browser": "NOT RUN",
            "physicalInput": "NOT RUN",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path, default=[Path("back-debug.log"), Path("/tmp/signal-server.log")])
    parser.add_argument("--output", type=Path, help="write JSON to this path instead of stdout")
    args = parser.parse_args()
    payload = json.dumps(summarize(args.paths), ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
