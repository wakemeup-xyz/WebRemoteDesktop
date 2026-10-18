"""Pure AST-injected schema/lineage checks. No operational package imports."""
import ast,copy,hashlib,json,math,pathlib,re,types,unittest
ROOT=pathlib.Path(__file__).resolve().parent
PRODUCT='d'*40;VIEWER='c'*40;FINAL='a'*40;TOOL='b'*40
FAILURES=['1'*64,'2'*64,'3'*64]
def need(value,reason):
 if not value:raise RuntimeError(reason)
def exact(value,keys):need(type(value) is dict and set(value)==set(keys),'exact')
def valid_sha(v):return type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None
def hex32(v):need(type(v) is str and re.fullmatch('[a-f0-9]{32}',v),'id')
def load(file,names,**injected):
 source=(ROOT/file).read_bytes();tree=ast.parse(source);nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names];assert len(nodes)==len(names)
 scope=dict(need=need,exact=exact,valid_sha=valid_sha,hex32=hex32,math=math,time=types.SimpleNamespace(time=lambda:1000.,monotonic=lambda:500.),PRODUCT=PRODUCT,VIEWER_TIP=VIEWER,FINAL_TIP=FINAL,viewer_source_tip=lambda:VIEWER,final_source_tip=lambda:FINAL,TOOL_TIP=TOOL,PRIOR_FAILURE=FAILURES[-1],FAILURES=FAILURES,SCENARIOS=('baseline','within-grace','after-grace','continuity'),BUDGET={'baseline':300,'within-grace':390,'after-grace':390,'continuity':10800},sha=lambda b:hashlib.sha256(b).hexdigest(),**injected)
 exec(compile(ast.Module(body=nodes,type_ignores=[]),'pure-guard-definitions','exec'),scope);return scope
