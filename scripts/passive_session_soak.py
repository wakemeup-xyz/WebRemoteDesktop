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
import re
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit


FRAME_STALL_MS = 5000
MAX_ROW_BYTES = 32768
MAX_RUN_BYTES = 67108864


ADMISSION_FAILURES = frozenset({'viewer-present-or-unknown', 'host-unavailable',
    'authentication-unavailable', 'admission-auth-changed', 'admission-body-cap',
    'admission-deadline', 'admission-refused', 'admission-unavailable', 'admission-already-present'})

# Current token/generation and admission stay in this disposable browser only.
PROOF_ADMISSION = '''async timeoutMs => {
  const auth = typeof Auth === 'undefined' ? null : Auth;
  if (!auth?.getToken || !auth?.getGeneration || !auth?.isVerified || !auth.isVerified())
    return 'authentication-unavailable';
  const token = auth.getToken(), generation = auth.getGeneration();
  if (!token || !Number.isSafeInteger(generation)) return 'authentication-unavailable';
  const deadline = performance.now() + Math.min(8000, timeoutMs);
  const current = () => auth === Auth && auth.isVerified()
    && auth.getToken() === token && auth.getGeneration() === generation;
  const fail = code => Object.assign(new Error(), {code});
  async function request(path, options={}) {
    const controller = new AbortController(); let timer;
    try { return await Promise.race([(async () => {
      if (performance.now() >= deadline) throw fail('admission-deadline');
      if (!current()) throw fail('admission-auth-changed');
      const r = await fetch(path, {...options, signal:controller.signal});
      if (performance.now() >= deadline) throw fail('admission-deadline');
      if (!current()) throw fail('admission-auth-changed');
      const reader = r.body.getReader(); let body='', bytes=0;
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (performance.now() >= deadline) throw fail('admission-deadline');
        if (!current()) throw fail('admission-auth-changed');
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16384) { await reader.cancel(); throw fail('admission-body-cap'); }
        body += decoder.decode(part.value, {stream:true});
      }
      body += decoder.decode();
      return {status:r.status, body:JSON.parse(body)};
    })(), new Promise((_,reject) => {timer=setTimeout(() => {
      controller.abort(); reject(fail('admission-deadline')); }, Math.max(0, deadline-performance.now()));})]);
    } finally {clearTimeout(timer);}
  }
  try {
    if (window.__wrdProofStartGuard || sessionStorage.getItem('wrdProofAdmission'))
      return 'admission-already-present';
    const status = await request('/api/status');
    if (!current()) return 'admission-auth-changed';
    if (status.status !== 200 || status.body.viewerCount !== 0) return 'viewer-present-or-unknown';
    if (status.body.hostOnline !== true) return 'host-unavailable';
    const proof = await request('/api/proof-admission',
      {method:'POST', headers:{Authorization:'Bearer '+token}});
    if (!current()) return 'admission-auth-changed';
    if (proof.status !== 201 || typeof proof.body.admission?.token !== 'string'
      || !proof.body.admission.token) return 'admission-refused';
    const stored = JSON.stringify(proof.body.admission);
    sessionStorage.setItem('wrdProofAdmission', stored);
    window.__wrdProofStartGuard = () => current()
      && sessionStorage.getItem('wrdProofAdmission') === stored;
    return 'ready';
  } catch (error) {
    return ['admission-auth-changed','admission-body-cap','admission-deadline'].includes(error?.code)
      ? error.code : 'admission-unavailable';
  }
}'''


STARTUP_SUMMARY = '''() => {
  const project = client => {
    const auth = typeof Auth === 'undefined' ? null : Auth;
    const media = client?.mediaActivityRuntime?.snapshot?.();
    const oneOf = (value, allowed) => allowed.includes(value) ? value : 'unknown';
    return {observerAvailable: typeof window.__wrdPassiveSampler?.sample === 'function',
      socketPresent: !!client?.socket, socketConnected: client?.socket?.connected === true,
      pcState: oneOf(client?.pc?.connectionState, ['new','connecting','connected','disconnected','failed','closed']),
      uiPhase: oneOf(client?.uiPhase, ['idle','signaling','media-pending','connected','media-stalled','disconnected']),
      controlState: oneOf(client?.controlState?.state, ['FREE','GRANTING','ACTIVE','REVOKING']),
      hostOnline: client?.controlState?.hostOnline === true,
      desiredMediaState: oneOf(media?.desiredState, ['active','suspended']),
      desiredGeneration: Number.isSafeInteger(media?.desiredGeneration) && media.desiredGeneration >= 0
        ? media.desiredGeneration : null,
      authState: oneOf(auth?.getCheck?.()?.state, ['verified','unavailable','unauthorized']),
      superseded: client?._superseded === true, failureCause:'unknown'};
  };
  const sampler = window.__wrdPassiveSampler;
  // The shared observer enrolls its owner before the first legacy getter.
  if (typeof sampler?.summarySnapshot === 'function') return sampler.summarySnapshot(project);
  return {...project(typeof WebRTC === 'undefined' ? null : WebRTC),browserNowMs:null};
}'''


async def login_via_ui(page, password):
    await page.locator('#password').fill(password)
    await page.locator('#loginForm button[type="submit"]').click()
    await page.wait_for_url('**/viewer.html', timeout=30000)


async def issue_start_proof(page, timeout_s):
    result = await page.evaluate(PROOF_ADMISSION, min(8000, timeout_s * 1000))
    if result != 'ready':
        raise RuntimeError(result if result in ADMISSION_FAILURES else 'admission-unavailable')


