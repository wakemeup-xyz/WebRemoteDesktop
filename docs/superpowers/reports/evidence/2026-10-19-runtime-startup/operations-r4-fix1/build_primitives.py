import sys
from core import *
from asset_template import *
from process_observation_diagnostics import Diagnostics,instrument_registry
NODE='/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node'

def child_owned(fixture_root,stamp,owned):
 """One attempt; Registry may settle registered child identities only."""
 import psutil
 diagnostic=Diagnostics(psutil.Process,(psutil.NoSuchProcess,psutil.AccessDenied,OSError),'worker',monotonic=time.monotonic,wall=time.time)
 registry=instrument_registry(owned.Registry,diagnostic);child=None;timedout=False;error=None;cleanup_error=None;exitcode=None;ownership={};ownership_error=None;start=time.monotonic()
 env=dict(ENV);env.pop('NODE_OPTIONS',None);env.pop('NODE_PATH',None)
 try:
  child=subprocess.Popen([NODE,str(R/'private-builder-entry.js'),str(fixture_root),str(stamp)],cwd=fixture_root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  registry.add_root(diagnostic.process(child.pid));deadline=start+180
  while child.poll() is None and time.monotonic()<deadline:
   try:registry.scan()
   except owned.Capacity:registry.note('identity-capacity')
   time.sleep(min(.25,max(0,deadline-time.monotonic())))
  if child.poll() is None:timedout=True
 except BaseException as exc:
  error=type(exc).__name__
 finally:
  # A clean Node exit does not establish that its recorded esbuild child exited.
  # Exactly one bounded owned cleanup path, including normal exit and exceptions.
  diagnostic.set_stage('cleanup')
  try:registry.cleanup(grace=0,term_wait=2,kill_wait=1)
  except BaseException as exc2:cleanup_error=type(exc2).__name__
 if child is not None:exitcode=child.poll()
 diagnostic.set_stage('result')
 try:ownership=registry.result()
 except BaseException as exc:ownership_error=type(exc).__name__
 diagnostics=None;diagnostics_error=None
 try:diagnostics=diagnostic.snapshot()
 except BaseException as exc:diagnostics_error=type(exc).__name__
 coverage=ownership.get('coverage');valid=isinstance(coverage,list) and len(coverage)<=64 and all(isinstance(x,str) and len(x)<=128 for x in coverage)
 unexpected=sorted(set(coverage)-INHERENT) if valid else ['invalid-coverage']
 signals=ownership.get('signals');intervened=bool(signals) if isinstance(signals,list) else None
 ok=(intervened is False and exitcode==0 and not timedout and error is None and cleanup_error is None and ownership_error is None and not unexpected and ownership.get('allRecordedIdentitiesExited') is True and ownership.get('completeProcessTreeExitEstablished') is False and diagnostics_error is None and not diagnostic.failed and type(diagnostics) is dict and diagnostics.get('failed') is False)
 return {'processDiagnostics':diagnostics,'diagnosticsErrorClass':diagnostics_error,'helperExit':exitcode,'timedOut':timedout,'errorClass':error,'cleanupErrorClass':cleanup_error,'elapsedSeconds':round(time.monotonic()-start,3),'ownership':ownership,'ownershipErrorClass':ownership_error,'intervened':intervened,'unexpectedCoverage':unexpected[:32],'fullProcessTreeExit':'unknown','classification':'observed-private-build-completed' if ok else 'failed-or-indeterminate'},ok

def compare_outputs(lower_root,upper_root,m,resultdir):
 left=lower_root/'web-client/dist';right=upper_root/'web-client/dist';a=manifest_info(left);b=manifest_info(right)
 need(a['builtAt']==m['windowLowerMs'] and b['builtAt']==m['windowUpperMs'],'endpoint build timestamps mismatch')
 need(a['buildId']==b['buildId'] and a['assets']==b['assets'] and a['retainedReleases']==b['retainedReleases'],'build ID/assets/retention crosses time boundary')
 dm=directory_modes(left);need(dm==directory_modes(right) and all(mode==0o755 for mode in dm.values()),'endpoint directory mode profile mismatch')
 lm,rm=distmap(left),distmap(right);need(set(lm)==set(rm),'endpoint dist path mismatch');files={}
 for rel in sorted(lm):
  lb,lmode=checked_file(left,rel);rb,rmode=checked_file(right,rel);need(lmode==rmode==0o644,'endpoint file mode profile mismatch')
  ln=normalized_file(rel,lb,m['windowLowerMs'],a['buildId']);rn=normalized_file(rel,rb,m['windowUpperMs'],b['buildId'])
  need(ln==rn,'endpoint bytes differ outside current builtAt: '+rel)
  istemplate=rel in ('asset-manifest.json','index.html','viewer.html')
  need(not istemplate or ln.count(TOKEN)==1,'exact current timestamp field required')
  write(resultdir/'expected'/rel,ln)
  files[rel]={'templateSha256':sha(ln),'filesystemMode':lmode,'timestampTemplate':istemplate,'lowerByteSha256':sha(lb),'upperByteSha256':sha(rb)}
 return {'schemaVersion':1,'kind':'frontend-two-time-template','tip':m['tip'],'windowLowerMs':m['windowLowerMs'],'windowUpperMs':m['windowUpperMs'],'buildId':a['buildId'],'assets':a['assets'],'retainedReleases':a['retainedReleases'],'files':files,'installedDependencies':'trusted-existing-installation; directory metadata only','directoryModes':dm,'fileModes':'explicit private child022 predicts files0644/dirs0755; actual startup exact equality required, no fallback','primaryMutated':False,'startupOrReadiness':'NOT_RUN','fullProcessTreeExit':'unknown'}
