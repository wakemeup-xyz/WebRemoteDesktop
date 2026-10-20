"""Pure fixtures: pinned Registry AST + actual module35; no OS observations."""
import ast
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from process_observation_diagnostics import Diagnostics, instrument_registry
from terminal_scan_proof import instrument_terminal_registry, validate_terminal_coverage, TerminalCoverageError

MODULE35_SHA = '00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b'
MODULE35 = Path(__file__).resolve().with_name('process_observation_diagnostics.py')
if hashlib.sha256(MODULE35.read_bytes()).hexdigest() != MODULE35_SHA:
    raise AssertionError('actual module35 hash mismatch')

SUP_SHA = 'd03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b'
SUP = Path(__file__).resolve().parents[1] / 'docs/superpowers/reports/evidence/2026-10-19-runtime-startup/immutable-registry-supervisor.py'


class NoSuchProcess(Exception):
    def __init__(self, pid=None):
        self.pid = pid


class AccessDenied(Exception):
    pass


class Clock:
    def __init__(self):
        self.value = 10.0
    def __call__(self):
        self.value += .001
        return self.value


def load_registry(clock):
    data = SUP.read_bytes()
    if hashlib.sha256(data).hexdigest() != SUP_SHA:
        raise AssertionError('portable SUP hash mismatch')
    tree = ast.parse(data)
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in ('Registry', 'Capacity')]
    namespace = {'psutil': SimpleNamespace(Process=None, NoSuchProcess=NoSuchProcess, AccessDenied=AccessDenied, STATUS_ZOMBIE='zombie'),
                 'time': SimpleNamespace(time=clock, monotonic=clock, sleep=lambda _: None), 'POLL': .25}
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(SUP), 'exec'), namespace)
    return namespace['Registry']


class Process:
    pid = 71
    def __init__(self, case):
        self.case = case
    def action(self, operation, default):
        self.case.calls.append((operation, self.pid))
        values = self.case.script.get(operation, [])
        value = values.pop(0) if values else default
        if isinstance(value, BaseException):
            raise value
        return value() if callable(value) else value
    def create_time(self):
        return self.action('birth', self.case.birth)
    def status(self):
        return self.action('status', 'zombie' if self.case.after_observation and self.case.after == 'zombie' else 'running')
    def children(self, recursive=False):
        self.case.after_observation = True
        return self.action('children', self.case.error if self.case.children_error else [])
    def terminate(self):
        self.case.signal_calls.append('term')
    def kill(self):
        self.case.signal_calls.append('kill')


class Case:
    registered_pid = 71
    def __init__(self, after='absent', instrument=True, children_error=True, birth=100.):
        self.clock = Clock(); self.calls = []; self.signal_calls = []; self.script = {}
        self.birth = birth; self.after = after; self.after_observation = False
        self.final = False; self.error = NoSuchProcess(71); self.children_error = children_error
        self.process = Process(self)
        self.diag = Diagnostics(self.resolve, (NoSuchProcess, AccessDenied, OSError), 'worker', monotonic=self.clock, wall=self.clock)
        Registry = load_registry(self.clock)
        self.registry = (instrument_terminal_registry(Registry, self.diag, wall=self.clock, monotonic=self.clock)
                         if instrument else instrument_registry(Registry, self.diag))
        self.registry.add_root(self.process)
    def resolve(self, pid):
        self.calls.append(('resolve', pid))
        values = self.script.get('resolve', [])
        if values:
            value = values.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value() if callable(value) else value
        if self.final or (self.after_observation and self.after == 'absent'):
            raise NoSuchProcess(pid)
        return Process(self)
    def scan(self):
        self.registry.scan()
        return self
    def finish_exited(self):
        self.final = True
        self.diag.set_stage('result')
        return self.registry.result(), self.diag.snapshot(), self.registry.terminal_proof_snapshot()


class CachedHandle:
    """A public handle caches its first birth just as psutil.Process does."""
    pid = 71
    def __init__(self, case):
        self.case = case
        self.cached_birth = None
    def create_time(self):
        self.case.calls.append(('birth', self.pid))
        if self.cached_birth is None:
            self.cached_birth = self.case.backend_birth
            self.case.backend_birth_reads.append(self.cached_birth)
        return self.cached_birth
    def status(self):
        self.case.calls.append(('status', self.pid))
        if self.case.after_observation:
            if self.case.mutate_after_status:
                self.case.backend_birth = 30.
            return 'zombie' if self.case.candidate == 'zombie' else 'running'
        return 'running'
    def children(self, recursive=False):
        self.case.calls.append(('children', self.pid))
        self.case.after_observation = True
        self.case.backend_birth = 20.
        raise self.case.error


