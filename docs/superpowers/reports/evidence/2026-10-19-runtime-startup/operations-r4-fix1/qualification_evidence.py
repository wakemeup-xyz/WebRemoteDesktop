"""Exact R3 acceptance validators. Definitions only; pinned helper loaded at runtime."""
import math,types
from operational_common import *
PASSIVE_SHA='b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426'
METRICS=('inputAckRttMs','inputToPostApplyFrameMs','inputToVisibleEffectMs','hostQueueMs','hostApplyMs','hostAdapterAwaitMs','paintIntervalMs','freshFrameAgeMs','candidateRttMs','jitterBufferMs','decodeMs','encoderMs','relayFrameAckRttMs')
SCOPE={'baseline':'native-passive-continuity','continuity':'native-passive-continuity','within-grace':'ordinary-functional-native-direct-close','after-grace':'ordinary-functional-playwright-routed-stimulus'}
INSTRUMENT={'baseline':'none','continuity':'none','within-grace':'native-direct','after-grace':'playwright-routed'}
PHASES=('preflight','startup','baseline','fault','recovering','recovered-stability','continuity','terminal')
EVENTS=('grace-started','grace-expired','rebind-confirmed','rebind-failed','reset-completed','host-disconnected')

def exact(obj,keys):need(type(obj) is dict and set(obj)==set(keys),'exact evidence keys')
def integer(v,upper,lower=0):need(type(v) is int and lower<=v<=upper,'integer evidence bound')
def number(v,upper,nullable=False):
 if nullable and v is None:return
 need(type(v) in (int,float) and math.isfinite(v) and 0<=v<=upper,'numeric evidence bound')
def boolean(v):need(type(v) is bool,'boolean evidence type')
def enum(v,allowed):need(type(v) is str and v in allowed,'evidence enum')
def hash16(v,nullable=True):need(nullable and v is None or type(v) is str and re.fullmatch('[a-f0-9]{16}',v) is not None,'private hash evidence')
def schema1(v):integer(v,1,1)

def load_passive_validators():
 # Runtime only. Hash both reviewed source bytes and deployed bytes beforehand.
 path=P/'scripts/passive_session_soak.py';data,_=regular(path)
 need(sha(data)==PASSIVE_SHA,'pure helper exact source pin mismatch')
 module=types.ModuleType('r3_pinned_passive_validators');module.__file__=str(path)
 # compile/exec avoids writing a primary __pycache__. __main__ guard stays false.
 exec(compile(data,str(path),'exec'),module.__dict__)
 return module

def host_observation(obj,complete=False):
 exact(obj,('status','hostHash','coverage','samples','hostDisconnectObserved'))
 enum(obj['status'],('not-started','stable','unavailable','changed'));enum(obj['coverage'],('not-started','complete','incomplete'));hash16(obj['hostHash']);integer(obj['samples'],12000);boolean(obj['hostDisconnectObserved'])
 if complete:need(obj['status']=='stable' and obj['coverage']=='complete' and obj['hostDisconnectObserved'] is False and obj['samples']>0 and obj['hostHash'] is not None,'Host observation incomplete')

def transport(obj):
 need(type(obj) is dict,'transport object');enum(obj.get('status'),('observed','unavailable','pending','scope-changed'))
 if set(obj)=={'status'}:need(obj['status']!='observed','observed transport fields missing');return
 exact(obj,('status','pathIdentity','localType','remoteType','protocol','remoteProtocol','relayProtocol','rttMs','bytesReceived','framesDecoded','framesDropped','codec'))
 need(obj['status'] in ('observed','unavailable'),'expanded transport status')
 path=obj['pathIdentity'];need(path is None or type(path) is str and re.fullmatch(r'path-([1-9][0-9]{0,3})',path) is not None and int(path[5:])<=1024,'transport path label')
 for key in ('localType','remoteType'):enum(obj[key],('host','srflx','prflx','relay','unknown'))
 for key in ('protocol','remoteProtocol'):enum(obj[key],('udp','tcp','unknown'))
 enum(obj['relayProtocol'],('udp','tcp','tls','unknown'));enum(obj['codec'],('video/h264','video/vp8','video/vp9','video/av1','unknown'))
 number(obj['rttMs'],9999999999999,True)
 for key in ('bytesReceived','framesDecoded','framesDropped'):
  if obj[key] is not None:integer(obj[key],9999999999999)

