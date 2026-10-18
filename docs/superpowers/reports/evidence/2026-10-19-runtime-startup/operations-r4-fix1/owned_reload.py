import sys
from core import *
HELPER='skills/webremote-service/scripts/wrd_service.py'

def owned_helper():
 """Registry signals only observed owned helper children; managed services excluded."""
 import psutil
 owned=load_owned()
 class HelperRegistry(owned.Registry):
  """Excluded identities are never registered, queued or signal eligible.
  Runtime rechecks also guard an owned shell that execs into a managed service.
  Unavailable child observations are recorded without aborting sibling scanning.
  """
  def eligible(self,p):
   try:
    cwd=pathlib.Path(p.cwd()).resolve();argv=p.cmdline()
    if (cwd==P/'python-host' and any(pathlib.Path(x).name in ('host.py','overlay_window.py') for x in argv)) or (cwd==P/'signal-server' and any(pathlib.Path(x).name=='server.js' for x in argv)):
     self.note('managed-service-excluded');return False
    return True
   except psutil.NoSuchProcess:return False
   except (psutil.AccessDenied,OSError):self.note('managed-service-observation-unavailable');return False
  def _add(self,p,parent):
   if parent is not None and not self.eligible(p):return False
   super()._add(p,parent)
   return p.pid in self.entries and self.entries[p.pid]['birth']==p.create_time()
  def state(self,pid):
   # The base signal/result methods can only traverse existing registered keys.
   if pid not in self.entries:return 'excluded'
   state=super().state(pid)
   if state!='alive':return state
   try:
    if not self.eligible(self.process(pid)):return 'unknown'
   except psutil.NoSuchProcess:return 'exited'
   except (psutil.AccessDenied,OSError):self.note('managed-service-observation-unavailable');return 'unknown'
   return 'alive'
  def scan(self):
   queue=list(self.entries);seen=set()
   while queue:
    pid=queue.pop(0)
    if pid in seen or pid not in self.entries:continue
    seen.add(pid)
    if self.state(pid)!='alive':continue
    try:children=self.process(pid).children(recursive=False)
    except (psutil.NoSuchProcess,psutil.AccessDenied,OSError):self.note('observation-unavailable');continue
    for child in children:
     try:
      birth=child.create_time()
      if self.state(pid)!='alive' or child.ppid()!=pid:self.note('parent-chain-unavailable');continue
      parent_birth=self.entries[pid]['birth']
      if child.create_time()!=birth or self.state(pid)!='alive' or child.ppid()!=pid:self.note('parent-chain-changed');continue
      registered=self._add(child,{'pid':pid,'birth':parent_birth})
      if registered and child.pid in self.entries and self.entries[child.pid]['birth']==birth and self.state(child.pid)=='alive':queue.append(child.pid)
     except (psutil.NoSuchProcess,psutil.AccessDenied,OSError):self.note('observation-unavailable');continue
 registry=HelperRegistry();child=None;failure=None;cleanup_error=None;timedout=False;started=time.monotonic()
 try:
  child=subprocess.Popen([sys.executable,'-B',str(P/HELPER),'restart-signal'],cwd=P,env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  registry.add_root(psutil.Process(child.pid));deadline=time.monotonic()+180
  while child.poll() is None and time.monotonic()<deadline:
   registry.scan();time.sleep(.25)
  if child.poll() is None:timedout=True;registry.cleanup(grace=0,term_wait=2,kill_wait=1)
  else:registry.observe_for(.25)
 except BaseException as exc:
  failure=type(exc).__name__
  try:registry.cleanup(grace=0,term_wait=2,kill_wait=1)
  except BaseException as exc2:cleanup_error=type(exc2).__name__
 ownership={};ownership_error=None
 try:ownership=registry.result()
 except BaseException as exc:ownership_error=type(exc).__name__
 coverage=ownership.get('coverage');unexpected=sorted(set(coverage)-INHERENT-{'managed-service-excluded'}) if isinstance(coverage,list) else ['invalid-coverage']
 code=child.poll() if child else None
 ok=code==0 and not timedout and failure is None and cleanup_error is None and ownership_error is None and not unexpected and ownership.get('allRecordedIdentitiesExited') is True and ownership.get('completeProcessTreeExitEstablished') is False and not ownership.get('signals')
 return {'exitCode':code,'timedOut':timedout,'errorClass':failure,'cleanupErrorClass':cleanup_error,'ownershipErrorClass':ownership_error,'ownership':ownership,'unexpectedCoverage':unexpected,'elapsedSeconds':round(time.monotonic()-started,3),'fullProcessTreeExit':'unknown','lifecycleAcceptable':ok}

def reconcilable_helper(helper):
 """Only clean helper exit plus a sole polling observation-unavailable gap.
 Timeout, signal, registration/cleanup error, live/unknown identities are ineligible.
 """
 if not isinstance(helper,dict):return False
 owner=helper.get('ownership',{});coverage=owner.get('coverage',[])
 return (helper.get('exitCode')==0 and helper.get('timedOut') is False and
  all(helper.get(k) is None for k in ('errorClass','cleanupErrorClass','ownershipErrorClass')) and
  helper.get('lifecycleAcceptable') is False and helper.get('unexpectedCoverage')==['observation-unavailable'] and
  isinstance(coverage,list) and set(coverage)<=INHERENT|{'observation-unavailable','managed-service-excluded'} and
  owner.get('allRecordedIdentitiesExited') is True and owner.get('completeProcessTreeExitEstablished') is False and
  owner.get('signals')==[] and isinstance(owner.get('identities'),list) and 0<len(owner['identities'])<=128 and
  all(row.get('status')=='exited' for row in owner['identities']))
