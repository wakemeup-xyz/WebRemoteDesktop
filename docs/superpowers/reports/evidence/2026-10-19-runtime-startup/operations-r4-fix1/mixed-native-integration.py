#!/usr/bin/env python3
"""Native startup fake-only producer/consumer check; execution requires root review."""
import argparse, ast, asyncio, builtins, hashlib, json, os, re, subprocess, sys, types
from pathlib import Path
from unittest.mock import patch
from unittest import TestResult

SOURCE = Path('/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop')
R6 = Path('/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r6-7f39_qy0')
PRODUCT = 'dfb15434e79da90b803b763c533836e16c080c71'
TOOL = '2822441791b59a021556c7e4eb24715df9d5b277'
R6_SHA = '4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8'
FILES = ('scripts/passive_session_soak.py', 'scripts/ordinary_session_recovery.py',
         'scripts/test_ordinary_session_recovery.py', 'scripts/passive_session_sampler.js')

def require(ok):
    if not ok: raise RuntimeError('pure-integration-check-failed')

def digest(data): return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tip', required=True)
    parser.add_argument('--binding-sha256', required=True)
    parser.add_argument('--viewer-build-id', required=True)
    parser.add_argument('--r6-manifest-sha256', required=True)
    args = parser.parse_args()
    binding_bytes = (Path(__file__).resolve().parent/'FINAL-BINDING.json').read_bytes()
    require(digest(binding_bytes) == args.binding_sha256)
    binding = json.loads(binding_bytes)
    require(set(binding) == {'schemaVersion','sourceTIP','viewerSourceTIP','toolTIP','sourceReview'} and type(binding['schemaVersion']) is int and binding['schemaVersion'] == 1 and binding['toolTIP'] == TOOL)
    TIP, VIEWER = binding['sourceTIP'], binding['viewerSourceTIP']
    require(all(type(v) is str and re.fullmatch('[a-f0-9]{40}', v) for v in (TIP, VIEWER)))
    require(sys.dont_write_bytecode and Path.cwd() == SOURCE)
    require(re.fullmatch('[a-f0-9]{40}', args.tip) is not None)
    require(args.tip == TIP and args.r6_manifest_sha256 == R6_SHA)
    require(re.fullmatch('[a-f0-9]{16}', args.viewer_build_id) is not None)
    def git(*words):
        return subprocess.check_output(['/usr/bin/git', '-C', str(SOURCE), *words], stderr=subprocess.DEVNULL)
    require(git('rev-parse', 'HEAD').decode().strip() == args.tip)
    source = {}
    for name in FILES:
        source[name] = (SOURCE/name).read_bytes()
        require(source[name] == git('show', args.tip+':'+name) == git('show', TOOL+':'+name))
    manifest_bytes = (R6/'SHA256SUMS.json').read_bytes()
    require(digest(manifest_bytes) == R6_SHA)
    manifest = json.loads(manifest_bytes)
    package = {}
    for name, sha in manifest.items():
        require(Path(name).name == name and re.fullmatch('[a-f0-9]{64}', sha) is not None)
        package[name] = (R6/name).read_bytes()
        require(digest(package[name]) == sha)
    require(digest(source[FILES[0]]) == 'b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426')
    # Compile only the exact reviewed need definition; no operational module runs.
    tree = ast.parse(package['prep_common.py'])
    need_nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'need']
    require(len(need_nodes) == 1)
    common = types.ModuleType('operational_common'); common.re = re
    exec(compile(ast.Module(body=need_nodes, type_ignores=[]), str(R6/'prep_common.py'), 'exec'), common.__dict__)
    names = ('scripts', 'scripts.passive_session_soak', 'scripts.ordinary_session_recovery',
             'scripts.test_ordinary_session_recovery', 'qualification_evidence')
    modules = {name: types.ModuleType(name) for name in names}
    modules['scripts'].__path__ = []
    modules['operational_common'] = common
    def load(name, path, data):
        module = modules[name]; module.__file__ = str(path)
        module.__package__ = name.rpartition('.')[0]
        exec(compile(data, str(path), 'exec'), module.__dict__)
        return module
    active = [True]; config_paths = set(); counts = {'accepted': 0, 'rejected': 0, 'rows': 0}
    def audit(event, values):
        if not active[0]: return
        require(event not in ('subprocess.Popen', 'os.system', 'os.posix_spawn',
                              'socket.connect', 'socket.bind', 'socket.getaddrinfo'))
        if event == 'open' and isinstance(values[0], (str, bytes, os.PathLike)):
            require(os.fsdecode(values[0]) not in config_paths)
    sys.addaudithook(audit)
    original_import = builtins.__import__
    def pure_import(name, *pos, **kw):
        if name.split('.')[0] in ('playwright', 'psutil', 'requests', 'httpx', 'dotenv'):
            require(name == 'dotenv' and isinstance(sys.modules.get(name), types.SimpleNamespace))
        return original_import(name, *pos, **kw)
    def forbidden(*pos, **kw): raise RuntimeError('forbidden-runtime-operation')
    try:
        with patch.dict(sys.modules, modules), patch('builtins.__import__', pure_import):
            pure = load(names[1], SOURCE/FILES[0], source[FILES[0]])
            runner = load(names[2], SOURCE/FILES[1], source[FILES[1]])
            fixtures = load(names[3], SOURCE/FILES[2], source[FILES[2]])
            consumer = load(names[4], R6/'qualification_evidence.py', package['qualification_evidence.py'])
            actual_run = runner.run
            # Change fixture inputs before serialization/hash and before observation.
            # Producer and consumer validators are unmodified.
            fixture_manifest = fixtures.valid_manifest
            fixture_sample = fixtures.private_sample
            def mixed_manifest(log, now=1000000):
                value = fixture_manifest(log, now)
                value['signal']['sourceCommit'] = PRODUCT
                value['host']['sourceCommit'] = PRODUCT
                value['viewer'] = {'sourceCommit': VIEWER, 'buildId': args.viewer_build_id}
                return value
            def mixed_sample():
                value = fixture_sample(); value['buildId'] = args.viewer_build_id
                return value
            fixtures.valid_manifest = mixed_manifest
            fixtures.private_sample = mixed_sample
            async def capture(runtime_args, **injection):
                require(runtime_args.scenario == 'baseline' and runtime_args.mode == 'stun')
                require(callable(injection.get('manager_factory')))
                require(getattr(injection.get('status_reader'), '__func__', None) is fixtures.RuntimeRunTests.status)
                name, expected_accept = expected[method_counts['accepted']+method_counts['rejected']]
                require(Path(runtime_args.output_dir).name == name)
                config_paths.add(str(runtime_args.runtime_config))
                result = await actual_run(runtime_args, **injection)
                output = Path(runtime_args.output_dir)
                data = {name: (output/name).read_bytes() for name in ('samples.jsonl', 'summary.json', 'lifecycle.json')}
                require(all(raw not in b''.join(data.values()) for raw in
                    (b'password-canary', b'session-canary', b'socket-canary', b'admission-canary', b'attempt-canary', b'host-canary', str(runtime_args.runtime_config).encode())))
                rows = [json.loads(line) for line in data['samples.jsonl'].splitlines()]
                summary = json.loads(data['summary.json']); lifecycle = json.loads(data['lifecycle.json'])
                runtime_manifest = json.loads(Path(runtime_args.runtime_manifest).read_bytes())
                runtime_manifest['_sha'] = runtime_args.runtime_manifest_sha256
                require(runtime_manifest['signal']['sourceCommit'] == PRODUCT and runtime_manifest['host']['sourceCommit'] == PRODUCT and runtime_manifest['viewer'] == {'sourceCommit': VIEWER, 'buildId': args.viewer_build_id})
                require(1 <= len(rows) <= 12000)
                if expected_accept or name in ('emptyTrue', 'nullTrue'):
                    require(len(rows) >= 300 and summary['continuity']['elapsedSeconds'] == 300)
                gate = consumer.ObservationGate('baseline', runtime_manifest['viewer']['buildId'], pure)
                accepted = True
                try:
                    for row in rows: gate.observe(row)
                    consumer.terminal_valid(summary, lifecycle, 'baseline', runtime_manifest, gate, pure)
                except RuntimeError:
                    accepted = False
                require(accepted is expected_accept and result == (0 if expected_accept else 1))
                key = 'accepted' if accepted else 'rejected'
                method_counts[key] += 1; counts[key] += 1; counts['rows'] += len(rows)
                return result
            # Empty local proxy avoids reading the caller's password environment.
            proxy = types.SimpleNamespace(**{name: getattr(os, name) for name in dir(os)})
            proxy.environ = {}
            plan = (
                ('test_native_empty_attempt_before_start_retained_without_qualifying_time', (('out', True),), (1, 0)),
                ('test_core_missing_null_attempt_before_start_remains_observable', (('out', True),), (1, 0)),
                ('test_malformed_attempt_still_stops_before_start', tuple((n, False) for n in ('number', 'bool', 'list', 'mapping', 'long', 'encoding')), (0, 6)),
                ('test_later_absent_attempt_cannot_preserve_qualified_pass', tuple((n, False) for n in ('emptyFalse', 'emptyTrue', 'nullFalse', 'nullTrue')), (0, 4)))
            with patch.object(runner, 'run', capture), patch.object(runner, 'read_local_host_status', forbidden), patch.object(runner, 'os', proxy), patch.object(fixtures.tempfile, 'tempdir', '/tmp'):
                for method, expected, wanted in plan:
                    method_counts = {'accepted': 0, 'rejected': 0}
                    case = fixtures.NativeStartupBoundaryTests(method); result = TestResult()
                    case.run(result)
                    require(result.testsRun == 1 and result.wasSuccessful())
                    require(not any((result.errors, result.failures, result.skipped,
                                     result.expectedFailures, result.unexpectedSuccesses)))
                    require((method_counts['accepted'], method_counts['rejected']) == wanted)
            require(counts['accepted'] == 2 and counts['rejected'] == 10)
    finally:
        active[0] = False
    print(json.dumps({'result': 'pure-native-startup-integration-only', 'methods': 4, **counts, 'sourceTIP': TIP, 'viewerBuildId': args.viewer_build_id, 'componentPins': {'signal': PRODUCT, 'host': PRODUCT, 'viewer': VIEWER, 'tools': TOOL}}, sort_keys=True))

if __name__ == '__main__':
    try: main()
    except BaseException:
        print('{"result":"pure-native-startup-integration-failed"}')
        raise SystemExit(1)
