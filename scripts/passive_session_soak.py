#!/usr/bin/env python3
"""Explicit Viewer continuity acceptance, passive after normal guarded connection.

--mode selects only this disposable browser's requested path. Ordinary admission,
control grants and mandatory safety resets remain active. No business desktop
click/text/input, clipboard or terminal action is issued by the sampling helper.

This is NOT visible-effect, active-control, optical or encoder qualification.
Only invoke in the authorized maintenance window with no existing Viewer.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit


FRAME_STALL_MS = 5000
MAX_ROW_BYTES = 32768
MAX_RUN_BYTES = 67108864


def nonnegative(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


class ContinuitySummary:
    def __init__(self, *, duration_s, mode):
        self.duration_s, self.mode = duration_s, mode
        self.samples = self.missing = self.late = self.failures = self.identity_changes = 0
        self.first_identity = None
        self.baseline = self.previous = self.relay_baseline = self.previous_relay = None
        self.progress_observed = False
        self.last_elapsed = 0.0
        self.max_gap_ms = 0.0

    def observe(self, row):
        self.last_elapsed = row['elapsedSeconds']
        self.late += int(row.get('lateByMs', 0) > 500)
        if row.get('status') != 'observed':
            self.missing += 1
            return
        self.samples += 1
        sample = row['sample']
        transport = sample.get('transport') or {}
        tunnel = self.mode == 'tunnel'
        path = ('tunnel-jpeg',) if tunnel else tuple(transport.get(key) for key in
            ('pathIdentity', 'localType', 'remoteType', 'protocol', 'remoteProtocol', 'relayProtocol'))
        identity = tuple(sample.get(key) for key in
            ('pcIdentity', 'attemptHash', 'generation', 'leaseEpoch', 'buildId')) + path
        if self.first_identity is None:
            self.first_identity = identity
        elif identity != self.first_identity:
            self.identity_changes += 1
        relay = 'relay' in (transport.get('localType'), transport.get('remoteType'))
        known_pair = (transport.get('status') == 'observed' and bool(transport.get('pathIdentity'))
            and transport.get('protocol') in ('udp', 'tcp')
            and transport.get('localType') in ('host', 'srflx', 'prflx', 'relay')
            and transport.get('remoteType') in ('host', 'srflx', 'prflx', 'relay'))
        valid_path = (tunnel and sample.get('tunnelRelayActive') is True
            and nonnegative(sample.get('relayFrameSeq'))
            or self.mode == 'relay' and known_pair and relay
            or self.mode == 'stun' and known_pair and not relay)
        if (not sample.get('socketConnected') or not valid_path or not sample.get('buildId')
            or not sample.get('attemptHash') or sample.get('scopeStable') is not True
            or not nonnegative(sample.get('generation')) or not nonnegative(sample.get('leaseEpoch'))):
            self.failures += 1
        if not tunnel and (sample.get('pcState') != 'connected' or not nonnegative(sample.get('pcIdentity'))):
            self.failures += 1
        current = sample.get('relayLoadCallbacks' if tunnel else 'callbacks')
        age = sample.get('relayLoadAgeMs' if tunnel else 'frameAgeMs')
        gap = sample.get('maxRelayLoadGapMs' if tunnel else 'maxFrameGapMs')
        if not nonnegative(current) or current <= 0:
            self.failures += 1
        else:
            if self.baseline is None: self.baseline = current
            if self.previous is not None and current < self.previous: self.failures += 1
            self.progress_observed |= current > self.baseline
            self.previous = current
        # Use actual observer age/gap, never pretend the sample time was a frame.
        if not nonnegative(age) or not nonnegative(gap):
            self.failures += 1
        else:
            self.max_gap_ms = max(self.max_gap_ms, age, gap)
            if age >= FRAME_STALL_MS or gap >= FRAME_STALL_MS: self.failures += 1
        if tunnel:
            seq = sample.get('relayFrameSeq')
            if nonnegative(seq):
                if self.relay_baseline is None: self.relay_baseline = seq
                if self.previous_relay is not None and seq < self.previous_relay: self.failures += 1
                self.previous_relay = seq

    def result(self, *, elapsed_s, interrupted=False):
        complete = (not interrupted and elapsed_s >= self.duration_s and self.last_elapsed >= self.duration_s - 1.5)
        progress = self.progress_observed and (self.mode != 'tunnel' or
            self.relay_baseline is not None and self.previous_relay > self.relay_baseline)
        passed = (complete and self.samples >= math.floor(self.duration_s) and not self.missing
            and not self.failures and not self.identity_changes and progress)
        return {'status': 'PASS' if passed else 'FAIL' if complete else 'INCOMPLETE',
            'kind': 'passive-session-continuity-only', 'requestedSeconds': self.duration_s,
            'elapsedSeconds': elapsed_s, 'samples': self.samples, 'missingSamples': self.missing,
            'lateSamples': self.late, 'failedObservations': self.failures,
            'identityChangeObservations': self.identity_changes, 'maxObservedNoProgressMs': self.max_gap_ms,
            'progressAfterBaseline': bool(progress), 'frameStallThresholdMs': FRAME_STALL_MS,
            'frameEvidence': 'image-load-event-not-optical-presentation' if self.mode == 'tunnel' else 'requestVideoFrameCallback',
            'threeHourContinuityMet': passed and self.duration_s >= 10800,
            'visibleEffect': 'NOT_RUN', 'activeControl': 'NOT_RUN', 'physicalDisplay': 'NOT_RUN',
            'connectionNote': 'Passive after normal guarded connection; required grant/reset lifecycle messages are permitted.',
            'metricNote': 'Metric p95 values are five-second application windows, not a whole-run percentile.'}


class EvidenceWriter:
    def __init__(self, stream, *, max_bytes=MAX_RUN_BYTES - MAX_ROW_BYTES, max_row_bytes=MAX_ROW_BYTES):
        self.stream, self.max_bytes, self.max_row_bytes = stream, max_bytes, max_row_bytes
        self.total_bytes = 0

    def write(self, row):
        encoded = json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n'
        size = len(encoded.encode('utf-8'))
        if size > self.max_row_bytes or self.total_bytes + size > self.max_bytes:
            raise RuntimeError('evidence-budget-exceeded')
        self.stream.write(encoded)
        self.stream.flush()
        self.total_bytes += size


def record_missed_ticks(writer, summary, *, tick, elapsed_s, duration_s):
    # Even an arbitrarily long OS stall cannot add schedule positions past end.
    last_missed = min(math.floor(duration_s), math.ceil(elapsed_s - 1) - 1)
    while tick <= last_missed:
        row = {'schemaVersion': 1, 'tick': tick, 'elapsedSeconds': tick,
            'status': 'missing', 'reason': 'scheduled-tick-missed'}
        writer.write(row)
        summary.observe(row)
        tick += 1
    return tick


async def collect_samples(sample_once, writer, summary, salt, *, start, duration_s,
                          monotonic=time.monotonic, sleep=asyncio.sleep, progress=None):
    tick = 0
    while tick <= duration_s:
        await sleep(max(0, start + tick - monotonic()))
        began = monotonic()
        tick = record_missed_ticks(writer, summary, tick=tick,
            elapsed_s=began-start, duration_s=duration_s)
        if tick > duration_s or began > start + duration_s + 1:
            raise RuntimeError('sampling-deadline-overrun')
        row = {'schemaVersion': 1, 'tick': tick, 'elapsedSeconds': began-start,
            'lateByMs': max(0, (began-start-tick)*1000), 'status': 'missing'}
        try:
            sample = await asyncio.wait_for(sample_once(), timeout=2)
            row.update(status='observed', sample=private_row(sample, salt))
        except Exception:
            row['reason'] = 'browser-sample-unavailable'
        writer.write(row)
        summary.observe(row)
        if progress and tick % 60 == 0: progress(began-start)
        if row['status'] != 'observed': raise RuntimeError('sample-continuity-lost')
        if summary.identity_changes or not sample['socketConnected']:
            raise RuntimeError('session-changed-or-disconnected')
        tick += 1
    if monotonic() > start + duration_s + 1:
        raise RuntimeError('sampling-deadline-overrun')


def private_row(sample, salt):
    sample = dict(sample)
    attempt = sample.pop('attempt', None)
    sample['attemptHash'] = hashlib.sha256(salt + attempt.encode()).hexdigest()[:16] if isinstance(attempt, str) else None
    build = sample.get('buildId')
    if not isinstance(build, str) or len(build) > 128 or not all(c.isalnum() or c in '-_.' for c in build):
        sample['buildId'] = None
    return sample


async def run(args):
    from dotenv import dotenv_values
    from playwright.async_api import async_playwright
    origin = args.origin.rstrip('/')
    parsed = urlsplit(origin)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError('origin must contain only scheme and host')
    password = os.environ.get('VIEWER_ACCESS_PASSWORD') or dotenv_values(args.runtime_config).get('VIEWER_ACCESS_PASSWORD')
    if not password:
        raise ValueError('runtime password unavailable')
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    fd = os.open(output/'samples.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    summary = ContinuitySummary(duration_s=args.duration_seconds, mode=args.mode)
    salt = secrets.token_bytes(16)
    start = None
    interrupted = True
    stage = 'browser-start'
    failure = None
    with os.fdopen(fd, 'w') as stream:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                context = await browser.new_context()
                page = await context.new_page()
                page.set_default_timeout(8000)
                await page.add_init_script("localStorage.setItem('wrdNetworkMode', " + json.dumps(args.mode) + ");")
                stage = 'entry'
                response = await page.goto(origin, wait_until='domcontentloaded', timeout=30000)
                if not response or response.status != 200:
                    raise RuntimeError('entry-unavailable')
                await page.locator('#password').wait_for(state='visible')
                stage = 'admission'
                admission = await page.evaluate('''async password => {
                  async function request(path, options={}) {
                    const controller = new AbortController(); let timer;
                    try { return await Promise.race([(async () => {
                      const r = await fetch(path, {...options, signal:controller.signal});
                      const reader = r.body.getReader(); let body='', bytes=0;
                      const decoder = new TextDecoder();
                      while (true) {
                        const part = await reader.read(); if (part.done) break;
                        bytes += part.value.byteLength;
                        if (bytes > 16384) { await reader.cancel(); throw new Error('body-cap'); }
                        body += decoder.decode(part.value, {stream:true});
                      }
                      body += decoder.decode();
                      return {status:r.status, body:JSON.parse(body)};
                    })(), new Promise((_,reject) => {timer=setTimeout(() => {
                      controller.abort(); reject(new Error('deadline')); },8000);})]);
                    } finally {clearTimeout(timer);}
                  }
                  const status = await request('/api/status');
                  if (status.status !== 200 || status.body.viewerCount !== 0) return 'viewer-present-or-unknown';
                  const auth = await request('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password})});
                  if (auth.status !== 200 || !auth.body.token) return 'authentication-unavailable';
                  const proof = await request('/api/proof-admission', {method:'POST', headers:{Authorization:'Bearer '+auth.body.token}});
                  if (proof.status !== 201 || !proof.body.admission?.token) return 'admission-refused';
                  sessionStorage.setItem('wrdProofAdmission', JSON.stringify(proof.body.admission));
                  return 'ready';
                }''', password)
                if admission != 'ready':
                    raise RuntimeError(admission)
                stage = 'ui-login'
                await page.locator('#password').fill(password)
                await page.locator('#loginForm').dispatch_event('submit')
                await page.wait_for_url('**/viewer.html', timeout=30000)
                await page.wait_for_function("typeof WebRTC !== 'undefined'", timeout=30000)
                await page.evaluate(Path(__file__).with_name('passive_session_sampler.js').read_text())
                start_button = page.locator('#startBtn')
                if await start_button.is_visible():
                    await start_button.click()
                stage = 'media-start'
                for _ in range(45):
                    sample = await asyncio.wait_for(page.evaluate('() => window.__wrdPassiveSampler.sample()'), timeout=2)
                    ready = (sample['socketConnected'] and (sample['relayFrameSeq'] is not None and sample['tunnelRelayActive'] and sample['relayLoadCallbacks'] > 1
                        if args.mode == 'tunnel' else sample['pcState'] == 'connected' and sample['callbacks'] > 1))
                    if ready: break
                    await asyncio.sleep(1)
                else: raise RuntimeError('media-start-deadline')
                stage = 'sampling'
                start = time.monotonic()
                await collect_samples(
                    lambda: page.evaluate('() => window.__wrdPassiveSampler.sample()'),
                    EvidenceWriter(stream), summary, salt, start=start, duration_s=args.duration_seconds,
                    progress=lambda elapsed: print(json.dumps({'stage': stage, 'elapsedSeconds': round(elapsed),
                        'samples': summary.samples, 'missing': summary.missing}), flush=True))
                interrupted = False
            except Exception as exc:
                failure = {'stage':stage, 'category':type(exc).__name__}
                # Only our own fixed reason vocabulary may reach evidence.
                if str(exc) in {'entry-unavailable','viewer-present-or-unknown','authentication-unavailable',
                    'admission-refused','media-start-deadline','sample-continuity-lost',
                    'session-changed-or-disconnected','evidence-budget-exceeded','sampling-deadline-overrun'}:
                    failure['reason'] = str(exc)
            finally:
                await browser.close()
    elapsed = time.monotonic()-start if start is not None else 0
    result = summary.result(elapsed_s=elapsed, interrupted=interrupted)
    result.update(mode=args.mode, failure=failure, originClass='loopback' if parsed.hostname in ('localhost','127.0.0.1','::1') else 'formal')
    report_fd = os.open(output/'summary.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(report_fd, 'w') as report:
        encoded = json.dumps(result, indent=2, allow_nan=False)
        if len(encoded.encode('utf-8')) > MAX_ROW_BYTES: raise RuntimeError('evidence-budget-exceeded')
        report.write(encoded)
    print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--mode', required=True, choices=('stun','relay','tunnel'))
    parser.add_argument('--duration-seconds', type=int, default=10800)
    parser.add_argument('--runtime-config', type=Path, default=Path(__file__).resolve().parents[1]/'signal-server'/'.env')
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    if not 1 <= args.duration_seconds <= 43200:
        parser.error('duration must be 1..43200 seconds')
    raise SystemExit(asyncio.run(run(args)))
