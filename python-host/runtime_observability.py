"""Passive, bounded runtime summaries. Importing this module starts no work."""
import asyncio
from collections import deque
import math
import os
import re
import resource
import sys
import threading
import time

QUEUE_NAMES = frozenset(('inputReliable', 'inputUnordered', 'relayFrames'))
QUEUE_FIELDS = ('pendingCount', 'pendingBytes', 'inFlightCount', 'droppedCount', 'frozen')
RELAY_STAGE_FIELDS = ('processorActive', 'deliveryPending', 'pendingAgeMs', 'processorAgeMs',
                      'deliveryAgeMs', 'lastQueueWaitMs', 'lastProcessorMs', 'lastDeliveryWaitMs')
WINDOW_NS = 60_000_000_000
INTERVAL_NS = 1_000_000_000
_RLOCK_TYPE = type(threading.RLock())


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def summarize_loop(samples):
    values = sorted(item[1] for item in samples)
    def percentile(fraction):
        return values[max(0, math.ceil(len(values) * fraction) - 1)] if values else None
    return {'count': len(values), 'last': samples[-1][1] if samples else None,
            'max': max(values) if values else None, 'p50': percentile(.5),
            'p95': percentile(.95), 'p99': percentile(.99),
            'missedSampleCount': sum(item[2] for item in samples)}


class RuntimeObservability:
    def __init__(self, now_ns=time.monotonic_ns, read_current_rss=lambda: None,
                 read_peak_rss=lambda: None):
        self._now_ns = now_ns
        self._read_current_rss = read_current_rss
        self._read_peak_rss = read_peak_rss
        self._loop_samples = deque(maxlen=120)
        self._queues = {}

    def _expire(self, now_ns):
        while self._loop_samples and self._loop_samples[0][0] <= now_ns - WINDOW_NS:
            self._loop_samples.popleft()

    def observe_loop(self, scheduled_ns, observed_ns):
        lag_ns = max(0, observed_ns - scheduled_ns)
        self._expire(observed_ns)
        self._loop_samples.append((observed_ns, lag_ns / 1_000_000, lag_ns // INTERVAL_NS))

    def register_queue(self, name, snapshot):
        if name not in QUEUE_NAMES:
            raise ValueError('unsupported queue name')
        if not callable(snapshot):
            raise ValueError('queue snapshot must be callable')
        self._queues[name] = snapshot

    def snapshot(self, now_ns=None):
        self._expire(self._now_ns() if now_ns is None else now_ns)
        queues = {name: None for name in sorted(QUEUE_NAMES)}
        for name, reader in self._queues.items():
            try:
                raw = reader()
                if not isinstance(raw, dict):
                    continue
                queues[name] = {key: (raw.get(key) if (
                    isinstance(raw.get(key), bool) if key in ('frozen', 'processorActive', 'deliveryPending')
                    else finite_number(raw.get(key)) and raw[key] >= 0) else None)
                    for key in (QUEUE_FIELDS + RELAY_STAGE_FIELDS if name == 'relayFrames' else QUEUE_FIELDS)}
            except Exception:
                pass
        def read(reader):
            try:
                value = reader()
                return value if finite_number(value) and value >= 0 else None
            except Exception:
                return None
        return {'currentRssMiB': read(self._read_current_rss), 'peakRssMiB': read(self._read_peak_rss),
                'eventLoop': summarize_loop(self._loop_samples), 'queues': queues}


def snapshot_relay_queue(worker):
    """The relay worker uses a reentrant Condition; contention means unavailable."""
    if worker is None:
        return None
    condition = getattr(worker, '_condition', None)
    reader = getattr(worker, 'snapshot', None)
    # RelayFrameWorker constructs threading.Condition() with its default RLock.
    # An unknown/non-reentrant lock cannot safely wrap its locking snapshot.
    if (not isinstance(condition, threading.Condition)
            or not isinstance(getattr(condition, '_lock', None), _RLOCK_TYPE)
            or not callable(reader)):
        return None
    if not condition.acquire(blocking=False):
        return None
    try:
        return reader()
    finally:
        condition.release()


def resource_delta(previous, current):
    previous = previous or {}
    elapsed = None
    if finite_number(previous.get('sampledNs')) and finite_number(current.get('sampledNs')):
        elapsed = (current['sampledNs'] - previous['sampledNs']) / 1_000_000
    page_size = current.get('pageSize')
    def rate(key):
        before, after = previous.get(key), current.get(key)
        if not all(finite_number(value) for value in (before, after, page_size, elapsed)):
            return None
        if after < before or before < 0 or elapsed <= 0 or page_size <= 0:
            return None
        return (after - before) * page_size * 1000 / elapsed
    def rss(key):
        value = current.get(key)
        return value if finite_number(value) and value >= 0 else None
    return {'elapsedMs': elapsed if elapsed is not None and elapsed > 0 else None,
            'swapInBytesPerSec': rate('swapIns'), 'swapOutBytesPerSec': rate('swapOuts'),
            'currentRssMiB': rss('currentRssMiB'), 'peakRssMiB': rss('peakRssMiB'),
            'memoryPressure': 'unknown'}


def validate_pid(pid, registered_pids):
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0 or pid not in registered_pids:
        raise ValueError('an explicitly registered positive PID is required')
    return pid


def parse_ps_rss(output):
    try:
        value = int(output.strip())
        return value / 1024 if value >= 0 else None
    except (ValueError, TypeError):
        return None


def parse_vm_stat(output):
    page = re.search(r'page size of (\d+) bytes', output)
    def counter(label):
        match = re.search(r'^' + label + r':\s*(\d+)\.?\s*$', output, re.MULTILINE)
        return int(match.group(1)) if match else None
    return {'pageSize': int(page.group(1)) if page else None,
            'swapIns': counter('Swapins'), 'swapOuts': counter('Swapouts')}


def read_peak_rss_mib():
    divisor = 1024 * 1024 if sys.platform == 'darwin' else 1024
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / divisor


async def run_command(*args):
    """Cancellation reaps the one owned child, including cancellation during spawn."""
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL))
    process = None
    try:
        process = await asyncio.shield(spawning)
        output, _ = await process.communicate()
        return output.decode('utf-8', errors='replace') if process.returncode == 0 else ''
    finally:
        async def reap():
            owned = process if process is not None else await spawning
            if owned.returncode is None:
                try:
                    owned.kill()
                except ProcessLookupError:
                    pass
                await owned.communicate()
        cleanup = asyncio.create_task(reap())
        cancelled_during_cleanup = False
        # Timeout and close can overlap. Repeated cancellation must not detach
        # the still-spawning process or interrupt its kill/wait cleanup.
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled_during_cleanup = True
        cleanup.result()
        if cancelled_during_cleanup:
            raise asyncio.CancelledError


