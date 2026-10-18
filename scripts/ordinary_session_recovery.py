#!/usr/bin/env python3
"""Bounded read-only recovery evidence primitives. No runtime/browser imports."""
from __future__ import annotations

import asyncio
from datetime import datetime
import hashlib
import json
import math
import os
import re
import stat
import time

from scripts.passive_session_soak import (
    CancellationCooperationError, compact, lifecycle_stage, validate_delta,
    validate_gate_fields,
)

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
        if self._fd is not None or self._status == 'failed': self._fail('server-log-unavailable')
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
        if type(correlation) is dict and self._reset_epoch is not None:
            if (correlation.get('viewerId') is not None and correlation.get('viewerId') not in sockets
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
        if not host and not reset:
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
                _keys(correlation, ('viewerId', 'previousViewerId'))
                if correlation['previousViewerId'] not in sockets: raise ValueError()
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
    if _status_owner is not None and not _status_owner.done():
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
    _status_owner = asyncio.create_task(request())
    try:
        return await lifecycle_stage(_status_owner, .75, settlement=.075)
    except (asyncio.CancelledError, CancellationCooperationError): raise
    except Exception: raise ValueError('host-observation-unavailable') from None
    finally:
        if _status_owner.done(): _status_owner = None


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
        for key in ('rttMs', 'bytesReceived', 'framesDecoded', 'framesDropped'): _number(transport[key], 9999999999999, nullable=True)
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