def sample_valid(obj,build,pure):
 exact(obj,('schemaVersion','browserNowMs','scopeStable','socketConnected','pcIdentity','pcState','transport','attemptHash','generation','leaseEpoch','mediaPhase','inputAllowed','inputGate','startupMarks','callbacks','lastFrameAtMs','frameAgeMs','maxFrameGapMs','width','height','relayFrameSeq','tunnelRelayActive','relayLoadCallbacks','lastRelayLoadAtMs','relayLoadAgeMs','maxRelayLoadGapMs','relayEvidenceKind','buildId','metrics','diagnostics'))
 schema1(obj['schemaVersion']);need(obj['buildId']==build and type(obj['buildId']) is str,'sample build mismatch');hash16(obj['attemptHash'])
 for key in ('scopeStable','socketConnected','inputAllowed','tunnelRelayActive'):boolean(obj[key])
 for key in ('pcIdentity','generation','leaseEpoch','callbacks','relayFrameSeq','relayLoadCallbacks'):
  if obj[key] is not None:integer(obj[key],999999999)
 for key in ('browserNowMs','lastFrameAtMs','frameAgeMs','maxFrameGapMs','width','height','lastRelayLoadAtMs','relayLoadAgeMs','maxRelayLoadGapMs'):number(obj[key],9999999999999,True)
 enum(obj['pcState'],('new','connecting','connected','disconnected','failed','closed','unknown'));enum(obj['mediaPhase'],('active','paused','resuming','suspending','suspended','unknown'))
 need(obj['relayEvidenceKind']=='image-load-event-not-optical-presentation','relay evidence scope');transport(obj['transport']);pure.validate_gate_fields(obj);pure.validate_delta(obj['diagnostics'])
 need(obj['inputAllowed'] is (obj['inputGate']['allowed'] is True),'input gate contradiction')
 exact(obj['metrics'],METRICS)
 for metric in obj['metrics'].values():
  if metric is None:continue
  exact(metric,('available','count','last','p95','lastSampleAgeMs'));boolean(metric['available'])
  if metric['count'] is not None:integer(metric['count'],9999999999999)
  for key in ('last','p95','lastSampleAgeMs'):number(metric[key],9999999999999,True)

def row_valid(row,scenario,build,pure):
 exact(row,('schemaVersion','scenario','elapsedSeconds','phase','qualificationEvidenceScope','hostObservation','sample','identity','serverEvents'));schema1(row['schemaVersion'])
 need(row['scenario']==scenario and row['qualificationEvidenceScope']==SCOPE[scenario],'sample scenario/scope');enum(row['phase'],PHASES);number(row['elapsedSeconds'],12000);host_observation(row['hostObservation'],True)
 exact(row['identity'],('sessionHash','socketHash','admissionHash'))
 for v in row['identity'].values():hash16(v)
 need(type(row['serverEvents']) is list and len(row['serverEvents'])<=1024,'server event capacity')
 for event in row['serverEvents']:
  exact(event,('n','event','serverTimestampMs','viewerHash','sessionHash','leaseEpoch','state'));integer(event['n'],1024,1);integer(event['serverTimestampMs'],9999999999999);enum(event['event'],EVENTS);need(event['state'] is None or type(event['state']) is str and event['state'] in ('FREE','GRANTING','ACTIVE','REVOKING'),'server state');hash16(event['viewerHash']);hash16(event['sessionHash'])
  if event['leaseEpoch'] is not None:integer(event['leaseEpoch'],999999999)
 # Null is a terminal missing observation, never a harmless skipped row.
 need(row['sample'] is not None,'missing sample');sample_valid(row['sample'],build,pure);return row

