"""R5 new logic fixtures. The complete legacy success chain is NOT_CLOSED."""
import unittest
import guarded_terminal_scan_continuation as r5

class FreshnessTests(unittest.TestCase):
    def test_source_validation_elapsed_time_must_expire_admission(self):
        with self.assertRaises(RuntimeError):
            r5._clock_window({'wall':100, 'monotonic':20}, {'wall':161, 'monotonic':81})

    def test_clock_reversal_must_reject(self):
        with self.assertRaises(RuntimeError):
            r5._clock_window({'wall':100, 'monotonic':20}, {'wall':101, 'monotonic':19})


# All fixture writes are memory-only. The immutable on-disk records are read
# into fake IO; no legacy gate, Git, network or live process observation is run.
import ast
import builtins
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
from unittest.mock import patch
class NoSuchProcess(Exception):
    def __init__(self,pid): self.pid=pid
class AccessDenied(Exception): pass

def load_registry(clock):
    path=Path(__file__).resolve().parents[1]/'docs/superpowers/reports/evidence/2026-10-19-runtime-startup/immutable-registry-supervisor.py'
    data=path.read_bytes()
    assert r5.sha(data)==r5.SUP_SHA
    classes=[x for x in ast.parse(data).body if isinstance(x,ast.ClassDef) and x.name in ('Registry','Capacity')]
    ns={'psutil':types.SimpleNamespace(Process=None,NoSuchProcess=NoSuchProcess,AccessDenied=AccessDenied,STATUS_ZOMBIE='zombie'),
        'time':types.SimpleNamespace(time=clock,monotonic=clock,sleep=lambda _:None),'POLL':.25}
    exec(compile(ast.Module(body=classes,type_ignores=[]),str(path),'exec'),ns)
    return ns['Registry']


class FixtureIO:
    def __init__(self):
        self.files = {}; self.operational_writes = []; self.popen_calls = []
        self.calls = []; self.clock_value = 100.0; self.observation_change = None
        self.main_hook = None
    def clock(self):
        self.clock_value += .0001
        return self.clock_value
    def read_file(self, path, limit):
        if path not in self.files:
            p = Path(path); self.files[path] = (p.read_bytes(),stat.S_IMODE(p.stat().st_mode))
        data, mode = self.files[path]
        if len(data)>limit: raise RuntimeError('fixture file bound')
        return data,mode
    def read_record(self, ref): return self.read_file(ref['path'],1048576)[0]
    def check_directory(self, path, mode): self.calls.append('directory')
    def exists(self, path): return path in self.files
    def verify_code(self, pins): self.calls.append('code-boundary-explicit-fake')
    def put(self, path, value):
        data = r5.compact(value); self.files[str(path)] = (data,0o600)
        return {'path':str(path),'sha256':r5.sha(data)}
    def write_exclusive(self,path,data):
        if self.exists(path): raise RuntimeError('exclusive')
        self.operational_writes.append(path); self.files[path]=(data,0o600)
    def observe_known(self, known, services, legacy, wall, monotonic):
        self.calls.append('fresh-known-and-idle')
        start = r5.point(wall,monotonic)
        rows = [{'identity':deepcopy(row),'outcome':'gone','birth':None,'birthAgain':None,'status':None,
                 'started':r5.point(wall,monotonic),'finished':r5.point(wall,monotonic)} for row in known]
        result = {'started':start,'finished':r5.point(wall,monotonic),'identities':rows,'services':services,
                  'idle':{'viewerCount':0,'relayViewerCount':0,'lsofTimeoutSeconds':5}}
        if self.observation_change: self.observation_change(result)
        return result
    def invoke_main(self,main,args):
        self.calls.append('original-main-code-with-explicit-legacy-boundary')
        with r5.contextlib.redirect_stdout(r5._BoundedOutput()):
            return self.main_hook(main,args) if self.main_hook else main()


def sealed(io):
    manifest = json.loads(io.read_file(str(r5.R4/'SHA256SUMS.json'),1048576)[0])
    sources = {name[:-3]:io.read_file(str(r5.R4/name),32*1024*1024)[0] for name in manifest if name.endswith('.py')}
    closure=set()
    def add(name):
        if name in closure:return
        closure.add(name)
        for node in ast.walk(ast.parse(sources[name])):
            imports = [a.name for a in node.names] if isinstance(node,ast.Import) else [node.module] if isinstance(node,ast.ImportFrom) else []
            for dependency in imports:
                if dependency in sources:add(dependency)
    for name in (r5.ENTRY,'readiness_records','owned_reload'): add(name)
    return {'root':str(r5.R4),'manifestSHA256':r5.MANIFEST_SHA,
            'files':{name+'.py':{'sha256':manifest[name+'.py'],'mode':0o600} for name in sorted(closure)},
            'supervisor':{'path':r5.SUP,'sha256':r5.SUP_SHA,'mode':io.read_file(r5.SUP,1048576)[1]},
            'passive':{'path':r5.PASSIVE,'sha256':r5.PASSIVE_SHA,'mode':io.read_file(r5.PASSIVE,1048576)[1]}}


