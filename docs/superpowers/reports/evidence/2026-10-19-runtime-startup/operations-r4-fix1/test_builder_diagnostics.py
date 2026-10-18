"""Actual child_owned/Registry/consumer AST, injected clocks/process/Popen/I/O only."""
import ast,hashlib,json,math,pathlib,types,unittest
from contextlib import contextmanager
from copy import deepcopy
ROOT=pathlib.Path(__file__).resolve().parent
OLD=pathlib.Path('/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r2-orrzbxl6')
SUP=pathlib.Path('/tmp/wrd-owned-turn-probe-private/supervisor.py')
INHERENT={'polling-may-miss-fast-orphan','macos-check-to-signal-race','no-CDP-no-manager-proxy'}
class NoSuchProcess(Exception):pass
class AccessDenied(Exception):pass
class Unsupported(Exception):pass
class Clock:
 def __init__(self):self.value=100.
 def time(self):return self.value+1000
 def monotonic(self):return self.value
 def sleep(self,n):self.value+=n

def need(ok,message):
 if not ok:raise ValueError(message)
def exact(value,keys):need(type(value) is dict and set(value)==set(keys),'exact keys required')
def sha(value):return hashlib.sha256(value).hexdigest()
def extract(path,names,scope,strip_import=False):
 nodes=[n for n in ast.parse(path.read_bytes()).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names];assert len(nodes)==len(names)
 if strip_import:
  for n in nodes:n.body=[v for v in n.body if not isinstance(v,(ast.Import,ast.ImportFrom))]
 exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path)+'#pure-AST','exec'),scope)

class Forest:
 def __init__(self,clock,mode,error):self.clock=clock;self.mode=mode;self.error=error;self.end=110. if mode=='overflow' else 101.;self.ledger=[];self.counts={};self.dead=set();self.objects={p:Process(self,p) for p in (1,2)}
 def call(self,pid,op,*args):
  self.ledger.append((pid,op,args));key=(pid,op);self.counts[key]=self.counts.get(key,0)+1;n=self.counts[key]
  if op=='resolve':
   if self.mode=='state-error' and pid==1 and n==2:raise AccessDenied()
   if self.clock.value>=self.end or pid in self.dead:raise NoSuchProcess()
   return self.objects[pid]
  if op=='pid':return pid
  if op=='create_time':return pid*10.
  if op=='status':return 'running'
  if op=='ppid':return 1
  if op=='children':
   if pid==1 and (n==2 and self.error is not None or self.mode=='overflow' and n>=2):raise self.error
   return [self.objects[2]] if pid==1 else []
  if op in ('terminate','kill'):self.dead.add(pid);return None
  raise AssertionError(op)
 def process(self,pid):return self.call(pid,'resolve')
class Process:
 def __init__(self,f,p):self.f=f;self.ident=p
 @property
 def pid(self):return self.f.call(self.ident,'pid')
 def create_time(self):return self.f.call(self.ident,'create_time')
 def status(self):return self.f.call(self.ident,'status')
 def children(self,recursive=False):return self.f.call(self.ident,'children',recursive)
 def ppid(self):return self.f.call(self.ident,'ppid')
 def terminate(self):return self.f.call(self.ident,'terminate')
 def kill(self):return self.f.call(self.ident,'kill')

