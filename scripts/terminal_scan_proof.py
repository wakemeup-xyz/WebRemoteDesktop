"""Bounded prospective evidence for a known process's direct children race.

No import/construction observations. The injected Registry retains every scan,
state, signal and cleanup decision. Extra reads bypass diagnostics only for the
single exact-PID terminal observation; raw diagnostic events/gaps are untouched.
This policy cannot establish complete process-tree exit.
"""
from copy import deepcopy
import json
import math


class TerminalCoverageError(RuntimeError):
    """Evidence cannot establish the narrow prospective coverage policy."""


_LIMITS = {'proofs': 32, 'bytes': 32768, 'maxIntervalSeconds': 1.0}
_INHERENT = {'polling-may-miss-fast-orphan', 'macos-check-to-signal-race', 'no-CDP-no-manager-proxy'}
_STAGES = {'worker-loop', 'cleanup', 'result'}
_MAX_INT = 2147483647
_ALIVE_STATUSES = {'running', 'sleeping', 'disk-sleep', 'stopped', 'tracing-stop',
                   'wake-kill', 'waking', 'idle', 'locked', 'waiting', 'parked'}


def _require(condition, message='invalid terminal evidence'):
    if not condition:
        raise TerminalCoverageError(message)


def _keys(value, keys):
    _require(type(value) is dict and set(value) == set(keys))


def _number(value, *, positive=False, integer=False):
    _require(type(value) is int if integer else type(value) in (int, float))
    try:
        valid = math.isfinite(value) and (value > 0 if positive else value >= 0)
    except (OverflowError, ValueError):
        valid = False
    _require(valid)
    if integer:
        _require(value <= _MAX_INT)
    return value


def _pid(value):
    return _number(value, positive=True, integer=True)


def _clock_pair(value):
    _keys(value, ('wall', 'monotonic'))
    for clock in value.values():
        _number(clock)


def _parent(value):
    if value is not None:
        _keys(value, ('pid', 'birth'))
        _pid(value['pid']); _number(value['birth'], positive=True)


def _metadata(entry, pid):
    _pid(pid)
    _require(type(entry) is dict)
    birth, parent = entry['birth'], entry['parent']
    _number(birth, positive=True); _parent(parent)
    provenance = {key: entry[key] for key in ('firstObservedEpoch', 'lastObservedEpoch')}
    for value in provenance.values():
        _number(value)
    _require(provenance['lastObservedEpoch'] >= provenance['firstObservedEpoch'])
    return {'pid': pid, 'birth': birth, 'parent': deepcopy(parent), 'provenance': provenance}