def historical(io):
    def get(path):
        data=io.read_file(str(path),1048576)[0]; return {'path':str(path),'sha256':r5.sha(data)}
    base=json.loads(io.read_file(str(r5.R4/'legacy-deployed-reference.json'),1048576)[0])['historical']
    second=json.loads(io.read_file(str(r5.R4/'legacy-tool-history.json'),1048576)[0])['records']
    third=json.loads(io.read_file(str(r5.R4/'deployment-history.json'),1048576)[0])['records']
    first_folder=Path(base['oldFailure']['path']).parent
    failures=[{'frozen':base['frozen'],'sourcePins':get(first_folder/'baseline-source-pins.json'),
               'started':base['oldMarker'],'runtime':base['oldRuntimeManifest'],'result':base['oldFailure']}]
    for records,prefix in ((second,'second'),(third,'third')):
        attempt=json.loads(io.read_record(records[prefix+'Attempt']))
        failures.append({'sequence':get(Path(attempt['sequenceDirectory'])/'sequence.json'),
                         'attempt':records[prefix+'Attempt'],'started':records[prefix+'Marker'],
                         'runtime':get(Path(records[prefix+'Attempt']['path']).parent/'runtime-manifest.json'),
                         'result':records[prefix+'Failure']})
    attempt=json.loads(io.read_file(str(r5.FOURTH/'attempt.json'),1048576)[0])
    failures.append({'sequence':get(Path(attempt['sequenceDirectory'])/'sequence.json'),
                     **{name:get(r5.FOURTH/file) for name,file in [('attempt','attempt.json'),('started','qualification-started.json'),
                       ('runtime','runtime-manifest.json'),('result','qualification-result.json')]}})
    reload={name:get(r5.DEPLOYMENT/file) for name,file in [('started','reload-started.json'),('result','reload-result.json'),
              ('readinessStarted','readiness-started.json'),('readiness','readiness-result.json')]}
    known={}
    def owner(value,source,role):
        for row in value['identities']:
            key=(row['pid'],row['birth'])
            known.setdefault(key,{k:deepcopy(row[k]) for k in ('pid','birth','parent','firstObservedEpoch','lastObservedEpoch')})
            known[key].setdefault('sources',[]).append({'resultSHA256':source,'role':role})
    for chain in failures:
        result=json.loads(io.read_record(chain['result']))
        for role,key in [('worker','owned'),('sample','sampleOwned')]:owner(result[key],chain['result']['sha256'],role)
    owner(json.loads(io.read_record(reload['result']))['helper']['ownership'],r5.RELOAD_SHA,'reload-helper')
    return {'schemaVersion':1,'failures':failures,'reload':reload,'knownIdentities':[known[key] for key in sorted(known)]}


class R5Case:
    """Actual new validators; explicitly fake *external legacy gate* boundaries."""
    def __init__(self, scenario='baseline'):
        self.io=FixtureIO(); self.seal=sealed(self.io)
        self.loaded=r5.load_sealed_r4(self.seal,io=self.io)
        self.history_record=historical(self.io)
        self.history=r5.validate_r5_history(self.history_record,read_record=self.io.read_record)
        seq,attempt,nonce='a'*32,'b'*32,'c'*32
        self.folder=r5.R4/('sequence-'+seq)/'attempts'/attempt
        decision=self.io.put('/fixture/legacy-decision.json',{'previousResult':None})
        self.sequence={'sequenceId':seq,'failedHistory':r5.FAILURES[:3],'sourceTIP':r5.PINS['sourceTIP'],
                       'readinessSHA256':r5.READY_SHA,'toolTIP':r5.PINS['deployedToolTIP']}
        self.pins={'sequenceId':seq,'attemptId':attempt,'runNonce':nonce,'scenario':scenario,'failedHistory':r5.FAILURES[:3],
                   'priorFailureSHA256':r5.FAILURES[2],'sourceTIP':r5.PINS['sourceTIP'],'toolTIP':r5.PINS['deployedToolTIP'],
                   'productTIP':r5.PINS['productTIP'],'readinessSHA256':r5.READY_SHA,'decision':decision,'runtimeManifestSHA256':'d'*64,
                   'mode':'relay','origin':'https://link.stockhub.wiki'}
        self.runtime={'runNonce':nonce,'validUntilEpochMs':9999999999999}
        self.ref={'expectedServices':self.history['services'],'assets':{'buildId':'fixture-build'}}
        self.context=(self.folder,self.sequence,self.ref,self.pins,self.runtime)
        self.a={'schemaVersion':1,'kind':'r5-terminal-scan-attempt','rootDirectory':'/fixture/r5',
                'sequenceId':seq,'attemptId':attempt,'runNonce':nonce,'scenario':scenario,
                'legacyAttempt':self.io.put(self.folder/'attempt.json',self.pins),
                'history':self.io.put('/fixture/history.json',self.history_record),'dependencySeal':self.seal,
                'codePins':{'supervisorSourceTIP':'e'*40,'files':{p:'f'*64 for p in r5.CODE_FILES}},
                'rootDecision':None,'previousResult':None,'immediatePriorFailureSHA256':r5.FAILURES[3],'deployedPins':r5.PINS}
        self.reseal()
    def reseal(self):
        decision={key:deepcopy(self.a[key]) for key in ('rootDirectory','sequenceId','attemptId','runNonce','scenario','legacyAttempt','codePins',
                 'previousResult','immediatePriorFailureSHA256','deployedPins')}
        decision.update(schemaVersion=1,kind='root-r5-one-scenario',historySHA256=r5.sha(r5.compact(self.history_record)),
                        dependencySealSHA256=r5.sha(r5.compact(self.seal)),issued={'wall':self.io.clock_value,'monotonic':self.io.clock_value},automaticLaunch=False)
        self.a['rootDecision']=self.io.put(self.a['rootDirectory']+'/decision-'+self.a['attemptId']+'.json',decision)
        self.path=Path(self.a['rootDirectory'])/self.a['sequenceId']/self.a['attemptId']/'r5-attempt.json'
        self.input=self.io.put(self.path,self.a)
    def admit(self):
        return r5.validate_r5_admission(self.a,self.context,self.history,
                 observation=r5.Observation(self.io,self.loaded.original,self.io.clock,self.io.clock),wall=self.io.clock,monotonic=self.io.clock)
    def boundary(self):
        """Clone only a test namespace; originals in loaded graph stay unchanged."""
        ns=types.SimpleNamespace(**vars(self.loaded.original))
        def context(args,admission=False):
            self.io.calls.append('attempt-context-explicit-fake')
            args.reference=self.ref;args.runtime_manifest=str(self.folder/'runtime-manifest.json')
            args.runtime_manifest_sha256=self.pins['runtimeManifestSHA256']
            return self.context
        def source(args,m):
            self.io.calls.append('source-pins-explicit-fake')
            context(args)
            if getattr(self,'source_error',False):raise RuntimeError('source injected boundary')
            self.io.clock_value+=getattr(self,'source_elapsed',0)
            return self.pins
        def current(args,expected):
            self.io.calls.append('current-gate-explicit-fake')
            if getattr(self,'gate_error',False):raise RuntimeError('occupied injected boundary')
            return {}
        ns.attempt_context=context;ns.source_pins=source;ns.current_gate=current
        # main is the actual immutable code object with an explicit fake external boundary.
        ns.main=types.FunctionType(self.loaded.original.main.__code__,vars(ns))
        return types.SimpleNamespace(original=ns,modules=self.loaded.modules,seal=self.seal)
    def run(self,check_only=False,loaded=None):
        loaded=loaded or self.boundary()
        with patch.object(r5,'load_sealed_r4',return_value=loaded):
            return r5.run_one_attempt(str(self.path),self.input['sha256'],io=self.io,wall=self.io.clock,
                                     monotonic=self.io.clock,check_only=check_only)