class Guards(unittest.TestCase):
 def runtime(self):
  manifest=dict(schemaVersion=1,runNonce='a'*32,createdAtEpochMs=1000000,validUntilEpochMs=1600000,scenario='baseline',mode='relay',originSource='formal-configured',originEvidenceSha256='1'*64,originSha256=hashlib.sha256(b'https://link.stockhub.wiki').hexdigest(),deploymentEvidence={'kind':'root-verified-local-deployment','sha256':'2'*64},signal={'sourceCommit':PRODUCT,'sourceTreeSha256':'s'},host={'sourceCommit':PRODUCT,'sourceTreeSha256':'h'},viewer={'sourceCommit':VIEWER,'buildId':'build'},signalLog={'path':'/fake/log','device':1,'inode':2})
  return manifest,{'sourceTIP':FINAL},{'componentTrees':{'signal':'s','host':'h'},'assets':{'buildId':'build'},'signalLogPath':'/fake/log'},{'runNonce':'a'*32,'scenario':'baseline','mode':'relay','origin':'https://link.stockhub.wiki'}
 def test_mixed_viewer_commit_stays_deployed_not_new_tool_archive(self):
  f=load('continuation_common.py',('check_runtime_binding',))['check_runtime_binding'];args=self.runtime();f(*args,admission=True)
  for wrong in (FINAL,TOOL):
   bad=copy.deepcopy(args);bad[0]['viewer']['sourceCommit']=wrong
   with self.assertRaises(RuntimeError):f(*bad,admission=True)
 def test_runtime_clock_and_immutable_backend(self):
  f=load('continuation_common.py',('check_runtime_binding',))['check_runtime_binding']
  for key,value in (('createdAtEpochMs',True),('createdAtEpochMs',1000001),('validUntilEpochMs',1200000)):
   args=self.runtime();args[0][key]=value
   with self.assertRaises(RuntimeError):f(*args,admission=True)
  args=self.runtime();args[0]['host']['sourceCommit']=FINAL
  with self.assertRaises(RuntimeError):f(*args)
 def decision(self,scenario='baseline'):
  return dict(schemaVersion=1,kind='root-one-scenario-attempt',sequenceId='a'*32,attemptId='b'*32,runNonce='c'*32,scenario=scenario,mode='relay',origin='https://link.stockhub.wiki',productTIP=PRODUCT,toolTIP=TOOL,priorFailureSHA256=FAILURES[-1],failedHistory=FAILURES,sourceTIP=FINAL,previousResult=None)
 def test_new_baseline_binds_all_three_failures(self):
  f=load('continuation_common.py',('validate_attempt_decision',))['validate_attempt_decision'];m={'sequenceId':'a'*32,'toolTIP':TOOL,'sourceTIP':FINAL};d=self.decision();f(d,m)
  for change in ({'failedHistory':FAILURES[:2]},{'priorFailureSHA256':FAILURES[1]},{'previousResult':{'path':'old','sha256':'0'*64}},{'runNonce':'b'*32}):
   with self.assertRaises(RuntimeError):f(d|change,m)
 def test_next_case_needs_exact_same_sequence_success(self):
  f=load('continuation_common.py',('validate_attempt_decision',))['validate_attempt_decision'];m={'sequenceId':'a'*32,'toolTIP':TOOL,'sourceTIP':FINAL};d=self.decision('within-grace');d['previousResult']={'path':'/fake/result','sha256':'4'*64};prior={'classification':'observed-qualification-completed','scenario':'baseline','sequenceId':'a'*32,'productTIP':PRODUCT,'toolTIP':TOOL,'sourceTIP':FINAL,'failedHistory':FAILURES};f(d,m,prior)
  for change in ({'classification':'failed-or-indeterminate'},{'scenario':'after-grace'},{'sequenceId':'f'*32},{'failedHistory':FAILURES[:2]}):
   with self.assertRaises(RuntimeError):f(d,m,prior|change)
 def history_fixture(self):
  refs={'secondAttempt':{'sha256':'2'*64},'thirdAttempt':{'sha256':'3'*64},'thirdMarker':{'sha256':'4'*64}};records={}
  def result(group):return dict(schemaVersion=1,kind='guarded-ordinary-qualification',scenario='baseline',classification='failed-or-indeterminate',workerExitCode=1,automaticNextRun=False,fullProcessTreeExit='unknown',owned={'allRecordedIdentitiesExited':True,'identities':[{'pid':group*100+i,'birth':float(group*100+i),'status':'exited'} for i in range(1,8)]},sampleOwned={'allRecordedIdentitiesExited':True,'identities':[]})
  first=result(1);marker={'oneUse':True,'scenario':'baseline','epoch':1.}
  for key in ('frozenSHA256','sourcePinsSHA256','runtimeManifestSHA256'):marker[key]=first[key]='1'*64
  b={'historical':{'oldMarker':{'value':marker},'oldFailure':{'value':first}}}
  for group,prefix in ((2,'second'),(3,'third')):
   r=result(group);a=dict(sequenceId=str(group)*32,attemptId=str(group+1)*32,productTIP=PRODUCT,toolTIP=TOOL,runtimeManifestSHA256=str(group)*64);r.update(a,attemptSHA256=refs[prefix+'Attempt']['sha256']);records[prefix+'Attempt']=a;records[prefix+'Failure']=r;records[prefix+'Marker']=dict(a,attemptSHA256=refs[prefix+'Attempt']['sha256'],oneUse=True,scenario='baseline')
  return b,{'records':refs},records
 def known_scope(self,history):
  return load('known_attempt_quiescence.py',('finite','known_from_closed','recorded_identities','all_known'),history=lambda:history,loads=lambda b:b,check_ref=lambda ref:ref['value'])
 def test_exact_21_known_closed_identities_from_three_attempts(self):
  h=self.history_fixture();s=self.known_scope(h);known=s['all_known']();self.assertEqual(len(known),21);self.assertEqual({r['registry'] for r in known},{'1:owned','2:owned','3:owned'})
 def test_missing_third_or_unclosed_or_duplicate_identity_refuses(self):
  for kind in ('missing','unclosed','duplicate'):
   h=self.history_fixture()
   if kind=='missing':h[2]['thirdFailure']['owned']['identities'].pop()
   if kind=='unclosed':h[2]['thirdFailure']['owned']['allRecordedIdentitiesExited']=False
   if kind=='duplicate':h[2]['thirdFailure']['owned']['identities'][0]=copy.deepcopy(h[2]['secondFailure']['owned']['identities'][0])
   with self.assertRaises(RuntimeError):self.known_scope(h)['all_known']()
 def observation(self,status):
  names=('finite','clock_pair','forward','observe_known','validate_observation','fresh_at');s=load('known_attempt_quiescence.py',names,SCOPE='task-known-recorded-identities-only',STATUSES=('running','zombie','dead'),QUIET=('gone','zombie','nonmatching-birth'));known=[{'registry':'3:owned','pid':7,'birthEpoch':7.}];calls=[]
  class Gone(Exception):pass
  def factory(pid):
   calls.append(pid)
   if status=='gone':raise Gone()
   if status=='unknown':raise PermissionError()
   return types.SimpleNamespace(create_time=lambda:8. if status=='reuse' else 7.,status=lambda:'zombie' if status=='zombie' else 'running')
  ob=s['observe_known'](known,factory,Gone,(PermissionError,),wall=lambda:100.,monotonic=lambda:50.);s['validate_observation'](ob,known);self.assertEqual(calls,[7]);return s,ob
 def test_only_known_gone_zombie_reused_are_quiet(self):
  for status in ('gone','zombie','reuse','alive','unknown'):
   _,ob=self.observation(status);self.assertEqual(ob['classification'],'known-identities-quiescent' if status in ('gone','zombie','reuse') else 'refused-alive-or-unknown');self.assertEqual(ob['fullProcessTreeExit'],'unknown')
 def test_receipt_ttl_sixty_and_reversal(self):
  s,ob=self.observation('gone');receipt={'observation':ob};s['fresh_at'](receipt,{'epoch':160.,'monotonic':110.})
  for now in ({'epoch':160.01,'monotonic':110.},{'epoch':99.,'monotonic':50.},{'epoch':100.,'monotonic':49.}):
   with self.assertRaises(RuntimeError):s['fresh_at'](receipt,now)
 def test_static_signal_only_and_precopy_quiescence(self):
  deployment=(ROOT/'deployment.py').read_text();apply=(ROOT/'apply-frontend-context.py').read_text();restart=(ROOT/'restart-signal-frontend.py').read_text();self.assertIn('check();before_replace()',deployment);self.assertIn('before_action(',apply);self.assertIn("'restart-signal'",restart);self.assertNotIn("'restart-local'",restart);self.assertNotIn("'restart-host'",restart);self.assertIn('same Host', (ROOT/'readiness_records.py').read_text())

if __name__=='__main__':unittest.main()