def validate_startup(value):
    allowed = {'observerAvailable':bool,'socketPresent':bool,'socketConnected':bool,'hostOnline':bool,
        'superseded':bool,'pcState':('new','connecting','connected','disconnected','failed','closed','unknown'),
        'uiPhase':('idle','signaling','media-pending','connected','media-stalled','disconnected','unknown'),
        'controlState':('FREE','GRANTING','ACTIVE','REVOKING','unknown'),
        'desiredMediaState':('active','suspended','unknown'),'authState':('verified','unavailable','unauthorized','unknown'),
        'failureCause':('unknown',),'desiredGeneration':None,'browserNowMs':None,'inputGate':None,'startupMarks':None}
    if not isinstance(value,dict) or set(value)-set(allowed): raise ValueError('startup-schema')
    for key,field in value.items():
        rule = allowed[key]
        if rule is bool and type(field) is not bool: raise ValueError('startup-schema')
        if isinstance(rule,tuple): enum(field,rule)
        if key == 'desiredGeneration' and field is not None: bounded_int(field)
    validate_gate_fields(value)
    byte_cap(value,6144)
    return value


def empty_capture(stage):
    return {'stage':stage,'status':'not-reached','browserClock':'performance-now','pythonClock':'monotonic','browserNowMs':None,
        'pythonRequestedMs':None,'pythonCompletedMs':None,'state':None}


def monotonic_ms(): return min(9999999999999,max(0,round(time.monotonic()*1000)))


async def startup_summary(page, *, required=False, capture=None):
    if capture is not None: capture['pythonRequestedMs'] = monotonic_ms()
    try:
        value = validate_startup(await asyncio.wait_for(page.evaluate(STARTUP_SUMMARY), timeout=2))
        if capture is not None:
            capture.update(status='ok',browserNowMs=value.get('browserNowMs'),state=value)
        return value
    except asyncio.CancelledError:
        if capture is not None: capture['status'] = 'cancelled'
        raise
    except TimeoutError:
        if capture is not None: capture['status'] = 'timeout'
        if required: raise RuntimeError('startup-summary-deadline') from None
    except Exception as exc:
        if capture is not None: capture['status'] = 'schema-rejected' if isinstance(exc,ValueError) else 'error'
        if required: raise RuntimeError('startup-summary-unavailable') from None
    finally:
        if capture is not None: capture['pythonCompletedMs'] = monotonic_ms()
    return {'observerAvailable': False, 'failureCause': 'unknown'}


# Only fixed booleans and bounded relevant mark counts cross this boundary.
# Never return shell mark details, session/auth objects or connection identities.
START_UI_SNAPSHOT = '''() => {
  const shell = window.__WRD_SHELL__;
  const state = typeof shell?.snapshot === 'function' ? shell.snapshot() : null;
  const client = typeof WebRTC === 'undefined' ? null : WebRTC;
  const marks = Array.isArray(state?.marks) && state.marks.length <= 1024 ? state.marks : null;
  const count = name => marks ? marks.filter(mark => mark?.name === name).length : null;
  return {shellAvailable: !!state, clientAvailable: !!client, marksAvailable: !!marks,
    coreInstalled: state?.coreInstalled === true, authVerified: state?.authVerified === true,
    queuedStart: state?.queuedStart === true, socketPresent: !!client?.socket,
    pcPresent: !!client?.pc, attemptPresent: !!client?.currentConnectionAttemptId,
    admissionCurrent: window.__wrdProofStartGuard?.() === true,
    htmlShellMarks: count('html-shell'), coreInteractiveMarks: count('core-interactive'),
    startClickMarks: count('start-click')};
}'''


async def start_via_ui(page, *, proof_callback=issue_start_proof, timeout_s=30,
                       monotonic=time.monotonic, sleep=asyncio.sleep):
    """Require a fresh, authenticated core and prove exactly one normal UI Start."""
    deadline = monotonic() + timeout_s
    clicked = False
    reason = 'start-ui-unavailable'

    async def bounded(operation):
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise RuntimeError(reason)
        try:
            return await asyncio.wait_for(operation(remaining), timeout=remaining)
        except Exception as exc:
            if isinstance(exc, RuntimeError) and str(exc) in ADMISSION_FAILURES:
                raise
            raise RuntimeError(reason if monotonic() >= deadline else 'start-ui-unavailable') from None

    button = page.locator('#startBtn')
    while monotonic() < deadline:
        state = await bounded(lambda _: page.evaluate(START_UI_SNAPSHOT))
        available = (state['shellAvailable'] and state['clientAvailable'] and state['marksAvailable']
            and state['htmlShellMarks'] == 1)
        if clicked:
            if not available or state['startClickMarks'] not in (0, 1):
                raise RuntimeError('start-ui-click-unproven')
            if state['startClickMarks'] == 1:
                return {'status': 'verified', 'freshPage': True, 'coreInstalled': True,
                    'authVerified': True, 'startClickMarksBefore': 0, 'startClickMarksAfter': 1}
        else:
            if (state['socketPresent'] or state['pcPresent'] or state['attemptPresent']
                or state['queuedStart'] or state['startClickMarks'] not in (None, 0)):
                raise RuntimeError('start-ui-not-fresh')
            core_ready = available and state['coreInstalled'] and state['coreInteractiveMarks'] == 1
            reason = 'start-ui-deadline' if core_ready else 'start-ui-unavailable'
            if (core_ready and state['authVerified']
                and await bounded(lambda _: button.is_visible())
                and await bounded(lambda _: button.is_enabled())):
                await bounded(lambda remaining: proof_callback(page, remaining))
                # Never remint or fall through to an ordinary-ticket Start if
                # auth, freshness, proof storage or the actionable UI changed.
                visible = await bounded(lambda _: button.is_visible())
                enabled = await bounded(lambda _: button.is_enabled())
                current = await bounded(lambda _: page.evaluate(START_UI_SNAPSHOT))
                if (not visible or not enabled or not current['admissionCurrent']
                    or not all(current[key] for key in ('shellAvailable','clientAvailable',
                        'marksAvailable','coreInstalled','authVerified'))
                    or current['htmlShellMarks'] != 1 or current['coreInteractiveMarks'] != 1
                    or any(current[key] for key in ('socketPresent','pcPresent','attemptPresent','queuedStart'))
                    or current['startClickMarks'] != 0):
                    raise RuntimeError('start-ui-state-changed')
                # Exactly one real Playwright click, with normal actionability checks.
                await bounded(lambda remaining: button.click(timeout=max(1, remaining * 1000)))
                clicked = True
                reason = 'start-ui-click-unproven'
                continue
        await sleep(min(0.1, max(0, deadline - monotonic())))
    raise RuntimeError(reason)


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
    def __init__(self, stream, *, max_bytes=MAX_RUN_BYTES - 2 * MAX_ROW_BYTES, max_row_bytes=MAX_ROW_BYTES):
        self.stream, self.max_bytes, self.max_row_bytes = stream, max_bytes, max_row_bytes
        self.total_bytes = 0

    def write(self, row):
        validate_additive_evidence(row)
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
            sample = await lifecycle_stage(sample_once(),2)
            row.update(status='observed', sample=private_row(sample, salt))
        except CancellationCooperationError:
            raise
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