class LoaderHistoryTests(unittest.TestCase):
    def test_loader_keeps_original_gates_and_private_import_graph(self):
        io=FixtureIO(); seal=sealed(io); before=set(sys.modules)
        one=r5.load_sealed_r4(seal,io=io);two=r5.load_sealed_r4(seal,io=io)
        self.assertIsNot(one.original,two.original)
        for name in ('attempt_context','ready_context','current_gate','source_pins'):
            self.assertIs(getattr(one.original,name),getattr(one.modules['continuation_common'],name))
        self.assertEqual(one.original.R,r5.R4)
        for name,module in one.modules.items():
            self.assertEqual(module.__file__,str(r5.R4/(name+'.py')))
            self.assertNotIn(name,sys.modules)
        self.assertFalse((set(sys.modules)-before)&set(one.modules))
    def test_root_closure_mode_and_drift_rejected(self):
        for kind in ('root','closure','mode','bytes','supervisor'):
            io=FixtureIO(); seal=sealed(io)
            if kind=='root':seal['root']='/copy/r4'
            if kind=='closure':seal['files'].pop('owned_reload.py')
            if kind=='mode':
                data,_=io.files[str(r5.R4/'core.py')];io.files[str(r5.R4/'core.py')]=(data,0o644)
            if kind=='bytes':
                data,mode=io.files[str(r5.R4/'core.py')];io.files[str(r5.R4/'core.py')]=(data+b'\n',mode)
            if kind=='supervisor':seal['supervisor']['sha256']='a'*64
            with self.subTest(kind=kind),self.assertRaises(RuntimeError):r5.load_sealed_r4(seal,io=io)
    def test_cached_same_name_pollution_rejected_without_replacing_it(self):
        io=FixtureIO();seal=sealed(io);foreign=types.ModuleType('core')
        with patch.dict(sys.modules,{'core':foreign}):
            with self.assertRaises(RuntimeError):r5.load_sealed_r4(seal,io=io)
            self.assertIs(sys.modules['core'],foreign)
    def test_real_local_legacy_entry_rejects_missing_attempt_before_external_gates(self):
        io=FixtureIO();loaded=r5.load_sealed_r4(sealed(io),io=io)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                loaded.original.attempt_context(types.SimpleNamespace(attempt_dir=directory,attempt_sha256='a'*64),admission=True)
    def test_four_real_pinned_lineages_derive_exact_union_and_full_nonces(self):
        io=FixtureIO();h=historical(io);v=r5.validate_r5_history(h,read_record=io.read_record)
        self.assertEqual(len(v['knownIdentities']),34)
        self.assertIn((36482,1792348652.844396),[(r['pid'],r['birth']) for r in v['knownIdentities']])
        self.assertIn('ff601377b608c2c4b1b51e55123e2f20',v['deniedIds'])
        self.assertTrue(any(x.startswith('0acf96f1') and len(x)==32 for x in v['deniedIds']))
        self.assertEqual(v['failedHistory'],r5.FAILURES)
        self.assertEqual(h['failures'][0].keys(),{'frozen','sourcePins','started','runtime','result'})
    def test_history_order_missing_identity_same_count_and_missing_helpers_rejected(self):
        io=FixtureIO();base=historical(io)
        for change in ('order','missing-chain','fourth','helpers','same-count','provenance','runtime','reload'):
            h=deepcopy(base)
            if change=='order':h['failures'].reverse()
            if change=='missing-chain':h['failures'].pop()
            if change=='fourth':h['knownIdentities']=[x for x in h['knownIdentities'] if x['pid']!=36482]
            if change=='helpers':h['knownIdentities']=[x for x in h['knownIdentities'] if x['sources'][0]['role']!='reload-helper']
            if change=='same-count':h['knownIdentities'][0]['birth']+=1
            if change=='provenance':h['knownIdentities'][0]['sources']=[]
            if change=='runtime':h['failures'][3]['runtime']['sha256']='a'*64
            if change=='reload':h['reload']['readiness']=h['reload']['result']
            with self.subTest(change=change),self.assertRaises(RuntimeError):r5.validate_r5_history(h,read_record=io.read_record)


