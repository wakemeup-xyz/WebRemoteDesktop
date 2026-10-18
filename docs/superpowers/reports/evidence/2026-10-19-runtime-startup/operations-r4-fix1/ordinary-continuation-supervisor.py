#!/usr/bin/env python3
"""Owned ordinary qualification derivative. Original SUP/helper/sampler stay unchanged.
No service signals, ticket/proof calls, browser reuse, automatic next run or retry.
"""
import sys,time,math,resource
from urllib.parse import urlsplit
from continuation_common import *
from process_observation_diagnostics import Diagnostics,instrument_registry
from validation_stages import ValidationStages
from qualification_evidence import *
RUNNER='scripts/ordinary_session_recovery.py'
IMMUTABLE=('scripts/passive_session_soak.py','scripts/passive_session_sampler.js')
SCENARIOS=('baseline','within-grace','after-grace','continuity')
BUDGET={'baseline':300,'within-grace':390,'after-grace':390,'continuity':10800}
SCOPE={'baseline':'native-passive-continuity','continuity':'native-passive-continuity','within-grace':'ordinary-functional-native-direct-close','after-grace':'ordinary-functional-playwright-routed-stimulus'}
INSTRUMENT={'baseline':'none','continuity':'none','within-grace':'native-direct','after-grace':'playwright-routed'}
PHASES={'preflight','startup','baseline','fault','recovering','recovered-stability','continuity','terminal'}
EVENTS={'grace-started','grace-expired','rebind-confirmed','rebind-failed','reset-completed','host-disconnected'}

