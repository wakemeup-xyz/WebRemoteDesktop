#!/usr/bin/env python3
"""Bounded read-only recovery evidence primitives. No runtime/browser imports."""
from __future__ import annotations

import argparse
import asyncio
import copy
import inspect
from datetime import datetime
import hashlib
import json
import math
import os
import re
import stat
import time
import secrets
from pathlib import Path
from urllib.parse import urlsplit

# Both direct CLI execution and package tests use the unchanged pure helper.
if __package__:
    from . import passive_session_soak as passive
else:
    import passive_session_soak as passive
CancellationCooperationError = passive.CancellationCooperationError
compact, lifecycle_stage = passive.compact, passive.lifecycle_stage
validate_delta, validate_gate_fields = passive.validate_delta, passive.validate_gate_fields
empty_diagnostic = passive.empty_diagnostic

MAX_ROW_BYTES = 32768
SCOPES = {'baseline': 'native-passive-continuity', 'continuity': 'native-passive-continuity',
          'within-grace': 'ordinary-functional-native-direct-close',
          'after-grace': 'ordinary-functional-playwright-routed-stimulus'}
PHASES = ('preflight', 'startup', 'baseline', 'fault', 'recovering', 'recovered-stability', 'continuity', 'terminal')
EVENTS = {'viewer_disconnect_grace_started': 'grace-started',
          'viewer_disconnect_grace_expired': 'grace-expired',
          'viewer_rebind_confirmed': 'rebind-confirmed', 'viewer_rebind_failed': 'rebind-failed',
          'control_reset_completed': 'reset-completed', 'signal_socket_disconnected': 'host-disconnected'}


def _keys(value, keys):
    if type(value) is not dict or set(value) != set(keys): raise ValueError('schema-rejected')


def _int(value, maximum=999999999, *, minimum=0, nullable=False):
    if nullable and value is None: return
    if type(value) is not int or not minimum <= value <= maximum: raise ValueError('schema-rejected')


def _number(value, maximum=12000, *, nullable=False):
    if nullable and value is None: return
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError('schema-rejected')


def _enum(value, allowed):
    if type(value) is not str or value not in allowed: raise ValueError('schema-rejected')


def _id(value):
    if type(value) is not str or not 1 <= len(value) <= 128: return False
    try: value.encode('utf-8')
    except UnicodeError: return False
    return True


def _hash(value):
    if value is not None and (type(value) is not str or re.fullmatch('[0-9a-f]{16}', value) is None):
        raise ValueError('schema-rejected')


def hash_identity(value, salt):
    if not isinstance(value, str) or not 1 <= len(value) <= 128: return None
    return hashlib.sha256(salt + value.encode('utf-8')).hexdigest()[:16]


def _json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('schema-rejected')
            value[key] = item
        return value
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('schema-rejected')))


def validate_host_observation(value):
    _keys(value, ('status', 'hostHash', 'coverage', 'samples', 'hostDisconnectObserved'))
    _enum(value['status'], ('not-started', 'stable', 'unavailable', 'changed'))
    _enum(value['coverage'], ('not-started', 'complete', 'incomplete'))
    _hash(value['hostHash']); _int(value['samples'], 12000)
    if type(value['hostDisconnectObserved']) is not bool: raise ValueError('schema-rejected')
    if value['status'] == 'not-started' and (value['coverage'] != 'not-started' or value['samples'] or value['hostHash'] is not None or value['hostDisconnectObserved']):
        raise ValueError('schema-rejected')
    if value['status'] in ('unavailable', 'changed') and value['coverage'] != 'incomplete': raise ValueError('schema-rejected')
    if value['status'] == 'stable' and (value['samples'] < 1): raise ValueError('schema-rejected')
    if value['status'] == 'stable' and (value['coverage'] != 'complete' or value['hostDisconnectObserved'] or value['hostHash'] is None):
        raise ValueError('schema-rejected')
    return value


class HostContinuityObserver:
    def __init__(self, salt):
        self._salt, self._initial, self._last = salt, None, None
        self._status, self._coverage, self._samples = 'not-started', 'not-started', 0
        self._disconnect = False
        self.reason = 'none'

    def _fail(self, reason, *, changed=False):
        if self.reason == 'none': self.reason = reason
        self._coverage = 'incomplete'
        if changed or self._status != 'changed': self._status = 'changed' if changed else 'unavailable'

    def observe_status(self, value, tick_ms):
        try:
            _number(tick_ms, 9999999999999)
            if self._last is not None and not 0 <= tick_ms-self._last <= 1500: raise ValueError()
        except ValueError:
            self._fail('host-observation-gap'); return self.snapshot()
        self._last = tick_ms
        try:
            _keys(value, ('hostOnline', 'hostId'))
            if type(value['hostOnline']) is not bool: raise ValueError()
            if not _id(value['hostId']) and not (value['hostOnline'] is False and value['hostId'] is None): raise ValueError()
        except (ValueError, TypeError):
            self._fail('host-observation-unavailable'); return self.snapshot()
        if self._samples >= 12000:
            self._fail('host-observation-gap'); return self.snapshot()
        self._samples += 1
        host_id = value['hostId']
        if self._initial is not None and host_id is not None and host_id != self._initial:
            self._fail('host-replaced', changed=True)
        elif not value['hostOnline']:
            self._fail('host-unavailable')
        elif self._initial is None:
            self._initial = host_id
        if self._coverage != 'incomplete': self._status, self._coverage = 'stable', 'complete'
        return self.snapshot()

    def observe_host_disconnect(self):
        self._disconnect = True; self._fail('host-disconnect-observed')
        return self.snapshot()

    def snapshot(self):
        return validate_host_observation({'status': self._status, 'hostHash': hash_identity(self._initial, self._salt),
            'coverage': self._coverage, 'samples': self._samples, 'hostDisconnectObserved': self._disconnect})


def validate_server_event(row):
    _keys(row, ('n', 'event', 'serverTimestampMs', 'viewerHash', 'sessionHash', 'leaseEpoch', 'state'))
    _int(row['n'], 1024, minimum=1); _enum(row['event'], tuple(EVENTS.values()))
    _int(row['serverTimestampMs'], 9999999999999); _hash(row['viewerHash']); _hash(row['sessionHash'])
    _int(row['leaseEpoch'], nullable=True)
    if row['state'] is not None: _enum(row['state'], ('FREE', 'GRANTING', 'ACTIVE', 'REVOKING'))
    if row['event'] == 'host-disconnected' and any(row[k] is not None for k in ('viewerHash', 'sessionHash', 'leaseEpoch', 'state')):
        raise ValueError('schema-rejected')
    return row


