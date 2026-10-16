#!/usr/bin/env python3
"""Explicit, preemptible production Viewer continuity acceptance; never sends input.

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


class ContinuitySummary:
    def __init__(self, *, duration_s, mode):
        self.duration_s, self.mode = duration_s, mode
        self.samples = self.missing = self.late = self.failures = self.identity_changes = 0
        self.first_identity = None
        self.last_callbacks = self.last_relay = None
        self.progress_at = None
        self.last_elapsed = 0.0
        self.max_gap_ms = 0.0

    def observe(self, row):
        elapsed = row['elapsedSeconds']
        self.last_elapsed = elapsed
        self.late += int(row.get('lateByMs', 0) > 500)
        if row.get('status') != 'observed':
            self.missing += 1
            return
        self.samples += 1
        sample = row['sample']
        identity = (sample.get('pcIdentity'), sample.get('attemptHash'), sample.get('generation'), sample.get('buildId'))
        if self.first_identity is None:
            self.first_identity = identity
        elif identity != self.first_identity:
            self.identity_changes += 1
        transport = sample.get('transport') or {}
        relay = 'relay' in (transport.get('localType'), transport.get('remoteType'))
        known_pair = (transport.get('status') == 'observed'
            and transport.get('localType') in ('host','srflx','prflx','relay')
            and transport.get('remoteType') in ('host','srflx','prflx','relay'))
        valid_path = (self.mode == 'tunnel' and sample.get('relayFrameSeq') is not None
            or self.mode == 'relay' and known_pair and relay
            or self.mode == 'stun' and known_pair and not relay)
        if not sample.get('socketConnected') or not valid_path or not sample.get('buildId') or not sample.get('attemptHash'):
            self.failures += 1
        if self.mode != 'tunnel' and sample.get('pcState') != 'connected':
            self.failures += 1
        current = sample.get('relayFrameSeq') if self.mode == 'tunnel' else sample.get('callbacks')
        previous = self.last_relay if self.mode == 'tunnel' else self.last_callbacks
        if current is not None and (previous is None or current > previous):
            self.progress_at = elapsed
        if self.mode == 'tunnel': self.last_relay = current
        else: self.last_callbacks = current
        gap = (elapsed - self.progress_at) * 1000 if self.progress_at is not None else None
        if gap is None or gap >= 5000:
            self.failures += 1
        if gap is not None:
            self.max_gap_ms = max(self.max_gap_ms, gap)

    def result(self, *, elapsed_s, interrupted=False):
        complete = (not interrupted and elapsed_s >= self.duration_s and self.last_elapsed >= self.duration_s - 1.5)
        passed = (complete and self.samples >= math.floor(self.duration_s) and not self.missing
            and not self.failures and not self.identity_changes)
        return {'status': 'PASS' if passed else 'FAIL' if complete else 'INCOMPLETE',
            'kind': 'passive-session-continuity-only', 'requestedSeconds': self.duration_s,
            'elapsedSeconds': elapsed_s, 'samples': self.samples, 'missingSamples': self.missing,
            'lateSamples': self.late, 'failedObservations': self.failures,
            'identityChangeObservations': self.identity_changes, 'maxObservedNoProgressMs': self.max_gap_ms,
            'threeHourContinuityMet': passed and self.duration_s >= 10800,
            'visibleEffect': 'NOT_RUN', 'activeControl': 'NOT_RUN', 'physicalDisplay': 'NOT_RUN',
            'metricNote': 'Metric p95 values are five-second application windows, not a whole-run percentile.'}


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
    salt, total_bytes = secrets.token_bytes(16), 0
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
                    ready = (sample['socketConnected'] and (sample['relayFrameSeq'] is not None
                        if args.mode == 'tunnel' else sample['pcState'] == 'connected' and sample['callbacks'] > 1))
                    if ready: break
                    await asyncio.sleep(1)
                else: raise RuntimeError('media-start-deadline')
                stage = 'sampling'
                start, tick = time.monotonic(), 0
                while True:
                    scheduled = start + tick
                    if scheduled > start + args.duration_seconds: break
                    await asyncio.sleep(max(0, scheduled - time.monotonic()))
                    began = time.monotonic()
                    row = {'schemaVersion': 1, 'tick': tick, 'elapsedSeconds': began-start,
                        'lateByMs': max(0, (began-scheduled)*1000), 'status': 'missing'}
                    try:
                        sample = await asyncio.wait_for(page.evaluate('() => window.__wrdPassiveSampler.sample()'), timeout=2)
                        row.update(status='observed', sample=private_row(sample, salt))
                    except Exception:
                        row['reason'] = 'browser-sample-unavailable'
                    summary.observe(row)
                    encoded = json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n'
                    total_bytes += len(encoded.encode())
                    if len(encoded.encode()) > 32768 or total_bytes > 67108864:
                        raise RuntimeError('evidence-budget-exceeded')
                    stream.write(encoded); stream.flush()
                    if tick % 60 == 0:
                        print(json.dumps({'stage':stage, 'elapsedSeconds':round(began-start), 'samples':summary.samples, 'missing':summary.missing}), flush=True)
                    if row['status'] != 'observed':
                        raise RuntimeError('sample-continuity-lost')
                    if summary.identity_changes or not sample['socketConnected']:
                        raise RuntimeError('session-changed-or-disconnected')
                    tick += 1
                    # Persist missing schedule positions rather than silently
                    # compressing a stall into a shorter apparent session.
                    while start + tick < time.monotonic() - 1:
                        missed = {'schemaVersion':1, 'tick':tick, 'elapsedSeconds':tick,
                            'status':'missing', 'reason':'scheduled-tick-missed'}
                        stream.write(json.dumps(missed) + '\n'); stream.flush()
                        summary.observe(missed); tick += 1
                interrupted = False
            except Exception as exc:
                failure = {'stage':stage, 'category':type(exc).__name__}
                # Only our own fixed reason vocabulary may reach evidence.
                if str(exc) in {'entry-unavailable','viewer-present-or-unknown','authentication-unavailable',
                    'admission-refused','media-start-deadline','sample-continuity-lost',
                    'session-changed-or-disconnected','evidence-budget-exceeded'}:
                    failure['reason'] = str(exc)
            finally:
                await browser.close()
    elapsed = time.monotonic()-start if start is not None else 0
    result = summary.result(elapsed_s=elapsed, interrupted=interrupted)
    result.update(mode=args.mode, failure=failure, originClass='loopback' if parsed.hostname in ('localhost','127.0.0.1','::1') else 'formal')
    report_fd = os.open(output/'summary.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(report_fd, 'w') as report:
        json.dump(result, report, indent=2, allow_nan=False)
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