class CachedCase(Case):
    def __init__(self, candidate='zombie', mutate=True, same_handle=False):
        self.candidate = candidate
        self.backend_birth = 20. if candidate == 'zombie' else 10.
        self.backend_birth_reads = []
        self.mutate_after_status = mutate
        self.same_handle = same_handle
        self.after_handles = []
        super().__init__(after='alive', birth=self.backend_birth)
    def resolve(self, pid):
        self.calls.append(('resolve', pid))
        if self.final:
            raise NoSuchProcess(pid)
        if self.after_observation and self.same_handle and self.after_handles:
            return self.after_handles[0]
        handle = CachedHandle(self)
        if self.after_observation:
            self.after_handles.append(handle)
        return handle


class TerminalProofTests(unittest.TestCase):
    def scan_case(self, **kwargs):
        return Case(**kwargs).scan()
    def canonical(self, value):
        return json.dumps(value, sort_keys=True, separators=(',', ':'))
    def test_direct_children_absent_keeps_raw_gap(self):
        case = self.scan_case(after='absent')
        owner, diag, proof = case.finish_exited()
        before = self.canonical((owner, diag))
        result = validate_terminal_coverage(owner, diag, proof)
        self.assertEqual(result['policy'], 'prospective-terminal-race-v1')
        self.assertIn('observation-unavailable', owner['coverage'])
        self.assertEqual(before, self.canonical((owner, diag)))
        self.assertEqual(sum(call[0] == 'children' for call in case.calls), 1)
        self.assertEqual(case.signal_calls, [])
    def test_alive_after_rejected_even_if_final_exited(self):
        case = self.scan_case(after='alive')
        with self.assertRaises(TerminalCoverageError):
            validate_terminal_coverage(*case.finish_exited())


    def reject(self, values):
        with self.assertRaises(TerminalCoverageError):
            validate_terminal_coverage(*values)

    def good(self):
        return self.scan_case().finish_exited()

    def test_same_birth_zombie_is_terminal(self):
        case = self.scan_case(after='zombie')
        result = validate_terminal_coverage(*case.finish_exited())
        self.assertEqual(result['checkedProofs'], 1)
        self.assertEqual(case.calls, [('birth', 71), ('resolve', 71), ('birth', 71), ('status', 71),
                                    ('resolve', 71), ('children', 71), ('resolve', 71), ('birth', 71),
                                    ('status', 71), ('resolve', 71), ('birth', 71), ('resolve', 71)])

    def test_normal_calls_match_original_and_no_proof(self):
        original = Case(instrument=False, children_error=False).scan()
        adapted = Case(children_error=False).scan()
        self.assertEqual(original.calls, adapted.calls)
        self.assertEqual(adapted.registry.terminal_proof_snapshot()['proofs'], [])
        self.assertEqual(validate_terminal_coverage(*adapted.finish_exited())['checkedProofs'], 0)

    def test_absent_adds_only_one_exact_pid_resolve(self):
        original = Case(instrument=False).scan()
        adapted = Case().scan()
        self.assertEqual(adapted.calls, original.calls + [('resolve', 71)])
        self.assertEqual(adapted.diag.snapshot()['events'][0]['birth'], None)
        self.assertEqual(adapted.diag._contexts, [])

    def test_raw_metadata_unchanged_and_snapshot_detached(self):
        case = self.scan_case()
        owner, diag, proof = case.finish_exited()
        before = self.canonical((owner, diag))
        validate_terminal_coverage(owner, diag, proof)
        self.assertEqual(before, self.canonical((owner, diag)))
        proof['proofs'][0]['before']['birth'] = 0
        self.assertEqual(case.registry.terminal_proof_snapshot()['proofs'][0]['before']['birth'], 100.)

    def test_reused_does_not_bypass_final_exited(self):
        case = Case(after='alive')
        case.script['birth'] = [100., 200., 200.]
        case.scan()
        case.birth = 200.
        owner = case.registry.result()
        self.assertEqual(owner['identities'][0]['status'], 'reused')
        self.assertFalse(owner['allRecordedIdentitiesExited'])
        self.reject((owner, case.diag.snapshot(), case.registry.terminal_proof_snapshot()))
        self.assertEqual(case.registry.terminal_proof_snapshot()['proofs'][0]['after']['outcome'], 'stable-reused')
        self.assertEqual(validate_terminal_coverage(*case.finish_exited())['checkedProofs'], 1)

    def test_after_unknown_double_birth_and_errors_rejected(self):
        for operation, values in (
                ('birth', [100., 200., 201.]),
                ('birth', [100., AccessDenied()]),
                ('birth', [100., NoSuchProcess(71)]),
                ('status', ['running', 'unknown']),
                ('status', ['running', OSError()]),
                ('resolve', [None, None, AccessDenied()]),
                ('resolve', [None, None, OSError()]),
                ('resolve', [None, None, NoSuchProcess(72)])):
            with self.subTest(operation=operation, values=values):
                case = Case(after='alive')
                case.script[operation] = [case.process if value is None else value for value in values]
                case.scan()
                self.reject(case.finish_exited())
                self.assertTrue(case.registry.terminal_proof_snapshot()['failed'])

    def test_wrong_missing_error_pid_and_unsupported_children_rejected(self):
        for error in (NoSuchProcess(), NoSuchProcess(72), NoSuchProcess(True), AccessDenied(), OSError()):
            with self.subTest(error=error):
                case = Case(); case.error = error; case.scan()
                self.reject(case.finish_exited())
        case = Case(); case.error = RuntimeError('unsupported')
        with self.assertRaises(RuntimeError) as caught:
            case.scan()
        self.assertIs(caught.exception, case.error)
        self.reject(case.finish_exited())

    def test_same_exception_object_rethrown_to_actual_registry(self):
        case = Case(); seen = []
        # A trace hook sees the original catch without replacing scan/state decisions.
        import sys
        def trace(frame, event, arg):
            if frame.f_code.co_name == 'scan' and event == 'exception':
                seen.append(arg[1])
            return trace
        previous = sys.gettrace()
        try:
            sys.settrace(trace)
            case.scan()
        finally:
            sys.settrace(previous)
        self.assertIn(case.error, seen)
        self.assertTrue(all(error is case.error for error in seen if isinstance(error, NoSuchProcess)))
        validate_terminal_coverage(*case.finish_exited())

    def test_scan_resolve_gap_not_eligible(self):
        case = Case(); case.script['resolve'] = [case.process, NoSuchProcess(71)]
        case.scan()
        self.assertEqual(case.diag.snapshot()['events'][0]['operation'], 'resolve')
        self.reject(case.finish_exited())

    def test_state_unknown_skip_preserved_without_new_veto(self):
        for error in (AccessDenied(), OSError()):
            for operation in ('resolve', 'birth', 'status'):
                with self.subTest(error=error, operation=operation):
                    original = Case(instrument=False); adapted = Case()
                    for case in (original, adapted):
                        case.script[operation] = [error]
                        case.scan()
                    self.assertEqual(original.calls, adapted.calls)
                    self.assertEqual(adapted.diag.snapshot()['gaps'], [])
                    self.assertFalse(adapted.registry.terminal_proof_snapshot()['failed'])
                    self.assertEqual(validate_terminal_coverage(*adapted.finish_exited())['checkedProofs'], 0)

    def test_entry_parent_and_provenance_drift_rejected(self):
        def mutate(case, kind):
            def callback():
                if kind == 'replace':
                    case.registry.entries[71] = dict(case.registry.entries[71])
                else:
                    case.registry.entries[71][kind] = {'pid': 70, 'birth': 90.} if kind == 'parent' else 0
                raise NoSuchProcess(71)
            return callback
        for kind in ('replace', 'parent', 'firstObservedEpoch', 'lastObservedEpoch', 'birth'):
            case = Case(); case.script['resolve'] = [case.process, case.process, mutate(case, kind)]
            case.scan(); self.reject(case.finish_exited())

    def test_missing_registration_information_does_not_gain_proof(self):
        case = Case(); del case.registry.entries[71]['firstObservedEpoch']
        case.scan()
        self.reject(case.finish_exited())
        self.assertTrue(case.registry.terminal_proof_snapshot()['failed'])

    def test_child_create_ppid_add_and_unregistered_child_errors_rejected(self):
        for operation in ('create', 'ppid', 'add'):
            case = Case(children_error=False)
            class Child:
                pid = 72
                reads = 0
                def create_time(self):
                    self.reads += 1
                    if operation == 'create' or (operation == 'add' and self.reads == 3):
                        raise NoSuchProcess(72)
                    return 110.
                def ppid(self):
                    if operation == 'ppid':
                        raise NoSuchProcess(72)
                    return 71
            case.script['children'] = [[Child()]]
            case.scan()
            self.assertEqual(case.registry.terminal_proof_snapshot()['proofs'], [])
            self.reject(case.finish_exited())

    def test_one_proof_cannot_cover_second_gap(self):
        owner, diag, proof = self.good()
        gap = deepcopy(diag['gaps'][0]); gap['eventId'] = 2
        event = deepcopy(diag['events'][0]); event.update(eventId=2, operation='ppid', pid=72)
        diag['events'].append(event); diag['gaps'].append(gap)
        self.reject((owner, diag, proof))

    def test_metadata_and_identity_tampering_rejected(self):
        paths = [('role',), ('stage',), ('scanId',), ('eventId',), ('gapIndex',), ('operation',),
                 ('recursive',), ('pid',), ('birth',), ('parent',), ('entryUnchanged',),
                 ('provenance', 'firstObservedEpoch'), ('before', 'birth'), ('before', 'status'),
                 ('error', 'pid'), ('error', 'class'), ('after', 'outcome'), ('after', 'operation'),
                 ('gap', 'wall')]
        for path in paths:
            values = deepcopy(self.good()); current = values[2]['proofs'][0]
            for key in path[:-1]:
                current = current[key]
            old = current[path[-1]]
            current[path[-1]] = False if old is not False else True
            with self.subTest(path=path):
                self.reject(values)
        for key in ('pid', 'birth', 'parent', 'firstObservedEpoch', 'lastObservedEpoch'):
            values = deepcopy(self.good()); values[0]['identities'][0][key] = {'pid': 70, 'birth': 90.} if key == 'parent' else None
            self.reject(values)

    def test_duplicate_orphan_extra_and_unassociated_proof_event_gap_rejected(self):
        for mutation in ('duplicate-proof', 'no-proof', 'no-gap', 'duplicate-gap', 'extra-event', 'missing-event', 'unassociated'):
            owner, diag, proof = deepcopy(self.good())
            if mutation == 'duplicate-proof': proof['proofs'] *= 2
            if mutation == 'no-proof': proof['proofs'] = []
            if mutation == 'no-gap': diag['gaps'] = []
            if mutation == 'duplicate-gap': diag['gaps'] *= 2
            if mutation == 'extra-event':
                event = deepcopy(diag['events'][0]); event['eventId'] = 2; diag['events'].append(event)
            if mutation == 'missing-event': diag['events'] = []
            if mutation == 'unassociated': diag['gaps'][0]['association'] = 'unassociated'
            with self.subTest(mutation=mutation): self.reject((owner, diag, proof))

    def test_diagnostic_integrity_and_coverage_rejected(self):
        for target, key, value in [('diag', 'failed', True), ('diag', 'dropped', 1), ('diag', 'gapsDropped', 1),
                ('diag', 'schemaVersion', True), ('diag', 'role', 'sample'), ('diag', 'scope', 'other'),
                ('proof', 'failed', True), ('proof', 'overflow', True), ('proof', 'version', True),
                ('proof', 'role', 'sample'), ('proof', 'scope', 'other'),
                ('owner', 'signals', [{'pid': 71}]), ('owner', 'allRecordedIdentitiesExited', False),
                ('owner', 'completeProcessTreeExitEstablished', True), ('owner', 'coverage', ['observation-unavailable'])]:
            values = deepcopy(self.good()); values[{'owner': 0, 'diag': 1, 'proof': 2}[target]][key] = value
            with self.subTest(target=target, key=key): self.reject(values)
        for key in ('events', 'gaps', 'contexts', 'counters'):
            values = deepcopy(self.good()); values[1]['overflow'][key] = True; self.reject(values)
        values = deepcopy(self.good()); values[0]['coverage'].append('parent-chain-unavailable'); self.reject(values)

    def test_numeric_clocks_nan_bool_missing_backwards_rejected(self):
        for point in ('before', 'error', 'after', 'gap'):
            for clock in ('wall', 'monotonic'):
                for value in (None, True, float('nan'), float('inf'), -1, 100):
                    values = deepcopy(self.good()); values[2]['proofs'][0][point][clock] = value
                    with self.subTest(point=point, clock=clock, value=value): self.reject(values)
                values = deepcopy(self.good()); del values[2]['proofs'][0][point][clock]; self.reject(values)
        for value in (True, float('nan'), -1, None):
            values = deepcopy(self.good()); values[2]['proofs'][0]['birth'] = value; self.reject(values)

    def test_exact_one_second_allowed_longer_rejected(self):
        for delta, allowed in ((1.0, True), (1.000001, False)):
            values = deepcopy(self.good()); proof = values[2]['proofs'][0]
            proof['before']['monotonic'] = 0
            proof['error']['monotonic'] = .2; values[1]['events'][0]['monotonic'] = .2
            proof['after']['monotonic'] = .4
            proof['gap']['monotonic'] = delta; values[1]['gaps'][0]['monotonic'] = delta
            if allowed: validate_terminal_coverage(*values)
            else: self.reject(values)

    def test_producer_bad_clocks_fail_closed(self):
        for value in (None, True, float('nan'), -1):
            case = Case(); case.clock.value = 0
            # Injected proof clocks are closed over these mutable callables.
            old_call = Clock.__call__
            try:
                Clock.__call__ = lambda self: value
                case.scan()
            finally:
                Clock.__call__ = old_call
            self.reject(case.finish_exited())

    def test_fourth_historical_shape_has_no_proof(self):
        owner, diag, proof = deepcopy(self.good())
        identity = owner['identities'][0]
        identity.update(pid=36482, birth=1792348652.844396, parent={'pid': 36476, 'birth': 1792348650.059264})
        diag['events'][0].update(scanId=457, eventId=1, pid=36482)
        diag['gaps'][0].update(scanId=457, eventId=1)
        proof['proofs'] = []
        for pid in range(6):
            item = deepcopy(identity); item['pid'] = 36490 + pid; owner['identities'].append(item)
        self.assertTrue(owner['allRecordedIdentitiesExited'])
        self.assertEqual(len(owner['identities']), 7)
        self.reject((owner, diag, proof))

    def test_worker_only_and_no_observation_on_construction(self):
        clock = Clock(); calls = []
        diag = Diagnostics(lambda pid: calls.append(pid), (NoSuchProcess, AccessDenied, OSError), 'worker', monotonic=clock, wall=clock)
        instrument_terminal_registry(load_registry(clock), diag, wall=clock, monotonic=clock)
        self.assertEqual(calls, []); self.assertEqual(clock.value, 10.)
        diag._role = 'sample'
        with self.assertRaises(TerminalCoverageError):
            instrument_terminal_registry(load_registry(clock), diag, wall=clock, monotonic=clock)


    def repeated_evidence(self, count):
        owner, diag, snapshot = deepcopy(self.good())
        identity = owner['identities'][0]; event = diag['events'][0]; gap = diag['gaps'][0]; proof = snapshot['proofs'][0]
        owner['identities'] = []; diag['events'] = []; diag['gaps'] = []; snapshot['proofs'] = []
        for index in range(count):
            pid = 71 + index
            item = deepcopy(identity); item['pid'] = pid; owner['identities'].append(item)
            e = deepcopy(event); e.update(eventId=index + 1, scanId=index + 1, pid=pid, wall=10, monotonic=10)
            g = deepcopy(gap); g.update(eventId=index + 1, scanId=index + 1, wall=10, monotonic=10)
            p = deepcopy(proof); p.update(proofId=index + 1, scanId=index + 1, eventId=index + 1, gapIndex=index, pid=pid)
            p['error']['pid'] = pid
            for point in ('before', 'error', 'after', 'gap'):
                p[point].update(wall=10, monotonic=10)
            diag['events'].append(e); diag['gaps'].append(g); snapshot['proofs'].append(p)
        return owner, diag, snapshot

    def boundary_evidence(self, byte_count):
        values = self.repeated_evidence(32)
        def size():
            return len(json.dumps(values[2], ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8'))
        # Exact JSON byte boundaries using finite provenance numbers, not ignored padding.
        for field in ('lastObservedEpoch', 'firstObservedEpoch'):
            for identity, proof in zip(values[0]['identities'], values[2]['proofs']):
                if size() >= byte_count:
                    break
                current_length = len(str(proof['provenance'][field]))
                extra = min(byte_count - size(), 300 - current_length)
                value = 10 ** (current_length + extra - 1)
                proof['provenance'][field] = value
                identity[field] = value
        self.assertEqual(size(), byte_count)
        return values

    def test_exact_snapshot_bytes_32768_allowed_32769_rejected(self):
        validate_terminal_coverage(*self.boundary_evidence(32768))
        self.reject(self.boundary_evidence(32769))

    def test_32_proofs_allowed_33_rejected_by_independent_consumer(self):
        self.assertEqual(validate_terminal_coverage(*self.repeated_evidence(32))['checkedProofs'], 32)
        self.reject(self.repeated_evidence(33))

    def test_producer_32_33_capacity_sticky_and_bounded(self):
        case = Case()
        for _ in range(32):
            case.after_observation = False; case.scan()
        self.assertEqual(len(case.registry.terminal_proof_snapshot()['proofs']), 32)
        validate_terminal_coverage(*case.finish_exited())
        case.final = False; case.after_observation = False; case.scan()
        snapshot = case.registry.terminal_proof_snapshot()
        self.assertTrue(snapshot['failed']); self.assertTrue(snapshot['overflow'])
        self.assertLessEqual(len(json.dumps(snapshot, separators=(',', ':')).encode()), 32768)
        self.reject(case.finish_exited())

    def test_producer_snapshot_byte_overflow_stays_failed(self):
        case = Case()
        # Huge but finite wall values enlarge the whole snapshot without new processes.
        original_call = Clock.__call__
        try:
            Clock.__call__ = lambda self: 10 ** 300
            for _ in range(32):
                case.after_observation = False; case.scan()
        finally:
            Clock.__call__ = original_call
        snapshot = case.registry.terminal_proof_snapshot()
        self.assertTrue(snapshot['failed']); self.assertTrue(snapshot['overflow'])
        self.assertLessEqual(len(json.dumps(snapshot, separators=(',', ':')).encode()), 32768)
        self.reject(case.finish_exited())

    def test_all_exact_schemas_and_limits_reject_extras_and_bool(self):
        for target in range(3):
            values = deepcopy(self.good())
            values[target]['extra'] = 0
            self.reject(values)
        for key in ('proofs', 'bytes', 'maxIntervalSeconds'):
            values = deepcopy(self.good()); values[2]['limits'][key] = True; self.reject(values)
        for key in ('events', 'gaps', 'contextDepth', 'counter'):
            values = deepcopy(self.good()); values[1]['limits'][key] = True; self.reject(values)
        for point in ('before', 'error', 'after', 'gap', 'provenance'):
            values = deepcopy(self.good()); values[2]['proofs'][0][point]['extra'] = None; self.reject(values)

    def test_before_missing_and_nested_attribution_rejected(self):
        for mode in ('missing', 'nested-state', 'nested-scan'):
            case = Case()
            def enter():
                if mode == 'missing':
                    case.registry._before = None
                elif mode == 'nested-state':
                    case.registry.state(71)
                else:
                    case.script['resolve'] = [NoSuchProcess(71)]
                    case.registry.scan()
                return case.process
            case.script['resolve'] = [case.process, enter]
            case.scan(); self.reject(case.finish_exited())

    def test_producer_interval_and_backward_wall_rejected(self):
        for jump in (2., -2.):
            case = Case(after='alive')
            def observe():
                case.clock.value += jump
                raise NoSuchProcess(71)
            case.script['resolve'] = [case.process, case.process, observe]
            case.scan(); self.reject(case.finish_exited())
            self.assertTrue(case.registry.terminal_proof_snapshot()['failed'])

    def test_final_status_each_identity_is_checked(self):
        for status in ('reused', 'unknown', 'alive'):
            values = deepcopy(self.good()); values[0]['identities'][0]['status'] = status
            # Deliberately keep aggregate true to prove consumer checks each row.
            self.reject(values)

    def test_gap_and_event_full_metadata_and_numbers_rejected(self):
        for pool, keys in (('gaps', ('scanId', 'eventId', 'role', 'stage', 'reason', 'association', 'wall', 'monotonic')),
                           ('events', ('scanId', 'eventId', 'role', 'stage', 'context', 'operation', 'pid', 'birth', 'exception', 'errno', 'wall', 'monotonic'))):
            for key in keys:
                values = deepcopy(self.good()); values[1][pool][0][key] = True
                with self.subTest(pool=pool, key=key): self.reject(values)


    def test_actual_cleanup_result_and_deadline_methods_inherited(self):
        original = Case(instrument=False); adapted = Case()
        for case in (original, adapted):
            case.final = True
            case.diag.set_stage('cleanup')
            case.registry.cleanup(grace=0, term_wait=0, kill_wait=0)
        self.assertEqual(original.calls, adapted.calls)
        self.assertEqual(original.signal_calls, adapted.signal_calls)
        self.assertEqual(original.registry.result(), adapted.registry.result())
        Registry = load_registry(Clock())
        # Both independently compiled AST classes preserve the exact original bytecode.
        for method in ('cleanup', 'observe_for', 'result'):
            self.assertEqual(getattr(type(adapted.registry), method).__code__.co_code,
                             getattr(Registry, method).__code__.co_code)
            self.assertNotIn(method, type(adapted.registry).__dict__)
        validate_terminal_coverage(*adapted.finish_exited())

    def test_successful_child_registration_process_call_parity(self):
        cases = [Case(instrument=False, children_error=False), Case(children_error=False)]
        for case in cases:
            class Child:
                pid = 72
                def create_time(self):
                    case.calls.append(('child-birth', 72)); return 110.
                def ppid(self):
                    case.calls.append(('child-ppid', 72)); return 71
            case.script['children'] = [[Child()]]
            # Child's own queued state exits, avoiding any invented child traversal.
            case.script['resolve'] = [case.process, case.process, case.process, case.process, NoSuchProcess(72)]
            case.scan()
            self.assertEqual(set(case.registry.entries), {71, 72})
        self.assertEqual(cases[0].calls, cases[1].calls)
        validate_terminal_coverage(*cases[1].finish_exited())

    def test_nested_without_children_candidate_is_not_global_veto(self):
        case = Case(children_error=False)
        def nested_birth():
            case.script['resolve'] = [AccessDenied()]
            self.assertEqual(case.registry.state(71), 'unknown')
            return 100.
        case.script['birth'] = [nested_birth]
        case.scan()
        self.assertFalse(case.registry.terminal_proof_snapshot()['failed'])
        validate_terminal_coverage(*case.finish_exited())

    def test_raw_original_events_gaps_and_coverage_match_exactly(self):
        cases = [Case(instrument=False), Case()]
        for case in cases:
            # Constant injected clocks make raw-byte equality meaningful.
            case.clock.value = 50.
        original_call = Clock.__call__
        try:
            Clock.__call__ = lambda self: 50.
            for case in cases:
                case.scan()
        finally:
            Clock.__call__ = original_call
        self.assertEqual(self.canonical(cases[0].diag.snapshot()), self.canonical(cases[1].diag.snapshot()))
        self.assertEqual(self.canonical(cases[0].registry.coverage), self.canonical(cases[1].registry.coverage))
        validate_terminal_coverage(*cases[1].finish_exited())

    def test_after_unsupported_and_wrong_named_exception_rejected(self):
        case = Case(after='alive')
        case.script['resolve'] = [case.process, case.process, RuntimeError('raw observation failed')]
        case.scan()
        self.assertEqual(case.diag.snapshot()['events'][0]['exception'], 'NoSuchProcess')
        self.reject(case.finish_exited())
        unrelated = type('NoSuchProcess', (Exception,), {'pid': 71})()
        case = Case(); case.error = unrelated
        with self.assertRaises(type(unrelated)) as caught:
            case.scan()
        self.assertIs(caught.exception, unrelated)
        self.reject(case.finish_exited())

    def test_global_proof_clock_regression_rejected(self):
        values = self.repeated_evidence(2)
        for point in ('before', 'error', 'after', 'gap'):
            values[2]['proofs'][1][point]['wall'] = 9
        values[1]['events'][1]['wall'] = 9; values[1]['gaps'][1]['wall'] = 9
        self.reject(values)

    def test_after_birth_status_numeric_schema_independently_checked(self):
        case = Case(after='zombie').scan()
        valid = case.finish_exited()
        for field in ('birth', 'birthAgain', 'status'):
            for value in (True, None, float('nan'), 'unknown'):
                values = deepcopy(valid); values[2]['proofs'][0]['after'][field] = value
                with self.subTest(field=field, value=value): self.reject(values)


    def test_producer_clock_callback_failure_preserves_original_exception_and_gap(self):
        case = Case()
        old_call = Clock.__call__
        try:
            def broken_clock(self):
                raise RuntimeError('clock unavailable')
            Clock.__call__ = broken_clock
            case.scan()
        finally:
            Clock.__call__ = old_call
        self.assertEqual(case.registry.coverage, ['observation-unavailable'])
        self.assertEqual(case.diag.snapshot()['events'][0]['exception'], 'NoSuchProcess')
        self.reject(case.finish_exited())

    def test_numeric_identity_parent_provenance_and_event_ids_not_bool(self):
        for container, key in (('proof', 'proofId'), ('proof', 'scanId'), ('proof', 'eventId'),
                               ('identity', 'pid'), ('identity', 'birth'),
                               ('identity', 'firstObservedEpoch'), ('identity', 'lastObservedEpoch')):
            values = deepcopy(self.good())
            target = values[2]['proofs'][0] if container == 'proof' else values[0]['identities'][0]
            target[key] = True
            self.reject(values)
        values = deepcopy(self.good())
        parent = {'pid': True, 'birth': 10}
        values[0]['identities'][0]['parent'] = parent
        values[2]['proofs'][0]['parent'] = deepcopy(parent)
        self.reject(values)

    def test_unknown_after_status_for_reused_identity_is_rejected(self):
        case = Case(after='alive')
        case.script['birth'] = [100., 200., 200.]
        case.script['status'] = ['running', 'unknown']
        case.scan()
        self.assertTrue(case.registry.terminal_proof_snapshot()['failed'])
        self.reject(case.finish_exited())


    def test_ownership_envelope_exact_original_schema(self):
        valid = self.good()
        self.assertEqual(set(valid[0]), {'identities', 'signals', 'allRecordedIdentitiesExited',
                                       'completeProcessTreeExitEstablished', 'coverage'})
        self.assertEqual(validate_terminal_coverage(*valid)['policy'], 'prospective-terminal-race-v1')
        extra = deepcopy(valid)
        extra[0]['unexpectedSchemaField'] = {'invalid': True}
        with self.subTest(extra='unexpectedSchemaField'):
            self.reject(extra)
        for field in valid[0]:
            missing = deepcopy(valid)
            del missing[0][field]
            with self.subTest(missing=field):
                self.reject(missing)


    def test_cache_faithful_birth_change_during_status_is_rejected(self):
        for candidate in ('zombie', 'reused'):
            with self.subTest(candidate=candidate):
                case = CachedCase(candidate=candidate, mutate=True).scan()
                owner, diag, proof = case.finish_exited()
                self.assertTrue(owner['allRecordedIdentitiesExited'])
                self.assertEqual(owner['identities'][0]['status'], 'exited')
                self.assertEqual(case.backend_birth, 30.)
                # This is the actual producer + consumer; final reused cannot mask failure.
                self.reject((owner, diag, proof))
                self.assertTrue(proof['failed'])
                self.assertEqual(case.backend_birth_reads[-2:], [20., 30.])
                self.assertEqual(len(case.after_handles), 2)
                self.assertIsNot(case.after_handles[0], case.after_handles[1])

    def test_cache_faithful_same_factory_handle_rejected(self):
        case = CachedCase(candidate='zombie', mutate=False, same_handle=True).scan()
        owner, diag, proof = case.finish_exited()
        self.assertTrue(owner['allRecordedIdentitiesExited'])
        self.reject((owner, diag, proof))
        self.assertTrue(proof['failed'])


    def test_cache_faithful_stable_zombie_and_reused_positive(self):
        for candidate, outcome in (('zombie', 'same-birth-zombie'), ('reused', 'stable-reused')):
            with self.subTest(candidate=candidate):
                case = CachedCase(candidate=candidate, mutate=False).scan()
                values = case.finish_exited()
                self.assertEqual(validate_terminal_coverage(*values)['checkedProofs'], 1)
                after = values[2]['proofs'][0]['after']
                self.assertEqual(after['outcome'], outcome)
                self.assertEqual(after['birth'], 20.)
                self.assertEqual(after['birthAgain'], 20.)
                self.assertEqual(len(case.after_handles), 2)
                self.assertIsNot(case.after_handles[0], case.after_handles[1])
                self.assertEqual(case.backend_birth_reads[-2:], [20., 20.])
                self.assertEqual(case.signal_calls, [])

    def test_present_adds_exact_two_same_pid_resolves_two_birth_one_status(self):
        original = Case(instrument=False, after='zombie').scan()
        adapted = Case(after='zombie').scan()
        self.assertEqual(adapted.calls, original.calls + [
            ('resolve', 71), ('birth', 71), ('status', 71), ('resolve', 71), ('birth', 71)])
        validate_terminal_coverage(*adapted.finish_exited())
        # The separate absent ledger enforces one resolve and no birth/status.

    def test_second_handle_resolve_errors_do_not_become_absent(self):
        for error in (NoSuchProcess(71), AccessDenied(), OSError(), RuntimeError('unsupported')):
            with self.subTest(error=type(error).__name__):
                case = Case(after='zombie')
                case.script['resolve'] = [case.process, case.process, Process(case), error]
                case.scan()
                values = case.finish_exited()
                self.assertEqual(values[2]['proofs'], [])
                self.assertTrue(values[2]['failed'])
                self.assertEqual(values[1]['events'][0]['operation'], 'children')
                self.assertEqual(len(values[1]['events']), 1)
                self.assertEqual(values[1]['gaps'][0]['eventId'], values[1]['events'][0]['eventId'])
                self.reject(values)
                self.assertEqual(case.calls, [('birth', 71), ('resolve', 71), ('birth', 71),
                    ('status', 71), ('resolve', 71), ('children', 71), ('resolve', 71),
                    ('birth', 71), ('status', 71), ('resolve', 71), ('resolve', 71)])

    def test_second_handle_birth_errors_unknown_and_change_rejected(self):
        for value in (NoSuchProcess(71), AccessDenied(), OSError(), RuntimeError('unsupported'),
                      None, True, float('nan'), float('inf'), 0., 30.):
            with self.subTest(value=value):
                case = Case(after='zombie')
                case.script['birth'] = [100., 100., value]
                case.scan()
                values = case.finish_exited()
                self.assertTrue(values[0]['allRecordedIdentitiesExited'])
                self.assertEqual(values[2]['proofs'], [])
                self.assertTrue(values[2]['failed'])
                self.assertEqual(len(values[1]['events']), 1)
                self.assertEqual(len(values[1]['gaps']), 1)
                self.reject(values)


if __name__ == '__main__':
    unittest.main()