class AdmissionTests(unittest.TestCase):
    def test_fresh_exact_known_union_admitted(self):
        c=R5Case();self.assertEqual(c.admit()['decisionSHA256'],c.a['rootDecision']['sha256'])
    def test_historical_ids_each_denied(self):
        c=R5Case()
        for field in ('sequenceId','attemptId','runNonce'):
            for value in c.history['deniedIds']:
                bad=deepcopy(c.a);bad[field]=value
                with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):
                    r5.validate_r5_admission(bad,c.context,c.history,observation=r5.Observation(c.io,c.loaded.original,c.io.clock,c.io.clock),wall=c.io.clock,monotonic=c.io.clock)
    def test_missing_fourth_identity_fails_before_worker(self):
        c=R5Case();c.history_record['knownIdentities']=[x for x in c.history_record['knownIdentities'] if x['pid']!=36482]
        c.a['history']=c.io.put('/fixture/history.json',c.history_record);c.reseal()
        with self.assertRaises(RuntimeError):c.run()
        self.assertEqual(c.io.popen_calls,[]);self.assertEqual(c.io.operational_writes,[])
    def test_known_observation_alive_unknown_incomplete_wrong_count_and_idle_fail(self):
        for change in ('alive','unknown','birth-race','missing','wrong-identity','occupied','lsof','old-clock','row-clock-reversal'):
            c=R5Case()
            def mutate(v):
                row=v['identities'][0]
                if change=='alive':row.update(outcome='zombie',birth=row['identity']['birth'],birthAgain=row['identity']['birth'],status='running')
                if change=='unknown':row['outcome']='unknown'
                if change=='birth-race':row.update(outcome='stable-nonmatching',birth=1.,birthAgain=2.,status='running')
                if change=='missing':v['identities'].pop()
                if change=='wrong-identity':row['identity']['pid']+=100
                if change=='occupied':v['idle']['viewerCount']=1
                if change=='lsof':v['idle']['lsofTimeoutSeconds']=6
                if change=='old-clock':row['finished']['wall']-=70
                if change=='row-clock-reversal':v['identities'][1]['started']=deepcopy(v['started'])
            c.io.observation_change=mutate
            with self.subTest(change=change),self.assertRaises(RuntimeError):c.admit()
    def test_zombie_and_stable_nonmatching_are_old_identity_quiescence(self):
        for outcome in ('zombie','stable-nonmatching'):
            c=R5Case()
            def mutate(v):
                row=v['identities'][0];birth=row['identity']['birth']+(1 if outcome=='stable-nonmatching' else 0)
                row.update(outcome=outcome,birth=birth,birthAgain=birth,status='zombie' if outcome=='zombie' else 'sleeping')
            c.io.observation_change=mutate;self.assertIn('checkedAt',c.admit())
    def test_legacy_success_without_outer_predecessor_is_not_admission(self):
        c=R5Case('within-grace')
        with self.assertRaises((RuntimeError,TypeError)):c.run()
        self.assertEqual(c.io.popen_calls,[])
    def test_schema_extra_nan_bool_and_expired_rejected(self):
        for change in ('extra','bool','expired','decision-drift'):
            c=R5Case()
            if change=='extra':c.a['skipStartup']=True
            if change=='bool':c.a['schemaVersion']=True
            if change=='expired':c.io.clock_value=161
            if change=='decision-drift':c.a['codePins']['supervisorSourceTIP']='1'*40
            with self.subTest(change=change),self.assertRaises(RuntimeError):c.admit()
    def test_check_only_real_new_logic_explicit_legacy_boundary_never_writes_or_launches(self):
        c=R5Case();result=c.run(check_only=True)
        self.assertEqual(result['classification'],'read-only-integration-passed')
        self.assertEqual(c.io.operational_writes,[]);self.assertEqual(c.io.popen_calls,[])
        calls=[x for x in c.io.calls if x in ('current-gate-explicit-fake','source-pins-explicit-fake','fresh-known-and-idle')]
        self.assertEqual(calls,['fresh-known-and-idle','current-gate-explicit-fake','source-pins-explicit-fake','fresh-known-and-idle'])
    def test_check_only_fresh_current_gate_but_expired_after_source_rejected(self):
        c=R5Case();c.source_elapsed=61
        with self.assertRaises(RuntimeError):c.run(check_only=True)
        self.assertEqual(c.io.operational_writes,[])
    def test_check_only_original_source_failure_propagates(self):
        c=R5Case();c.source_error=True
        with self.assertRaises(RuntimeError):c.run(check_only=True)
        self.assertEqual(c.io.operational_writes,[])