async def collect_resources(pid, *, registered_pids, command=run_command,
                            now_ns=time.monotonic_ns, platform=sys.platform):
    validate_pid(pid, registered_pids)
    current_rss = None
    try:
        current_rss = parse_ps_rss(await command('/bin/ps', '-o', 'rss=', '-p', str(pid)))
    except (OSError, ValueError):
        pass
    counters = {}
    if platform == 'darwin':
        try:
            counters = parse_vm_stat(await command('/usr/bin/vm_stat'))
        except (OSError, ValueError):
            pass
    return {'sampledNs': now_ns(), 'currentRssMiB': current_rss,
            'peakRssMiB': read_peak_rss_mib() if pid == os.getpid() else None, **counters}


class ResourceSampler:
    """One owned asynchronous worker, one total budget, cached-only reads."""
    def __init__(self, pid, *, registered_pids, collect=None, now_ns=time.monotonic_ns,
                 interval_seconds=5, budget_seconds=1, stale_seconds=10):
        self.pid = validate_pid(pid, registered_pids)
        self._collect = collect or (lambda selected_pid: collect_resources(
            selected_pid, registered_pids=registered_pids, now_ns=now_ns))
        self._now_ns = now_ns
        self.interval_seconds = max(5, interval_seconds)
        self.budget_seconds = min(1, max(.001, budget_seconds))
        self.stale_ns = stale_seconds * 1_000_000_000
        self._task = None
        self._sample_task = None
        self._previous = None
        self._cached = None
        self._status = 'unavailable'
        self._closed = False

    async def sample_once(self):
        if self._closed or self._sample_task is not None:
            return
        self._sample_task = asyncio.create_task(self._collect(self.pid))
        try:
            current = await asyncio.wait_for(self._sample_task, self.budget_seconds)
            self._cached = {**resource_delta(self._previous, current), 'sampledNs': current['sampledNs']}
            self._previous = current
            self._status = 'ok' if self._cached['currentRssMiB'] is not None else 'unavailable'
        except asyncio.TimeoutError:
            self._status = 'timeout'
        except asyncio.CancelledError:
            raise
        except Exception:
            self._status = 'unavailable'
        finally:
            self._sample_task = None

    def start(self):
        if self._task is None and not self._closed:
            self._task = asyncio.create_task(self._run())

    async def _run(self):
        interval_ns = int(self.interval_seconds * 1_000_000_000)
        deadline = self._now_ns()
        while True:
            await self.sample_once()
            deadline += interval_ns
            observed = self._now_ns()
            if deadline <= observed:
                deadline += ((observed - deadline) // interval_ns + 1) * interval_ns
            await asyncio.sleep(max(0, (deadline - observed) / 1_000_000_000))

    def snapshot(self):
        cached = self._cached or {}
        sampled_ns = cached.get('sampledNs')
        age_ns = max(0, self._now_ns() - sampled_ns) if sampled_ns is not None else None
        fresh = age_ns is not None and age_ns <= self.stale_ns
        result = {key: cached.get(key) if fresh else None for key in (
            'elapsedMs', 'swapInBytesPerSec', 'swapOutBytesPerSec', 'currentRssMiB', 'peakRssMiB')}
        return {**result, 'memoryPressure': 'unknown', 'ageMs': age_ns / 1_000_000 if age_ns is not None else None,
                'available': fresh and cached.get('currentRssMiB') is not None, 'status': self._status}

    async def close(self):
        self._closed = True
        tasks = [task for task in (self._task, self._sample_task) if task is not None]
        # The loop owns the sample task. Cancel its owner once; a second cancel
        # during child spawn/reaping could interrupt the cleanup itself.
        owner = self._task if self._task is not None and not self._task.done() else self._sample_task
        if owner is not None:
            owner.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