class Rows:
 """Only newline-completed bounded rows; no malformed-row skipping."""
 def __init__(self,path):self.path=path;self.offset=0;self.pending=b'';self.identity=None;self.total=0
 def read(self):
  try:st=self.path.lstat()
  except FileNotFoundError:return []
  need(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600,'sample file type/mode');identity=(st.st_dev,st.st_ino)
  if self.identity is None:self.identity=identity
  need(identity==self.identity and st.st_size>=self.offset,'sample identity/truncation gap')
  fd=os.open(self.path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
  with os.fdopen(fd,'rb') as f:
   check=os.fstat(f.fileno());need((check.st_dev,check.st_ino)==identity,'sample read race');f.seek(self.offset);data=f.read(262144)
  self.offset+=len(data);self.total+=len(data);need(self.total<=67108864,'sample total bound')
  lines=(self.pending+data).split(b'\n');self.pending=lines.pop();need(len(self.pending)<=32768,'partial sample too large');out=[]
  for line in lines:need(0<len(line)<=32768,'sample row byte bound');out.append(loads(line))
  return out

def completed_result(out,scenario,manifest,gate,pure):
 summary_bytes,_=regular(out/'session/summary.json',32768);lifecycle_bytes,_=regular(out/'session/lifecycle.json',32768)
 summary=loads(summary_bytes);lifecycle=loads(lifecycle_bytes)
 terminal_valid(summary,lifecycle,scenario,manifest,gate,pure)
 return {'summarySHA256':sha(summary_bytes),'lifecycleSHA256':sha(lifecycle_bytes),'qualificationEvidenceScope':SCOPE[scenario],'nativeAfterGraceQualification':'NOT_RUN','sourceEvidence':'root-attested'}

def register_worker(worker,registry,factory,deadline,monotonic,sleep):
 """A created Popen remains observable even when ownership is unavailable."""
 record={'registered':False,'registrationErrorClass':None,'deadlineMonotonic':deadline,'status':'registering','exitCode':None,'exitObservedMonotonic':None,'unresolvedChild':False}
 try:registry.add_root(factory(worker.pid))
 except BaseException as exc:
  record['registrationErrorClass']=type(exc).__name__
  while True:
   code=worker.poll();now=monotonic()
   if code is not None:
    record.update(status='created-worker-exit-observed',exitCode=code,exitObservedMonotonic=now);return record
   if now>=deadline:
    record.update(status='created-worker-unresolved-at-deadline',unresolvedChild=True);return record
   sleep(min(.25,deadline-now))
 record.update(registered=True,status='registered');return record

def main():
 os.umask(0o077);args=parser(__doc__).parse_args()
 f,m,ref,pins,manifest=attempt_context(args,admission=True);scenario=pins['scenario'];duration=BUDGET[scenario];expected=ref['expectedServices'];t={'buildId':ref['assets']['buildId']}
 manifest['_sha']=args.runtime_manifest_sha256
 current_gate(args,expected)
 marker=f/'qualification-started.json';resultpath=f/'qualification-result.json';need(not marker.exists() and not resultpath.exists(),'attempt already consumed')
 owned=load_owned();pure=load_passive_validators();import psutil
 worker_diag=Diagnostics(psutil.Process,(psutil.NoSuchProcess,psutil.AccessDenied,OSError),'worker',monotonic=time.monotonic,wall=time.time);sample_diag=Diagnostics(psutil.Process,(psutil.NoSuchProcess,psutil.AccessDenied,OSError),'sample',monotonic=time.monotonic,wall=time.time)
 current_gate(args,expected);source_pins(args,m)
 out=pathlib.Path(tempfile.mkdtemp(prefix='ordinary-'+scenario+'-',dir=f));out.chmod(0o700)
 jsonwrite(marker,{'attemptSHA256':args.attempt_sha256,'sequenceId':m['sequenceId'],'attemptId':pins['attemptId'],'productTIP':PRODUCT,'toolTIP':m['toolTIP'],'priorFailureSHA256':PRIOR_FAILURE,'sourceTIP':m['sourceTIP'],'viewerSourceTIP':viewer_source_tip(),'failedHistory':FAILURES,'runtimeManifestSHA256':args.runtime_manifest_sha256,'scenario':scenario,'epoch':time.time(),'outputDirectory':str(out),'oneUse':True})
 reg=instrument_registry(owned.Registry,worker_diag);sreg=instrument_registry(owned.Registry,sample_diag);worker=None;worker_registration=None;sample=None;observation=None;failure=None;timeout=False;triggered=False;result=None;sample_info={'status':'not-triggered'};rows=Rows(out/'session/samples.jsonl');started=time.monotonic();expected_host=expected['host'];row_count=0;gate=ObservationGate(scenario,t['buildId'],pure);sampling_enabled=scenario in ('baseline','continuity')
 if not sampling_enabled:sample_info={'status':'disabled-for-entire-recovery-scenario','scope':'no Host sample during baseline, fault, recovery or stability; passive/log evidence only'}
 def valid_host():
  try:return process_identity(expected_host['pid'],'host')==expected_host
  except Exception:return False
 def sample_tick():
  if observation is not None:observation.check()
 def start_sample(row):
  nonlocal sample,observation,triggered
  need(sampling_enabled and scenario in ('baseline','continuity'),'Host sampling forbidden for entire recovery scenario')
  triggered=True;need(valid_host(),'Host changed before sample');raw=out/'host-sample.txt';write(raw,b'');sample_info.update(status='starting',startedEpoch=time.time(),startedMonotonic=time.monotonic(),triggerPhase=row['phase'],triggerFrameAgeMs=row['sample'].get('relayLoadAgeMs' if pins['mode']=='tunnel' else 'frameAgeMs'),scope='route-free no-fault scenario only; diagnostic perturbs Host; polling and scheduling delay')
  sample=subprocess.Popen(['/usr/bin/sample',str(expected_host['pid']),'3','10','-file',str(raw)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=owned.sample_limits)
  sreg.add_root(sample_diag.process(sample.pid));os.set_blocking(sample.stdout.fileno(),False);sample_info['status']='running';observation=owned.SampleObservation(sample,sreg,sample_info)
 def consume():
  nonlocal row_count
  for raw in rows.read():
   row=gate.observe(raw);row_count+=1;need(row_count<=12000,'sample count cap');sample_data=row['sample']
   # Whole-scenario exclusion removes both queued-row and sample-duration races.
   if not sampling_enabled or triggered or row['phase'] not in ('baseline','continuity'):continue
   callbacks=sample_data.get('relayLoadCallbacks' if pins['mode']=='tunnel' else 'callbacks');age=sample_data.get('relayLoadAgeMs' if pins['mode']=='tunnel' else 'frameAgeMs')
   if type(callbacks) not in (int,float) or callbacks<=0 or type(age) not in (int,float) or not math.isfinite(age) or sample_data.get('scopeStable') is not True or sample_data.get('mediaPhase')!='active':continue
   if age>=5000 if scenario=='continuity' else age>2000:start_sample(row)
 reg.tick=sample_tick
 try:
  deadline=started+duration+128
  worker=subprocess.Popen([sys.executable,'-B',str(P/RUNNER),'--origin',pins['origin'],'--mode',pins['mode'],'--scenario',scenario,'--runtime-manifest',str(args.runtime_manifest),'--runtime-manifest-sha256',args.runtime_manifest_sha256,'--runtime-config',str(P/'signal-server/.env'),'--output-dir',str(out/'session')],cwd=P,env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  worker_registration=register_worker(worker,reg,worker_diag.process,deadline,time.monotonic,time.sleep);timeout=worker_registration['unresolvedChild'];need(worker_registration['registered'],'worker registration failed');next_progress=started+30
  while True:
   reg.scan();sreg.scan();consume();sample_tick();need(valid_host(),'Host replacement during run');preserved_gate()
   if worker.poll() is not None:consume();break
   if time.monotonic()>=deadline:timeout=True;break
   if time.monotonic()>=next_progress:print(json.dumps({'scenario':scenario,'stage':'supervising','elapsedSeconds':round(time.monotonic()-started),'sampleTriggered':triggered}),flush=True);next_progress+=30
   time.sleep(.25)
 except BaseException as exc:gate.reject();failure=type(exc).__name__
 finally:
  worker_diag.set_stage('cleanup');sample_diag.set_stage('cleanup')
  cleanup_errors=[]
  try:reg.cleanup()
  except BaseException as exc:cleanup_errors.append(type(exc).__name__)
  try:
   if sample is not None:
    until=sample_info['startedMonotonic']+10
    while sample.poll() is None and time.monotonic()<until:sample_tick();time.sleep(min(.25,max(0,until-time.monotonic())))
   sreg.tick=sample_tick;sreg.cleanup(grace=0,term_wait=.5,kill_wait=.5)
   if observation is not None:observation.finalize(out/'sample-diagnostic-prefix.bin')
  except BaseException as exc:cleanup_errors.append(type(exc).__name__)
  for child in (worker,sample):
   if child is not None:
    try:child.wait(timeout=.1)
    except subprocess.TimeoutExpired:pass
  worker_diag.set_stage('result');sample_diag.set_stage('result')
  try:ownership=reg.result();sample_ownership=sreg.result()
  except BaseException as exc:ownership={};sample_ownership={};cleanup_errors.append(type(exc).__name__)
  validation_error=None;final_integrity=None;postclose_occupancy=None;validation=ValidationStages()
  try:
   with validation.stage('rows'):need(not rows.pending and rows.path.lstat().st_size==rows.offset,'incomplete/unconsumed trailing sample data')
   with validation.stage('worker'):need(worker is not None and worker.poll()==0 and not timeout and failure is None and not cleanup_errors,'worker incomplete')
   with validation.stage('coverage'):
    validate_owned_coverage(ownership,sample_ownership)
   with validation.stage('signals'):validate_no_signals(ownership,sample_ownership)
   with validation.stage('diagnostics'):need(not worker_diag.failed and not sample_diag.failed,'diagnostic failure veto')
   with validation.stage('source-pins'):source_pins(args,m)
   with validation.stage('manifest'):need(sha(regular(args.runtime_manifest,16384)[0])==args.runtime_manifest_sha256 and int(time.time()*1000)<=manifest['validUntilEpochMs'],'manifest final drift/expiry')
   with validation.stage('runtime-integrity'):
    final_integrity=qualification_integrity(args,expected)
    h=final_integrity['health'];postclose_occupancy={'viewerCount':h['viewerCount'],'relayViewerCount':h['relayViewerCount'],'observedAtEpoch':h['observedAtEpoch'],'classification':'idle-observed' if h['viewerCount']==0 and h['relayViewerCount']==0 else 'occupied-unattributed'}
   with validation.stage('sticky-observation'):need(gate.failure is None,'sticky observation failure')
   with validation.stage('terminal-evidence'):result=completed_result(out,scenario,manifest,gate,pure)
  except BaseException as exc:validation_error=type(exc).__name__
  final={'schemaVersion':1,'kind':'guarded-ordinary-qualification','scenario':scenario,'durationSeconds':duration,'workerDeadlineSeconds':duration+128,'attemptSHA256':args.attempt_sha256,'sequenceId':m['sequenceId'],'attemptId':pins['attemptId'],'productTIP':PRODUCT,'toolTIP':m['toolTIP'],'priorFailureSHA256':PRIOR_FAILURE,'sourceTIP':m['sourceTIP'],'viewerSourceTIP':viewer_source_tip(),'failedHistory':FAILURES,'runtimeManifestSHA256':args.runtime_manifest_sha256,'qualificationEvidenceScope':SCOPE[scenario],'nativeAfterGraceQualification':'NOT_RUN','sourceEvidence':'root-attested','workerRegistration':worker_registration,'workerExitCode':worker.poll() if worker else None,'timedOut':timeout,'errorClass':failure,'cleanupErrorClasses':cleanup_errors,'validationErrorClass':validation_error,'validationStages':validation.snapshot(),'processDiagnostics':{'worker':worker_diag.snapshot(),'sample':sample_diag.snapshot()},'observedUnexpectedCoverage':{'worker':sorted(set(ownership.get('coverage',[]))-INHERENT),'sample':sorted(set(sample_ownership.get('coverage',[]))-INHERENT)},'owned':ownership,'sampleOwned':sample_ownership,'sampleTriggered':triggered,'sampling':sample_info,'completedRows':row_count,'observationFailure':gate.failure,'samplingEnabled':sampling_enabled,'qualification':result,'finalRuntimeIntegrity':final_integrity,'postCloseOccupancy':postclose_occupancy,'nextRunAdmission':'NOT_ESTABLISHED','strictFreshPreflightRequired':True,'serverMapDrainEstablished':False,'currentReadiness':readiness_facts(),'fullProcessTreeExit':'unknown','classification':'observed-qualification-completed' if validation_error is None else 'failed-or-indeterminate','automaticNextRun':False}
  digest=jsonwrite(resultpath,final);print(json.dumps({'record':str(resultpath),'sha256':digest,'classification':final['classification']}))
 return 0 if final['classification']=='observed-qualification-completed' else 2
if __name__=='__main__':raise SystemExit(main())