class ObservationGate:
 """Sticky invalid/missing/phase/Host/event evidence. Summary cannot clear failure."""
 def __init__(self,scenario,build,pure):
  self.scenario=scenario;self.build=build;self.pure=pure;self.failure=None;self.phase=None;self.elapsed=None;self.rows=0;self.host_hash=None;self.host_samples=0;self.event_n=0;self.event_time=0;self.seen=set();self.events=[];self.phase_windows={};self.owner=None;self.startup_owner=[None,None];self.baseline_lease=None;self.stable_lease=None
 def reject(self):
  if self.failure is None:self.failure='invalid-or-missing-observation'
 def observe(self,raw):
  need(self.failure is None,'latched observation failure')
  try:
   row=row_valid(raw,self.scenario,self.build,self.pure);phase=row['phase'];recovery=self.scenario in ('within-grace','after-grace')
   qualified=('baseline','fault','recovering','recovered-stability') if recovery else (('continuity',) if self.scenario=='continuity' else ('baseline',))
   chain=('startup',)+qualified
   # Actual producer persists startup before the qualified chain. Transient
   # recovery edges may remain between ticks; no mandatory edge-row API.
   need(phase in chain or phase=='terminal','sample phase outside scenario')
   if self.phase is None:need(phase=='startup','initial startup observation missing')
   else:
    need(self.phase!='terminal','row after terminal')
    if phase!='terminal':
     need(chain.index(phase)>=chain.index(self.phase),'unreachable/backward/restarted phase')
     if self.phase=='startup' and phase!='startup':need(phase==qualified[0],'initial qualified phase missing')
   # Same elapsed anchor as qualified rows; use the existing startup allowance,
   # never restart the clock or credit startup toward a qualified phase window.
   if phase=='startup':need(row['elapsedSeconds']<=120,'startup observation budget exceeded')
   if self.elapsed is not None:need(row['elapsedSeconds']>=self.elapsed and row['elapsedSeconds']-self.elapsed<=1.5,'sample clock/gap')
   h=row['hostObservation'];need(self.host_hash in (None,h['hostHash']) and h['samples']>=self.host_samples,'Host observation changed/regressed')
   identity=(row['identity']['sessionHash'],row['identity']['admissionHash'])
   if phase=='startup':
    # A null is no identity observation and never establishes admission authority.
    for index,value in enumerate(identity):
     if value is not None:
      need(self.startup_owner[index] in (None,value),'startup identity contradicted')
      self.startup_owner[index]=value
   else:
    need(all(v is not None for v in identity),'missing ordinary owner evidence')
    if self.owner is None:
     need(phase==qualified[0] and row['identity']['socketHash'] is not None,'complete first qualified identity required')
     need(all(previous in (None,value) for previous,value in zip(self.startup_owner,identity)),'qualified owner contradicts startup')
    need(self.owner in (None,identity),'ordinary owner changed');self.owner=identity
   for event in row['serverEvents']:
    need(event['n']==self.event_n+1 and event['serverTimestampMs']>=self.event_time,'server event gap/order');need(event['event']!='host-disconnected','Host disconnect alarm');self.event_n=event['n'];self.event_time=event['serverTimestampMs'];self.events.append(event)
   if phase=='baseline':self.baseline_lease=row['sample']['leaseEpoch']
   if phase=='recovered-stability':self.stable_lease=row['sample']['leaseEpoch']
   self.phase=phase;self.elapsed=row['elapsedSeconds'];self.rows+=1;need(self.rows<=12000,'row count cap');self.host_hash=h['hostHash'];self.host_samples=h['samples'];self.seen.add(phase)
   window=self.phase_windows.setdefault(phase,{'first':row['elapsedSeconds'],'last':row['elapsedSeconds'],'count':0});window['last']=row['elapsedSeconds'];window['count']+=1;return row
  except BaseException:self.reject();raise
 def finish(self,summary):
  need(self.failure is None and self.rows>0 and 'startup' in self.seen and self.owner is not None,'latched/missing startup or qualified owner observations')
  expected='recovered-stability' if self.scenario in ('within-grace','after-grace') else 'continuity' if self.scenario=='continuity' else 'baseline'
  need(expected in self.seen and self.phase in (expected,'terminal'),'terminal phase coherence')
  h=summary['hostObservation'];need(h['hostHash']==self.host_hash and h['samples']>=self.host_samples,'terminal Host contradiction')
  required={'baseline':300,'recovered-stability':30} if self.scenario in ('within-grace','after-grace') else {expected:10800 if self.scenario=='continuity' else 300}
  for phase,seconds in required.items():
   window=self.phase_windows.get(phase);need(window is not None and window['count']>=seconds and window['last']-window['first']>=seconds-1.5,'observed phase duration incomplete')
  if self.scenario in ('within-grace','after-grace'):self.recovery_events()
  else:need(summary['continuity']['samples']<=self.phase_windows[expected]['count'],'summary invents unseen samples')
 def recovery_events(self):
  # Server wall-clock order only. Never subtract these timestamps from browser
  # or Python clocks. Hash/session/epoch binding follows the approved spec.
  need(not any(e['event']=='rebind-failed' for e in self.events),'rebind failure retained')
  starts=[e for e in self.events if e['event']=='grace-started' and e['sessionHash']==self.owner[0]]
  need(len(starts)==1,'one matching grace start required');start=starts[0];need(start['viewerHash'] is not None,'missing viewer correlation')
  expiries=[e for e in self.events if e['event']=='grace-expired']
  if self.scenario=='within-grace':
   need(not expiries,'within-grace has expiry contradiction')
   rebind=[e for e in self.events if e['event']=='rebind-confirmed' and e['sessionHash']==start['sessionHash'] and e['n']>start['n']]
   need(len(rebind)==1 and self.baseline_lease is not None and rebind[0]['leaseEpoch']==self.baseline_lease==self.stable_lease,'matching within-grace rebind missing')
  else:
   match=[e for e in expiries if e['n']>start['n'] and e['sessionHash']==start['sessionHash'] and e['viewerHash']==start['viewerHash']]
   need(len(match)==1 and len(expiries)==1 and match[0]['leaseEpoch'] is not None,'matching after-grace expiry missing');expiry=match[0]
   resets=[e for e in self.events if e['event']=='reset-completed' and e['n']>expiry['n'] and e['leaseEpoch']==expiry['leaseEpoch'] and e['state']=='FREE']
   need(len(resets)==1 and self.stable_lease is not None and self.stable_lease>expiry['leaseEpoch'] and self.stable_lease!=self.baseline_lease,'expiry-bound reset/new lease missing')