def actual_main_fixture(case, failure=None, gap=True):
    """Run original main code; fake external R4 gates, filesystem and process IO.

    Registry/Diagnostics/producer/consumer and original main stages are actual.
    Rows and business terminal validators are explicit external legacy boundaries.
    This is not the complete historical/live R4 successful gate chain.
    """
    loaded=case.boundary();ns=loaded.original;io=case.io
    case.runtime['validUntilEpochMs']=9999999999999
    raw=r5.compact(case.runtime);case.pins['runtimeManifestSHA256']=r5.sha(raw)
    case.io.files[str(case.folder/'runtime-manifest.json')]=(raw,0o600)
    case.a['legacyAttempt']=io.put(case.folder/'attempt.json',case.pins);case.reseal()
    class VPath:
        def __init__(self,path):self.path=Path(str(path))
        def __truediv__(self,part):return VPath(self.path/part)
        def __str__(self):return str(self.path)
        def __fspath__(self):return str(self.path)
        def exists(self):return io.exists(str(self))
        def chmod(self,mode):io.calls.append('fake-output-chmod')
        def lstat(self):return types.SimpleNamespace(st_size=len(io.files.get(str(self),(b'',0o600))[0]))
    ctx=(VPath(case.folder),*case.context[1:])
    boundary_context=ns.attempt_context
    def context(args,admission=False):boundary_context(args,admission=admission);return ctx
    ns.attempt_context=context
    parsed=types.SimpleNamespace(attempt_dir=str(case.folder),attempt_sha256=case.a['legacyAttempt']['sha256'])
    ns.parser=lambda _:types.SimpleNamespace(parse_args=lambda:parsed)
    ns.time=types.SimpleNamespace(time=io.clock,monotonic=io.clock,sleep=lambda _:None)
    ns.os=types.SimpleNamespace(umask=lambda _:None)
    ns.pathlib=types.SimpleNamespace(Path=VPath)
    def tempdir(prefix,dir):
        io.calls.append('original-tempdir-position')
        path=Path(str(dir))/(prefix+'fixture')
        io.files[str(path/'session/samples.jsonl')]=(b'',0o600)
        return str(path)
    ns.tempfile=types.SimpleNamespace(mkdtemp=tempdir)
    ns.regular=lambda path,limit=1048576:io.read_file(str(path),limit)
    def jsonwrite(path,value):
        io.write_exclusive(str(path),r5.compact(value));return r5.sha(r5.compact(value))
    ns.jsonwrite=jsonwrite
    ns.load_passive_validators=lambda:types.SimpleNamespace()
    ns.load_owned=lambda:types.SimpleNamespace(Registry=load_registry(io.clock))
    ns.process_identity=lambda pid,kind:case.history['services']['host']
    ns.preserved_gate=lambda:None
    ns.readiness_facts=lambda:{'fixtureBoundary':True}
    ns.viewer_source_tip=lambda:r5.PINS['viewerSourceTIP']
    class Rows:
        def __init__(self,path):self.path=path;self.pending=b'';self.offset=0
        def read(self):return []
    ns.Rows=Rows
    ns.ObservationGate=lambda *args:types.SimpleNamespace(failure=None,reject=lambda:None)
    def integrity(*args):
        if failure=='runtime':raise RuntimeError('explicit runtime boundary')
        return {'health':{'viewerCount':0,'relayViewerCount':0,'observedAtEpoch':io.clock()}}
    ns.qualification_integrity=integrity
    def completed(*args):
        if failure=='terminal':raise RuntimeError('explicit terminal boundary')
        return {'scope':'explicit-fake-legacy-terminal-boundary'}
    ns.completed_result=completed
    process_state={'after':False,'final':False,'polled':False}
    class Process:
        pid=71
        def create_time(self):return 10.
        def status(self):return 'running'
        def children(self,recursive=False):
            process_state['after']=True
            if gap:raise NoSuchProcess(71)
            return []
        def terminate(self):raise AssertionError('no signal')
        def kill(self):raise AssertionError('no signal')
    process=Process()
    def resolve(pid):
        if process_state['final'] or (gap and process_state['after']):raise NoSuchProcess(pid)
        return process
    fake_psutil=types.SimpleNamespace(Process=resolve,NoSuchProcess=NoSuchProcess,AccessDenied=AccessDenied,STATUS_ZOMBIE='zombie')
    importer=ns.__dict__['__builtins__']['__import__']
    ns.__dict__['__builtins__']=dict(ns.__dict__['__builtins__'],__import__=lambda name,*args,**kw:fake_psutil if name=='psutil' else importer(name,*args,**kw))
    class Worker:
        pid=71
        def poll(self):
            if not process_state['polled']:
                io.clock_value+=300;process_state['polled']=True;process_state['final']=True
            return 1 if failure=='worker' else 0
        def wait(self,timeout):return self.poll()
    def popen(argv,**kw):
        io.popen_calls.append(argv)
        if argv[0]=='/usr/bin/sample':raise AssertionError('sample must not start')
        return Worker()
    ns.subprocess=types.SimpleNamespace(Popen=popen,DEVNULL=-3,PIPE=-1,STDOUT=-2,TimeoutExpired=TimeoutError)
    ns.main=types.FunctionType(case.loaded.original.main.__code__,vars(ns))
    return loaded


