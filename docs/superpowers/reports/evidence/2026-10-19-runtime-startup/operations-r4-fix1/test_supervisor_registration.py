"""Actual new supervisor AST, fake creation/Registry/clock only; no ops imports."""
import ast,pathlib,types,unittest
ROOT=pathlib.Path(__file__).resolve().parent
class Registration(unittest.TestCase):
 def run_case(self,outcome):
  raw=(ROOT/'ordinary-continuation-supervisor.py').read_bytes();tree=ast.parse(raw);main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main');function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='register_worker');clock=[100.];events=[]
  class Child:
   pid=77
   def poll(self):events.append(('poll',clock[0]));return 0 if outcome=='exit' and clock[0]>=101 else None
  child=Child()
  class Registry:
   def add_root(self,obj):
    events.append(('register',obj))
    if outcome!='normal':raise PermissionError('injected')
   def signal(self,*args):raise AssertionError('unknown child signal forbidden')
  def sleep(seconds):self.assertGreater(seconds,0);self.assertLessEqual(seconds,.25);clock[0]+=seconds
  def popen(*args,**kwargs):events.append(('Popen',clock[0]));return child
  def need(value,reason):
   if not value:raise RuntimeError(reason)
  scope=dict(time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=sleep),subprocess=types.SimpleNamespace(Popen=popen,DEVNULL=-3),worker_diag=types.SimpleNamespace(process=lambda pid:('created-child',pid)),sys=types.SimpleNamespace(executable='/fake/python'),P=pathlib.Path('/fake'),RUNNER='scripts/ordinary_session_recovery.py',pins={'origin':'https://fixture.invalid','mode':'relay'},scenario='baseline',duration=300,started=50.,args=types.SimpleNamespace(runtime_manifest='/fake/runtime',runtime_manifest_sha256='a'*64),out=pathlib.Path('/fake/out'),ENV={},reg=Registry(),need=need,worker=None,worker_registration=None,timeout=False)
  exec(compile(ast.Module(body=[function],type_ignores=[]),'new-register-worker','exec'),scope)
  block=next(n for n in ast.walk(main) if isinstance(n,ast.Try) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='worker' for t in x.targets) for x in n.body));stop=next(i for i,n in enumerate(block.body) if isinstance(n,ast.While))
  try:exec(compile(ast.Module(body=block.body[:stop],type_ignores=[]),'actual-new-supervisor-creation-block','exec'),scope)
  except RuntimeError as exc:self.assertEqual(str(exc),'worker registration failed')
  self.assertIs(scope['worker'],child);self.assertEqual(scope['deadline'],478.);self.assertEqual(events[:2],[('Popen',100.),('register',('created-child',77))]);return scope,clock[0],events
 def test_registration_failure_eventual_exit(self):
  s,clock,events=self.run_case('exit');r=s['worker_registration'];self.assertEqual(clock,101.);self.assertEqual(r['registrationErrorClass'],'PermissionError');self.assertEqual(r['status'],'created-worker-exit-observed');self.assertEqual(r['exitCode'],0);self.assertFalse(r['unresolvedChild']);self.assertFalse(s['timeout'])
 def test_registration_failure_alive_at_original_deadline(self):
  s,clock,events=self.run_case('alive');r=s['worker_registration'];self.assertEqual(clock,478.);self.assertEqual(r['deadlineMonotonic'],478.);self.assertEqual(r['status'],'created-worker-unresolved-at-deadline');self.assertTrue(r['unresolvedChild']);self.assertTrue(s['timeout'])
 def test_normal_registration_has_no_added_wait_or_poll(self):
  s,clock,events=self.run_case('normal');self.assertEqual(clock,100.);self.assertEqual(len(events),2);self.assertTrue(s['worker_registration']['registered']);self.assertIsNone(s['worker_registration']['registrationErrorClass']);self.assertEqual(s['next_progress'],80.)
if __name__=='__main__':unittest.main()