GATE_ENUMS = {
    'uiPhase':('idle','signaling','media-pending','connected','media-stalled','disconnected','unknown'),
    'desiredMediaState':('active','suspended','unknown'),
    'mediaRuntimePhase':('active','suspending','suspended','resuming','unknown'),
    'keyboardControllerState':('INACTIVE','READY','BLOCKED','RESET_REQUIRED','unknown'),
    'keyboardTransportState':('ready','blocked','reacquire-required','revoked','unknown'),
    'surfaceState':('settled','pending','uncertain','unknown'),
    'desktopWriteRecoveryState':('none','reacquire-required','reconciled','unknown'),
    'recoveryState':('idle','waiting','recovered','failed','unknown')}
GATE_BOOLEANS = ('allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame',
    'currentAttemptReady','hasActiveControl','socketConnected','manualDisconnect','superseded',
    'mouseResetPending','draftComposing','draftPending','draftUncertain','firstFrameTimerHandlePresent')
GATE_REASONS = frozenset(('no-active-control','inactive','viewport-unsupported','manual-disconnect',
    'media-not-ready-for-attempt','media-gate',
    *('runtime-phase:'+v for v in ('active','suspending','suspended','resuming','unknown')),
    *('media-state:'+v for v in ('active','suspended','unknown')),
    'keyboard-transport-blocked','keyboard-transport-reacquire-required','keyboard-transport-revoked',
    'keyboard-reset-pending','keyboard-blocked','surface-pending','surface-uncertain','mouse-reset-pending',
    'desktop-write-reacquire-required','draft-composing','draft-pending','draft-uncertain',
    'recovery-waiting','recovery-failed','unknown'))
MARK_NAMES = ('start-click','bootstrap-start','bootstrap-ready','bootstrap-degraded','signal-connected','first-frame','active')


def bounded_time(value):
    if value is not None and (not nonnegative(value) or value > 9999999999999):
        raise ValueError('evidence-time-schema')


def validate_gate(value):
    exact_keys(value, ('status','blockedReasons',*GATE_BOOLEANS,*GATE_ENUMS))
    enum(value['status'], ('observed','unavailable','scope-changed'))
    for key in GATE_BOOLEANS:
        if value[key] is not None and type(value[key]) is not bool: raise ValueError('gate-schema')
    for key,allowed in GATE_ENUMS.items(): enum(value[key],allowed)
    reasons = value['blockedReasons']
    if not isinstance(reasons,list) or len(reasons) > 32: raise ValueError('gate-schema')
    for reason in reasons: enum(reason,GATE_REASONS)
    if len(set(reasons)) != len(reasons): raise ValueError('gate-schema')
    if value['status'] != 'observed' and (reasons or any(value[k] is not None for k in GATE_BOOLEANS)
        or any(value[k] != 'unknown' for k in GATE_ENUMS)): raise ValueError('gate-schema')
    byte_cap(value,4096)
    return value


def validate_gate_fields(value):
    if 'browserNowMs' in value: bounded_time(value['browserNowMs'])
    if 'inputGate' in value: validate_gate(value['inputGate'])
    if 'startupMarks' in value:
        exact_keys(value['startupMarks'],MARK_NAMES)
        for field in value['startupMarks'].values(): bounded_time(field)
        byte_cap(value['startupMarks'],512)


def validate_capture(value):
    exact_keys(value, ('stage','status','browserClock','pythonClock','browserNowMs','pythonRequestedMs','pythonCompletedMs','state'))
    enum(value['stage'], ('startup-baseline','post-failure-preclose'))
    enum(value['browserClock'], ('performance-now',))
    enum(value['pythonClock'], ('monotonic',))
    enum(value['status'], ('ok','not-reached','unavailable','timeout','schema-rejected','cancelled','error'))
    for key in ('browserNowMs','pythonRequestedMs','pythonCompletedMs'): bounded_time(value[key])
    if value['state'] is not None: validate_startup(value['state'])
    if value['status'] == 'ok':
        if value['state'] is None or value['pythonRequestedMs'] is None or value['pythonCompletedMs'] is None:
            raise ValueError('capture-schema')
        if value['browserNowMs'] != value['state'].get('browserNowMs'): raise ValueError('capture-schema')
    elif value['state'] is not None or value['browserNowMs'] is not None: raise ValueError('capture-schema')
    if value['status'] == 'not-reached' and any(value[k] is not None for k in ('pythonRequestedMs','pythonCompletedMs')):
        raise ValueError('capture-schema')
    if value['pythonRequestedMs'] is not None and value['pythonCompletedMs'] is not None \
        and value['pythonCompletedMs'] < value['pythonRequestedMs']: raise ValueError('capture-schema')
    byte_cap(value,6656)