def continuity_valid(obj,scenario,mode):
 keys=('status','kind','requestedSeconds','elapsedSeconds','samples','missingSamples','lateSamples','failedObservations','identityChangeObservations','maxObservedNoProgressMs','progressAfterBaseline','frameStallThresholdMs','frameEvidence','threeHourContinuityMet','visibleEffect','activeControl','physicalDisplay','connectionNote','metricNote')
 exact(obj,keys);enum(obj['status'],('PASS','FAIL','INCOMPLETE'));number(obj['requestedSeconds'],12000);number(obj['elapsedSeconds'],12000);number(obj['maxObservedNoProgressMs'],9999999999999)
 for key in ('samples','missingSamples','lateSamples','failedObservations','identityChangeObservations'):integer(obj[key],12000)
 for key in ('progressAfterBaseline','threeHourContinuityMet'):boolean(obj[key])
 integer(obj['frameStallThresholdMs'],5000,5000)
 need(obj['kind']=='passive-session-continuity-only' and obj['frameEvidence']==('image-load-event-not-optical-presentation' if mode=='tunnel' else 'requestVideoFrameCallback'),'continuity kind/scope')
 need(all(obj[k]=='NOT_RUN' for k in ('visibleEffect','activeControl','physicalDisplay')),'continuity scope overclaim')
 need(obj['connectionNote']=='Passive after normal guarded connection; required grant/reset lifecycle messages are permitted.' and obj['metricNote']=='Metric p95 values are five-second application windows, not a whole-run percentile.','continuity notes schema')
 if scenario in ('within-grace','after-grace'):
  need(obj['status']=='INCOMPLETE' and obj['requestedSeconds']==300 and obj['threeHourContinuityMet'] is False,'induced continuity must remain interrupted')
 else:
  target=10800 if scenario=='continuity' else 300
  need(obj['status']=='PASS' and obj['requestedSeconds']==target and obj['elapsedSeconds']>=target and obj['samples']>=target and obj['missingSamples']==0 and obj['failedObservations']==0 and obj['identityChangeObservations']==0 and obj['maxObservedNoProgressMs']<5000 and obj['progressAfterBaseline'] is True and obj['threeHourContinuityMet'] is (scenario=='continuity'),'contradictory continuity PASS')