class ServerRecoveryEvidence:
    def __init__(self, path, salt):
        self._path, self._salt, self._fd = path, salt, None
        self._device = self._inode = self._offset = None
        self._partial = b''; self._events = []; self._last_time = None; self._reset_epoch = None
        self._session = None; self._status, self._coverage = 'not-started', 'not-started'
        self.reason = 'none'

    def _fail(self, reason):
        if self.reason == 'none': self.reason = reason
        self._status, self._coverage = 'failed', 'incomplete'
        self.close()
        raise ValueError(self.reason) from None

    def start(self):
        if self._status != 'not-started' or self._fd is not None: self._fail('server-log-unavailable')
        try:
            fd = os.open(self._path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode): raise OSError()
                self._offset = os.lseek(fd, 0, os.SEEK_END)
                self._device, self._inode = info.st_dev, info.st_ino
            except BaseException: os.close(fd); raise
            self._fd = fd
        except OSError: self._fail('server-log-unavailable')
        self._status, self._coverage = 'reading', 'complete'

    def close(self):
        if self._fd is not None:
            os.close(self._fd); self._fd = None
        if self._partial and self._status == 'reading':
            self._coverage = 'incomplete'
            if self.reason == 'none': self.reason = 'server-log-gap'
        self._partial = b''
        if self._status == 'reading': self._status = 'closed'

    def snapshot(self):
        return {'status': self._status, 'selectedEvents': [dict(e) for e in self._events],
                'lastSequence': len(self._events), 'coverage': self._coverage}

    def read_tick(self, identities):
        if self._status != 'reading' or self._fd is None: self._fail('server-log-gap')
        try:
            _keys(identities, ('sessionId', 'socketId', 'previousSocketId'))
            if any(v is not None and not _id(v) for v in identities.values()): raise ValueError()
            session = identities['sessionId']
            if self._session is not None and session != self._session: raise ValueError()
            if session is not None: self._session = session
        except ValueError: self._fail('server-log-schema')
        try:
            info = os.stat(self._path, follow_symlinks=False)
            current = os.fstat(self._fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (self._device, self._inode):
                self._fail('server-log-identity-changed')
            if current.st_size < self._offset: self._fail('server-log-gap')
            unread = current.st_size-self._offset
            if unread > 65536: self._fail('server-log-capacity')
            data = os.read(self._fd, unread)
            if len(data) != unread: self._fail('server-log-gap')
            self._offset += len(data)
        except OSError: self._fail('server-log-unavailable')
        before = len(self._events)
        # The aggregate is bounded by one tick plus the bounded partial line.
        lines = (self._partial+data).split(b'\n')
        self._partial = lines.pop()
        if len(self._partial) > 16384: self._fail('server-log-capacity')
        for line in lines:
            if len(line)+1 > 16384: self._fail('server-log-capacity')
            try: value = _json(line)
            except (ValueError, UnicodeError, RecursionError): self._fail('server-log-schema')
            try: self._select(value, identities)
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
                if self._status == 'failed': raise
                self._fail('server-log-schema')
        return [dict(e) for e in self._events[before:]]

    def _select(self, value, identities):
        if type(value) is not dict: self._fail('server-log-schema')
        name = value.get('event'); correlation = value.get('correlation', {})
        sockets = {v for v in (identities['socketId'], identities['previousSocketId']) if v is not None}
        session = identities['sessionId']
        rebind = name in ('viewer_rebind_confirmed', 'viewer_rebind_failed')
        direct_rebind_match = False
        if rebind:
            try:
                _keys(correlation, ('viewerId', 'previousViewerId', 'browserSessionId'))
                if any(not _id(v) for v in correlation.values()): raise ValueError()
            except ValueError: self._fail('server-log-schema')
            # Server observation can precede the next browser snapshot. Retain
            # only its direct stable session/known-previous link; never adopt
            # the new socket into browser identities or match other event kinds.
            direct_rebind_match = (session is not None
                and correlation['browserSessionId'] == session
                and correlation['previousViewerId'] in sockets)
        if type(correlation) is dict and self._reset_epoch is not None:
            if (correlation.get('viewerId') is not None and correlation.get('viewerId') not in sockets and not direct_rebind_match
                or correlation.get('browserSessionId') is not None and correlation.get('browserSessionId') != session):
                self._fail('server-log-gap')
        if name not in EVENTS: return
        meta = value.get('meta')
        host = name == 'signal_socket_disconnected'
        if host:
            if type(meta) is not dict or meta.get('role') not in ('host', 'viewer', 'relay-viewer'):
                self._fail('server-log-schema')
            if meta['role'] != 'host': return
        reset = name == 'control_reset_completed'
        if rebind:
            if not direct_rebind_match: return
        elif not host and not reset:
            if type(correlation) is not dict: self._fail('server-log-schema')
            if not (correlation.get('viewerId') in sockets or session is not None and correlation.get('browserSessionId') == session): return
            if (correlation.get('viewerId') is not None and correlation.get('viewerId') not in sockets
                or correlation.get('browserSessionId') is not None and correlation.get('browserSessionId') != session):
                return
        try:
            _keys(value, ('ts', 'level', 'domain', 'event', 'message', 'source', 'schemaVersion', 'correlation', 'meta', 'redactionVersion'))
            if type(correlation) is not dict or not set(correlation) <= {'viewerId', 'previousViewerId', 'browserSessionId', 'connectionAttemptId'}: raise ValueError()
            if any(not _id(v) for v in correlation.values()): raise ValueError()
            if host or reset: _keys(correlation, ())
            elif name in ('viewer_disconnect_grace_started', 'viewer_disconnect_grace_expired'):
                _keys(correlation, ('viewerId', 'browserSessionId'))
            else:
                _keys(correlation, ('viewerId', 'previousViewerId', 'browserSessionId'))
            if value['schemaVersion'] != 1 or type(value['schemaVersion']) is not int or type(value['redactionVersion']) is not int or value['redactionVersion'] != 1: raise ValueError()
            _enum(value['level'], ('info',)); _enum(value['domain'], ('signaling',) if host else ('control',))
            if type(value['message']) is not str or len(value['message']) > 256 or value['source'] != 'signal-server': raise ValueError()
            if type(value['ts']) is not str or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value['ts']) is None: raise ValueError()
            timestamp = int(datetime.fromisoformat(value['ts'].replace('Z', '+00:00')).timestamp()*1000)
            _int(timestamp, 9999999999999)
            epoch = state = None
            if name == 'viewer_disconnect_grace_started':
                _keys(meta, ('graceMs',)); _int(meta['graceMs'], 30000)
            elif name == 'viewer_disconnect_grace_expired':
                _keys(meta, ('leaseEpoch', 'state', 'reason'))
                _enum(meta['reason'], ('viewer-disconnect-timeout',)); epoch, state = meta['leaseEpoch'], meta['state']
            elif name == 'viewer_rebind_confirmed':
                _keys(meta, ('leaseEpoch',)); epoch = meta['leaseEpoch']
            elif name == 'viewer_rebind_failed':
                _keys(meta, ('reason',)); _enum(meta['reason'], ('rebind-timeout', 'rebind-rejected', 'rebind-cancelled'))
            elif reset:
                _keys(meta, ('leaseEpoch', 'status', 'state')); _enum(meta['status'], ('applied',)); _enum(meta['state'], ('FREE',))
                epoch, state = meta['leaseEpoch'], meta['state']
            else:
                _keys(meta, ('role', 'reason'))
                _enum(meta['reason'], ('ping timeout', 'transport close', 'transport error', 'server namespace disconnect', 'client namespace disconnect', 'server shutting down', 'parse error', 'forced close', 'forced server close', 'other'))
            _int(epoch, nullable=name not in ('viewer_disconnect_grace_expired', 'viewer_rebind_confirmed', 'control_reset_completed'))
            if name == 'viewer_disconnect_grace_expired' and state is None: raise ValueError()
            if state is not None: _enum(state, ('FREE', 'GRANTING', 'ACTIVE', 'REVOKING'))
        except (ValueError, TypeError, OverflowError): self._fail('server-log-schema')
        if reset and (self._reset_epoch is None or epoch != self._reset_epoch): return
        if self._last_time is not None and timestamp < self._last_time: self._fail('server-clock-regression')
        if len(self._events) >= 1024: self._fail('server-log-capacity')
        if host: self._reset_epoch = None
        elif name == 'viewer_disconnect_grace_expired':
            if self._reset_epoch is not None and self._reset_epoch != epoch: self._fail('server-log-gap')
            self._reset_epoch = epoch
        elif reset: self._reset_epoch = None
        row = {'n': len(self._events)+1, 'event': EVENTS[name], 'serverTimestampMs': timestamp,
               'viewerHash': None if host else hash_identity(correlation.get('viewerId'), self._salt),
               'sessionHash': None if host else hash_identity(correlation.get('browserSessionId'), self._salt),
               'leaseEpoch': epoch, 'state': state}
        self._events.append(validate_server_event(row)); self._last_time = timestamp


_status_owner = None


async def read_local_host_status():
    """One fixed loopback request, including owned cancellation and writer close."""
    global _status_owner
    if _status_owner is not None:
        raise ValueError('host-observation-unavailable')

    async def request():
        writer = None
        deadline = time.monotonic()+.75
        try:
            reader, writer = await asyncio.open_connection('127.0.0.1', 8080)
            writer.write(b'GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nConnection: close\r\nCache-Control: no-store\r\nAccept: application/json\r\n\r\n')
            await writer.drain()
            total = 0
            async def line():
                nonlocal total
                # A byte-at-a-time read never buffers an unbounded header line.
                data = bytearray()
                while not data.endswith(b'\r\n'):
                    part = await reader.readexactly(1); data.extend(part); total += 1
                    if len(data) > 1024 or total > 8192: raise ValueError()
                return bytes(data[:-2])
            status_line = await line()
            if re.fullmatch(rb'HTTP/1\.[01] 200(?: [\x20-\x7e]*)?', status_line) is None: raise ValueError()
            headers = {}
            for count in range(33):
                data = await line()
                if not data: break
                if count == 32 or b':' not in data: raise ValueError()
                name, value = data.split(b':', 1)
                if re.fullmatch(rb'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', name) is None: raise ValueError()
                name = name.lower(); value = value.strip()
                if name in headers or any(b < 32 or b > 126 for b in value): raise ValueError()
                headers[name] = value
            if b'transfer-encoding' in headers or headers.get(b'content-encoding', b'identity').lower() != b'identity': raise ValueError()
            if headers.get(b'content-type', b'').split(b';', 1)[0].strip().lower() != b'application/json': raise ValueError()
            length = headers.get(b'content-length', b'')
            if re.fullmatch(rb'[0-9]{1,5}', length) is None or int(length) > 16384: raise ValueError()
            value = _json(await reader.readexactly(int(length)))
            if type(value) is not dict or 'hostId' not in value or type(value.get('hostOnline')) is not bool: raise ValueError()
            host_id = value.get('hostId')
            if not _id(host_id) and not (value['hostOnline'] is False and host_id is None): raise ValueError()
            return {'hostOnline': value['hostOnline'], 'hostId': host_id}
        finally:
            if writer is not None:
                writer.close()
                # wait_closed is owned directly, never detached from this stage.
                await asyncio.wait_for(writer.wait_closed(), max(0, deadline-time.monotonic()))
    # Reserve the slot through wrapper settlement, including the interval after
    # the child finishes but before lifecycle_stage returns to this caller.
    owned_task = asyncio.create_task(request())
    _status_owner = owned_task
    try:
        return await lifecycle_stage(owned_task, .75, settlement=.075)
    except (asyncio.CancelledError, CancellationCooperationError): raise
    except Exception: raise ValueError('host-observation-unavailable') from None
    finally:
        if owned_task.done() and _status_owner is owned_task: _status_owner = None


_METRICS = ('inputAckRttMs', 'inputToPostApplyFrameMs', 'inputToVisibleEffectMs', 'hostQueueMs',
    'hostApplyMs', 'hostAdapterAwaitMs', 'paintIntervalMs', 'freshFrameAgeMs', 'candidateRttMs',
    'jitterBufferMs', 'decodeMs', 'encoderMs', 'relayFrameAckRttMs')
_SAMPLE_KEYS = ('schemaVersion', 'browserNowMs', 'scopeStable', 'socketConnected', 'pcIdentity', 'pcState',
    'transport', 'attemptHash', 'generation', 'leaseEpoch', 'mediaPhase', 'inputAllowed', 'inputGate',
    'startupMarks', 'callbacks', 'lastFrameAtMs', 'frameAgeMs', 'maxFrameGapMs', 'width', 'height',
    'relayFrameSeq', 'tunnelRelayActive', 'relayLoadCallbacks', 'lastRelayLoadAtMs', 'relayLoadAgeMs',
    'maxRelayLoadGapMs', 'relayEvidenceKind', 'buildId', 'metrics', 'diagnostics')