class TimeoutConsoleObserver:
    # A positive page transition only. No argument/location/stack access.
    pattern = re.compile(r'\[PAINT-GATE\] uiPhase=disconnected reason=first-frame-timeout painted=(true|false)\Z')

    def __init__(self):
        self.page = None
        self.active = False
        self.handler = self.observe
        self.value = {'status':'unavailable','installedBeforeStart':False,'attachedMs':None,'detachedMs':None,
            'error':'none','capped':False,'acceptedCount':0,'firstEvent':None}

    def attach(self,page):
        if not callable(getattr(page,'on',None)) or not callable(getattr(page,'remove_listener',None)):
            return
        self.page = page
        self.active = True
        try:
            page.on('console',self.handler)
            self.value.update(status='attached',installedBeforeStart=True,attachedMs=monotonic_ms())
        except Exception:
            self.value.update(status='failed',error='attach-error')
            self.detach()

    def observe(self,message):
        if not self.active: return
        try:
            if message.type != 'log': return
            text = message.text
            if not isinstance(text,str) or len(text) > 128: return
            match = self.pattern.fullmatch(text)
            if match is None: return
            if self.value['acceptedCount'] >= 64:
                self.value['capped'] = True
                return
            event = {'class':'first-frame-timeout-transition','painted':match[1] == 'true',
                'pythonReceiptMs':monotonic_ms()}
            self.value['acceptedCount'] += 1
            if self.value['firstEvent'] is None: self.value['firstEvent'] = event
        except Exception:
            self.value['error'] = 'parser-error'

    def detach(self):
        if not self.active: return
        self.active = False
        try: self.page.remove_listener('console',self.handler)
        except Exception: self.value['error'] = 'detach-error'
        finally:
            self.value['detachedMs'] = monotonic_ms()
            if self.value['status'] == 'attached': self.value['status'] = 'detached'


def validate_console(value):
    exact_keys(value, ('status','installedBeforeStart','attachedMs','detachedMs','error','capped','acceptedCount','firstEvent'))
    enum(value['status'], ('unavailable','attached','detached','failed'))
    enum(value['error'], ('none','attach-error','parser-error','detach-error'))
    for key in ('installedBeforeStart','capped'):
        if type(value[key]) is not bool: raise ValueError('console-schema')
    for key in ('attachedMs','detachedMs'): bounded_time(value[key])
    bounded_int(value['acceptedCount'],64)
    event = value['firstEvent']
    if event is not None:
        exact_keys(event, ('class','painted','pythonReceiptMs'))
        enum(event['class'], ('first-frame-timeout-transition',))
        if type(event['painted']) is not bool: raise ValueError('console-schema')
        bounded_time(event['pythonReceiptMs'])
        if event['pythonReceiptMs'] is None: raise ValueError('console-schema')
    if (event is None) != (value['acceptedCount'] == 0): raise ValueError('console-schema')
    byte_cap(value,1024)


def validate_additive_evidence(value):
    validate_gate_fields(value)
    if 'sample' in value and isinstance(value['sample'],dict): validate_gate_fields(value['sample'])
    if 'startupSummary' in value and value['startupSummary'] is not None: validate_startup(value['startupSummary'])
    for key in ('startupSnapshot','failureSnapshot'):
        if key in value: validate_capture(value[key])
    if value.get('failureObservation') is not None:
        observation = value['failureObservation']
        exact_keys(observation, ('browserNowMs','inputGate'))
        validate_gate_fields(observation)
    if 'timeoutConsole' in value: validate_console(value['timeoutConsole'])


def private_row(sample, salt):
    sample = dict(sample)
    validate_gate_fields(sample)
    attempt = sample.pop('attempt', None)
    sample['attemptHash'] = hashlib.sha256(salt + attempt.encode()).hexdigest()[:16] if isinstance(attempt, str) else None
    if 'diagnostics' in sample: validate_delta(sample['diagnostics'])
    build = sample.get('buildId')
    if not isinstance(build, str) or len(build) > 128 or not all(c.isalnum() or c in '-_.' for c in build):
        sample['buildId'] = None
    return sample


# Browser diagnostics are a separate, strictly validated schema. Never retain an
# unchecked browser dictionary, exception message, URL or real transport ID.
EVENT_KINDS = ('sd','mc','ec','se','re','rx','tx','sc','mo','ra','rr','rf','ep','eo',
    'ef','eu','bind','vis','net','focus','hide','show','freeze','resume','preclose','cap')
TERMINAL_KINDS = frozenset(('sd','mc','ec','se','re'))
CLOSE_REASONS = frozenset(('server','client','ping','transport-close','transport-error','parse','forced','unknown'))
COUNTER_MAX = 999999999
EVENT_TIME_MAX = 43320000
FINAL_EXPORT = '() => window.__wrdPassiveSampler?.finalize?.() ?? null'


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('diagnostic-schema')


def bounded_int(value, maximum=COUNTER_MAX, nullable=False):
    if nullable and value is None:
        return
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('diagnostic-schema')


def enum(value, allowed):
    if not isinstance(value, str) or value not in allowed:
        raise ValueError('diagnostic-schema')


def byte_cap(value, maximum):
    if len(compact(value)) > maximum:
        raise ValueError('diagnostic-capacity')


def validate_event(event):
    if not isinstance(event, dict): raise ValueError('diagnostic-schema')
    kind = event.get('k')
    enum(kind, EVENT_KINDS)
    keys = {'t','n','k'}
    if kind in TERMINAL_KINDS: keys |= {'o','c','r'}
    elif kind in ('rx','tx'): keys |= {'o','c','p'}
    elif kind in ('sc','mo','ra','rr','rf','ep','eo','ef','eu','bind'): keys |= {'o','c'}
    elif kind in ('vis','net','focus'): keys |= {'v'}
    if kind == 'ec' and 'ws' in event: keys.add('ws')
    exact_keys(event, keys)
    if 'ws' in keys:
        ws = event['ws']
        exact_keys(ws, {'code','wasClean'})
        if type(ws['code']) is not int or not 1000 <= ws['code'] <= 4999 or type(ws['wasClean']) is not bool:
            raise ValueError('diagnostic-schema')
    bounded_int(event['t'], EVENT_TIME_MAX)
    bounded_int(event['n'])
    if event['n'] < 1: raise ValueError('diagnostic-schema')
    if 'o' in keys:
        label = event['o']
        if not isinstance(label, str) or len(label) not in (2,3) or label[0] not in 'sme' \
            or not label[1:].isascii() or not label[1:].isdigit() or not 1 <= int(label[1:]) <= 64 \
            or str(int(label[1:])) != label[1:] or type(event['c']) is not bool:
            raise ValueError('diagnostic-schema')
        prefix = 's' if kind in ('sd','se','sc') else 'm' if kind in ('mc','mo','ra','rr','re','rf') else 'e'
        if kind != 'bind' and label[0] != prefix: raise ValueError('diagnostic-schema')
    if 'r' in keys:
        reasons = ('transport-error','unknown') if kind in ('se','re') else CLOSE_REASONS
        if kind in ('mc','ec'): reasons = CLOSE_REASONS - {'server','client'}
        enum(event['r'], reasons)
    if 'p' in keys: enum(event['p'], ('ping','pong','unknown'))
    if kind == 'vis': enum(event['v'], ('visible','hidden','prerender','unknown'))
    if kind in ('net','focus') and event['v'] is not None and type(event['v']) is not bool:
        raise ValueError('diagnostic-schema')
    byte_cap(event, 192)
    return event


