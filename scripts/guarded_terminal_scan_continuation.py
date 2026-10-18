#!/usr/bin/env python3
"""Sealed, prospective R5 continuation. Import and no-argument CLI never run a scenario.

IO adapters are trusted boundaries, not acceptance policy. read_file(path, limit)
returns (bytes, mode) after regular-file/no-symlink/owner checks; read_record(ref)
returns bytes, which this module independently hashes. observe_known returns a
bounded identity/idle observation. Production adapters are constructed only by CLI.
The unchanged R4 main is rebound with exactly three narrow globals in a private
namespace. Its complete legacy gate chain remains mandatory in production.
"""
import argparse
import ast
import builtins
import contextlib
import hashlib
import io as stringio
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time
import types

from terminal_scan_proof import instrument_terminal_registry, validate_terminal_coverage

R4 = Path('/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm')
MANIFEST_SHA = 'bcd09baaa0b0936e7424cd0dea5e51fb067503399ca49d3a236e789fc0fa6861'
SUP = '/tmp/wrd-owned-turn-probe-private/supervisor.py'
SUP_SHA = 'd03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b'
PASSIVE = '/Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/passive_session_soak.py'
PASSIVE_SHA = 'b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426'
FAILURES = [
    '2f0f2a2a0774b15f8b62adef72bb997d5deeae298a06640e71583d2d3cd33242',
    'af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6',
    '5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9',
    '5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd',
]
RELOAD_SHA = 'ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f'
READY_SHA = '1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c'
DEPLOYMENT = R4 / 'deployment-1a71096791fb71844ae08c95c50fb9cc'
FOURTH = R4 / 'sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550'
PINS = {'sourceTIP': '41c7b0998859a7e9d088cefcc0f3a1eeab190684',
        'viewerSourceTIP': 'fefc555aea9640b563bfd22f5b36b6b8ca6365ec',
        'deployedToolTIP': '2822441791b59a021556c7e4eb24715df9d5b277',
        'productTIP': 'dfb15434e79da90b803b763c533836e16c080c71'}
SCENARIOS = ('baseline', 'within-grace', 'after-grace', 'continuity')
BUDGET = (300, 390, 390, 10800)
ENTRY = 'ordinary-continuation-supervisor'
CODE_FILES = ('scripts/guarded_terminal_scan_continuation.py', 'scripts/terminal_scan_proof.py')
_RUN_LOCK = threading.Lock()


def need(value, message):
    if not value:
        raise RuntimeError(message)


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'exact schema required')


def compact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value, length=64):
    need(type(value) is str and re.fullmatch('[0-9a-f]{%d}' % length, value) is not None, 'invalid digest/identity')


def number(value, positive=False):
    need(type(value) in (int, float) and math.isfinite(value) and (value > 0 if positive else value >= 0), 'finite clock/identity required')


def pairs(rows):
    result = {}
    for key, value in rows:
        need(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def loads(data, limit=1048576):
    need(type(data) is bytes and len(data) <= limit, 'bounded record bytes required')
    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: need(False, 'nonfinite JSON'))
        compact(value)
        return value
    except (ValueError, TypeError, RecursionError) as error:
        raise RuntimeError('invalid bounded JSON') from error


def reference(value):
    exact(value, ('path', 'sha256'))
    digest(value['sha256'])
    need(type(value['path']) is str and len(value['path'].encode()) <= 1024
         and Path(value['path']).is_absolute() and '..' not in Path(value['path']).parts, 'absolute bounded reference required')
    return value


def read_ref(ref, read_record):
    reference(ref)
    data = read_record(ref)
    need(type(data) is bytes and sha(data) == ref['sha256'], 'record SHA drift')
    return loads(data)


def _clock_window(start, end, maximum=60):
    exact(start, ('wall', 'monotonic')); exact(end, ('wall', 'monotonic'))
    for key in start:
        number(start[key]); number(end[key])
        need(0 <= end[key] - start[key] <= maximum, 'stale admission or clock reversal')


def point(wall, monotonic):
    value = {'wall': wall(), 'monotonic': monotonic()}
    _clock_window(value, value)
    return value


def _checked(io, path, expected, mode=0o600, limit=1048576):
    digest(expected)
    data, actual_mode = io.read_file(str(path), limit)
    need(type(data) is bytes and len(data) <= limit and actual_mode == mode and sha(data) == expected,
         'sealed dependency bytes/mode drift')
    return data