def _validate_private_sample(sample):
    _keys(sample, _SAMPLE_KEYS)
    if type(sample['schemaVersion']) is not int or sample['schemaVersion'] != 1: raise ValueError('schema-rejected')
    for key in ('scopeStable', 'socketConnected', 'inputAllowed', 'tunnelRelayActive'):
        if type(sample[key]) is not bool: raise ValueError('schema-rejected')
    _number(sample['browserNowMs'], 9999999999999)
    for key in ('pcIdentity', 'generation', 'leaseEpoch', 'callbacks', 'width', 'height', 'relayFrameSeq', 'relayLoadCallbacks'):
        _int(sample[key], nullable=True)
    for key in ('lastFrameAtMs', 'frameAgeMs', 'maxFrameGapMs', 'lastRelayLoadAtMs', 'relayLoadAgeMs', 'maxRelayLoadGapMs'):
        _number(sample[key], 9999999999999, nullable=True)
    _hash(sample['attemptHash'])
    _enum(sample['pcState'], ('new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'unknown'))
    _enum(sample['mediaPhase'], ('active', 'paused', 'resuming', 'suspending', 'suspended', 'unknown'))
    if sample['relayEvidenceKind'] != 'image-load-event-not-optical-presentation': raise ValueError('schema-rejected')
    if sample['buildId'] is not None and (type(sample['buildId']) is not str or re.fullmatch('[0-9a-f]{16}', sample['buildId']) is None):
        raise ValueError('schema-rejected')
    validate_gate_fields(sample); validate_delta(sample['diagnostics'])
    transport = sample['transport']
    if type(transport) is not dict: raise ValueError('schema-rejected')
    if set(transport) == {'status'}: _enum(transport['status'], ('unavailable', 'pending', 'scope-changed'))
    else:
        _keys(transport, ('status', 'pathIdentity', 'localType', 'remoteType', 'protocol', 'remoteProtocol', 'relayProtocol',
            'rttMs', 'bytesReceived', 'framesDecoded', 'framesDropped', 'codec'))
        _enum(transport['status'], ('observed', 'unavailable'))
        if transport['pathIdentity'] is not None and (type(transport['pathIdentity']) is not str or re.fullmatch(r'path-[1-9][0-9]{0,3}', transport['pathIdentity']) is None or int(transport['pathIdentity'][5:]) > 1024):
            raise ValueError('schema-rejected')
        for key in ('localType', 'remoteType'): _enum(transport[key], ('host', 'srflx', 'prflx', 'relay', 'unknown'))
        for key in ('protocol', 'remoteProtocol'): _enum(transport[key], ('udp', 'tcp', 'unknown'))
        _enum(transport['relayProtocol'], ('udp', 'tcp', 'tls', 'unknown'))
        _enum(transport['codec'], ('video/h264', 'video/vp8', 'video/vp9', 'video/av1', 'unknown'))
        _number(transport['rttMs'], 9999999999999, nullable=True)
        for key in ('bytesReceived', 'framesDecoded', 'framesDropped'): _int(transport[key], 9999999999999, nullable=True)
    _keys(sample['metrics'], _METRICS)
    for metric in sample['metrics'].values():
        if metric is None: continue
        _keys(metric, ('available', 'count', 'last', 'p95', 'lastSampleAgeMs'))
        if type(metric['available']) is not bool: raise ValueError('schema-rejected')
        _int(metric['count'], nullable=True)
        for key in ('last', 'p95', 'lastSampleAgeMs'): _number(metric[key], 9999999999999, nullable=True)


def validate_recovery_row(value):
    """Reject unknown fields before a new sample wrapper can reach evidence."""
    try:
        _keys(value, ('schemaVersion', 'scenario', 'elapsedSeconds', 'phase', 'qualificationEvidenceScope',
                      'hostObservation', 'sample', 'identity', 'serverEvents'))
        if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1: raise ValueError()
        _enum(value['scenario'], SCOPES); _enum(value['phase'], PHASES)
        if value['qualificationEvidenceScope'] != SCOPES[value['scenario']]: raise ValueError()
        if value['scenario'] in ('baseline', 'continuity') and value['phase'] in ('fault', 'recovering', 'recovered-stability'): raise ValueError()
        _number(value['elapsedSeconds']); validate_host_observation(value['hostObservation'])
        _keys(value['identity'], ('sessionHash', 'socketHash', 'admissionHash'))
        for item in value['identity'].values(): _hash(item)
        if value['sample'] is not None: _validate_private_sample(value['sample'])
        events = value['serverEvents']
        if type(events) is not list or len(events) > 1024: raise ValueError()
        previous = 0
        for row in events:
            validate_server_event(row)
            if row['n'] <= previous: raise ValueError()
            previous = row['n']
        if len(compact(value)) > MAX_ROW_BYTES: raise ValueError()
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        raise ValueError('schema-rejected') from None
    return value

REASONS = frozenset(('none scenario-not-requested run-in-progress runtime-manifest-unavailable '
    'runtime-manifest-invalid runtime-manifest-pin-mismatch runtime-manifest-stale runtime-manifest-changed '
    'deployment-build-mismatch runtime-dependency-unavailable entry-unavailable authentication-unavailable '
    'authentication-changed selector-invalid proof-conflict start-ui-unavailable start-ui-deadline '
    'start-ui-not-fresh start-ui-state-changed start-ui-click-unproven admission-refused '
    'extra-admission-request extra-start baseline-incomplete baseline-failed fault-capability-unavailable '
    'fault-target-unavailable fault-already-triggered fault-handler-failed fault-attempt-cap '
    'fault-trigger-unconfirmed server-log-unavailable server-log-identity-changed server-log-gap '
    'server-log-schema server-log-capacity server-clock-regression sampling-gap schema-rejected '
    'ordinary-owner-changed human-priority host-unavailable host-replaced host-observation-unavailable '
    'host-observation-gap host-disconnect-observed rebind-rejected rebind-timeout reset-unconfirmed '
    'recovery-deadline wrong-grace-class recovery-gates-unmet recovered-stability-incomplete cancelled '
    'cleanup-incomplete evidence-write-failed evidence-budget-exceeded cancellation-noncooperative internal-error').split())
VERIFIED_STARTUP = dict(status='verified', freshPage=True, authVerified=True, selector='vacant-only-v1',
    startClickMarksBefore=0, startClickMarksAfter=1, guardedApiRequests=1)


def _reason(exc):
    if isinstance(exc, asyncio.CancelledError): return 'cancelled'
    if isinstance(exc, CancellationCooperationError): return 'cancellation-noncooperative'
    value = str(exc)
    return value if value in REASONS else 'internal-error'


def _hex(value, count):
    if type(value) is not str or re.fullmatch('[0-9a-f]{%d}' % count, value) is None: raise ValueError()


def normalized_origin(origin):
    if type(origin) is not str: raise ValueError('runtime-manifest-invalid')
    origin = origin.rstrip('/')
    p = urlsplit(origin)
    if (p.scheme not in ('http','https') or not p.hostname or not p.netloc or p.username is not None
        or p.password is not None or p.path or p.query or p.fragment or any(c.isspace() for c in origin)):
        raise ValueError('runtime-manifest-invalid')
    return origin


def _manifest_bytes(path):
    try:
        if not Path(path).is_absolute(): raise ValueError('runtime-manifest-invalid')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('runtime-manifest-invalid')
            data = os.read(fd, 16385)
            if len(data) > 16384: raise ValueError('runtime-manifest-invalid')
            return data, (info.st_dev, info.st_ino)
        finally: os.close(fd)
    except OSError: raise ValueError('runtime-manifest-unavailable') from None


class PinnedManifest(dict):
    def projection(self):
        return dict(sha256=self.sha, runNonce=self['runNonce'], originSource=self['originSource'],
            originEvidenceSha256=self['originEvidenceSha256'], signalSourceCommit=self['signal']['sourceCommit'],
            hostSourceCommit=self['host']['sourceCommit'], viewerSourceCommit=self['viewer']['sourceCommit'],
            viewerBuildId=self['viewer']['buildId'], sourceEvidence='root-attested')

    def recheck(self, now_epoch_ms):
        try:
            data, identity = _manifest_bytes(self.path)
            if identity != self.identity or hashlib.sha256(data).hexdigest() != self.sha: raise ValueError()
            _int(now_epoch_ms, 9999999999999)
            if not self.last_epoch <= now_epoch_ms < self['validUntilEpochMs']: raise ValueError()
            self.last_epoch=now_epoch_ms
        except (ValueError, OSError): raise ValueError('runtime-manifest-changed') from None


def read_runtime_manifest(path, expected_sha256, *, origin, scenario, mode, now_epoch_ms):
    try: _hex(expected_sha256,64)
    except ValueError: raise ValueError('runtime-manifest-invalid') from None
    data, identity = _manifest_bytes(path)
    if hashlib.sha256(data).hexdigest() != expected_sha256: raise ValueError('runtime-manifest-pin-mismatch')
    try:
        value = _json(data)
        _keys(value, ('schemaVersion','runNonce','createdAtEpochMs','validUntilEpochMs','scenario','mode',
            'originSource','originEvidenceSha256','originSha256','deploymentEvidence','signal','host','viewer','signalLog'))
        _int(value['schemaVersion'],1,minimum=1); _hex(value['runNonce'],32)
        for key in ('createdAtEpochMs','validUntilEpochMs'): _int(value[key],9999999999999)
        _int(now_epoch_ms,9999999999999)
        if not 0 < value['validUntilEpochMs']-value['createdAtEpochMs'] <= 43200000: raise ValueError()
        _enum(value['scenario'],SCOPES); _enum(value['mode'],('stun','relay','tunnel'))
        if value['scenario'] != scenario or value['mode'] != mode: raise ValueError()
        _enum(value['originSource'],('quick-url-file','formal-configured'))
        for key in ('originEvidenceSha256','originSha256'): _hex(value[key],64)
        if value['originSha256'] != hashlib.sha256(normalized_origin(origin).encode()).hexdigest(): raise ValueError()
        _keys(value['deploymentEvidence'],('kind','sha256'))
        if value['deploymentEvidence']['kind'] != 'root-verified-local-deployment': raise ValueError()
        _hex(value['deploymentEvidence']['sha256'],64)
        for component in ('signal','host'):
            _keys(value[component],('sourceCommit','sourceTreeSha256'))
            _hex(value[component]['sourceCommit'],40); _hex(value[component]['sourceTreeSha256'],64)
        _keys(value['viewer'],('sourceCommit','buildId'))
        _hex(value['viewer']['sourceCommit'],40); _hex(value['viewer']['buildId'],16)
        log = value['signalLog']; _keys(log,('path','device','inode'))
        if type(log['path']) is not str or not 1 <= len(log['path'].encode('utf-8')) <= 512 or not Path(log['path']).is_absolute(): raise ValueError()
        _int(log['device'],2**53-1); _int(log['inode'],2**53-1,minimum=1)
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError):
        raise ValueError('runtime-manifest-invalid') from None
    budget = 10800 if scenario == 'continuity' else 300 if scenario == 'baseline' else 390
    if not 0 <= now_epoch_ms-value['createdAtEpochMs'] <= 900000 or value['validUntilEpochMs']-now_epoch_ms < (budget+120)*1000:
        raise ValueError('runtime-manifest-stale')
    try:
        fd = os.open(log['path'],os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_dev,info.st_ino) != (log['device'],log['inode']):
                raise ValueError('server-log-identity-changed')
        finally: os.close(fd)
    except OSError: raise ValueError('server-log-unavailable') from None
    result = PinnedManifest(value); result.path, result.identity, result.sha = Path(path), identity, expected_sha256
    result.last_epoch=now_epoch_ms
    return result


async def _await(value):
    return await value if inspect.isawaitable(value) else value


class OwnedBrowserLifecycle:
    """One browser ownership chain; API completion never proves process exit."""
    def __init__(self, *, limits=None):
        self.caps = dict(managerStart=10,managerLaunch=15,export=1,browserClose=5,managerStop=3,cleanup=8)
        for key,value in (limits or {}).items():
            if key not in self.caps: raise ValueError('schema-rejected')
            _number(value,self.caps[key]); self.caps[key] = value
        self.manager = self.playwright = self.browser = self.context = self.page = None
        self.disarm = None; self.diagnostic = empty_diagnostic()
        self.capture_status, self.write_status = 'not-started','ok'
        self.python = dict(failureDetectedMs=None,failureWallEpochMs=None,cleanupStatus='not-started',
            **{k:dict(startedMs=None,finishedMs=None,status='not-created' if k=='browserClose' else 'not-started')
               for k in ('managerStart','managerLaunch','managerStop','browserClose')})
        self._cleaned = False

    async def _tracked(self,key,operation,cap):
        record = self.python[key]; record['startedMs'] = passive.monotonic_ms()
        try:
            result = await lifecycle_stage(_await(operation()),cap,settlement=min(.25,cap/4))
            record['status'] = 'closed' if key == 'browserClose' else 'ok'
            return result
        except BaseException as exc:
            record['status'] = ('cancelled' if isinstance(exc,asyncio.CancelledError) else
                'noncooperative' if isinstance(exc,CancellationCooperationError) else
                'timeout' if isinstance(exc,TimeoutError) else 'error')
            raise
        finally: record['finishedMs'] = passive.monotonic_ms()

    async def start(self,manager_factory):
        self.manager = manager_factory()
        self.playwright = await self._tracked('managerStart',lambda: self.manager.start() if hasattr(self.manager,'start')
            else self.manager.__aenter__(),self.caps['managerStart'])
        self.browser = await self._tracked('managerLaunch',lambda:self.playwright.chromium.launch(headless=True),self.caps['managerLaunch'])
        self.context = await lifecycle_stage(_await(self.browser.new_context(service_workers='block')),8)
        self.page = await lifecycle_stage(_await(self.context.new_page()),8)
        return self.page

    async def cleanup(self,export):
        if self._cleaned: return
        self._cleaned = True
        deadline = time.monotonic()+self.caps['cleanup']; self.python['cleanupStatus'] = 'running'
        failed = self.page is None
        remaining = lambda key: passive.cleanup_allowance(key,self.caps,deadline,time.monotonic())
        prior_attribution=dict(self.diagnostic['attribution'])
        async def final_capture():
            if self.disarm is not None: await _await(self.disarm())
            if self.page is None: return None
            return await export()
        try:
            value = await lifecycle_stage(final_capture(),remaining('export'),settlement=min(.075,remaining('export')/4))
            if value is None: self.capture_status='unavailable'; failed=True
            else:
                value = passive.validate_diagnostic(value)
                first = prior_attribution['firstDisconnectEvent']
                found = value['attribution']['firstDisconnectEvent']
                if first is not None and (found is None or found['n'] > first['n']):
                    value['attribution'] = prior_attribution
                self.diagnostic = passive.validate_diagnostic(value); self.capture_status='ok'
        except BaseException as exc:
            failed=True
            self.capture_status = ('cancelled' if isinstance(exc,asyncio.CancelledError) else
                'noncooperative' if isinstance(exc,CancellationCooperationError) else 'timeout' if isinstance(exc,TimeoutError)
                else ('schema-rejected' if str(exc) not in REASONS or str(exc)=='schema-rejected' else 'unavailable') if isinstance(exc,ValueError) else 'error')
        for key, owned, operation in (
            ('browserClose',self.browser,lambda:self.browser.close()),
            ('managerStop',self.manager,lambda:self.playwright.stop() if self.playwright is not None and hasattr(self.playwright,'stop')
                else self.manager.stop() if hasattr(self.manager,'stop') else self.manager.__aexit__(None,None,None))):
            if owned is not None:
                try: await self._tracked(key,operation,remaining(key))
                except BaseException: failed=True
        self.python['cleanupStatus'] = 'incomplete' if failed else 'api-finished-exit-unknown'

    def snapshot(self):
        return dict(captureStatus=self.capture_status,cleanupStatus=self.python['cleanupStatus'],
            writeStatus=self.write_status,ownedProcessExitEvidence='not-observed')

    def record(self):
        value = dict(schemaVersion=1,diagnostics=self.diagnostic,python=self.python,captureStatus=self.capture_status,
            writeStatus=self.write_status,ownedProcessExitEvidence='not-observed')
        validate_lifecycle(value)
        return value


def _gates(sample,mode,*,recovery=False):
    if sample is None: return False
    gate = sample['inputGate']
    yes = ('allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame','currentAttemptReady','hasActiveControl','socketConnected')
    no = ('manualDisconnect','superseded','mouseResetPending','draftComposing','draftPending','draftUncertain','firstFrameTimerHandlePresent')
    if (gate['status'] != 'observed' or gate['blockedReasons'] or any(gate[k] is not True for k in yes)
        or any(gate[k] is not False for k in no) or gate['uiPhase'] != 'connected'
        or gate['desiredMediaState'] != 'active' or gate['mediaRuntimePhase'] != 'active'
        or gate['keyboardControllerState'] != 'READY' or gate['keyboardTransportState'] != 'ready'
        or gate['surfaceState'] != 'settled' or gate['desktopWriteRecoveryState'] not in ('none','reconciled')
        or gate['recoveryState'] not in ('idle','recovered') or not sample['inputAllowed']): return False
    # Recovery retains historical outage maxima as evidence; readiness uses
    # current frame age, while stability separately requires fresh progress.
    if recovery:
        sample=dict(sample)
        sample['maxFrameGapMs']=sample['frameAgeMs']
        sample['maxRelayLoadGapMs']=sample['relayLoadAgeMs']
    # The unchanged reducer supplies path, current identity and age gates.
    probe = passive.ContinuitySummary(duration_s=1,mode=mode)
    probe.observe(dict(elapsedSeconds=0,status='observed',sample=sample))
    return not probe.failures


def _recovered_identity(identity,sample):
    transport=sample['transport']
    path=tuple(transport.get(k) for k in ('pathIdentity','localType','remoteType','protocol','remoteProtocol','relayProtocol'))
    return (identity['socketHash'],sample['pcIdentity'],sample['attemptHash'],sample['generation'],sample['leaseEpoch'],path)


class OrdinaryRecoverySummary:
    def __init__(self,scenario,mode):
        _enum(scenario,SCOPES); _enum(mode,('stun','relay','tunnel'))
        self.scenario,self.mode,self.phase = scenario,mode,'preflight'
        self.continuity = passive.ContinuitySummary(duration_s=10800 if scenario=='continuity' else 300,mode=mode)
        self.failure = self.startup = self.manifest = self.expected_build = None
        self.host = HostContinuityObserver(b'').snapshot()
        self.lifecycle = dict(captureStatus='not-started',cleanupStatus='not-started',writeStatus='ok',ownedProcessExitEvidence='not-observed')
        self.fault = empty_fault(scenario)
        self.server_coverage = 'not-started'; self.classification='not-attempted'
        self.started = self.triggered = self.recovered = self.last = None
        self.elapsed = self.stable = 0; self.identity = self.baseline_sample = self.stable_identity = None
        self._startup_sample = None; self._events=[]; self._product_failure=False
        self._stability_previous=None; self._progress_at=None
        self.latest_sample=self.fault_sample=None
        self.baseline_ready=False

    def transition(self,phase):
        allowed = {'preflight':('startup',),'startup':('continuity',) if self.scenario=='continuity' else ('baseline',),
            'baseline':('fault',) if self.scenario in ('within-grace','after-grace') else (),
            'fault':('recovering',),'recovering':('recovered-stability',),'recovered-stability':(),'continuity':(),'terminal':()}
        if phase not in allowed[self.phase] and not (phase=='terminal' and self.phase!='terminal'): raise ValueError('schema-rejected')
        self.phase=phase

    def fail(self,reason,*,product=False):
        _enum(reason,REASONS-{'none','scenario-not-requested','run-in-progress'})
        if self.failure is None:
            self.failure=dict(phase=self.phase,reason=reason); self._product_failure=product
        if self.phase!='terminal': self.transition('terminal')

    def confirm_fault(self,elapsed):
        _number(elapsed)
        if not self.baseline_ready or self.triggered is not None: raise ValueError('fault-already-triggered')
        self.transition('fault'); self.triggered=elapsed; self.classification='unclassified'; self.fault_sample=self.latest_sample

    def observe(self,row):
        try: validate_recovery_row(row)
        except ValueError: self.fail('schema-rejected'); return
        if row['scenario']!=self.scenario or row['phase']!=self.phase: self.fail('schema-rejected'); return
        self.host=row['hostObservation']; at=row['elapsedSeconds']; sample=row['sample']
        if self.last is not None and not 0 <= at-self.last <= 1.5: self.fail('sampling-gap')
        self.last=at
        if self.host['coverage']!='complete' or self.host['status']!='stable' or self.host['hostDisconnectObserved']:
            self.fail('host-replaced' if self.host['status']=='changed' else 'host-disconnect-observed'
                if self.host['hostDisconnectObserved'] else 'host-observation-unavailable')
        if sample is None: self.fail('sampling-gap'); return
        if sample['buildId']!=self.expected_build: self.fail('deployment-build-mismatch')
        if sample['inputGate']['superseded']: self.fail('human-priority')
        identity=row['identity']; self.latest_sample=sample
        if self.triggered is None and (sample['diagnostics']['firstDisconnectEvent'] is not None or row['serverEvents']):
            self.fail('baseline-failed',product=True)
        if self.identity is not None and any(identity[k]!=self.identity[k] for k in ('sessionHash','admissionHash')):
            self.fail('ordinary-owner-changed')
        if self.phase=='terminal': return
        if self.phase=='startup':
            ready = self.startup is not None and all(identity.values()) and _gates(sample,self.mode)
            previous=self._startup_sample; self._startup_sample=sample
            counter='relayLoadCallbacks' if self.mode=='tunnel' else 'callbacks'
            if not ready or previous is None or not _gates(previous,self.mode) or sample[counter]<=previous[counter]: return
            self.started=at; self.identity=dict(identity); self.baseline_sample=sample
            self.transition('continuity' if self.scenario=='continuity' else 'baseline')
        if self.phase in ('baseline','continuity'):
            self.elapsed=at-self.started
            self.continuity.observe(dict(elapsedSeconds=self.elapsed,status='observed',sample=sample))
            if not _gates(sample,self.mode) or identity['socketHash']!=self.identity['socketHash'] or self.continuity.identity_changes or self.continuity.failures:
                self.fail('baseline-failed',product=True); return
            self.baseline_ready=self.continuity.result(elapsed_s=self.elapsed)['status']=='PASS'
            return
        for event in row['serverEvents']:
            if self._events and (event['n']<=self._events[-1]['n'] or event['serverTimestampMs']<self._events[-1]['serverTimestampMs']):
                self.fail('server-clock-regression'); return
            if len(self._events)>=1024: self.fail('server-log-capacity'); return
            self._events.append(event)
            if event['event']=='host-disconnected': self.fail('host-disconnect-observed'); return
            if self.phase=='recovered-stability':
                if event['event']=='grace-expired' and self.classification=='within-grace-rebind' and event['sessionHash']==self.identity['sessionHash'] and event['viewerHash']==self.identity['socketHash']:
                    self.classification='after-grace-reset'; self.fail('wrong-grace-class',product=True)
                else: self.fail('recovery-gates-unmet',product=True)
                return

        self._classify(identity,sample,at)
        if self.phase=='recovered-stability':
            current=_recovered_identity(identity,sample)
            if not _gates(sample,self.mode,recovery=True) or current!=self.stable_identity:
                self.fail('recovery-gates-unmet',product=True); return
            counter=sample['relayLoadCallbacks'] if self.mode=='tunnel' else sample['callbacks']
            seq=sample['relayFrameSeq'] if self.mode=='tunnel' else counter
            if self._stability_previous is not None:
                old_counter,old_seq=self._stability_previous
                if counter<old_counter or seq<old_seq: self.fail('recovery-gates-unmet',product=True); return
                if counter>old_counter and seq>old_seq: self._progress_at=at
            self._stability_previous=(counter,seq)
            if self._progress_at is None: self._progress_at=at
            if at-self._progress_at>=5: self.fail('recovery-gates-unmet',product=True); return
            self.stable=at-self.recovered
        self.expire(at)

    def _classify(self,identity,sample,at):
        if self.phase!='recovering': return
        starts=[e for e in self._events if e['event']=='grace-started' and e['sessionHash']==self.identity['sessionHash'] and e['viewerHash']==self.identity['socketHash']]
        if len(starts)!=1: return
        start=starts[0]
        failed=next((e for e in self._events if e['event']=='rebind-failed' and e['n']>start['n']
            and e['sessionHash']==self.identity['sessionHash'] and e['viewerHash']==identity['socketHash']),None)
        if failed:
            self.fail('recovery-gates-unmet',product=self.server_coverage=='complete'); return
        expiry=next((e for e in self._events if e['event']=='grace-expired' and e['n']>start['n'] and e['sessionHash']==self.identity['sessionHash'] and e['viewerHash']==self.identity['socketHash']),None)
        rebind=next((e for e in self._events if e['event']=='rebind-confirmed' and e['n']>start['n'] and e['viewerHash']==identity['socketHash'] and e['sessionHash']==self.identity['sessionHash']),None)
        if expiry:
            self.classification='after-grace-reset'
            reset=next((e for e in self._events if e['event']=='reset-completed' and e['n']>expiry['n'] and e['leaseEpoch']==expiry['leaseEpoch'] and e['state']=='FREE'),None)
            matched=reset is not None and sample['leaseEpoch'] is not None and sample['leaseEpoch']>expiry['leaseEpoch'] and sample['leaseEpoch']>self.baseline_sample['leaseEpoch']
        elif rebind:
            self.classification='within-grace-rebind'
            matched=rebind['leaseEpoch']==self.baseline_sample['leaseEpoch']==sample['leaseEpoch']
        else: return
        expected='within-grace-rebind' if self.scenario=='within-grace' else 'after-grace-reset'
        if self.classification!=expected: self.fail('wrong-grace-class',product=True); return
        counter='relayLoadCallbacks' if self.mode=='tunnel' else 'callbacks'
        fresh=self.fault_sample is not None and sample[counter] is not None and self.fault_sample[counter] is not None and sample[counter]>self.fault_sample[counter]
        if matched and fresh and at-self.triggered<=60 and _gates(sample,self.mode,recovery=True) and self.server_coverage=='complete':
            self.recovered=at
            self.stable_identity=_recovered_identity(identity,sample)
            self.transition('recovered-stability')

    def expire(self,elapsed):
        if self.phase=='recovering' and elapsed-self.triggered>=60:
            self.fail('reset-unconfirmed' if self.classification=='after-grace-reset' else 'recovery-deadline')

    def result(self,*,cleanup_complete):
        requested=self.scenario in ('within-grace','after-grace'); attempted=self.triggered is not None
        passed=attempted and self.recovered is not None and self.recovered-self.triggered<=60 and self.stable>=30 and self.server_coverage=='complete' and self.failure is None
        host_ok=self.host['status']=='stable' and self.host['coverage']=='complete' and not self.host['hostDisconnectObserved']
        failure=self.failure
        if not cleanup_complete and failure is None and (passed or self.lifecycle['cleanupStatus']=='incomplete'): failure=dict(phase=self.phase,reason='cleanup-incomplete')
        reason=('scenario-not-requested' if not requested else failure['reason'] if failure else 'none' if passed and host_ok else 'run-in-progress')
        status=('NOT_RUN' if not attempted else 'PASS' if passed and host_ok and cleanup_complete else 'FAIL' if self._product_failure and self.server_coverage=='complete' and host_ok and cleanup_complete else 'INCOMPLETE')
        recovery=dict(status=status,classification=self.classification,requestedScenario=self.scenario,
            qualificationEvidenceScope=SCOPES[self.scenario],recoverySeconds=None if self.recovered is None else self.recovered-self.triggered,
            recoveredStableSeconds=self.stable,serverCoverage=self.server_coverage,reason=reason)
        return dict(schemaVersion=1,scenario=self.scenario,mode=self.mode,phase=self.phase,
            qualificationEvidenceScope=SCOPES[self.scenario],nativeAfterGraceQualification='NOT_RUN',hostObservation=self.host,
            continuity=self.continuity.result(elapsed_s=self.elapsed,interrupted=attempted or failure is not None or not cleanup_complete),
            ordinaryRecovery=recovery,failure=failure,startup=self.startup,manifest=self.manifest,lifecycle=self.lifecycle,
            fault=self.fault,businessInput='NOT_RUN',visibleEffect='NOT_RUN',physical='NOT_RUN')


def empty_fault(scenario):
    return dict(capability='not-checked',status='not-requested',instrumentation='native-direct' if scenario=='within-grace'
        else 'playwright-routed' if scenario=='after-grace' else 'none',triggerCount=0,blockedHttp=0,blockedWebSocket=0,
        blockSeconds=12 if scenario=='after-grace' else 0)


def validate_lifecycle(value):
    _keys(value,('schemaVersion','diagnostics','python','captureStatus','writeStatus','ownedProcessExitEvidence'))
    _int(value['schemaVersion'],1,minimum=1); passive.validate_diagnostic(value['diagnostics'])
    _enum(value['captureStatus'],('not-started','ok','unavailable','timeout','error','cancelled','schema-rejected','noncooperative'))
    _enum(value['writeStatus'],('ok','error'))
    if value['ownedProcessExitEvidence']!='not-observed': raise ValueError('schema-rejected')
    p=value['python']; _keys(p,('failureDetectedMs','failureWallEpochMs','managerStart','managerLaunch','managerStop','browserClose','cleanupStatus'))
    for key in ('failureDetectedMs','failureWallEpochMs'): _int(p[key],9999999999999,nullable=True)
    _enum(p['cleanupStatus'],('not-started','running','api-finished-exit-unknown','incomplete'))
    for key in ('managerStart','managerLaunch','managerStop','browserClose'):
        r=p[key]; _keys(r,('startedMs','finishedMs','status'))
        for clock in ('startedMs','finishedMs'): _int(r[clock],9999999999999,nullable=True)
        _enum(r['status'],('ok','timeout','error','cancelled','not-started','not-created','closed','noncooperative'))
    if len(compact(value))>MAX_ROW_BYTES: raise ValueError('evidence-budget-exceeded')
    return value

# A private page-local closure compares auth and object identities. It does not
# write product state or expose a token, ticket, product method or recovery API.
OBSERVATION_INSTALL = r'''() => {
  if (window.__wrdOrdinaryObservation) throw new Error('already-installed');
  let auth=null, token=null, generation=null, shell=null, client=null;
  const bounded=v => typeof v === 'string' && v.length>0 && v.length<=128 ? v : null;
  window.__wrdOrdinaryObservation = () => {
    const a=typeof Auth==='undefined'?null:Auth, c=typeof WebRTC==='undefined'?null:WebRTC;
    const s=window.__WRD_SHELL__, state=typeof s?.snapshot==='function'?s.snapshot():null;
    const verified=state?.authVerified===true && a?.isVerified?.()===true;
    if (!auth && verified && typeof a.getToken?.()==='string' && a.getToken().length>0 && Number.isSafeInteger(a.getGeneration?.())) {
      auth=a; token=a.getToken(); generation=a.getGeneration();
    }
    if (!shell && s) shell=s;
    if (!client && c) client=c;
    const marks=Array.isArray(state?.marks)&&state.marks.length<=1024?state.marks:null;
    const count=name => marks?marks.filter(m=>m?.name===name).length:null;
    return {shellAvailable:!!state,clientAvailable:!!c,marksAvailable:!!marks,
      coreInstalled:state?.coreInstalled===true,authVerified:verified,authCaptured:!!auth,
      authCurrent:!!auth&&auth===a&&verified&&a.getToken()===token&&a.getGeneration()===generation,
      ownerCurrent:(!shell||shell===s)&&(!client||client===c),
      selectorValid:location.pathname==='/viewer.html'&&location.search==='?wrdAdmission=vacant-only-v1',
      proofPresent:sessionStorage.getItem('wrdProofAdmission')!==null||!!window.__wrdProofStartGuard,
      queuedStart:state?.queuedStart===true,socketPresent:!!c?.socket,pcPresent:!!c?.pc,
      attemptPresent:!!c?.currentConnectionAttemptId,htmlShellMarks:count('html-shell'),
      coreInteractiveMarks:count('core-interactive'),startClickMarks:count('start-click'),
      sessionId:bounded(c?._viewerSessionId),socketId:bounded(c?.socket?.id),
      admissionId:c?._viewerAdmission?.mode==='resume'?bounded(c._viewerAdmission.generation):null,
      networkMode:['stun','relay','tunnel'].includes(c?.networkMode)?c.networkMode:'unknown'};
  };
}'''
OBSERVE_UI = '() => window.__wrdOrdinaryObservation()'
OBSERVE_SAMPLE = '''async () => {
  const sample=await window.__wrdPassiveSampler.sample();
  return {state:window.__wrdOrdinaryObservation(),sample};
}'''
_UI_BOOLEANS = ('shellAvailable','clientAvailable','marksAvailable','coreInstalled','authVerified','authCaptured',
    'authCurrent','ownerCurrent','selectorValid','proofPresent','queuedStart','socketPresent','pcPresent','attemptPresent')
_UI_COUNTS = ('htmlShellMarks','coreInteractiveMarks','startClickMarks')


def _ui_state(value):
    _keys(value,(*_UI_BOOLEANS,*_UI_COUNTS,'sessionId','socketId','admissionId','networkMode'))
    if any(type(value[k]) is not bool for k in _UI_BOOLEANS): raise ValueError('schema-rejected')
    for key in _UI_COUNTS: _int(value[key],1024,nullable=True)
    for key in ('sessionId','socketId','admissionId'):
        if value[key] is not None and not _id(value[key]): raise ValueError('schema-rejected')
    _enum(value['networkMode'],('stun','relay','tunnel','unknown'))
    if not value['selectorValid']: raise ValueError('selector-invalid')
    if value['proofPresent']: raise ValueError('proof-conflict')
    if value['authCaptured'] and not value['authCurrent']: raise ValueError('authentication-changed')
    if not value['ownerCurrent']: raise ValueError('start-ui-state-changed')
    return value


class _AdmissionObservation:
    def __init__(self,page,origin):
        self.page,self.origin=page,origin
        self.requests=self.responses=0; self.reason=None
        page.on('request',self.request); page.on('response',self.response)

    def request(self,value):
        try:
            url=urlsplit(value.url)
            if url.path=='/api/proof-admission': self.reason=self.reason or 'proof-conflict'; return
            if url.path!='/api/auth/viewer-admission': return
            self.requests=min(2,self.requests+1)
            if self.requests>1: self.reason=self.reason or 'extra-admission-request'; return
            if type(value.post_data) is not str or len(value.post_data.encode('utf-8'))>16384: raise ValueError()
            body=_json(value.post_data.encode('utf-8'))
            _keys(body,('viewerSessionId','initialPolicy'))
            if (value.url!=self.origin+'/api/auth/viewer-admission' or value.method!='POST'
                or body['initialPolicy']!='vacant-only-v1' or not _id(body['viewerSessionId'])): raise ValueError()
        except Exception: self.reason=self.reason or 'admission-refused'

    def response(self,value):
        try:
            if urlsplit(value.url).path!='/api/auth/viewer-admission': return
            self.responses=min(2,self.responses+1)
            if value.url!=self.origin+'/api/auth/viewer-admission' or value.status!=201 or self.responses>1:
                self.reason=self.reason or 'admission-refused'
        except Exception: self.reason=self.reason or 'admission-refused'

    def check(self,*,started=False):
        if self.reason: raise ValueError(self.reason)
        if started and (self.requests!=1 or self.responses!=1): raise ValueError('start-ui-click-unproven')

    def detach(self):
        self.page.remove_listener('request',self.request); self.page.remove_listener('response',self.response)


def _fresh(state):
    if any(state[k] for k in ('socketPresent','pcPresent','attemptPresent','queuedStart')) or state['startClickMarks'] not in (None,0):
        raise ValueError('start-ui-not-fresh')
    if state['htmlShellMarks'] not in (None,0,1) or state['coreInteractiveMarks'] not in (None,0,1):
        raise ValueError('start-ui-not-fresh')
    return all(state[k] for k in ('shellAvailable','clientAvailable','marksAvailable','coreInstalled','authVerified','authCurrent')) and state['htmlShellMarks']==state['coreInteractiveMarks']==1


async def start_guarded_via_ui(page,*,timeout_s=30,monotonic=time.monotonic,sleep=asyncio.sleep):
    parsed=urlsplit(page.url)
    if parsed.path!='/viewer.html' or parsed.query!='wrdAdmission=vacant-only-v1' or parsed.fragment:
        raise ValueError('selector-invalid')
    observer=getattr(page,'_wrd_ordinary_guard',None)
    owned=observer is None
    if owned: observer=_AdmissionObservation(page,normalized_origin(parsed.scheme+'://'+parsed.netloc))
    if normalized_origin(parsed.scheme+'://'+parsed.netloc)!=observer.origin: raise ValueError('selector-invalid')
    deadline=monotonic()+timeout_s; clicked=False; reason='start-ui-unavailable'
    async def bounded(operation):
        remaining=max(0,deadline-monotonic())
        try: return await lifecycle_stage(operation,remaining,settlement=min(.075,remaining/4))
        except CancellationCooperationError: raise
        except TimeoutError: raise ValueError(reason) from None
        except Exception: raise ValueError(reason if monotonic()>=deadline else 'start-ui-unavailable') from None
    try:
        try: button=page.locator('#startBtn')
        except Exception: raise ValueError('start-ui-unavailable') from None
        while monotonic()<deadline:
            observer.check(); state=_ui_state(await bounded(page.evaluate(OBSERVE_UI)))
            if clicked:
                if state['startClickMarks'] not in (0,1): raise ValueError('extra-start')
                if (state['startClickMarks']==1 and observer.requests==observer.responses==1):
                    if not all(state[k] for k in ('shellAvailable','clientAvailable','marksAvailable','coreInstalled','authCurrent')) or state['htmlShellMarks']!=1 or state['coreInteractiveMarks']!=1:
                        raise ValueError('start-ui-state-changed')
                    return dict(VERIFIED_STARTUP)
            elif _fresh(state):
                reason='start-ui-deadline'
                if await bounded(button.is_visible()) and await bounded(button.is_enabled()):
                    visible=await bounded(button.is_visible()); enabled=await bounded(button.is_enabled())
                    current=_ui_state(await bounded(page.evaluate(OBSERVE_UI)))
                    observer.check()
                    if not visible or not enabled or not _fresh(current): raise ValueError('start-ui-state-changed')
                    if observer.requests: raise ValueError('extra-admission-request')
                    await bounded(button.click(timeout=max(1,(deadline-monotonic())*1000)))
                    clicked=True; reason='start-ui-click-unproven'; continue
            await sleep(min(.1,max(0,deadline-monotonic())))
        raise ValueError(reason)
    finally:
        if owned: observer.detach()


async def _observation_pair(page_once,status_reader):
    """Concurrent page/status work with one owner and cancellation settlement."""
    # The production status function owns its 750ms budget itself; injected
    # readers receive the identical budget without importing runtime packages.
    async def status():
        try:
            if status_reader is read_local_host_status: return await status_reader()
            return await lifecycle_stage(status_reader(),.75,settlement=.075)
        except TimeoutError: raise ValueError('host-observation-unavailable') from None
    tasks=[asyncio.create_task(page_once()),asyncio.create_task(status())]
    try:
        await asyncio.wait(tasks,return_when=asyncio.FIRST_EXCEPTION)
        for task in tasks:
            if task.done() and not task.cancelled() and task.exception() is not None: raise task.exception()
        return [await task for task in tasks]
    finally:
        pending=[task for task in tasks if not task.done()]
        for task in pending: task.cancel()
        if pending:
            # Both children remain owned until settlement; no detached reader or
            # page work can silently survive the outer 2s / final 1s stage.
            await lifecycle_stage(asyncio.gather(*pending,return_exceptions=True),.075,settlement=.025)


async def _observe_start(action,tick,*,interval=1):
    """Keep one observation flow alive during the one owned UI action."""
    task=asyncio.create_task(action)
    try:
        while not task.done():
            at=time.monotonic(); await tick()
            if task.done(): break
            await asyncio.wait({task},timeout=max(0,interval-(time.monotonic()-at)))
        return task.result()
    finally:
        if not task.done():
            task.cancel()
            await lifecycle_stage(asyncio.gather(task,return_exceptions=True),.075,settlement=.025)


def validate_fault(value,scenario):
    _keys(value,('capability','status','instrumentation','triggerCount','blockedHttp','blockedWebSocket','blockSeconds'))
    _enum(value['capability'],('not-checked','available','unavailable'))
    _enum(value['status'],('not-requested','ready','triggered','disarmed','failed'))
    expected=empty_fault(scenario)
    if value['instrumentation']!=expected['instrumentation'] or type(value['blockSeconds']) is not int or value['blockSeconds']!=expected['blockSeconds']:
        raise ValueError('schema-rejected')
    _int(value['triggerCount'],1)
    for key in ('blockedHttp','blockedWebSocket'): _int(value[key],32)
    if value['blockedHttp']+value['blockedWebSocket']>32: raise ValueError('schema-rejected')
    if scenario in ('baseline','continuity') and value!=expected: raise ValueError('schema-rejected')
    if value['triggerCount'] and (value['capability']!='available' or value['status'] not in ('triggered','disarmed','failed')): raise ValueError('schema-rejected')
    return value


def validate_summary(value):
    _keys(value,('schemaVersion','scenario','mode','phase','qualificationEvidenceScope','nativeAfterGraceQualification',
        'hostObservation','continuity','ordinaryRecovery','failure','startup','manifest','lifecycle','fault','businessInput','visibleEffect','physical'))
    _int(value['schemaVersion'],1,minimum=1); _enum(value['scenario'],SCOPES); _enum(value['mode'],('stun','relay','tunnel')); _enum(value['phase'],PHASES)
    if value['qualificationEvidenceScope']!=SCOPES[value['scenario']]: raise ValueError('schema-rejected')
    for key in ('nativeAfterGraceQualification','businessInput','visibleEffect','physical'):
        if value[key]!='NOT_RUN': raise ValueError('schema-rejected')
    validate_host_observation(value['hostObservation']); validate_fault(value['fault'],value['scenario'])
    failure=value['failure']
    if failure is not None:
        _keys(failure,('phase','reason')); _enum(failure['phase'],PHASES)
        _enum(failure['reason'],REASONS-{'none','scenario-not-requested','run-in-progress'})
    if value['startup'] is not None:
        _keys(value['startup'],VERIFIED_STARTUP)
        if any(type(value['startup'][k]) is not type(v) or value['startup'][k]!=v for k,v in VERIFIED_STARTUP.items()): raise ValueError('schema-rejected')
    m=value['manifest']
    if m is not None:
        _keys(m,('sha256','runNonce','originSource','originEvidenceSha256','signalSourceCommit','hostSourceCommit','viewerSourceCommit','viewerBuildId','sourceEvidence'))
        for key in ('sha256','originEvidenceSha256'): _hex(m[key],64)
        _hex(m['runNonce'],32); _hex(m['viewerBuildId'],16)
        for key in ('signalSourceCommit','hostSourceCommit','viewerSourceCommit'): _hex(m[key],40)
        _enum(m['originSource'],('quick-url-file','formal-configured'))
        if m['sourceEvidence']!='root-attested': raise ValueError('schema-rejected')
    lifecycle=value['lifecycle']; _keys(lifecycle,('captureStatus','cleanupStatus','writeStatus','ownedProcessExitEvidence'))
    _enum(lifecycle['captureStatus'],('not-started','ok','unavailable','timeout','error','cancelled','schema-rejected','noncooperative'))
    _enum(lifecycle['cleanupStatus'],('not-started','running','api-finished-exit-unknown','incomplete'))
    _enum(lifecycle['writeStatus'],('ok','error'))
    if lifecycle['ownedProcessExitEvidence']!='not-observed': raise ValueError('schema-rejected')
    r=value['ordinaryRecovery']
    _keys(r,('status','classification','requestedScenario','qualificationEvidenceScope','recoverySeconds','recoveredStableSeconds','serverCoverage','reason'))
    _enum(r['status'],('NOT_RUN','INCOMPLETE','FAIL','PASS')); _enum(r['classification'],('not-attempted','unclassified','within-grace-rebind','after-grace-reset'))
    _enum(r['serverCoverage'],('not-started','complete','incomplete')); _enum(r['reason'],REASONS)
    if r['requestedScenario']!=value['scenario'] or r['qualificationEvidenceScope']!=value['qualificationEvidenceScope']: raise ValueError('schema-rejected')
    _number(r['recoverySeconds'],nullable=True); _number(r['recoveredStableSeconds'])
    if value['scenario'] in ('baseline','continuity') and (r['status']!='NOT_RUN' or r['classification']!='not-attempted' or r['reason']!='scenario-not-requested'):
        raise ValueError('schema-rejected')
    if r['status']=='NOT_RUN' and (r['classification']!='not-attempted' or r['recoverySeconds'] is not None or r['recoveredStableSeconds']!=0):
        raise ValueError('schema-rejected')
    if r['status']=='PASS':
        expected='within-grace-rebind' if value['scenario']=='within-grace' else 'after-grace-reset'
        host=value['hostObservation']
        if (failure is not None or value['fault']['status']=='failed' or r['reason']!='none' or r['classification']!=expected or r['serverCoverage']!='complete'
            or r['recoverySeconds'] is None or r['recoverySeconds']>60 or r['recoveredStableSeconds']<30
            or lifecycle['cleanupStatus']!='api-finished-exit-unknown' or lifecycle['captureStatus']!='ok' or lifecycle['writeStatus']!='ok'
            or host['status']!='stable' or host['coverage']!='complete' or host['hostDisconnectObserved']): raise ValueError('schema-rejected')
    # Continuity is generated solely by the unchanged reducer. Validate every
    # emitted key and scalar against its fixed result schema before persistence.
    c=value['continuity']; template=passive.ContinuitySummary(duration_s=10800 if value['scenario']=='continuity' else 300,mode=value['mode']).result(elapsed_s=0.0)
    _keys(c,template)
    for key,expected in template.items():
        item=c[key]
        if key=='status': _enum(item,('PASS','FAIL','INCOMPLETE'))
        elif type(expected) is bool:
            if type(item) is not bool: raise ValueError('schema-rejected')
        elif type(expected) in (int,float):
            _number(item,9999999999999)
            if type(expected) is int: _int(item,9999999999999)
        elif item!=expected: raise ValueError('schema-rejected')
    if len(compact(value))>MAX_ROW_BYTES: raise ValueError('evidence-budget-exceeded')
    return value


def _raise_fault_failure(fault, snapshot):
    if snapshot['status'] != 'failed': return
    # This is directly owned adapter evidence, never inferred server causality.
    reason = getattr(fault, 'failure_reason', 'fault-handler-failed')
    _enum(reason, ('fault-attempt-cap', 'fault-handler-failed'))
    raise ValueError(reason)


def _load_fault(scenario):
    if scenario not in ('within-grace','after-grace'): return None
    try:
        if __package__:
            from .ordinary_recovery_fault import BrowserLocalFault
        else:
            from ordinary_recovery_fault import BrowserLocalFault
        return BrowserLocalFault(scenario=scenario)
    except ImportError: raise ValueError('fault-capability-unavailable') from None


async def run(args,*,manager_factory=None,status_reader=None,limits=None):
    model=OrdinaryRecoverySummary(args.scenario,args.mode); life=OwnedBrowserLifecycle(limits=limits)
    manifest=log=guard=fault=None; stream=None; observing=False; cancelled=False; observation_poisoned=False
    origin=None; salt=secrets.token_bytes(16); host=HostContinuityObserver(salt)
    current_ids=dict(sessionId=None,socketId=None,previousSocketId=None)
    last_socket=None; began=time.monotonic(); output=Path(args.output_dir)
    status_reader=status_reader or read_local_host_status
    writer=None

    def fail(exc):
        model.fail(_reason(exc))
        if life.python['failureDetectedMs'] is None:
            life.python['failureDetectedMs']=passive.monotonic_ms()
            life.python['failureWallEpochMs']=round(time.time()*1000)

    def persist(*,initial=False):
        model.lifecycle=life.snapshot(); model.host=host.snapshot()
        complete=life.python['cleanupStatus']=='api-finished-exit-unknown'
        ok=True; written=[]
        for name in ('lifecycle.json','summary.json'):
            try:
                model.lifecycle=life.snapshot()
                value=life.record() if name=='lifecycle.json' else validate_summary(model.result(cleanup_complete=complete))
                passive.atomic_evidence(output/name,value,initial=initial); written.append(name)
            except (OSError,ValueError,TypeError):
                life.write_status='error'; fail(ValueError('evidence-write-failed')); ok=False
        if not ok:
            model.lifecycle=life.snapshot()
            for name in written:
                try:
                    value=life.record() if name=='lifecycle.json' else validate_summary(model.result(cleanup_complete=complete))
                    passive.atomic_evidence(output/name,value)
                except (OSError,ValueError,TypeError): pass
        return ok

    def check_state(state):
        nonlocal last_socket,current_ids
        _ui_state(state); guard.check(started=model.startup is not None)
        if state['networkMode']!=args.mode and (model.startup is not None or state['networkMode']!='unknown'): raise ValueError('recovery-gates-unmet')
        if state['startClickMarks'] is not None and state['startClickMarks']>1: raise ValueError('extra-start')
        if model.startup is not None and (state['startClickMarks']!=1 or not state['authCurrent'] or state['htmlShellMarks']!=1 or state['coreInteractiveMarks']!=1):
            raise ValueError('start-ui-state-changed')
        socket=state['socketId']
        if socket is not None and socket!=last_socket:
            current_ids['previousSocketId']=last_socket; last_socket=socket
        current_ids.update(sessionId=state['sessionId'],socketId=socket or last_socket)
        return dict(sessionHash=hash_identity(state['sessionId'],salt),socketHash=hash_identity(socket,salt),admissionHash=hash_identity(state['admissionId'],salt))

    async def tick(*,final=False):
        nonlocal observation_poisoned
        if observation_poisoned: raise CancellationCooperationError('cancellation-noncooperative')
        sample=None; identity=dict.fromkeys(('sessionHash','socketHash','admissionHash')); events=[]; diagnostic=None; log_read=False
        async def page_once():
            if final:
                return await life.page.evaluate('''async () => {
                  const sample=await window.__wrdPassiveSampler.sample();
                  const state=window.__wrdOrdinaryObservation();
                  const diagnostic=window.__wrdPassiveSampler.finalize();
                  return {sample,state,diagnostic};
                }''')
            return await life.page.evaluate(OBSERVE_SAMPLE)
        try:
            if final: manifest.recheck(round(time.time()*1000))
            # Cleanup supplies the 1s outer deadline; ordinary ticks own 2s.
            operation=_observation_pair(page_once,status_reader)
            result,status = await operation if final else await lifecycle_stage(operation,2,settlement=.1)
            host.observe_status(status,time.monotonic()*1000)
            _keys(result,('state','sample','diagnostic') if final else ('state','sample'))
            identity=check_state(result['state'])
            if fault is not None:
                model.fault=validate_fault(fault.snapshot(),args.scenario)
                _raise_fault_failure(fault,model.fault)
            raw=result['sample']
            try:
                _keys(raw,(*[k for k in _SAMPLE_KEYS if k!='attemptHash'],'attempt'))
                if raw['attempt'] is not None and not _id(raw['attempt']): raise ValueError()
                sample=passive.private_row(raw,salt); _validate_private_sample(sample)
            except (ValueError,TypeError,KeyError,OverflowError):
                sample=None; raise ValueError('schema-rejected') from None
            if sample['buildId']!=model.expected_build: raise ValueError('deployment-build-mismatch')
            prior=life.diagnostic['attribution']
            life.diagnostic=passive.diagnostic_from_delta(life.diagnostic,sample['diagnostics'])
            found=life.diagnostic['attribution']['firstDisconnectEvent']
            if prior['firstDisconnectEvent'] is not None and (found is None or found['n']>prior['firstDisconnectEvent']['n']):
                life.diagnostic['attribution']=prior
            log_read=True
            events=log.read_tick(current_ids); model.server_coverage=log.snapshot()['coverage']
            if any(e['event']=='host-disconnected' for e in events): host.observe_host_disconnect()
            if host.reason!='none': raise ValueError(host.reason)
            if log.reason!='none': raise ValueError(log.reason)
            if final:
                diagnostic=passive.validate_diagnostic(result['diagnostic'])
                if model.identity is not None and any(identity[k]!=model.identity[k] for k in ('sessionHash','admissionHash')):
                    raise ValueError('ordinary-owner-changed')
                if model.failure is None and model.triggered is None and (events or sample['diagnostics']['firstDisconnectEvent'] is not None):
                    raise ValueError('baseline-failed')
                if model.failure is None and model.triggered is None and model.identity is not None and identity['socketHash']!=model.identity['socketHash']:
                    raise ValueError('ordinary-owner-changed')
                if model.failure is None and model.triggered is not None and (events or _recovered_identity(identity,sample)!=model.stable_identity):
                    raise ValueError('recovery-gates-unmet')
                if model.failure is None and not _gates(sample,args.mode,recovery=model.triggered is not None):
                    raise ValueError('recovery-gates-unmet' if model.triggered is not None else 'baseline-failed')
                if model.failure is None and model.triggered is None:
                    # Validate against the qualified history, without advancing
                    # its duration, sample count, identity or counter baselines.
                    final_continuity=copy.copy(model.continuity)
                    final_continuity.observe(dict(elapsedSeconds=model.elapsed,status='observed',sample=sample))
                    if final_continuity.result(elapsed_s=model.elapsed)['status']!='PASS':
                        raise ValueError('baseline-failed')
        except BaseException as exc:
            if isinstance(exc,CancellationCooperationError): observation_poisoned=True
            if isinstance(exc,(TimeoutError,CancellationCooperationError)) or sample is None:
                host._fail('host-observation-unavailable')
            if log is not None: model.server_coverage=log.snapshot()['coverage']
            fail(ValueError('sampling-gap') if isinstance(exc,TimeoutError) else exc)
            raise
        finally:
            # Even a rejected page/status observation must not hide a Host
            # disconnect. Drain once using only the last validated identities.
            if not log_read and log is not None and log.snapshot()['status']=='reading':
                try:
                    events=log.read_tick(current_ids)
                    if any(e['event']=='host-disconnected' for e in events): host.observe_host_disconnect()
                except ValueError as exc: fail(exc)
            if log is not None: model.server_coverage=log.snapshot()['coverage']
            model.host=host.snapshot()
            row=dict(schemaVersion=1,scenario=args.scenario,elapsedSeconds=min(12000,max(0,time.monotonic()-began)),
                phase=model.phase,qualificationEvidenceScope=SCOPES[args.scenario],hostObservation=model.host,
                sample=sample,identity=identity,serverEvents=events)
            validate_recovery_row(row)
            if writer is not None:
                try: writer.write(row)
                except (OSError,ValueError,RuntimeError) as exc:
                    fail(ValueError('evidence-budget-exceeded') if str(exc)=='evidence-budget-exceeded' else ValueError('evidence-write-failed'))
                    raise
        if not final:
            model.observe(row)
            if model.failure: raise ValueError(model.failure['reason'])
        return diagnostic

    async def export():
        if not observing: return None
        return await tick(final=True)

    try:
        try:
            manifest=read_runtime_manifest(args.runtime_manifest,args.runtime_manifest_sha256,origin=args.origin,
                scenario=args.scenario,mode=args.mode,now_epoch_ms=round(time.time()*1000))
            model.manifest=manifest.projection(); model.expected_build=manifest['viewer']['buildId']
            origin=normalized_origin(args.origin)
        except Exception as exc: fail(exc)
        try:
            output.mkdir(parents=True,exist_ok=False,mode=0o700)
            fd=os.open(output/'samples.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            stream=os.fdopen(fd,'w'); writer=passive.EvidenceWriter(stream,max_bytes=passive.MAX_RUN_BYTES-3*MAX_ROW_BYTES)
        except OSError:
            life.write_status='error'; return 1
        if not persist(initial=True) or model.failure is not None: return 1
        try:
            from dotenv import dotenv_values
            if manager_factory is None:
                from playwright.async_api import async_playwright
                manager_factory=async_playwright
        except ImportError: raise ValueError('runtime-dependency-unavailable') from None
        password=os.environ.get('VIEWER_ACCESS_PASSWORD') or dotenv_values(args.runtime_config).get('VIEWER_ACCESS_PASSWORD')
        if not password: raise ValueError('authentication-unavailable')
        fault=_load_fault(args.scenario)
        if fault is not None: model.fault=validate_fault(fault.snapshot(),args.scenario)
        model.transition('startup')
        page=await life.start(manager_factory); page.set_default_timeout(8000)
        guard=_AdmissionObservation(page,origin); page._wrd_ordinary_guard=guard
        if fault is not None:
            life.disarm=fault.disarm
            await lifecycle_stage(fault.install(page,origin,scenario=args.scenario),8)
            model.fault=validate_fault(fault.snapshot(),args.scenario)
            if model.fault['capability']!='available': raise ValueError('fault-capability-unavailable')
        await lifecycle_stage(page.add_init_script("localStorage.setItem('wrdNetworkMode',"+json.dumps(args.mode)+');'),8)
        response=await lifecycle_stage(page.goto(origin,wait_until='domcontentloaded',timeout=30000),31)
        if response is None or response.status!=200: raise ValueError('entry-unavailable')
        async def login():
            await page.locator('#password').fill(password)
            await page.locator('#loginForm button[type="submit"]').click()
            await page.wait_for_url('**/viewer.html',timeout=30000)
        try: await lifecycle_stage(login(),39)
        except CancellationCooperationError: raise
        except Exception: raise ValueError('authentication-unavailable') from None
        response=await lifecycle_stage(page.goto(origin+'/viewer.html?wrdAdmission=vacant-only-v1',wait_until='domcontentloaded',timeout=30000),31)
        if response is None or response.status!=200: raise ValueError('entry-unavailable')
        await lifecycle_stage(page.evaluate(OBSERVATION_INSTALL),8)
        await lifecycle_stage(page.evaluate(Path(__file__).with_name('passive_session_sampler.js').read_text()),8)
        log=ServerRecoveryEvidence(manifest['signalLog']['path'],salt); log.start()
        if (log._device,log._inode)!=(manifest['signalLog']['device'],manifest['signalLog']['inode']): raise ValueError('server-log-identity-changed')
        observing=True; began=time.monotonic(); model.server_coverage='complete'
        # Initial observation is completed before the UI action is even created.
        await tick()
        model.startup=await _observe_start(start_guarded_via_ui(page),tick)
        startup_deadline=time.monotonic()+45
        while model.failure is None:
            at=time.monotonic(); await tick()
            if model.phase=='startup' and time.monotonic()>=startup_deadline: raise ValueError('baseline-incomplete')
            if model.baseline_ready and model.triggered is None:
                if fault is None: break
                manifest.recheck(round(time.time()*1000))
                # This tick has just completed status, log, identity and full gates.
                await lifecycle_stage(fault.trigger_once(page),2,settlement=.1)
                model.fault=validate_fault(fault.snapshot(),args.scenario)
                if model.fault['triggerCount']!=1 or model.fault['status']!='triggered': raise ValueError('fault-trigger-unconfirmed')
                model.confirm_fault(time.monotonic()-began); model.transition('recovering')
            if model.recovered is not None and model.stable>=30: break
            await asyncio.sleep(max(0,1-(time.monotonic()-at)))
    except asyncio.CancelledError as exc:
        cancelled=True; fail(exc)
    except BaseException as exc:
        if isinstance(exc,(KeyboardInterrupt,SystemExit)): raise
        if isinstance(exc,CancellationCooperationError): observation_poisoned=True
        fail(exc)
    finally:
        # Exactly one coordinator/deadline, including repeated external cancels.
        coordinator=asyncio.create_task(life.cleanup(export))
        while not coordinator.done():
            try: await asyncio.shield(coordinator)
            except asyncio.CancelledError:
                cancelled=True; fail(ValueError('cancelled'))
            except BaseException: break
        try: coordinator.result()
        except BaseException: life.python['cleanupStatus']='incomplete'
        if guard is not None:
            try: guard.detach()
            except Exception: life.python['cleanupStatus']='incomplete'; fail(ValueError('cleanup-incomplete'))
        if log is not None:
            try: log.close()
            except OSError:
                life.python['cleanupStatus']='incomplete'; fail(ValueError('server-log-unavailable'))
            model.server_coverage=log.snapshot()['coverage']
            if log.reason!='none': fail(ValueError(log.reason))
        if fault is not None:
            try:
                model.fault=validate_fault(fault.snapshot(),args.scenario)
                _raise_fault_failure(fault,model.fault)
            except ValueError as exc: fail(exc)
        model.lifecycle=life.snapshot(); model.host=host.snapshot()
        if life.python['cleanupStatus']!='api-finished-exit-unknown' and model.failure is None: fail(ValueError('cleanup-incomplete'))
        if model.phase!='terminal': model.transition('terminal')
        if stream is not None:
            persist()
            try: stream.close()
            except OSError:
                life.write_status='error'; fail(ValueError('evidence-write-failed')); persist()
    final=model.result(cleanup_complete=life.python['cleanupStatus']=='api-finished-exit-unknown')
    selected=final['ordinaryRecovery'] if args.scenario in ('within-grace','after-grace') else final['continuity']
    return 0 if not cancelled and not final['failure'] and life.write_status=='ok' and selected['status']=='PASS' else 1


def main():
    parser=argparse.ArgumentParser(description='Owned ordinary Viewer recovery qualification; no business input.')
    parser.add_argument('--origin',required=True)
    parser.add_argument('--mode',choices=('stun','relay','tunnel'),required=True)
    parser.add_argument('--scenario',choices=tuple(SCOPES),required=True)
    parser.add_argument('--runtime-manifest',type=Path,required=True)
    parser.add_argument('--runtime-manifest-sha256',required=True)
    parser.add_argument('--runtime-config',type=Path,default=Path(__file__).resolve().parents[1]/'signal-server'/'.env')
    parser.add_argument('--output-dir',required=True)
    return asyncio.run(run(parser.parse_args()))


if __name__=='__main__': raise SystemExit(main())
