#!/usr/bin/env python3
"""One explicit-PID resource sample; imports and tests never start sampling."""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location('wrd_runtime_observability',
    Path(__file__).resolve().parents[1] / 'python-host' / 'runtime_observability.py')
_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runtime)
validate_pid = _runtime.validate_pid
parse_ps_rss = _runtime.parse_ps_rss
parse_vm_stat = _runtime.parse_vm_stat
resource_delta = _runtime.resource_delta


async def snapshot_pid(pid, *, registered_pids, collect=None):
    sampler = _runtime.ResourceSampler(pid, registered_pids=registered_pids, collect=collect)
    try:
        await sampler.sample_once()
        return sampler.snapshot()
    finally:
        await sampler.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', required=True, type=int)
    args = parser.parse_args()
    pid = validate_pid(args.pid, {args.pid})
    print(json.dumps(asyncio.run(snapshot_pid(pid, registered_pids={pid}))))


if __name__ == '__main__':
    main()