def lifecycle_valid(obj,pure):
 exact(obj,('schemaVersion','diagnostics','python','captureStatus','writeStatus','ownedProcessExitEvidence'));schema1(obj['schemaVersion']);pure.validate_diagnostic(obj['diagnostics'])
 need(obj['captureStatus']=='ok' and obj['writeStatus']=='ok' and obj['ownedProcessExitEvidence']=='not-observed','lifecycle not complete')
 state=obj['python'];exact(state,('failureDetectedMs','failureWallEpochMs','managerStart','managerLaunch','managerStop','browserClose','cleanupStatus'))
 for key in ('failureDetectedMs','failureWallEpochMs'):
  if state[key] is not None:integer(state[key],9999999999999)
 need(state['failureDetectedMs'] is None and state['failureWallEpochMs'] is None and state['cleanupStatus']=='api-finished-exit-unknown','Python lifecycle retains a failure')
 previous=None
 for key in ('managerStart','managerLaunch','browserClose','managerStop'):
  stage=state[key];exact(stage,('startedMs','finishedMs','status'));enum(stage['status'],('ok','timeout','error','cancelled','not-started','not-created','closed','noncooperative'))
  integer(stage['startedMs'],9999999999999);integer(stage['finishedMs'],9999999999999)
  need(stage['status']==('closed' if key=='browserClose' else 'ok') and stage['finishedMs']>=stage['startedMs'] and (previous is None or stage['startedMs']>=previous),'stage failure/order contradicts cleanup')
  previous=stage['finishedMs']