class MainWiringTests(unittest.TestCase):
    def test_actual_main_proof_preserves_legacy_gap_and_outer_one_use(self):
        c=R5Case();loaded=actual_main_fixture(c)
        result=c.run(loaded=loaded)
        self.assertEqual(result['classification'],'observed-qualification-completed',result)
        legacy=r5.loads(c.io.files[str(c.folder/'qualification-result.json')][0])
        self.assertIn('observation-unavailable',legacy['owned']['coverage'])
        self.assertEqual(legacy['observedUnexpectedCoverage']['worker'],['observation-unavailable'])
        self.assertEqual(result['fullProcessTreeExit'],'unknown')
        self.assertEqual(result['coverageAssessment']['checkedProofs'],1)
        self.assertEqual(len(c.io.popen_calls),1)
        self.assertEqual(legacy['durationSeconds'],300);self.assertEqual(legacy['workerDeadlineSeconds'],428)
        with self.assertRaises(RuntimeError):c.run(loaded=loaded)
        self.assertEqual(len(c.io.popen_calls),1)
        calls=c.io.calls
        self.assertEqual(calls.count('current-gate-explicit-fake'),2)
        self.assertEqual(calls.count('source-pins-explicit-fake'),2)
        startup=calls.index('source-pins-explicit-fake')
        self.assertLess(startup,calls.index('original-tempdir-position'))
    def test_actual_main_no_gap_success_uses_same_prospective_consumer(self):
        c=R5Case();result=c.run(loaded=actual_main_fixture(c,gap=False))
        self.assertEqual(result['classification'],'observed-qualification-completed',result)
        self.assertEqual(result['coverageAssessment']['checkedProofs'],0)
    def test_main_fresh_at_current_but_expired_after_source_never_popen(self):
        c=R5Case();c.source_elapsed=61
        result=c.run(loaded=actual_main_fixture(c))
        self.assertEqual(result['classification'],'failed-or-indeterminate')
        self.assertEqual(c.io.popen_calls,[])
        self.assertFalse(any(p.endswith('qualification-started.json') for p in c.io.operational_writes))
    def test_main_occupied_source_runtime_worker_terminal_failures_propagate(self):
        for failure in ('occupied','source','runtime','worker','terminal'):
            c=R5Case();c.gate_error=failure=='occupied';c.source_error=failure=='source'
            result=c.run(loaded=actual_main_fixture(c,failure=failure))
            self.assertEqual(result['classification'],'failed-or-indeterminate',failure)
            if failure in ('occupied','source'):self.assertEqual(c.io.popen_calls,[])
            if failure in ('occupied','source'):
                self.assertFalse(any(p.endswith('terminal-proof.json') for p in c.io.operational_writes))
    def test_source_hook_calls_original_even_on_extra_call_and_late_final_is_valid(self):
        c=R5Case();loaded=c.boundary();args=types.SimpleNamespace(attempt_dir=str(c.folder),attempt_sha256=c.a['legacyAttempt']['sha256'])
        loaded.original.attempt_context(args,admission=True)
        main,state=r5.bind_main(loaded,c.a,c.context,c.history,io=c.io,wall=c.io.clock,monotonic=c.io.clock)
        source=main.__globals__['source_pins'];source(args,c.sequence)
        c.io.clock_value+=10800
        c.io.put(c.folder/'qualification-started.json',{'sequenceId':c.a['sequenceId'],'attemptId':c.a['attemptId'],
                 'scenario':c.a['scenario'],'attemptSHA256':c.a['legacyAttempt']['sha256'],'runtimeManifestSHA256':c.pins['runtimeManifestSHA256'],
                 'oneUse':True,'epoch':101,'outputDirectory':str(c.folder/'ordinary-baseline-fixture'),
                 'productTIP':r5.PINS['productTIP'],'toolTIP':r5.PINS['deployedToolTIP'],'sourceTIP':r5.PINS['sourceTIP'],
                 'viewerSourceTIP':r5.PINS['viewerSourceTIP'],'failedHistory':r5.FAILURES[:3],'priorFailureSHA256':r5.FAILURES[2]})
        source(args,c.sequence)
        self.assertEqual(state['sourceCalls'],2)
        before=c.io.calls.count('source-pins-explicit-fake')
        with self.assertRaises(RuntimeError):source(args,c.sequence)
        self.assertEqual(c.io.calls.count('source-pins-explicit-fake'),before+1)
    def test_source_hook_preexisting_foreign_missing_marker_fail_closed(self):
        for change in ('preexisting','missing-final','foreign-final'):
            c=R5Case();loaded=c.boundary();args=types.SimpleNamespace(attempt_dir=str(c.folder),attempt_sha256=c.a['legacyAttempt']['sha256'])
            loaded.original.attempt_context(args,admission=True)
            main,state=r5.bind_main(loaded,c.a,c.context,c.history,io=c.io,wall=c.io.clock,monotonic=c.io.clock)
            source=main.__globals__['source_pins']
            if change=='preexisting':
                c.io.put(c.folder/'qualification-started.json',{})
                with self.assertRaises(RuntimeError):source(args,c.sequence)
            else:
                source(args,c.sequence)
                if change=='foreign-final':c.io.put(c.folder/'qualification-started.json',{'sequenceId':'f'*32})
                with self.assertRaises((RuntimeError,KeyError,FileNotFoundError)):source(args,c.sequence)
    def test_worker_missing_proof_extra_gap_and_sample_gap_are_real_consumer_vetoes(self):
        for change in ('missing-proof','extra-gap','sample-gap'):
            c=R5Case();loaded=actual_main_fixture(c)
            original_invoke=c.io.invoke_main
            def invoke(main,args):
                coverage=main.__globals__['validate_owned_coverage']
                def tamper(worker,sample):
                    if change=='sample-gap':sample['coverage'].append('observation-unavailable')
                    if change=='extra-gap':worker['coverage'].append('new-unproved-gap')
                    if change=='missing-proof':
                        # Suppress producer proof only at the explicit fault injection
                        # boundary; the downstream real consumer must reject raw gap.
                        closure={name:cell.cell_contents for name,cell in zip(coverage.__code__.co_freevars,coverage.__closure__)}
                        closure['state']['registry']._proofs=[]
                    return coverage(worker,sample)
                main.__globals__['validate_owned_coverage']=tamper
                return original_invoke(main,args)
            c.io.invoke_main=invoke
            result=c.run(loaded=loaded)
            self.assertEqual(result['classification'],'failed-or-indeterminate',change)
            legacy=r5.loads(c.io.files[str(c.folder/'qualification-result.json')][0])
            self.assertEqual(legacy['validationStages']['firstFailedStage'],'coverage')
    def test_original_final_source_failure_preserves_partial_assessment_but_never_passes(self):
        c=R5Case();loaded=actual_main_fixture(c)
        source=loaded.original.source_pins; calls=[]
        def fail_final(args,sequence):
            calls.append(1)
            if len(calls)==2:raise RuntimeError('explicit final source boundary')
            return source(args,sequence)
        loaded.original.source_pins=fail_final
        result=c.run(loaded=loaded)
        self.assertEqual(result['classification'],'failed-or-indeterminate')
        self.assertEqual(len(calls),2)
        self.assertEqual(result['coverageAssessment']['checkedProofs'],1)
        legacy=r5.loads(c.io.files[str(c.folder/'qualification-result.json')][0])
        self.assertEqual(legacy['validationStages']['firstFailedStage'],'source-pins')
    def test_nonfinite_bool_and_backward_clock_pairs_fail_closed(self):
        for value in (True,float('nan'),float('inf'),-1):
            with self.subTest(value=value),self.assertRaises(RuntimeError):
                r5._clock_window({'wall':100,'monotonic':100},{'wall':value,'monotonic':101})

    def test_original_main_and_budgets_unchanged_and_only_three_bindings(self):
        c=R5Case();main,state=r5.bind_main(c.loaded,c.a,c.context,c.history,io=c.io,wall=c.io.clock,monotonic=c.io.clock)
        self.assertIs(main.__code__,c.loaded.original.main.__code__)
        for name in ('attempt_context','ready_context','current_gate'):
            self.assertIs(main.__globals__[name],getattr(c.loaded.modules['continuation_common'],name))
        self.assertEqual(main.__globals__['BUDGET'],dict(zip(r5.SCENARIOS,r5.BUDGET)))
        changed={key for key,value in main.__globals__.items() if value is not vars(c.loaded.original).get(key)}
        self.assertEqual(changed,{'source_pins','instrument_registry','validate_owned_coverage'})