def validate_events(events, count):
    if not isinstance(events, list) or len(events) > count: raise ValueError('diagnostic-capacity')
    previous_n, previous_t = 0, 0
    for event in events:
        validate_event(event)
        if event['n'] <= previous_n or event['t'] < previous_t: raise ValueError('diagnostic-order')
        previous_n, previous_t = event['n'], event['t']
    byte_cap(events, count*192+count+1)


def validate_attribution(value):
    exact_keys(value, ('firstDisconnectEvent','cause'))
    enum(value['cause'], ('unknown',))
    if value['firstDisconnectEvent'] is not None:
        validate_event(value['firstDisconnectEvent'])
        if value['firstDisconnectEvent']['k'] not in TERMINAL_KINDS: raise ValueError('diagnostic-schema')
    byte_cap(value, 384)


def validate_delta(value):
    exact_keys(value, ('schemaVersion','events','cursor','gap','truncated','droppedEvents',
        'coverageStatus','firstDisconnectEvent','cause'))
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1: raise ValueError('diagnostic-schema')
    validate_events(value['events'], 16)
    for key in ('cursor','gap','droppedEvents'): bounded_int(value[key])
    if type(value['truncated']) is not bool: raise ValueError('diagnostic-schema')
    enum(value['coverageStatus'], ('partial','capacity','unavailable'))
    validate_attribution({key:value[key] for key in ('firstDisconnectEvent','cause')})
    if value['events']:
        if value['cursor'] != value['events'][-1]['n'] or value['gap'] > value['events'][0]['n']-1:
            raise ValueError('diagnostic-order')
    elif value['gap'] or value['truncated']:
        raise ValueError('diagnostic-order')
    if value['truncated'] and len(value['events']) != 16: raise ValueError('diagnostic-order')
    if value['gap'] > value['droppedEvents']: raise ValueError('diagnostic-order')
    if len(compact(value))-len(compact(value['events'])) > 1007: raise ValueError('diagnostic-capacity')
    byte_cap(value,4096)
    return value


def empty_diagnostic():
    return {'schemaVersion':1,
        'anchors':dict.fromkeys(('browserWallEpochMs','browserTimeOriginEpochMs','browserAnchorNowMs')),
        'attribution':{'firstDisconnectEvent':None,'cause':'unknown'},
        'counters':dict.fromkeys(EVENT_KINDS,0),
        'state':{'visibility':'unknown','online':None,'focus':None,'socketState':'unavailable','pingReceivedAtMs':None,
            'pongCreatedAtMs':None,'flushAtMs':None,
            'lag':{'lastMs':None,'maxMs':0,'count':0,'missedIntervals':0,'buckets':[0,0,0,0]}},
        'coverage':{'status':'unavailable','failure':'none','observedFromMs':0,
            'boundAtMs':dict.fromkeys(('s','m','e')), 'bindingChanges':0,
            'missingReferences':0,'transport':'unknown'},
        'droppedEvents':0,'events':[]}


def validate_diagnostic(value):
    exact_keys(value, ('schemaVersion','anchors','attribution','counters','state','coverage','droppedEvents','events'))
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1: raise ValueError('diagnostic-schema')
    exact_keys(value['anchors'], ('browserWallEpochMs','browserTimeOriginEpochMs','browserAnchorNowMs'))
    for field in value['anchors'].values(): bounded_int(field,9999999999999,True)
    byte_cap(value['anchors'],512)
    validate_attribution(value['attribution'])
    exact_keys(value['counters'], EVENT_KINDS)
    for field in value['counters'].values(): bounded_int(field)
    byte_cap(value['counters'],1024)
    state = value['state']
    exact_keys(state, ('visibility','online','focus','socketState','pingReceivedAtMs','pongCreatedAtMs','flushAtMs','lag'))
    enum(state['visibility'], ('visible','hidden','prerender','unknown'))
    enum(state['socketState'], ('unavailable','connected','state-observed-disconnected'))
    for key in ('online','focus'):
        if state[key] is not None and type(state[key]) is not bool: raise ValueError('diagnostic-schema')
    for key in ('pingReceivedAtMs','pongCreatedAtMs','flushAtMs'): bounded_int(state[key],EVENT_TIME_MAX,True)
    exact_keys(state['lag'], ('lastMs','maxMs','count','missedIntervals','buckets'))
    for key in ('lastMs','maxMs','count','missedIntervals'): bounded_int(state['lag'][key],nullable=key == 'lastMs')
    if not isinstance(state['lag']['buckets'],list) or len(state['lag']['buckets']) != 4: raise ValueError('diagnostic-schema')
    for field in state['lag']['buckets']: bounded_int(field)
    byte_cap(state,1024)
    coverage = value['coverage']
    exact_keys(coverage, ('status','failure','observedFromMs','boundAtMs','bindingChanges','missingReferences','transport'))
    enum(coverage['status'], ('partial','capacity','unavailable'))
    enum(coverage['failure'], ('none','schema-capacity'))
    bounded_int(coverage['observedFromMs'],EVENT_TIME_MAX)
    exact_keys(coverage['boundAtMs'], ('s','m','e'))
    for field in coverage['boundAtMs'].values(): bounded_int(field,EVENT_TIME_MAX,True)
    for key in ('bindingChanges','missingReferences'): bounded_int(coverage[key])
    enum(coverage['transport'], ('websocket','polling','unknown'))
    byte_cap(coverage,1024)
    bounded_int(value['droppedEvents'])
    validate_events(value['events'],128)
    if len(compact(value))-len(compact(value['events'])) > 8063: raise ValueError('diagnostic-capacity')
    return value