def _compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _validate_proof(proof, identity, event, gap, index):
    _keys(proof, ('proofId', 'role', 'stage', 'scanId', 'eventId', 'gapIndex', 'operation',
                  'recursive', 'pid', 'birth', 'parent', 'provenance', 'before', 'error',
                  'after', 'gap', 'entryUnchanged'))
    _pid(proof['proofId']); _pid(proof['scanId']); _pid(proof['eventId'])
    _number(proof['gapIndex'], integer=True)
    _require(proof['gapIndex'] == index and proof['role'] == 'worker'
             and proof['stage'] in _STAGES and proof['operation'] == 'children'
             and proof['recursive'] is False and proof['entryUnchanged'] is True)
    metadata = _metadata(identity, identity['pid'])
    for key, value in metadata.items():
        _require(proof[key] == value)
    # Equality alone accepts bool == 1; validate every serialized numeric field.
    _pid(proof['pid']); _number(proof['birth'], positive=True); _parent(proof['parent'])
    _keys(proof['provenance'], ('firstObservedEpoch', 'lastObservedEpoch'))
    for value in proof['provenance'].values():
        _number(value)
    for source in (event, gap):
        _require(all(proof[key] == source[key] for key in ('role', 'stage', 'scanId', 'eventId')))
    _require(event['context'] == 'scan' and event['operation'] == 'children'
             and event['exception'] == 'NoSuchProcess' and event['pid'] == proof['pid']
             and (event['birth'] is None or event['birth'] == proof['birth'])
             and gap['association'] == 'direct-scan-error' and gap['reason'] == 'observation-unavailable')
    before, error, after = proof['before'], proof['error'], proof['after']
    _keys(before, ('birth', 'status', 'wall', 'monotonic'))
    _number(before['birth'], positive=True)
    _require(before['birth'] == proof['birth'] and before['status'] in _ALIVE_STATUSES)
    _keys(error, ('class', 'pid', 'wall', 'monotonic'))
    _pid(error['pid'])
    _require(error['class'] == 'NoSuchProcess' and error['pid'] == proof['pid'])
    _require(all(error[key] == event[key] for key in ('wall', 'monotonic')))
    _keys(after, ('operation', 'outcome', 'birth', 'status', 'birthAgain', 'wall', 'monotonic'))
    _require(after['operation'] == 'exact-pid-identity')
    if after['outcome'] == 'absent':
        _require(after['birth'] is None and after['birthAgain'] is None and after['status'] is None)
    else:
        _number(after['birth'], positive=True); _number(after['birthAgain'], positive=True)
        _require(after['birth'] == after['birthAgain'])
        if after['outcome'] == 'same-birth-zombie':
            _require(after['birth'] == proof['birth'] and after['status'] == 'zombie')
        else:
            _require(after['outcome'] == 'stable-reused' and after['birth'] != proof['birth']
                     and after['status'] in _ALIVE_STATUSES | {'zombie'})
    _clock_pair(proof['gap'])
    _require(proof['gap'] == {key: gap[key] for key in ('wall', 'monotonic')})
    points = (before, error, after, proof['gap'])
    for point in points:
        for key in ('wall', 'monotonic'):
            _number(point[key])
    for key in ('wall', 'monotonic'):
        _require(all(a[key] <= b[key] for a, b in zip(points, points[1:])))
    _require(proof['gap']['monotonic'] - before['monotonic'] <= 1.0)


def validate_terminal_coverage(ownership, diagnostic_snapshot, proof_snapshot):
    """Validate detached numbers and bidirectional associations independently."""
    try:
        return _validate(ownership, diagnostic_snapshot, proof_snapshot)
    except TerminalCoverageError:
        raise
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError) as error:
        raise TerminalCoverageError('malformed terminal evidence') from error