def advance_case(previous,scenario):
    c=R5Case(scenario); c.io=previous.io
    index=r5.SCENARIOS.index(scenario)
    attempt=('d','e','f')[index-1]*32;nonce=str(index)*32
    c.a['attemptId']=attempt;c.a['runNonce']=nonce
    c.folder=r5.R4/('sequence-'+c.a['sequenceId'])/'attempts'/attempt
    c.pins=dict(c.pins,attemptId=attempt,runNonce=nonce)
    c.runtime=dict(c.runtime,runNonce=nonce)
    legacy_path=previous.folder/'qualification-result.json'
    legacy_ref={'path':str(legacy_path),'sha256':r5.sha(c.io.files[str(legacy_path)][0])}
    c.pins['decision']=c.io.put('/fixture/legacy-decision-'+attempt+'.json',{'previousResult':legacy_ref})
    previous_path=previous.path.parent/'r5-result.json'
    c.a['previousResult']={'path':str(previous_path),'sha256':r5.sha(c.io.files[str(previous_path)][0])}
    c.a['legacyAttempt']=c.io.put(c.folder/'attempt.json',c.pins)
    c.context=(c.folder,c.sequence,c.ref,c.pins,c.runtime);c.reseal()
    return c


class SequenceAndIOTests(unittest.TestCase):
    def test_later_scenarios_require_full_outer_and_legacy_chain_and_recovery_has_no_sample(self):
        c=R5Case();self.assertEqual(c.run(loaded=actual_main_fixture(c))['classification'],'observed-qualification-completed')
        for scenario in r5.SCENARIOS[1:]:
            c=advance_case(c,scenario)
            result=c.run(loaded=actual_main_fixture(c))
            self.assertEqual(result['classification'],'observed-qualification-completed',result)
            legacy=r5.loads(c.io.files[str(c.folder/'qualification-result.json')][0])
            if scenario in ('within-grace','after-grace'):
                self.assertFalse(legacy['sampleTriggered']);self.assertFalse(legacy['samplingEnabled'])
                self.assertEqual(legacy['durationSeconds'],390);self.assertEqual(legacy['workerDeadlineSeconds'],518)
            else:
                self.assertEqual(legacy['durationSeconds'],10800);self.assertEqual(legacy['workerDeadlineSeconds'],10928)
        self.assertEqual(len(c.io.popen_calls),4)
        self.assertFalse(any(argv[0]=='/usr/bin/sample' for argv in c.io.popen_calls))
    def test_predecessor_outer_or_proof_or_marker_loss_rejects_before_next_worker(self):
        for missing in ('r5-result.json','terminal-proof.json','r5-started.json'):
            c=R5Case();c.run(loaded=actual_main_fixture(c));next_case=advance_case(c,'within-grace')
            c.io.files[str(c.path.parent/missing)]=(b'{}',0o600)
            with self.subTest(missing=missing),self.assertRaises(RuntimeError):next_case.run()
            self.assertEqual(len(c.io.popen_calls),1)
    def test_outer_success_cannot_be_inferred_when_legacy_result_is_missing(self):
        c=R5Case();loaded=actual_main_fixture(c);original=c.io.invoke_main
        def invoke(main,args):
            code=original(main,args);c.io.files.pop(str(c.folder/'qualification-result.json'));return code
        c.io.invoke_main=invoke
        result=c.run(loaded=loaded)
        self.assertEqual(result['classification'],'failed-or-indeterminate')
        self.assertIsNone(result['legacyResult'])
    def test_check_only_and_fresh_run_can_use_distinct_immutable_outer_inputs(self):
        c=R5Case();c.run(check_only=True);old_path=c.path;old_bytes=c.io.files[str(old_path)][0];old_decision=c.a['rootDecision'];old_decision_bytes=c.io.read_record(old_decision)
        c.a['rootDirectory']='/fixture/r5-run';c.io.clock_value+=1;c.reseal()
        result=c.run(loaded=actual_main_fixture(c))
        self.assertEqual(result['classification'],'observed-qualification-completed')
        self.assertEqual(c.io.files[str(old_path)][0],old_bytes)
        self.assertEqual(c.io.read_record(old_decision),old_decision_bytes)
        self.assertFalse(any(p.startswith('/fixture/r5/') for p in c.io.operational_writes))
    def test_production_io_regular_mode_symlink_and_exclusive_behavior_on_temporary_fixture_only(self):
        io=r5.ProductionIO()
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder).resolve();folder.chmod(0o700)
            target=folder/'record.json';io.write_exclusive(str(target),b'{}')
            self.assertEqual(io.read_file(str(target),2),(b'{}',0o600))
            with self.assertRaises(FileExistsError):io.write_exclusive(str(target),b'{}')
            link=folder/'alias.json';link.symlink_to(target)
            with self.assertRaises(RuntimeError):io.read_file(str(link),2)
            target.chmod(0o644)
            with self.assertRaises(RuntimeError):io.read_record({'path':str(target),'sha256':r5.sha(b'{}')})
    def test_bounded_json_stdout_nonfinite_and_no_argument_cli(self):
        with self.assertRaises(RuntimeError):r5.loads(b'{"a":NaN}')
        with self.assertRaises(RuntimeError):r5.loads(b'{"a":1,"a":2}')
        output=r5._BoundedOutput();output.write('x'*32768)
        output.write('x');self.assertTrue(output.truncated);self.assertEqual(output.count,32768)
        with patch.object(r5,'run_one_attempt') as run, r5.contextlib.redirect_stderr(r5.stringio.StringIO()):
            with self.assertRaises(SystemExit) as raised:r5.cli([])
            self.assertEqual(raised.exception.code,2);run.assert_not_called()
    def test_production_known_observation_uses_only_fake_exact_pids_and_original_service_boundary(self):
        c=R5Case();calls=[]
        def absent(pid):calls.append(pid);raise NoSuchProcess(pid)
        fake=types.SimpleNamespace(Process=absent,NoSuchProcess=NoSuchProcess)
        legacy=types.SimpleNamespace(service_set=lambda:c.history['services'],health=lambda **kw:{'viewerCount':0,'relayViewerCount':0})
        with patch.dict(sys.modules,{'psutil':fake}):
            value=r5.ProductionIO().observe_known(c.history['knownIdentities'],c.history['services'],legacy,c.io.clock,c.io.clock)
        self.assertEqual(calls,[row['pid'] for row in c.history['knownIdentities']])
        self.assertEqual(value['idle']['lsofTimeoutSeconds'],5)
        r5._check_observation(value,c.history['knownIdentities'],c.history['services'],value['started'],c.io.clock,c.io.clock)
    def test_actual_supervisor_code_pin_gate_with_fake_git_and_file_io(self):
        payload=b'fixture source bytes only'
        pins={'supervisorSourceTIP':'9'*40,'files':{name:r5.sha(payload) for name in r5.CODE_FILES}}
        io=r5.ProductionIO();calls=[]
        def fake_run(argv,**kwargs):
            calls.append((argv,kwargs))
            return types.SimpleNamespace(returncode=0,stdout=(pins['supervisorSourceTIP']+'\n').encode() if argv[-2:]==['rev-parse','HEAD'] else payload)
        with patch.object(io,'read_file',return_value=(payload,0o644)),patch.object(r5.subprocess,'run',side_effect=fake_run):
            io.verify_code(pins)
            self.assertEqual(len(calls),3)
            self.assertTrue(all(kwargs['timeout']==30 and '--no-replace-objects' in argv for argv,kwargs in calls))
            bad=deepcopy(pins);bad['files'][r5.CODE_FILES[0]]='0'*64
            with self.assertRaises(RuntimeError):io.verify_code(bad)
        with patch.object(r5.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=b'0'*40+b'\n')):
            with self.assertRaises(RuntimeError):io.verify_code(pins)
    def test_cli_diagnostic_is_bounded_and_does_not_echo_untrusted_error(self):
        stdout=r5.stringio.StringIO()
        with patch.object(r5,'run_one_attempt',side_effect=RuntimeError('fixture-sensitive-message')),r5.contextlib.redirect_stdout(stdout):
            code=r5.cli(['--r5-attempt','/fixture/input.json','--r5-attempt-sha256','a'*64,'--check-only'])
        self.assertEqual(code,2);self.assertLessEqual(len(stdout.getvalue().encode()),32768)
        self.assertNotIn('fixture-sensitive-message',stdout.getvalue())
        self.assertEqual(json.loads(stdout.getvalue())['errorClass'],'RuntimeError')

    def test_clock_reversal_between_admission_stages_is_sticky(self):
        values=iter([100,101,100.5]);clock=r5._nondecreasing(lambda:next(values))
        self.assertEqual(clock(),100);self.assertEqual(clock(),101)
        with self.assertRaises(RuntimeError):clock()


if __name__ == '__main__':
    unittest.main()