def diagnostic_from_delta(previous, delta):
    validate_delta(delta)
    # This is explicitly partial last-known evidence, never a fabricated history.
    value = json.loads(compact(previous))
    value['events'] = delta['events']
    value['droppedEvents'] = delta['droppedEvents']
    value['attribution'] = {key:delta[key] for key in ('firstDisconnectEvent','cause')}
    value['coverage']['status'] = delta['coverageStatus']
    return validate_diagnostic(value)


def atomic_evidence(path, value, *, initial=False):
    validate_additive_evidence(value)
    encoded = compact(value)
    if len(encoded) > MAX_ROW_BYTES: raise ValueError('evidence-budget-exceeded')
    if initial:
        fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as stream: stream.write(encoded)
        return
    # One same-directory temporary file, at most MAX_ROW_BYTES extra disk bytes.
    temporary = path.with_name('.'+path.name+'.tmp')
    fd = os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write(encoded)
        os.replace(temporary,path)
    finally:
        try: temporary.unlink()
        except FileNotFoundError: pass


class CancellationCooperationError(RuntimeError):
    """The backend did not settle within its cancellation allowance."""


async def lifecycle_stage(operation, timeout, *, settlement=0.25):
    """Own the task and include cancellation settlement in the stage deadline.

    API teardown bounds require cancellation cooperation; an uncooperative API is
    an implementation gate failure, never evidence of process exit or success.
    """
    task = asyncio.ensure_future(operation)
    started = time.monotonic()
    try:
        done,_ = await asyncio.wait({task},timeout=max(0,timeout-settlement))
        if done: return task.result()
        raise TimeoutError()
    except BaseException:
        task.cancel()
        settle_deadline = time.monotonic()+min(settlement,max(0,timeout-(time.monotonic()-started)))
        done = {task} if task.done() else set()
        while not done and time.monotonic() < settle_deadline:
            try:
                done,_ = await asyncio.wait({task},timeout=max(0,settle_deadline-time.monotonic()))
            except asyncio.CancelledError:
                # Preserve the first failure/cancellation while still owning the
                # one child task and its original cancellation-settlement budget.
                continue
        if not done:
            # Caller must treat this as a hard implementation gate failure. No
            # in-process asyncio primitive can force an arbitrary API to settle.
            raise CancellationCooperationError('cancellation-noncooperative') from None
        try: task.result()
        except BaseException: pass
        raise