def load_sealed_r4(dependency_seal, *, io):
    """Compile original bytes in an isolated graph; never mutate sys.path/modules.

    Custom per-module builtins handle bare imports, including imports inside
    function bodies. No shared R4 module is ever patched or reused. AST is used
    only to discover imports; original complete source bytes are compiled intact.
    """
    seal = dependency_seal
    exact(seal, ('root', 'manifestSHA256', 'files', 'supervisor', 'passive'))
    need(seal['root'] == str(R4) and seal['manifestSHA256'] == MANIFEST_SHA, 'fixed R4 root/manifest required')
    io.check_directory(str(R4), 0o700)
    manifest = loads(_checked(io, R4/'SHA256SUMS.json', MANIFEST_SHA))
    need(type(manifest) is dict and 1 <= len(manifest) <= 64, 'package manifest bound')
    sources = {}
    # Verify the entire original manifest before any package code executes.
    for name, expected in manifest.items():
        need(type(name) is str and Path(name).name == name and name not in ('.', '..'), 'manifest path')
        data = _checked(io, R4/name, expected, limit=32*1024*1024)
        if name.endswith('.py'):
            sources[name[:-3]] = data
    closure = set()
    def discover(name):
        if name in closure:
            return
        need(name in sources, 'missing import dependency')
        closure.add(name)
        for node in ast.walk(ast.parse(sources[name], filename=str(R4/(name+'.py')))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                need(node.level == 0, 'unexpected relative import')
                names = [node.module]
            else:
                continue
            for imported in names:
                if imported in sources:
                    discover(imported)
    for name in (ENTRY, 'readiness_records', 'owned_reload'):
        discover(name)
    expected_files = {name+'.py': {'sha256': manifest[name+'.py'], 'mode': 0o600} for name in sorted(closure)}
    need(seal['files'] == expected_files, 'exact transitive import closure required')
    for key, path, expected in (('supervisor', SUP, SUP_SHA), ('passive', PASSIVE, PASSIVE_SHA)):
        exact(seal[key], ('path', 'sha256', 'mode'))
        need(seal[key]['path'] == path and seal[key]['sha256'] == expected
             and type(seal[key]['mode']) is int and seal[key]['mode'] in (0o600, 0o644, 0o755), 'external definition pin')
        _checked(io, path, expected, seal[key]['mode'])
    need(not (set(sources) & set(sys.modules)), 'foreign cached package module')
    modules = {}
    importing = set()
    def private_import(name, globals=None, locals=None, fromlist=(), level=0):
        need(level == 0, 'relative import outside closure')
        if name in sources:
            need(name in closure and name not in sys.modules, 'unsealed or polluted import')
            return load(name)
        return builtins.__import__(name, globals, locals, fromlist, level)
    def load(name):
        if name in modules:
            need(name not in importing, 'circular private import')
            return modules[name]
        module = types.ModuleType('_r5_private_' + name)
        module.__file__ = str(R4/(name+'.py'))
        module.__dict__['__builtins__'] = dict(vars(builtins), __import__=private_import)
        modules[name] = module; importing.add(name)
        try:
            exec(compile(sources[name], module.__file__, 'exec'), module.__dict__)
        finally:
            importing.remove(name)
        need(module.__file__ == str(R4/(name+'.py')) and sha(sources[name]) == manifest[name+'.py'], 'actual imported source drift')
        return module
    original = load(ENTRY)
    for name in sorted(closure):
        load(name)
    common = modules['continuation_common']
    need(original.R == R4 and all(getattr(original, name) is getattr(common, name)
         for name in ('attempt_context', 'ready_context', 'current_gate', 'source_pins')), 'original gate identity')
    return types.SimpleNamespace(original=original, modules=modules, seal=seal)


def _identity(row):
    need(type(row) is dict and type(row.get('pid')) is int and row['pid'] > 0, 'positive PID required')
    number(row.get('birth'), True)
    return (row['pid'], row['birth'])


def validate_r5_history(history_record, *, read_record):
    """Verify immutable failure lineage and derive, never manufacture, the union."""
    h = history_record
    exact(h, ('schemaVersion', 'failures', 'reload', 'knownIdentities'))
    need(type(h['schemaVersion']) is int and h['schemaVersion'] == 1
         and type(h['failures']) is list and len(h['failures']) == 4, 'four ordered failures required')
    manifest = read_ref({'path': str(R4/'SHA256SUMS.json'), 'sha256': MANIFEST_SHA}, read_record)
    def package_json(name):
        return read_ref({'path': str(R4/name), 'sha256': manifest[name]}, read_record)
    base = package_json('legacy-deployed-reference.json')['historical']
    second = package_json('legacy-tool-history.json')['records']
    third = package_json('deployment-history.json')['records']
    expected_results = [base['oldFailure'], second['secondFailure'], third['thirdFailure'],
                        {'path': str(FOURTH/'qualification-result.json'), 'sha256': FAILURES[3]}]
    identities = {}; pid_births = {}; deny = set(); groups = []
    def add_owner(owner, source, role):
        need(type(owner) is dict and type(owner.get('identities')) is list and len(owner['identities']) <= 128, 'bounded ownership history')
        added = set()
        for row in owner['identities']:
            key = _identity(row)
            need(row.get('status') == 'exited', 'historical identity not closed')
            parent = row.get('parent')
            if parent is not None:
                exact(parent, ('pid', 'birth')); _identity(parent)
            for field in ('firstObservedEpoch', 'lastObservedEpoch'):
                number(row.get(field))
            need(row['firstObservedEpoch'] <= row['lastObservedEpoch'], 'identity provenance clock')
            metadata = {name: row[name] for name in ('parent', 'firstObservedEpoch', 'lastObservedEpoch')}
            need(row['pid'] not in pid_births or pid_births[row['pid']] == row['birth'], 'conflicting historical PID/birth')
            pid_births[row['pid']] = row['birth']
            if key in identities:
                need({name: identities[key][name] for name in metadata} == metadata, 'conflicting identity provenance')
            else:
                identities[key] = {'pid': key[0], 'birth': key[1], **metadata, 'sources': []}
            provenance = {'resultSHA256': source, 'role': role}
            need(provenance not in identities[key]['sources'], 'duplicate ownership identity')
            identities[key]['sources'].append(provenance); added.add(key)
        return added
    for index, chain in enumerate(h['failures']):
        names = ('frozen', 'sourcePins', 'started', 'runtime', 'result') if index == 0 else ('sequence', 'attempt', 'started', 'runtime', 'result')
        exact(chain, names)
        need(chain['result'] == expected_results[index] and chain['result']['sha256'] == FAILURES[index], 'ordered pinned failure required')
        records = {name: read_ref(chain[name], read_record) for name in names}
        result, started, runtime = (records[name] for name in ('result', 'started', 'runtime'))
        need(result['classification'] == 'failed-or-indeterminate' and result['fullProcessTreeExit'] == 'unknown'
             and started['oneUse'] is True, 'failure classification preserved')
        need(started['runtimeManifestSHA256'] == result['runtimeManifestSHA256'] == chain['runtime']['sha256'], 'runtime lineage')
        digest(runtime['runNonce'], 32); deny.add(runtime['runNonce'])
        folder = Path(chain['result']['path']).parent
        if index == 0:
            need(chain['started'] == base['oldMarker'] and chain['runtime'] == base['oldRuntimeManifest']
                 and chain['frozen'] == base['frozen'], 'first historical variant references')
            for name in ('frozen', 'sourcePins'):
                need(started[name+'SHA256'] == result[name+'SHA256'] == chain[name]['sha256'], 'first frozen/source lineage')
            need(Path(chain['sourcePins']['path']) == folder/'baseline-source-pins.json', 'first source pins path')
        else:
            attempt, sequence = records['attempt'], records['sequence']
            need(started['attemptSHA256'] == result['attemptSHA256'] == chain['attempt']['sha256']
                 and attempt['sequenceSHA256'] == chain['sequence']['sha256'], 'attempt/sequence lineage')
            for key in ('sequenceId', 'attemptId', 'runtimeManifestSHA256', 'productTIP', 'toolTIP'):
                need(started[key] == result[key] == attempt[key], 'started/result/attempt binding')
            for key in ('sequenceId', 'attemptId', 'runNonce'):
                digest(attempt[key], 32); deny.add(attempt[key])
            need(sequence['sequenceId'] == attempt['sequenceId'] and runtime['runNonce'] == attempt['runNonce'], 'sequence/nonce lineage')
            need(Path(chain['sequence']['path']) == Path(attempt['sequenceDirectory'])/'sequence.json'
                 and folder == Path(attempt['sequenceDirectory'])/'attempts'/attempt['attemptId'], 'historical attempt location')
            for name, filename in (('attempt','attempt.json'), ('started','qualification-started.json'), ('runtime','runtime-manifest.json')):
                need(Path(chain[name]['path']) == folder/filename, 'historical chain location')
            need(result['priorFailureSHA256'] == FAILURES[index-1], 'immediate legacy failure')
            if index >= 2:
                need(result['failedHistory'] == FAILURES[:index], 'legacy failed history preserved')
        group = set()
        for role, key in (('worker', 'owned'), ('sample', 'sampleOwned')):
            group |= add_owner(result[key], FAILURES[index], role)
        need(len(group) == 7, 'seven failed-attempt identities required'); groups.append(group)
    reload_chain = h['reload']
    exact(reload_chain, ('started', 'result', 'readinessStarted', 'readiness'))
    for name, filename, pin in (('result','reload-result.json',RELOAD_SHA), ('readiness','readiness-result.json',READY_SHA)):
        need(reload_chain[name] == {'path': str(DEPLOYMENT/filename), 'sha256': pin}, 'pinned reload/readiness')
    records = {key: read_ref(value, read_record) for key,value in reload_chain.items()}
    reload, started, ready, ready_started = (records[key] for key in ('result','started','readiness','readinessStarted'))
    need(reload['classification'] == 'failed-or-indeterminate' and reload['helper']['lifecycleAcceptable'] is False
         and reload['startedSHA256'] == reload_chain['started']['sha256']
         and ready['startedSHA256'] == reload_chain['readinessStarted']['sha256']
         and ready['reloadSHA256'] == RELOAD_SHA and ready['classification'] == 'runtime-ready-observed'
         and ready['reloadClassificationPreserved'] == reload['classification']
         and ready['helperLifecycleAcceptable'] is False, 'reload FAIL preserved/readiness lineage')
    need(Path(reload_chain['started']['path']) == DEPLOYMENT/'reload-started.json'
         and Path(reload_chain['readinessStarted']['path']) == DEPLOYMENT/'readiness-started.json', 'reload marker location')
    for key in ('frozenSHA256', 'assetReviewSHA256'):
        need(reload[key] == started[key] == ready[key], 'reload/readiness common lineage')
    need(ready_started['frozenSHA256'] == ready['frozenSHA256'] and ready_started['reloadSHA256'] == RELOAD_SHA
         and ready_started['readOnly'] is True, 'readiness started lineage')
    need(started['oneUse'] is True
         and reload['applySHA256'] == started['applySHA256'] and reload['newIdentity'] == ready['newIdentity'], 'reload marker/runtime binding')
    for key in ('assets','identities','sourceTIP','frozenSHA256','componentPins'):
        need(reload['runtimeValidation'][key] == ready['runtimeValidation'][key], 'reload/readiness runtime mismatch')
    helper = reload['helper']; owner = helper['ownership']
    need(helper['exitCode'] == 0 and helper['timedOut'] is False and helper['unexpectedCoverage'] == ['observation-unavailable']
         and all(helper[key] is None for key in ('errorClass','cleanupErrorClass','ownershipErrorClass'))
         and owner['signals'] == [] and owner['allRecordedIdentitiesExited'] is True
         and owner['completeProcessTreeExitEstablished'] is False, 'helper readiness-only closure')
    helpers = add_owner(owner, RELOAD_SHA, 'reload-helper')
    need(len(set.union(*groups[:3])) == 21 and len(helpers) == 6 and len(identities) == 34, 'exact 21+7+6 history union')
    known = sorted(identities.values(), key=lambda row: (row['pid'], row['birth']))
    need(h['knownIdentities'] == known, 'exact known identity/provenance union required')
    return {'knownIdentities': known, 'deniedIds': sorted(deny), 'historySHA256': sha(compact(h)),
            'failedHistory': list(FAILURES), 'services': ready['newIdentity'], 'record': h}


def _check_observation(value, known, services, start, wall, monotonic):
    exact(value, ('started', 'finished', 'identities', 'idle', 'services'))
    _clock_window(start, value['started']); _clock_window(value['started'], value['finished'])
    need(value['services'] == services, 'protected service identity drift')
    idle = value['idle']; exact(idle, ('viewerCount','relayViewerCount','lsofTimeoutSeconds'))
    need(type(idle['viewerCount']) is int and idle['viewerCount'] == 0
         and type(idle['relayViewerCount']) is int and idle['relayViewerCount'] == 0
         and type(idle['lsofTimeoutSeconds']) is int and idle['lsofTimeoutSeconds'] == 5, 'strict idle/5s listener bound')
    need(type(value['identities']) is list and len(value['identities']) == len(known), 'complete fresh known list')
    previous = value['started']
    for expected, observed in zip(known, value['identities']):
        exact(observed, ('identity','outcome','birth','birthAgain','status','started','finished'))
        need(observed['identity'] == expected, 'same known identity/provenance list required')
        _clock_window(previous, observed['started']); _clock_window(observed['started'], observed['finished'])
        previous = observed['finished']
        _clock_window(observed['finished'], value['finished'])
        if observed['outcome'] == 'gone':
            need(observed['birth'] is None and observed['birthAgain'] is None and observed['status'] is None, 'gone observation')
        else:
            number(observed['birth'], True); number(observed['birthAgain'], True)
            need(observed['birth'] == observed['birthAgain'] and type(observed['status']) is str, 'stable observed identity')
            if observed['outcome'] == 'zombie':
                need(observed['birth'] == expected['birth'] and observed['status'] == 'zombie', 'same birth zombie')
            else:
                need(observed['outcome'] == 'stable-nonmatching' and observed['birth'] != expected['birth']
                     and observed['status'] in ('running','sleeping','disk-sleep','stopped','tracing-stop','zombie','idle','locked','waiting','waking','wake-kill','parked'), 'old known identity not quiescent')
    end = point(wall, monotonic)
    _clock_window(value['finished'], end); _clock_window(start, end)
    return end


ATTEMPT_KEYS = ('schemaVersion','kind','rootDirectory','sequenceId','attemptId','runNonce','scenario','legacyAttempt',
                'history','dependencySeal','codePins','rootDecision','previousResult','immediatePriorFailureSHA256','deployedPins')
DECISION_KEYS = ('schemaVersion','kind','rootDirectory','sequenceId','attemptId','runNonce','scenario','legacyAttempt','historySHA256',
                 'dependencySealSHA256','codePins','previousResult','immediatePriorFailureSHA256','deployedPins','issued','automaticLaunch')


def validate_r5_admission(r5_attempt, legacy_context, history, *, observation, wall, monotonic):
    a = r5_attempt; exact(a, ATTEMPT_KEYS)
    need(type(a['schemaVersion']) is int and a['schemaVersion'] == 1 and a['kind'] == 'r5-terminal-scan-attempt', 'outer attempt kind')
    need(a['deployedPins'] == PINS and a['immediatePriorFailureSHA256'] == FAILURES[3], 'deployed/immediate failure pins')
    ids = [a[key] for key in ('sequenceId','attemptId','runNonce')]
    for value in ids:
        digest(value, 32)
        need(value not in history['deniedIds'], 'historical identity reuse')
    need(len(set(ids)) == 3 and a['scenario'] in SCENARIOS, 'distinct fresh IDs/scenario')
    root = Path(a['rootDirectory'])
    need(root.is_absolute() and '..' not in root.parts and root != R4 and R4 not in root.parents, 'separate outer root required')
    exact(a['codePins'], ('supervisorSourceTIP','files'))
    digest(a['codePins']['supervisorSourceTIP'], 40)
    need(a['codePins']['supervisorSourceTIP'] not in PINS.values() and set(a['codePins']['files']) == set(CODE_FILES), 'distinct supervisor source pins')
    for value in a['codePins']['files'].values():
        digest(value)
    folder, sequence, ref, pins, runtime = legacy_context
    reference(a['legacyAttempt'])
    need(Path(a['legacyAttempt']['path']) == Path(folder)/'attempt.json'
         and Path(folder) == R4/('sequence-'+a['sequenceId'])/'attempts'/a['attemptId'], 'new legacy attempt location')
    for key in ('sequenceId','attemptId','runNonce','scenario'):
        need(pins[key] == a[key], 'real legacy return/outer binding')
    need(sequence['sequenceId'] == a['sequenceId'] and sequence['failedHistory'] == pins['failedHistory'] == FAILURES[:3]
         and pins['priorFailureSHA256'] == FAILURES[2] and pins['sourceTIP'] == sequence['sourceTIP'] == PINS['sourceTIP']
         and pins['toolTIP'] == PINS['deployedToolTIP'] and pins['productTIP'] == PINS['productTIP']
         and pins['readinessSHA256'] == sequence['readinessSHA256'] == READY_SHA
         and runtime['runNonce'] == a['runNonce'] and ref['expectedServices'] == history['services'], 'legacy history/deployment binding')
    legacy_decision = read_ref(pins['decision'], observation.read_record)
    need(legacy_decision['previousResult'] == pins.get('previousResult', legacy_decision['previousResult']), 'legacy predecessor drift')
    decision = read_ref(a['rootDecision'], observation.read_record); exact(decision, DECISION_KEYS)
    for key in ('rootDirectory','sequenceId','attemptId','runNonce','scenario','legacyAttempt','codePins','previousResult','immediatePriorFailureSHA256','deployedPins'):
        need(decision[key] == a[key], 'root decision binding')
    need(type(decision['schemaVersion']) is int and decision['schemaVersion'] == 1
         and decision['kind'] == 'root-r5-one-scenario' and decision['automaticLaunch'] is False
         and decision['historySHA256'] == history['historySHA256']
         and read_ref(a['history'], observation.read_record) == history['record']
         and decision['dependencySealSHA256'] == sha(compact(a['dependencySeal'])), 'root decision history/seal binding')
    index = SCENARIOS.index(a['scenario'])
    if index == 0:
        need(a['previousResult'] is None and legacy_decision['previousResult'] is None, 'new baseline requires null predecessors')
    else:
        _validate_predecessors(a, history, observation, legacy_decision['previousResult'], index)
    now = point(wall, monotonic); _clock_window(decision['issued'], now)
    fresh = observation(history['knownIdentities'], history['services'])
    end = _check_observation(fresh, history['knownIdentities'], history['services'], now, wall, monotonic)
    _clock_window(decision['issued'], end)
    return {'decisionSHA256': a['rootDecision']['sha256'], 'checkedAt': end, 'knownIdentitiesSHA256': sha(compact(history['knownIdentities'])), 'observation': fresh}


RESULT_KEYS = ('schemaVersion','kind','classification','sequenceId','attemptId','runNonce','scenario','attemptSHA256',
               'startedSHA256','history','historySHA256','failedHistory','codePins','dependencySealSHA256','rootDecision',
               'legacyResult','proof','coverageAssessment','fullProcessTreeExit','completeProcessTreeExitEstablished',
               'errorClass','automaticNextRun','policy','startupAdmission')


STARTED_KEYS = ('schemaVersion','kind','attemptSHA256','sequenceId','attemptId','runNonce','rootDecision','admission','oneUse')


def _validate_legacy_marker(value, attempt, runtime_sha):
    """Pure validation shared by final-source and historical predecessor checks."""
    exact(value, ('attemptSHA256','sequenceId','attemptId','productTIP','toolTIP','priorFailureSHA256','sourceTIP',
                  'viewerSourceTIP','failedHistory','runtimeManifestSHA256','scenario','epoch','outputDirectory','oneUse'))
    need(value['productTIP'] == PINS['productTIP'] and value['toolTIP'] == PINS['deployedToolTIP']
         and value['sourceTIP'] == PINS['sourceTIP'] and value['viewerSourceTIP'] == PINS['viewerSourceTIP']
         and value['failedHistory'] == FAILURES[:3] and value['priorFailureSHA256'] == FAILURES[2], 'legacy marker source/history')
    for key in ('attemptId','sequenceId','scenario'):
        need(value[key] == attempt[key], 'legacy marker ownership/scenario')
    need(value['attemptSHA256'] == attempt['legacyAttempt']['sha256'] and value['oneUse'] is True
         and value['runtimeManifestSHA256'] == runtime_sha, 'legacy marker binding')
    number(value['epoch'])
    output = Path(value['outputDirectory'])
    need(output.parent == Path(attempt['legacyAttempt']['path']).parent
         and output.name.startswith('ordinary-'+attempt['scenario']+'-'), 'legacy output marker location')


def _validate_predecessors(attempt, history, observation, legacy_reference, count):
    """Bounded walk to the new baseline; no stale admission is replayed."""
    ref = attempt['previousResult']; used = {attempt[key] for key in ('sequenceId','attemptId','runNonce')}
    for index in range(count-1, -1, -1):
        previous = read_ref(ref, observation.read_record); exact(previous, RESULT_KEYS)
        need(type(previous['schemaVersion']) is int and previous['schemaVersion'] == 1
             and previous['kind'] == 'r5-terminal-scan-result' and previous['classification'] == 'observed-qualification-completed'
             and previous['sequenceId'] == attempt['sequenceId'] and previous['scenario'] == SCENARIOS[index]
             and previous['history'] == attempt['history'] and previous['historySHA256'] == history['historySHA256']
             and previous['failedHistory'] == FAILURES and previous['codePins'] == attempt['codePins']
             and previous['dependencySealSHA256'] == sha(compact(attempt['dependencySeal']))
             and previous['fullProcessTreeExit'] == 'unknown' and previous['completeProcessTreeExitEstablished'] is False
             and previous['automaticNextRun'] is False and previous['errorClass'] is None
             and previous['policy'] == 'prospective-terminal-race-v1', 'same sequence complete R5 predecessor required')
        for key in ('attemptId','runNonce'):
            digest(previous[key],32)
            need(previous[key] not in used and previous[key] not in history['deniedIds'], 'predecessor identity reuse')
            used.add(previous[key])
        folder = Path(attempt['rootDirectory'])/attempt['sequenceId']/previous['attemptId']
        need(Path(ref['path']) == folder/'r5-result.json', 'outer predecessor location')
        prior_attempt = read_ref({'path':str(folder/'r5-attempt.json'),'sha256':previous['attemptSHA256']}, observation.read_record)
        exact(prior_attempt, ATTEMPT_KEYS)
        need(type(prior_attempt['schemaVersion']) is int and prior_attempt['schemaVersion'] == 1
             and prior_attempt['kind'] == 'r5-terminal-scan-attempt'
             and prior_attempt['scenario'] == SCENARIOS[index], 'predecessor attempt kind/version/scenario')
        started = read_ref({'path':str(folder/'r5-started.json'),'sha256':previous['startedSHA256']}, observation.read_record)
        exact(started, STARTED_KEYS)
        need(type(started['schemaVersion']) is int and started['schemaVersion'] == 1
             and started['kind'] == 'r5-terminal-scan-started', 'predecessor started kind/version')
        for key in ('sequenceId','attemptId','runNonce'):
            need(previous[key] == prior_attempt[key] == started[key], 'predecessor one-use identities')
        need(started['oneUse'] is True and started['attemptSHA256'] == previous['attemptSHA256']
             and started['rootDecision'] == previous['rootDecision'] == prior_attempt['rootDecision']
             and prior_attempt['rootDirectory'] == attempt['rootDirectory']
             and prior_attempt['history'] == attempt['history'] and prior_attempt['dependencySeal'] == attempt['dependencySeal']
             and prior_attempt['codePins'] == attempt['codePins'], 'predecessor attempt/marker binding')
        decision = read_ref(prior_attempt['rootDecision'], observation.read_record); exact(decision, DECISION_KEYS)
        for key in ('rootDirectory','sequenceId','attemptId','runNonce','scenario','legacyAttempt','codePins','previousResult',
                    'immediatePriorFailureSHA256','deployedPins'):
            need(decision[key] == prior_attempt[key], 'predecessor decision binding')
        need(type(decision['schemaVersion']) is int and decision['schemaVersion'] == 1
             and decision['kind'] == 'root-r5-one-scenario' and decision['automaticLaunch'] is False
             and decision['historySHA256'] == history['historySHA256']
             and decision['dependencySealSHA256'] == sha(compact(attempt['dependencySeal']))
             and decision['deployedPins'] == PINS and decision['immediatePriorFailureSHA256'] == FAILURES[3], 'predecessor root authorization')
        for admission in (started['admission'], previous['startupAdmission']):
            exact(admission, ('decisionSHA256','checkedAt','knownIdentitiesSHA256','observation'))
            need(admission['decisionSHA256'] == previous['rootDecision']['sha256']
                 and admission['knownIdentitiesSHA256'] == sha(compact(history['knownIdentities'])), 'predecessor fresh known binding')
            _clock_window(decision['issued'], admission['checkedAt'])
            _check_observation(admission['observation'], history['knownIdentities'], history['services'],
                               admission['observation']['started'], lambda:admission['checkedAt']['wall'],
                               lambda:admission['checkedAt']['monotonic'])
        need(previous['legacyResult'] == legacy_reference, 'dual predecessor reference')
        legacy = read_ref(legacy_reference, observation.read_record)
        need(legacy['classification'] == 'observed-qualification-completed' and legacy['sequenceId'] == attempt['sequenceId']
             and legacy['attemptId'] == previous['attemptId'] and legacy['scenario'] == SCENARIOS[index]
             and legacy['attemptSHA256'] == prior_attempt['legacyAttempt']['sha256'], 'same sequence legacy predecessor')
        proof = read_ref(previous['proof'], observation.read_record)
        need(Path(previous['proof']['path']) == folder/'terminal-proof.json'
             and validate_terminal_coverage(legacy['owned'],legacy['processDiagnostics']['worker'],proof) == previous['coverageAssessment'],
             'predecessor proof/assessment binding')
        observation.legacy.validate_owned_coverage(legacy['sampleOwned'])
        legacy_folder = R4/('sequence-'+attempt['sequenceId'])/'attempts'/previous['attemptId']
        need(Path(prior_attempt['legacyAttempt']['path']) == legacy_folder/'attempt.json'
             and Path(legacy_reference['path']) == legacy_folder/'qualification-result.json', 'predecessor legacy record locations')
        legacy_attempt = read_ref(prior_attempt['legacyAttempt'], observation.read_record)
        for key in ('sequenceId','attemptId','runNonce','scenario'):
            need(legacy_attempt[key] == prior_attempt[key], 'predecessor legacy attempt binding')
        marker_data, marker_mode = observation.io.read_file(str(legacy_folder/'qualification-started.json'), 32768)
        need(marker_mode == 0o600, 'predecessor legacy marker mode')
        legacy_marker = loads(marker_data)
        _validate_legacy_marker(legacy_marker, prior_attempt, legacy_attempt['runtimeManifestSHA256'])
        need(legacy_marker['scenario'] == previous['scenario'] == legacy['scenario'] == decision['scenario'] == SCENARIOS[index]
             and legacy_marker['runtimeManifestSHA256'] == legacy['runtimeManifestSHA256']
             and legacy_marker['epoch'] >= previous['startupAdmission']['checkedAt']['wall'], 'predecessor five-record scenario/marker binding')
        legacy_decision = read_ref(legacy_attempt['decision'], observation.read_record)
        ref = prior_attempt['previousResult']; legacy_reference = legacy_decision['previousResult']
    need(ref is None and legacy_reference is None, 'predecessor baseline termination')


class Observation:
    def __init__(self, io, legacy, wall, monotonic):
        self.io = io; self.legacy = legacy; self.wall = wall; self.monotonic = monotonic
        self.read_record = io.read_record
    def __call__(self, known, services):
        return self.io.observe_known(known, services, self.legacy, self.wall, self.monotonic)


def bind_main(loaded, attempt, context, history, *, io, wall, monotonic):
    """Exactly three hooks. Original main code and every other global stay intact."""
    original = loaded.original
    namespace = dict(vars(original)); state = {'sourceCalls': 0, 'registry': None, 'diagnostic': None, 'assessment': None}
    observer = Observation(io, original, wall, monotonic)
    marker = Path(context[0])/'qualification-started.json'
    def instrument(registry_type, diagnostic):
        if diagnostic._role == 'sample':
            return original.instrument_registry(registry_type, diagnostic)
        need(diagnostic._role == 'worker' and state['registry'] is None, 'one worker producer only')
        registry = instrument_terminal_registry(registry_type, diagnostic, wall=wall, monotonic=monotonic)
        state.update(registry=registry, diagnostic=diagnostic)
        return registry
    def coverage(worker, sample):
        need(state['registry'] is not None and state['assessment'] is None, 'one actual producer/consumer only')
        # Original validator is a pure variadic loop; the actual sample is passed
        # unchanged. No invented clean worker is supplied to the legacy consumer.
        original.validate_owned_coverage(sample)
        state['assessment'] = validate_terminal_coverage(worker, state['diagnostic'].snapshot(), state['registry'].terminal_proof_snapshot())
    def sources(args, sequence):
        actual = original.source_pins(args, sequence)  # unconditional, including invalid/extra calls
        need(actual == context[3] and args.attempt_sha256 == attempt['legacyAttempt']['sha256']
             and str(args.attempt_dir) == str(context[0]) and sequence == context[1], 'source/outer context drift')
        if state['sourceCalls'] == 0:
            need(not io.exists(str(marker)), 'startup marker already exists')
            fresh_context = (context[0], sequence, args.reference, actual, context[4])
            state['admission'] = validate_r5_admission(attempt, fresh_context, history, observation=observer, wall=wall, monotonic=monotonic)
            state['sourceCalls'] = 1
        elif state['sourceCalls'] == 1:
            marker_data, marker_mode = io.read_file(str(marker), 32768)
            need(marker_mode == 0o600, 'legacy marker mode')
            value = loads(marker_data)
            _validate_legacy_marker(value, attempt, context[3]['runtimeManifestSHA256'])
            _clock_window(state['admission']['checkedAt'], point(wall, monotonic), maximum=float('inf'))
            need(value['epoch'] >= state['admission']['checkedAt']['wall'], 'final marker predates startup')
            state['sourceCalls'] = 2
        else:
            need(False, 'unexpected source validation order')
        return actual
    namespace.update(instrument_registry=instrument, validate_owned_coverage=coverage, source_pins=sources)
    need({key for key in namespace if namespace[key] is not vars(original).get(key)}
         == {'instrument_registry','validate_owned_coverage','source_pins'}, 'three hooks only')
    main = types.FunctionType(original.main.__code__, namespace, original.main.__name__, original.main.__defaults__, original.main.__closure__)
    return main, state


class _BoundedOutput(stringio.TextIOBase):
    def __init__(self): self.count = 0; self.truncated = False
    def write(self, text):
        # Discard progress without introducing a new operational failure or wait.
        size = len(text.encode('utf-8'))
        self.truncated = self.truncated or self.count + size > 32768
        self.count = min(32768, self.count + size)
        return len(text)
    def flush(self): pass


def _nondecreasing(clock):
    previous = None
    def read():
        nonlocal previous
        value = clock(); number(value)
        need(previous is None or value >= previous, 'clock reversed across admission stages')
        previous = value
        return value
    return read


def run_one_attempt(r5_attempt_path, r5_attempt_sha256, *, io, wall, monotonic, check_only=False):
    """One explicit attempt; check-only has no operational writes or main call."""
    wall, monotonic = _nondecreasing(wall), _nondecreasing(monotonic)
    digest(r5_attempt_sha256)
    attempt = read_ref({'path': str(r5_attempt_path), 'sha256': r5_attempt_sha256}, io.read_record)
    exact(attempt, ATTEMPT_KEYS)
    directory = Path(attempt['rootDirectory'])/attempt['sequenceId']/attempt['attemptId']
    need(Path(r5_attempt_path) == directory/'r5-attempt.json', 'outer attempt location')
    for path in (Path(attempt['rootDirectory']), directory.parent, directory):
        io.check_directory(str(path), 0o700)
    loaded = load_sealed_r4(attempt['dependencySeal'], io=io)
    original = loaded.original
    io.verify_code(attempt['codePins'])
    args = types.SimpleNamespace(attempt_dir=str(Path(attempt['legacyAttempt']['path']).parent), attempt_sha256=attempt['legacyAttempt']['sha256'])
    context = original.attempt_context(args, admission=True)
    history_record = read_ref(attempt['history'], io.read_record)
    history = validate_r5_history(history_record, read_record=io.read_record)
    observer = Observation(io, original, wall, monotonic)
    admission = validate_r5_admission(attempt, context, history, observation=observer, wall=wall, monotonic=monotonic)
    marker = directory/'r5-started.json'; resultpath = directory/'r5-result.json'; proofpath = directory/'terminal-proof.json'
    need(not any(io.exists(str(p)) for p in (marker,resultpath,proofpath)), 'outer attempt already consumed')
    if check_only:
        need(not io.exists(str(Path(context[0])/'qualification-started.json'))
             and not io.exists(str(Path(context[0])/'qualification-result.json')), 'legacy attempt already consumed')
        original.current_gate(args, context[2]['expectedServices'])
        pins = original.source_pins(args, context[1])
        need(pins == context[3], 'check-only actual source pins')
        validate_r5_admission(attempt, context, history, observation=observer, wall=wall, monotonic=monotonic)
        return {'classification':'read-only-integration-passed', 'qualification':'NOT_RUN', 'oneUseConsumed':False,
                'fullProcessTreeExit':'unknown', 'knownIdentities':34, 'historySHA256':history['historySHA256']}
    main, state = bind_main(loaded, attempt, context, history, io=io, wall=wall, monotonic=monotonic)
    need(_RUN_LOCK.acquire(blocking=False), 'concurrent in-process invocation refused')
    try:
        started = {'schemaVersion':1,'kind':'r5-terminal-scan-started','attemptSHA256':r5_attempt_sha256,
                   'sequenceId':attempt['sequenceId'],'attemptId':attempt['attemptId'],'runNonce':attempt['runNonce'],
                   'rootDecision':attempt['rootDecision'],'admission':admission,'oneUse':True}
        io.write_exclusive(str(marker), compact(started))
        result = {'schemaVersion':1,'kind':'r5-terminal-scan-result','classification':'failed-or-indeterminate',
                  'sequenceId':attempt['sequenceId'],'attemptId':attempt['attemptId'],'runNonce':attempt['runNonce'],
                  'scenario':attempt['scenario'],'attemptSHA256':r5_attempt_sha256,'startedSHA256':sha(compact(started)),
                  'history':attempt['history'],'historySHA256':history['historySHA256'],'failedHistory':list(FAILURES),
                  'codePins':attempt['codePins'],'dependencySealSHA256':sha(compact(attempt['dependencySeal'])),
                  'rootDecision':attempt['rootDecision'],'legacyResult':None,'proof':None,'coverageAssessment':None,
                  'fullProcessTreeExit':'unknown','completeProcessTreeExitEstablished':False,'errorClass':None,
                  'automaticNextRun':False,'policy':'prospective-terminal-race-v1','startupAdmission':None}
        try:
            code = io.invoke_main(main, args)
            result['startupAdmission'] = state.get('admission')
            result['coverageAssessment'] = state['assessment']
            path = Path(context[0])/'qualification-result.json'
            data, mode = io.read_file(str(path), 1048576); need(mode == 0o600, 'legacy result mode')
            legacy = loads(data); result['legacyResult'] = {'path':str(path),'sha256':sha(data)}
            proof = state['registry'].terminal_proof_snapshot() if state['registry'] is not None else None
            if proof is not None:
                io.write_exclusive(str(proofpath), compact(proof))
                result['proof'] = {'path':str(proofpath),'sha256':sha(compact(proof))}
            need(code == 0 and legacy['classification'] == 'observed-qualification-completed'
                 and state['sourceCalls'] == 2 and state['assessment'] is not None, 'legacy incomplete or failed')
            for key in ('attemptId','sequenceId','scenario'):
                need(legacy[key] == attempt[key], 'legacy result binding')
            need(legacy['attemptSHA256'] == attempt['legacyAttempt']['sha256']
                 and legacy['runtimeManifestSHA256'] == context[3]['runtimeManifestSHA256'], 'legacy result source binding')
            assessment = validate_terminal_coverage(legacy['owned'], legacy['processDiagnostics']['worker'], proof)
            need(assessment == state['assessment'], 'persisted proof/consumer mismatch')
            original.validate_owned_coverage(legacy['sampleOwned'])
            if attempt['scenario'] in ('within-grace','after-grace'):
                need(legacy['sampleTriggered'] is False and legacy['samplingEnabled'] is False, 'recovery sample forbidden')
            result.update(proof={'path':str(proofpath),'sha256':sha(compact(proof))},coverageAssessment=assessment,
                          classification='observed-qualification-completed')
        except Exception as error:
            result['errorClass'] = type(error).__name__
        encoded = compact(result); need(len(encoded) <= 262144, 'outer result byte bound')
        io.write_exclusive(str(resultpath), encoded)
        return result
    finally:
        _RUN_LOCK.release()


class ProductionIO:
    """Explicit runtime IO. Construction itself performs no observation."""
    def read_file(self, path, limit):
        p = Path(path)
        literal = str(p)
        canonical = '/private'+literal if literal.startswith(('/tmp/','/var/')) else literal
        need(p.is_absolute() and str(p.resolve(strict=True)) == canonical, 'symlink path refused')
        st = p.lstat(); need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid(), 'regular owned file required')
        fd = os.open(p, os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
        with os.fdopen(fd,'rb') as stream:
            current = os.fstat(stream.fileno())
            need((current.st_dev,current.st_ino) == (st.st_dev,st.st_ino), 'file identity race')
            data = stream.read(limit+1)
        end = p.lstat()
        need((st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns) == (end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns)
             and len(data) <= limit, 'file change/byte bound')
        return data, stat.S_IMODE(st.st_mode)
    def read_record(self, ref):
        reference(ref); data, mode = self.read_file(ref['path'], 1048576)
        need(mode == 0o600, 'private record mode'); return data
    def check_directory(self, path, mode):
        p = Path(path); st = p.lstat()
        need(str(p.resolve(strict=True)) == str(p) and stat.S_ISDIR(st.st_mode)
             and stat.S_IMODE(st.st_mode) == mode and st.st_uid == os.getuid(), 'private plain directory')
    def exists(self, path):
        return os.path.lexists(path)
    def write_exclusive(self, path, data):
        need(len(data) <= 262144, 'operational output bound'); self.check_directory(str(Path(path).parent),0o700)
        fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())
    def verify_code(self, pins):
        exact(pins, ('supervisorSourceTIP','files')); digest(pins['supervisorSourceTIP'],40)
        need(set(pins['files']) == set(CODE_FILES), 'code source closure')
        repo = Path(__file__).resolve().parents[1]
        def git(*args):
            r = subprocess.run(['git','--no-replace-objects','-C',str(repo),*args],stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL,timeout=30,env=dict(os.environ,GIT_OPTIONAL_LOCKS='0'))
            need(r.returncode == 0 and len(r.stdout) <= 1048576, 'supervisor Git pin failed'); return r.stdout
        need(git('rev-parse','HEAD').decode().strip() == pins['supervisorSourceTIP'], 'supervisor HEAD drift')
        for name in CODE_FILES:
            data,_ = self.read_file(str(repo/name),1048576)
            need(sha(data) == pins['files'][name] == sha(git('show',pins['supervisorSourceTIP']+':'+name)), 'supervisor source drift')
    def observe_known(self, known, services, legacy, wall, monotonic):
        import psutil
        start = point(wall,monotonic); rows = []
        for identity in known:
            row = {'identity':identity,'outcome':None,'birth':None,'birthAgain':None,'status':None,'started':point(wall,monotonic)}
            try:
                process = psutil.Process(identity['pid'])
            except psutil.NoSuchProcess as error:
                need(error.pid == identity['pid'], 'unknown absent PID'); row['outcome'] = 'gone'
            else:
                try:
                    row['birth'] = process.create_time(); row['status'] = process.status()
                    # Each public Process caches create_time. Resolve the same PID
                    # once more for an independent birth observation, never retry.
                    verification = psutil.Process(identity['pid'])
                    need(verification is not process, 'independent known identity handle required')
                    row['birthAgain'] = verification.create_time()
                    number(row['birth'], True); number(row['birthAgain'], True)
                    need(row['birth'] == row['birthAgain'], 'known identity birth changed')
                    if row['birth'] == identity['birth']:
                        need(row['status'] == 'zombie', 'known identity still alive or unknown')
                        row['outcome'] = 'zombie'
                    else:
                        need(row['status'] in ('running','sleeping','disk-sleep','stopped','tracing-stop','zombie',
                                              'idle','locked','waiting','waking','wake-kill','parked'), 'unknown process status')
                        row['outcome'] = 'stable-nonmatching'
                except Exception:
                    # A second resolve/read failure is not initial absence. Keep
                    # partial observations but never grant gone/reused admission.
                    row['outcome'] = 'unknown'
            row['finished'] = point(wall,monotonic); rows.append(row)
        current = legacy.service_set()  # original listener command retains timeout=5
        idle = legacy.health(require_idle=True)
        return {'started':start,'finished':point(wall,monotonic),'identities':rows,'services':current,
                'idle':{'viewerCount':idle['viewerCount'],'relayViewerCount':idle['relayViewerCount'],'lsofTimeoutSeconds':5}}
    def invoke_main(self, main, args):
        argv = sys.argv
        try:
            sys.argv = ['sealed-r4','--attempt-dir',args.attempt_dir,'--attempt-sha256',args.attempt_sha256]
            with contextlib.redirect_stdout(_BoundedOutput()):
                return main()
        finally:
            sys.argv = argv


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--r5-attempt',required=True)
    parser.add_argument('--r5-attempt-sha256',required=True)
    parser.add_argument('--check-only',action='store_true')
    args = parser.parse_args(argv)
    try:
        result = run_one_attempt(args.r5_attempt,args.r5_attempt_sha256,io=ProductionIO(),
                                 wall=time.time,monotonic=time.monotonic,check_only=args.check_only)
        summary = {key:result[key] for key in ('classification','fullProcessTreeExit')}
        summary.update(checkOnly=args.check_only, qualification='NOT_RUN' if args.check_only else result['classification'])
        print(compact(summary).decode())
        return 0 if result['classification'] in ('read-only-integration-passed','observed-qualification-completed') else 2
    except Exception as error:
        print(compact({'classification':'failed-or-indeterminate','errorClass':type(error).__name__,
                       'checkOnly':args.check_only,'fullProcessTreeExit':'unknown'}).decode())
        return 2


if __name__ == '__main__':
    raise SystemExit(cli())