class BuilderDiagnostics(unittest.TestCase):
 def run_child(self,wrapped,mode='normal',error=None):
  clock=Clock();forest=Forest(clock,mode,error);fakeps=types.SimpleNamespace(Process=forest.process,NoSuchProcess=NoSuchProcess,AccessDenied=AccessDenied,STATUS_ZOMBIE='zombie');regscope={'time':clock,'psutil':fakeps,'POLL':.25}
  self.assertEqual(sha(SUP.read_bytes()),'d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b');extract(SUP,{'Registry','Capacity'},regscope)
  diag={'contextmanager':contextmanager,'deepcopy':deepcopy,'math':math};raw=(ROOT/'process_observation_diagnostics.py').read_bytes();self.assertEqual(sha(raw),'00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b');nodes=[n for n in ast.parse(raw).body if isinstance(n,(ast.Assign,ast.ClassDef,ast.FunctionDef))];exec(compile(ast.Module(body=nodes,type_ignores=[]),'approved-diagnostic-definitions','exec'),diag)
  class Child:
   pid=1
   def poll(self):return -15 if 1 in forest.dead else 0 if clock.value>=forest.end else None
  child=Child();popen=[]
  def launch(*args,**kw):popen.append((args,kw));return child
  scope={'time':clock,'psutil':fakeps,'subprocess':types.SimpleNamespace(Popen=launch,DEVNULL=-3),'R':pathlib.Path('/private-fixture'),'NODE':'/fake/node','ENV':{},'INHERENT':INHERENT,'Diagnostics':diag['Diagnostics'],'instrument_registry':diag['instrument_registry']}
  extract((ROOT if wrapped else OLD)/'build_primitives.py',{'child_owned'},scope,True)
  record,ok=scope['child_owned'](pathlib.Path('/fake/build'),123,types.SimpleNamespace(Registry=regscope['Registry'],Capacity=regscope['Capacity']))
  self.assertEqual(len(popen),1);return record,ok,forest.ledger
 def pair(self,mode='normal',error=None):
  old,oldok,oldcalls=self.run_child(False,mode,error);new,newok,newcalls=self.run_child(True,mode,error);self.assertEqual(oldcalls,newcalls);self.assertEqual({k:new[k] for k in old},old);return new,newok,oldok
 def test_actual_child_positive_exact_calls_and_lifecycle(self):
  r,ok,oldok=self.pair();self.assertTrue(ok and oldok);self.assertFalse(r['processDiagnostics']['failed']);self.assertEqual(r['processDiagnostics']['events'],[]);self.assertEqual(r['ownership']['signals'],[]);self.assertEqual(r['elapsedSeconds'],4.);self.assertGreater(r['processDiagnostics']['expectedStateExitCounts']['result'],0)
 def test_actual_child_scan_exceptions_still_fail_unchanged_coverage(self):
  for error in (NoSuchProcess(),AccessDenied(),OSError(5,'injected')):
   r,ok,oldok=self.pair(error=error);self.assertFalse(ok or oldok);self.assertEqual(r['unexpectedCoverage'],['observation-unavailable']);self.assertEqual(r['ownership']['signals'],[]);self.assertFalse(r['processDiagnostics']['failed']);self.assertEqual(r['processDiagnostics']['events'][0]['context'],'scan')
 def test_supported_state_error_is_event_not_automatic_failure(self):
  r,ok,oldok=self.pair('state-error');self.assertTrue(ok and oldok);self.assertEqual(r['unexpectedCoverage'],[]);self.assertFalse(r['processDiagnostics']['failed']);self.assertEqual(r['processDiagnostics']['events'][0]['exception'],'AccessDenied');self.consumer(r)
 def test_actual_child_unsupported_and_overflow_veto(self):
  for mode,error in [('normal',Unsupported()),('overflow',AccessDenied())]:
   r,ok,oldok=self.pair(mode,error);self.assertFalse(ok);self.assertTrue(r['processDiagnostics']['failed'])
   if mode=='overflow':self.assertEqual(len(r['processDiagnostics']['events']),32);self.assertTrue(r['processDiagnostics']['overflow']['events'])
 def consumer(self,child):
  f=pathlib.Path('/fake/deployment');d=f/'two-time-template-fixture';m={'codeHashes':{},'tip':'source','windowLowerMs':1,'windowUpperMs':2};t={'codeHashes':{},'kind':'frontend-two-time-template','tip':'source','frozenSHA256':'f'*64,'windowLowerMs':1,'windowUpperMs':2,'directoryModes':{'assets':493},'files':{'asset':{'filesystemMode':420,'templateSha256':sha(b'asset')}}};v={'schemaVersion':1,'frozenSHA256':'f'*64,'templateRelativePath':d.name,'templateSHA256':'t'*64,'buildResultSHA256':'b'*64,'independentReview':{'path':'/fake/review','sha256':'r'*64}};result={'classification':'private-two-time-template-frozen','frozenSHA256':'f'*64,'templateSHA256':'t'*64,'templateDirectory':str(d),'children':[{'endpoint':e,'result':deepcopy(child)} for e in ('lower','upper')]};data={str(d/'template.json'):t,str(f/'build-result.json'):result,'/fake/asset-review':v}
  scope={'need':need,'exact':exact,'math':math,'json':json,'INHERENT':INHERENT,'frozen':lambda *a,**k:(f,m,{},{}),'private_json':lambda path,*a:deepcopy(data[str(path)]),'check_ref':lambda v:None,'relative':lambda s:s,'checked_file':lambda *a:(b'asset',420),'sha':sha}
  extract(ROOT/'bindings.py',{'validate_owned_coverage','validate_no_signals'},scope);extract(ROOT/'deployment.py',{'validate_builder_diagnostics','asset_context'},scope)
  return scope['asset_context'](types.SimpleNamespace(frozen_dir=str(f),frozen_sha256='f'*64,asset_review='/fake/asset-review',asset_review_sha256='a'*64))
 def test_actual_asset_consumer_accepts_valid_snapshot(self):self.assertEqual(len(self.consumer(self.run_child(True)[0])),7)
 def test_actual_asset_consumer_missing_failed_malformed_reject(self):
  base=self.run_child(True)[0]
  for case in ('missing','null','failed','overflow','schema-bool','role','extra-key','dropped','count-bool','limits','oversized','event-malformed','snapshot-error'):
   child=deepcopy(base);diag=child['processDiagnostics']
   if case=='missing':del child['processDiagnostics']
   elif case=='null':child['processDiagnostics']=None
   elif case=='failed':diag['failed']=True
   elif case=='overflow':diag['overflow']['events']=True
   elif case=='schema-bool':diag['schemaVersion']=True
   elif case=='role':diag['role']='sample'
   elif case=='extra-key':diag['extra']=1
   elif case=='dropped':diag['dropped']=1
   elif case=='count-bool':diag['expectedStateExitCounts']['cleanup']=True
   elif case=='limits':diag['limits']['events']=33
   elif case=='oversized':diag['events']=[{}]*33
   elif case=='event-malformed':diag['events']=[{}]
   elif case=='snapshot-error':child['diagnosticsErrorClass']='RuntimeError'
   with self.subTest(case=case),self.assertRaises(ValueError):self.consumer(child)
 def test_consumer_preserves_coverage_and_signals_veto(self):
  for field,value in [('coverage',list(INHERENT)+['observation-unavailable']),('signals',[{'kind':'term'}])]:
   child=self.run_child(True)[0];child['ownership'][field]=value
   with self.assertRaises(ValueError):self.consumer(child)
if __name__=='__main__':unittest.main()