async def run(args, *, manager_factory=None, limits=None):
    from dotenv import dotenv_values
    if manager_factory is None:
        from playwright.async_api import async_playwright
        manager_factory = async_playwright
    caps = {'managerStart':10,'managerLaunch':15,'export':1,'browserClose':3,'managerStop':3,'cleanup':8}
    if limits:
        for key,value in limits.items():
            if key not in caps or not nonnegative(value) or value > caps[key]: raise ValueError('lifecycle-limit')
            caps[key] = value
    enum(args.mode, ('stun','relay','tunnel'))
    if type(args.duration_seconds) is not int or not 1 <= args.duration_seconds <= 43200:
        raise ValueError('duration must be 1..43200 seconds')
    origin = args.origin.rstrip('/')
    parsed = urlsplit(origin)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError('origin must contain only scheme and host')
    password = os.environ.get('VIEWER_ACCESS_PASSWORD') or dotenv_values(args.runtime_config).get('VIEWER_ACCESS_PASSWORD')
    if not password: raise ValueError('runtime password unavailable')
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    fd = os.open(output/'samples.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    summary = ContinuitySummary(duration_s=args.duration_seconds, mode=args.mode)
    salt = secrets.token_bytes(16)
    start = None
    interrupted = True
    stage = 'not-started'
    failure = None
    cancellation = None
    cooperation_failure = None
    manager = playwright = browser = page = None
    start_proof = {'status':'NOT_VERIFIED'}
    startup = None
    startup_capture = empty_capture('startup-baseline')
    failure_capture = empty_capture('post-failure-preclose')
    failure_observation = last_gate_observation = None
    console = TimeoutConsoleObserver()
    diagnostic = empty_diagnostic()
    python_state = {'failureDetectedMs':None,'failureWallEpochMs':None,
        'managerStart':{'startedMs':None,'finishedMs':None,'status':'not-started'},
        'managerLaunch':{'startedMs':None,'finishedMs':None,'status':'not-started'},
        'managerStop':{'startedMs':None,'finishedMs':None,'status':'not-started'},
        'browserClose':{'startedMs':None,'finishedMs':None,'status':'not-created'},
        'cleanupStatus':'not-started'}
    capture_status = 'not-started'
    write_status = 'ok'
    cleanup_failed = False
    stages = frozenset(('not-started','manager-start','browser-start','browser-context','entry',
        'ui-login','observer-install','start-ui','media-start','startup-summary','sampling','cancelled','cleanup'))
    reasons = ADMISSION_FAILURES | {'entry-unavailable','media-start-deadline',
        'sample-continuity-lost','session-changed-or-disconnected','evidence-budget-exceeded',
        'sampling-deadline-overrun','start-ui-unavailable','start-ui-deadline','start-ui-not-fresh',
        'start-ui-click-unproven','start-ui-state-changed','timeout','cancelled','unknown',
        'cancellation-noncooperative','cleanup-failed','evidence-write-failed',
        'startup-summary-unavailable','startup-summary-deadline'}

    def now(): return min(9999999999999,round(time.monotonic()*1000))

    def fail(exc, *, at=None):
        nonlocal failure, interrupted, failure_observation
        interrupted = True
        if failure is not None: return
        at = at or stage
        if at not in stages: at = 'cleanup'
        reason = 'cancelled' if isinstance(exc,asyncio.CancelledError) else 'timeout' if isinstance(exc,TimeoutError) else str(exc)
        failure = {'stage':at,'category':'startup-guard' if at == 'start-ui' else 'media-wait' if at == 'media-start' else 'runtime',
            'reason':reason if reason in reasons else 'unknown'}
        if at == 'sampling' and last_gate_observation is not None:
            failure_observation = json.loads(compact(last_gate_observation))
        python_state['failureDetectedMs'] = now()
        python_state['failureWallEpochMs'] = min(9999999999999,max(0,round(time.time()*1000)))

    def result():
        elapsed = time.monotonic()-start if start is not None else 0
        value = summary.result(elapsed_s=elapsed,interrupted=interrupted or cleanup_failed or write_status != 'ok' or python_state['cleanupStatus'] != 'api-finished-exit-unknown')
        value.update(mode=args.mode,failure=failure,startProof=start_proof,startupSummary=startup,
            startupSnapshot=startup_capture,failureSnapshot=failure_capture,
            failureObservation=failure_observation,timeoutConsole=console.value,
            originClass='loopback' if parsed.hostname in ('localhost','127.0.0.1','::1') else 'formal',
            lifecycle={'file':'lifecycle.json','captureStatus':capture_status,
                'cleanupStatus':python_state['cleanupStatus'],'writeStatus':write_status,
                'ownedProcessExitEvidence':'not-observed'})
        return value

    def lifecycle():
        validate_diagnostic(diagnostic)
        # All Python values are locally generated, but validate the entire schema
        # before every persistence attempt, including fallback/preliminary files.
        exact_keys(python_state, ('failureDetectedMs','failureWallEpochMs','managerStart',
            'managerLaunch','managerStop','browserClose','cleanupStatus'))
        for key in ('failureDetectedMs','failureWallEpochMs'): bounded_int(python_state[key],9999999999999,True)
        for key in ('managerStart','managerLaunch','managerStop','browserClose'):
            record = python_state[key]
            exact_keys(record, ('startedMs','finishedMs','status'))
            for clock_key in ('startedMs','finishedMs'): bounded_int(record[clock_key],9999999999999,True)
            enum(record['status'], ('ok','timeout','error','cancelled','not-started','not-created','closed','noncooperative'))
        enum(python_state['cleanupStatus'], ('not-started','running','api-finished-exit-unknown','incomplete'))
        enum(capture_status, ('not-started','ok','unavailable','timeout','error','cancelled','schema-rejected','noncooperative'))
        enum(write_status, ('ok','error'))
        byte_cap(python_state,2048)
        value = {'schemaVersion':1,'diagnostics':diagnostic,'python':python_state,
            'captureStatus':capture_status,'writeStatus':write_status,'ownedProcessExitEvidence':'not-observed'}
        byte_cap({k:v for k,v in value.items() if k not in ('diagnostics','python')},512)
        if len(compact(value))-len(compact(diagnostic['events'])) > 8063: raise ValueError('diagnostic-capacity')
        byte_cap(value,MAX_ROW_BYTES)
        return value

    def persist(*, initial=False):
        nonlocal write_status, diagnostic
        try:
            value = lifecycle()
        except ValueError:
            # Preserve only previously validated anchors/first terminal, fixed
            # statuses and cleanup; never truncate bytes or arbitrary fields.
            fallback = empty_diagnostic()
            fallback['anchors'] = diagnostic['anchors']
            fallback['attribution'] = diagnostic['attribution']
            fallback['coverage'].update(status='capacity',failure='schema-capacity')
            diagnostic = validate_diagnostic(fallback)
            value = lifecycle()
        committed = True
        for name in ('lifecycle.json','summary.json'):
            payload = value if name == 'lifecycle.json' else result()
            try: atomic_evidence(output/name,payload,initial=initial)
            except (OSError,ValueError):
                committed = False
                write_status = 'error'
                fail(RuntimeError('evidence-write-failed'))
        return committed

    async def tracked(key, operation, cap):
        record = python_state[key]
        record.update(startedMs=now(),status='not-started')
        try:
            value = await lifecycle_stage(operation,cap,settlement=min(.25,cap/4))
            record['status'] = 'closed' if key == 'browserClose' else 'ok'
            return value
        except asyncio.CancelledError:
            record['status'] = 'cancelled'; raise
        except TimeoutError:
            record['status'] = 'timeout'; raise
        except CancellationCooperationError:
            record['status'] = 'noncooperative'; raise
        except Exception:
            record['status'] = 'error'; raise
        finally: record['finishedMs'] = now()

    async def sample_once():
        nonlocal diagnostic, last_gate_observation
        last_gate_observation = None
        value = await page.evaluate('() => window.__wrdPassiveSampler.sample()')
        if isinstance(value,dict):
            validate_gate_fields(value)
            if value.get('inputGate',{}).get('status') == 'observed' and value.get('browserNowMs') is not None:
                last_gate_observation = json.loads(compact({key:value[key] for key in ('browserNowMs','inputGate')}))
        if isinstance(value,dict) and 'diagnostics' in value:
            diagnostic = diagnostic_from_delta(diagnostic,value['diagnostics'])
        return value

    async def cleanup():
        nonlocal diagnostic, capture_status, cleanup_failed, cooperation_failure
        deadline = time.monotonic()+caps['cleanup']
        python_state['cleanupStatus'] = 'running'
        def remaining(key): return max(0,min(caps[key],deadline-time.monotonic()))
        if failure is not None and page is not None and remaining('export') > 0:
            try:
                await lifecycle_stage(startup_summary(page,capture=failure_capture),remaining('export'),
                    settlement=min(.25,remaining('export')/4))
            except CancellationCooperationError as exc:
                cooperation_failure = exc; cleanup_failed = True
            except TimeoutError: failure_capture['status'] = 'timeout'
            except BaseException: pass
        elif failure is not None:
            failure_capture['status'] = 'unavailable'
        if page is not None and remaining('export') > 0:
            try:
                value = await lifecycle_stage(page.evaluate(FINAL_EXPORT),remaining('export'),
                    settlement=min(.25,remaining('export')/4))
                if value is None: capture_status = 'unavailable'; cleanup_failed = True
                else:
                    candidate = validate_diagnostic(value)
                    prior = diagnostic['attribution']['firstDisconnectEvent']
                    found = candidate['attribution']['firstDisconnectEvent']
                    if prior is not None and (found is None or found['n'] > prior['n']):
                        candidate['attribution']['firstDisconnectEvent'] = prior
                    diagnostic = validate_diagnostic(candidate)
                    capture_status = 'ok'
            except asyncio.CancelledError: capture_status = 'cancelled'; cleanup_failed = True
            except TimeoutError: capture_status = 'timeout'; cleanup_failed = True
            except ValueError: capture_status = 'schema-rejected'; cleanup_failed = True
            except CancellationCooperationError as exc:
                cooperation_failure = exc; capture_status = 'noncooperative'; cleanup_failed = True
            except Exception: capture_status = 'error'; cleanup_failed = True
        else: capture_status = 'unavailable'
        console.detach()
        # Ordered pre-close evidence survives browser.close and manager.stop.
        persist()
        if browser is not None:
            if remaining('browserClose') > 0:
                try: await tracked('browserClose',browser.close(),remaining('browserClose'))
                except CancellationCooperationError as exc:
                    cooperation_failure = exc; cleanup_failed = True
                except BaseException: cleanup_failed = True
            else:
                python_state['browserClose'].update(status='timeout',startedMs=now(),finishedMs=now())
                cleanup_failed = True
        # A manager may exist after an unsuccessful start or launch. Teardown is
        # attempted independently of browser close, inside this one total budget.
        if manager is not None:
            if remaining('managerStop') > 0:
                try:
                    operation = playwright.stop() if playwright is not None and hasattr(playwright,'stop') else manager.stop() if hasattr(manager,'stop') else manager.__aexit__(None,None,None)
                    await tracked('managerStop',operation,remaining('managerStop'))
                except CancellationCooperationError as exc:
                    cooperation_failure = exc; cleanup_failed = True
                except BaseException: cleanup_failed = True
            else:
                python_state['managerStop'].update(status='timeout',startedMs=now(),finishedMs=now())
                cleanup_failed = True
        if python_state['managerStart']['status'] != 'ok' or python_state['managerLaunch']['status'] != 'ok':
            cleanup_failed = True
        if cleanup_failed:
            fail(RuntimeError('cleanup-failed'),at='cleanup')
        python_state['cleanupStatus'] = 'incomplete' if cleanup_failed else 'api-finished-exit-unknown'

    # Evidence ownership starts before manager construction/entry and ends after
    # teardown. Even launch failure and repeated cancellation reach final writes.
    with os.fdopen(fd,'w') as stream:
        try:
            if not persist(initial=True):
                raise RuntimeError('evidence-write-failed')
            stage = 'manager-start'
            manager = manager_factory()
            operation = manager.start() if hasattr(manager,'start') else manager.__aenter__()
            playwright = await tracked('managerStart',operation,caps['managerStart'])
            stage = 'browser-start'
            browser = await tracked('managerLaunch',playwright.chromium.launch(headless=True),caps['managerLaunch'])
            stage = 'browser-context'
            context = await lifecycle_stage(browser.new_context(),8)
            page = await lifecycle_stage(context.new_page(),8)
            page.set_default_timeout(8000)
            await lifecycle_stage(page.add_init_script("localStorage.setItem('wrdNetworkMode', " + json.dumps(args.mode) + ");"),8)
            stage = 'entry'
            response = await lifecycle_stage(page.goto(origin,wait_until='domcontentloaded',timeout=30000),31)
            if not response or response.status != 200: raise RuntimeError('entry-unavailable')
            await lifecycle_stage(page.locator('#password').wait_for(state='visible'),9)
            stage = 'ui-login'
            await lifecycle_stage(login_via_ui(page,password),39)
            stage = 'observer-install'
            await lifecycle_stage(page.evaluate(Path(__file__).with_name('passive_session_sampler.js').read_text()),8)
            console.attach(page)
            stage = 'start-ui'
            start_proof = await start_via_ui(page)
            stage = 'media-start'
            for _ in range(45):
                sample = await lifecycle_stage(sample_once(),2)
                ready = (sample['socketConnected'] and (sample['relayFrameSeq'] is not None and sample['tunnelRelayActive'] and sample['relayLoadCallbacks'] > 1
                    if args.mode == 'tunnel' else sample['pcState'] == 'connected' and sample['callbacks'] > 1))
                if ready: break
                await asyncio.sleep(1)
            else: raise RuntimeError('media-start-deadline')
            stage = 'startup-summary'
            startup = await startup_summary(page,required=True,capture=startup_capture)
            stage = 'sampling'
            start = time.monotonic()
            await collect_samples(sample_once,EvidenceWriter(stream),summary,salt,
                start=start,duration_s=args.duration_seconds,
                progress=lambda elapsed: print(json.dumps({'stage':stage,'elapsedSeconds':round(elapsed),
                    'samples':summary.samples,'missing':summary.missing}),flush=True))
            interrupted = False
        except asyncio.CancelledError as exc:
            cancellation = exc
            fail(exc)
        except CancellationCooperationError as exc:
            cooperation_failure = exc
            fail(exc)
        except Exception as exc:
            fail(exc)
        finally:
            # A shield owns the single coordinator. Repeated external cancellation
            # never restarts its deadline or skips synchronous final persistence.
            coordinator = asyncio.create_task(cleanup())
            try:
                while not coordinator.done():
                    try: await asyncio.shield(coordinator)
                    except asyncio.CancelledError as exc:
                        if cancellation is None: cancellation = exc; fail(exc)
                    except BaseException:
                        break
                try: coordinator.result()
                except BaseException:
                    cleanup_failed = True
                    python_state['cleanupStatus'] = 'incomplete'
                    fail(RuntimeError('cleanup-failed'),at='cleanup')
            finally:
                persist()
    final = result()
    print(json.dumps(final),flush=True)
    if cancellation is not None: raise cancellation
    if cooperation_failure is not None: raise cooperation_failure
    return 0 if final['status'] == 'PASS' else 1


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