def terminal_valid(summary,lifecycle,scenario,manifest,gate,pure):
 exact(summary,('schemaVersion','scenario','mode','phase','qualificationEvidenceScope','nativeAfterGraceQualification','hostObservation','continuity','ordinaryRecovery','failure','startup','manifest','lifecycle','fault','businessInput','visibleEffect','physical'));schema1(summary['schemaVersion'])
 need(summary['scenario']==scenario and summary['mode']==manifest['mode'] and summary['phase']=='terminal' and summary['qualificationEvidenceScope']==SCOPE[scenario] and summary['failure'] is None,'summary terminal mismatch')
 need(all(summary[k]=='NOT_RUN' for k in ('nativeAfterGraceQualification','businessInput','visibleEffect','physical')),'summary scope overclaim');host_observation(summary['hostObservation'],True)
 projection=summary['manifest'];exact(projection,('sha256','runNonce','originSource','originEvidenceSha256','signalSourceCommit','hostSourceCommit','viewerSourceCommit','viewerBuildId','sourceEvidence'))
 need(projection=={'sha256':manifest['_sha'],'runNonce':manifest['runNonce'],'originSource':manifest['originSource'],'originEvidenceSha256':manifest['originEvidenceSha256'],'signalSourceCommit':manifest['signal']['sourceCommit'],'hostSourceCommit':manifest['host']['sourceCommit'],'viewerSourceCommit':manifest['viewer']['sourceCommit'],'viewerBuildId':manifest['viewer']['buildId'],'sourceEvidence':'root-attested'},'manifest projection mismatch')
 startup=summary['startup'];exact(startup,('status','freshPage','authVerified','selector','startClickMarksBefore','startClickMarksAfter','guardedApiRequests'))
 for key in ('freshPage','authVerified'):boolean(startup[key]);need(startup[key] is True,'startup boolean')
 integer(startup['startClickMarksBefore'],0);integer(startup['startClickMarksAfter'],1,1);integer(startup['guardedApiRequests'],1,1);need(startup['status']=='verified' and startup['selector']=='vacant-only-v1','startup selector/status')
 fault=summary['fault'];exact(fault,('capability','status','instrumentation','triggerCount','blockedHttp','blockedWebSocket','blockSeconds'));enum(fault['capability'],('not-checked','available','unavailable'));enum(fault['status'],('not-requested','ready','triggered','disarmed','failed'));need(fault['instrumentation']==INSTRUMENT[scenario],'fault instrumentation')
 integer(fault['triggerCount'],1);integer(fault['blockSeconds'],12)
 for key in ('blockedHttp','blockedWebSocket'):integer(fault[key],32)
 need(fault['blockedHttp']+fault['blockedWebSocket']<=32,'fault attempts bound')
 rec=summary['ordinaryRecovery'];exact(rec,('status','classification','requestedScenario','qualificationEvidenceScope','recoverySeconds','recoveredStableSeconds','serverCoverage','reason'))
 need(rec['requestedScenario']==scenario and rec['qualificationEvidenceScope']==SCOPE[scenario],'recovery scope');number(rec['recoverySeconds'],12000,True);number(rec['recoveredStableSeconds'],12000)
 if scenario in ('baseline','continuity'):
  need(fault=={'capability':'not-checked','status':'not-requested','instrumentation':'none','triggerCount':0,'blockedHttp':0,'blockedWebSocket':0,'blockSeconds':0},'no-fault terminal contradiction')
  need(rec['status']=='NOT_RUN' and rec['classification']=='not-attempted' and rec['reason']=='scenario-not-requested' and rec['serverCoverage'] in ('not-started','complete') and rec['recoverySeconds'] is None and rec['recoveredStableSeconds']==0,'unexpected recovery in no-fault run')
 else:
  need(fault['capability']=='available' and fault['status']=='disarmed' and fault['triggerCount']==1 and fault['blockSeconds']==(12 if scenario=='after-grace' else 0),'fault terminal not successfully disarmed')
  if scenario=='within-grace':need(fault['blockedHttp']==fault['blockedWebSocket']==0,'native-direct must have no routed block')
  need(rec['status']=='PASS' and rec['classification']==('within-grace-rebind' if scenario=='within-grace' else 'after-grace-reset') and rec['serverCoverage']=='complete' and rec['reason']=='none' and rec['recoverySeconds'] is not None and rec['recoverySeconds']<=60 and rec['recoveredStableSeconds']>=30,'recovery terminal incomplete')
 continuity_valid(summary['continuity'],scenario,manifest['mode']);lifecycle_valid(lifecycle,pure)
 exact(summary['lifecycle'],('captureStatus','cleanupStatus','writeStatus','ownedProcessExitEvidence'))
 need(summary['lifecycle']=={'captureStatus':'ok','cleanupStatus':'api-finished-exit-unknown','writeStatus':'ok','ownedProcessExitEvidence':'not-observed'},'summary lifecycle contradiction');gate.finish(summary)