def _validate(owner, diag, snapshot):
    _keys(snapshot, ('version', 'scope', 'role', 'proofs', 'failed', 'overflow', 'limits'))
    _require(type(snapshot['version']) is int and snapshot['version'] == 1
             and snapshot['scope'] == 'known-process-terminal-scan-proof' and snapshot['role'] == 'worker'
             and snapshot['failed'] is False and snapshot['overflow'] is False)
    _keys(snapshot['limits'], _LIMITS)
    _require(type(snapshot['limits']['proofs']) is int and type(snapshot['limits']['bytes']) is int
             and type(snapshot['limits']['maxIntervalSeconds']) in (int, float) and snapshot['limits'] == _LIMITS)
    _require(len(_compact(snapshot)) <= 32768)
    _require(type(snapshot['proofs']) is list and len(snapshot['proofs']) <= 32)
    _keys(diag, ('schemaVersion', 'scope', 'role', 'events', 'gaps', 'dropped', 'gapsDropped', 'failed',
                 'expectedStateExitCounts', 'overflow', 'limits'))
    _require(type(diag['schemaVersion']) is int and diag['schemaVersion'] == 2
             and diag['scope'] == 'diagnostic-only' and diag['role'] == 'worker' and diag['failed'] is False)
    for key in ('dropped', 'gapsDropped'):
        _number(diag[key], integer=True); _require(diag[key] == 0)
    _keys(diag['overflow'], ('events', 'gaps', 'contexts', 'counters'))
    _require(all(value is False for value in diag['overflow'].values()))
    _keys(diag['expectedStateExitCounts'], _STAGES)
    for value in diag['expectedStateExitCounts'].values():
        _number(value, integer=True)
    _keys(diag['limits'], ('events', 'gaps', 'contextDepth', 'counter'))
    for key in ('events', 'gaps'):
        _pid(diag['limits'][key]); _require(diag['limits'][key] <= 32)
        _require(type(diag[key]) is list and len(diag[key]) <= diag['limits'][key])
    _require(type(diag['limits']['contextDepth']) is int and diag['limits']['contextDepth'] == 8
             and type(diag['limits']['counter']) is int and diag['limits']['counter'] == _MAX_INT)
    events = {}
    previous_id = 0
    for event in diag['events']:
        _keys(event, ('eventId', 'scanId', 'role', 'stage', 'context', 'operation', 'pid', 'birth', 'exception',
                      'errno', 'monotonic', 'wall'))
        _pid(event['eventId']); _require(event['eventId'] > previous_id); previous_id = event['eventId']
        if event['scanId'] is not None:
            _pid(event['scanId'])
        _require(event['role'] == 'worker' and event['stage'] in _STAGES
                 and event['context'] in ('scan', 'state', 'signal', 'outside')
                 and event['operation'] in ('resolve', 'pid', 'create_time', 'status', 'children', 'ppid', 'terminate', 'kill')
                 and event['exception'] in ('NoSuchProcess', 'AccessDenied', 'OSError'))
        if event['pid'] is not None:
            _pid(event['pid'])
        if event['birth'] is not None:
            _number(event['birth'])
        if event['errno'] is not None:
            _require(type(event['errno']) is int and -_MAX_INT <= event['errno'] <= _MAX_INT)
        _number(event['wall']); _number(event['monotonic'])
        events[event['eventId']] = event
    _require(type(owner) is dict and type(owner['coverage']) is list
             and all(type(reason) is str for reason in owner['coverage']))
    coverage = set(owner['coverage'])
    _require(len(coverage) == len(owner['coverage']) and _INHERENT <= coverage
             and coverage <= _INHERENT | {'observation-unavailable'})
    _require(owner['allRecordedIdentitiesExited'] is True and owner['completeProcessTreeExitEstablished'] is False
             and type(owner['signals']) is list and owner['signals'] == []
             and type(owner['identities']) is list and len(owner['identities']) <= 128)
    identities = {}
    for identity in owner['identities']:
        _keys(identity, ('pid', 'birth', 'parent', 'firstObservedEpoch', 'lastObservedEpoch', 'status'))
        _metadata(identity, identity['pid'])
        _require(identity['status'] == 'exited' and identity['pid'] not in identities)
        identities[identity['pid']] = identity
    _require(('observation-unavailable' in coverage) == bool(diag['gaps']))
    _require(len(snapshot['proofs']) == len(diag['gaps']))
    used_events = set()
    previous_proof_id = 0
    previous_clocks = None
    for index, (gap, proof) in enumerate(zip(diag['gaps'], snapshot['proofs'])):
        _keys(gap, ('scanId', 'eventId', 'association', 'reason', 'role', 'stage', 'monotonic', 'wall'))
        _pid(gap['scanId']); _pid(gap['eventId']); _number(gap['wall']); _number(gap['monotonic'])
        _require(gap['eventId'] not in used_events)
        event = events[gap['eventId']]
        _validate_proof(proof, identities[proof['pid']], event, gap, index)
        _require(proof['proofId'] > previous_proof_id); previous_proof_id = proof['proofId']
        if previous_clocks is not None:
            _require(all(previous_clocks[key] <= proof['before'][key] for key in ('wall', 'monotonic')))
        previous_clocks = proof['gap']
        used_events.add(gap['eventId'])
    for event in events.values():
        if event['eventId'] in used_events:
            continue
        # Preserve the original unknown/skip behavior, without creating proof eligibility.
        _require(event['context'] == 'state' and event['exception'] in ('AccessDenied', 'OSError')
                 and event['operation'] in ('resolve', 'create_time', 'status'))
    return {'policy': 'prospective-terminal-race-v1', 'checkedProofs': len(snapshot['proofs']),
            'checkedEvents': len(used_events), 'checkedGaps': len(diag['gaps']),
            'rawUnexpectedCoverage': [reason for reason in owner['coverage'] if reason not in _INHERENT],
            'fullProcessTreeExit': 'unknown', 'completeProcessTreeExitEstablished': False}


def instrument_terminal_registry(registry_type, diagnostic, *, wall, monotonic):
    """Return worker-only Registry; capture existing reads, never repeat before."""
    if diagnostic._role != 'worker':
        raise TerminalCoverageError('worker proof role required')

    class TerminalRegistry(registry_type):
        def __init__(self):
            self._proofs = []; self._proof_failed = False; self._proof_overflow = False
            self._proof_attempts = 0; self._last_proof_clocks = None
            self._before = None; self._pending_proof = None; self._scan_depth = 0
            self._state_reads = None; self._generation = 0
            super().__init__(process=self._process)

        def _clocks(self):
            point = {'wall': wall(), 'monotonic': monotonic()}
            _clock_pair(point)
            return point

        def _process(self, pid):
            token = self._before
            if self._state_reads is not None:
                self._state_reads.append(('resolve', pid))
            elif token is not None:
                if token['metadata']['pid'] != pid or token.get('resolved'):
                    self._before = None
                else:
                    token['resolved'] = True
            proxy = Proxy(diagnostic.process(pid), pid, self)
            if token is not None and self._before is token and token.get('resolved'):
                token['proxy'] = proxy
            return proxy

        def state(self, pid):
            self._generation += 1
            generation = self._generation
            self._before = None
            previous = self._state_reads
            reads = []; self._state_reads = reads
            try:
                with diagnostic.context('state', registry=self, pid=pid):
                    result = super().state(pid)
                if result == 'alive' and previous is None and self._scan_depth == 1:
                    try:
                        _require(self._generation == generation and len(reads) == 3 and reads[0] == ('resolve', pid)
                                 and reads[1][0] == 'birth' and reads[2][0] == 'status')
                        entry = self.entries[pid]; metadata = _metadata(entry, pid)
                        _require(reads[1][1] == metadata['birth'] and reads[2][1] in _ALIVE_STATUSES)
                        _clock_pair(reads[2][2])
                        self._before = {'metadata': metadata, 'entry': entry, 'object': entry['object'],
                                        'before': {'birth': reads[1][1], 'status': reads[2][1], **reads[2][2]},
                                        'generation': self._generation}
                    except BaseException:
                        # Invalid before is a veto only if a children candidate actually occurs.
                        self._before = None
                return result
            finally:
                self._state_reads = previous

        def scan(self):
            self._generation += 1
            self._before = None
            self._scan_depth += 1
            try:
                with diagnostic.context('scan', registry=self):
                    return super().scan()
            finally:
                self._scan_depth -= 1
                self._before = None
                if self._pending_proof is not None:
                    self._proof_failed = True
                    self._pending_proof = None

        def signal(self, kind):
            self._before = None
            with diagnostic.context('signal', registry=self):
                return super().signal(kind)

        def _unchanged(self, token):
            pid = token['metadata']['pid']
            entry = self.entries.get(pid)
            return (self._generation == token['generation'] and entry is token['entry']
                    and entry.get('object') is token['object'] and _metadata(entry, pid) == token['metadata'])

        def _candidate(self, pid, recursive, token, error):
            self._proof_attempts += 1
            try:
                _require(self._scan_depth == 1 and recursive is False and token is not None
                         and token.get('resolved') is True and self._pending_proof is None)
                _require(isinstance(error, diagnostic._supported[0]))
                error_pid = getattr(error, 'pid', None); _pid(error_pid); _require(error_pid == pid)
                _require(self._unchanged(token))
                _require(self._proof_attempts <= 32)
                snap = diagnostic.snapshot()
                frame = diagnostic._frame()
                _require(frame is not None and frame['name'] == 'scan')
                event = snap['events'][-1]
                _require(frame['pending'] == event['eventId'] and event['pid'] == pid
                         and event['operation'] == 'children' and event['context'] == 'scan'
                         and event['exception'] == 'NoSuchProcess')
                after = {'operation': 'exact-pid-identity', 'outcome': None, 'birth': None,
                         'status': None, 'birthAgain': None}
                try:
                    target = diagnostic._factory(pid)
                except diagnostic._supported[0] as absent:
                    absent_pid = getattr(absent, 'pid', None); _pid(absent_pid); _require(absent_pid == pid)
                    after['outcome'] = 'absent'
                else:
                    birth = target.create_time(); status = target.status(); again = target.create_time()
                    _number(birth, positive=True); _number(again, positive=True)
                    _require(birth == again and type(status) is str and status in _ALIVE_STATUSES | {'zombie'})
                    after.update(birth=birth, birthAgain=again, status=status)
                    if birth != token['metadata']['birth']:
                        after['outcome'] = 'stable-reused'
                    else:
                        _require(status == 'zombie')
                        after['outcome'] = 'same-birth-zombie'
                after.update(self._clocks())
                _require(self._unchanged(token))
                self._pending_proof = {'token': token, 'proof': {
                    'proofId': len(self._proofs) + 1, 'role': event['role'], 'stage': event['stage'],
                    'scanId': event['scanId'], 'eventId': event['eventId'], 'gapIndex': len(snap['gaps']),
                    'operation': 'children', 'recursive': False, **token['metadata'],
                    'before': token['before'], 'error': {'class': 'NoSuchProcess', 'pid': error_pid,
                                                      'wall': event['wall'], 'monotonic': event['monotonic']},
                    'after': after, 'entryUnchanged': True}}
            except BaseException:
                self._proof_failed = True
                if self._proof_attempts > 32:
                    self._proof_overflow = True

        def note(self, reason):
            result = super().note(reason)
            try:
                diagnostic._note(reason)
            except BaseException:
                diagnostic._failed = True
                self._proof_failed = True
            pending = self._pending_proof
            if pending is not None:
                self._pending_proof = None
                try:
                    _require(reason == 'observation-unavailable' and self._unchanged(pending['token']))
                    snap = diagnostic.snapshot(); proof = pending['proof']; index = proof['gapIndex']
                    _require(len(snap['gaps']) == index + 1)
                    gap = snap['gaps'][index]
                    proof['gap'] = {key: gap[key] for key in ('wall', 'monotonic')}
                    event = next(event for event in snap['events'] if event['eventId'] == proof['eventId'])
                    identity = {**self.entries[proof['pid']], 'pid': proof['pid']}
                    _validate_proof(proof, identity, event, gap, index)
                    if self._last_proof_clocks is not None:
                        _require(all(self._last_proof_clocks[key] <= proof['before'][key]
                                     for key in ('wall', 'monotonic')))
                    self._last_proof_clocks = proof['gap']
                    self._proofs.append(proof)
                    self.terminal_proof_snapshot()
                except BaseException:
                    self._proof_failed = True
            return result

        def terminal_proof_snapshot(self):
            def snapshot():
                return {'version': 1, 'scope': 'known-process-terminal-scan-proof', 'role': 'worker',
                        'proofs': self._proofs, 'failed': self._proof_failed,
                        'overflow': self._proof_overflow, 'limits': dict(_LIMITS)}
            try:
                _require(self._pending_proof is None)
                if len(_compact(snapshot())) > 32768:
                    self._proof_failed = self._proof_overflow = True
                    # Failure cannot become success by truncation; bounded failure envelope.
                    self._proofs = []
            except BaseException:
                self._proof_failed = True
                self._proofs = []
            return deepcopy(snapshot())

    class Proxy:
        def __init__(self, target, pid, registry):
            self.target = target; self.pid_hint = pid; self.registry = registry
        def _read(self, operation, call):
            registry = self.registry
            if registry._state_reads is None:
                registry._before = None
            result = call()
            if registry._state_reads is not None:
                if operation == 'birth':
                    registry._state_reads.append(('birth', result))
                elif operation == 'status':
                    try:
                        clocks = registry._clocks()
                    except BaseException:
                        clocks = {'wall': None, 'monotonic': None}
                    registry._state_reads.append(('status', result, clocks))
                else:
                    registry._state_reads.append((operation, result))
            return result
        @property
        def pid(self):
            return self._read('pid', lambda: self.target.pid)
        def create_time(self):
            return self._read('birth', self.target.create_time)
        def status(self):
            return self._read('status', self.target.status)
        def ppid(self):
            return self._read('ppid', self.target.ppid)
        def children(self, recursive=False):
            registry = self.registry; token = registry._before; registry._before = None
            if token is not None and token.get('proxy') is not self:
                token = None
            try:
                children = self.target.children(recursive=recursive)
            except BaseException as error:
                registry._candidate(self.pid_hint, recursive, token, error)
                raise
            return [Proxy(child, None, registry) for child in children]
        def terminate(self):
            return self._read('terminate', self.target.terminate)
        def kill(self):
            return self._read('kill', self.target.kill)

    return TerminalRegistry()
