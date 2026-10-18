import math
from bindings import *
SCOPE='task-known-recorded-identities-only'
STATUSES=('running','sleeping','disk-sleep','stopped','tracing-stop','zombie','dead','wake-kill','waking','idle','locked','waiting','parked')
QUIET=('gone','zombie','nonmatching-birth')

def finite(value):return type(value) in (int,float) and math.isfinite(value) and 0<=value<=9999999999999

def known_from_closed(marker,result):
 need(type(marker) is dict and type(result) is dict,'closed prior record required')
 need(marker.get('oneUse') is True and marker.get('scenario')=='baseline' and type(marker.get('epoch')) in (int,float) and finite(marker['epoch']),'prior started marker')
 need(type(result.get('schemaVersion')) is int and result['schemaVersion']==1 and result.get('kind')=='guarded-ordinary-qualification' and result.get('scenario')=='baseline' and result.get('classification')=='failed-or-indeterminate' and type(result.get('workerExitCode')) is int and result.get('automaticNextRun') is False and result.get('fullProcessTreeExit')=='unknown','prior attempt not closed')
 for key in ('frozenSHA256','sourcePinsSHA256','runtimeManifestSHA256'):need(valid_sha(marker.get(key)) and result.get(key)==marker[key],'prior marker/result mismatch')
 return recorded_identities(result)

def recorded_identities(result):
 rows=[]
 for name in ('owned','sampleOwned'):
  group=result.get(name);need(type(group) is dict and group.get('allRecordedIdentitiesExited') is True and type(group.get('identities')) is list and len(group['identities'])<=64,'unclosed known identity record')
  for row in group['identities']:
   need(type(row) is dict and type(row.get('pid')) is int and 0<row['pid']<=2147483647 and finite(row.get('birth')) and row['birth']>0 and row.get('status')=='exited','unclosed or malformed known identity')
   rows.append({'registry':name,'pid':row['pid'],'birthEpoch':row['birth']})
 need(1<=len(rows)<=64 and len({(r['pid'],r['birthEpoch']) for r in rows})==len(rows),'known identity bounds/duplicates')
 return sorted(rows,key=lambda r:(r['registry'],r['pid'],r['birthEpoch']))

def clock_pair(wall,monotonic):
 pair={'epoch':wall(),'monotonic':monotonic()};need(all(finite(v) for v in pair.values()),'quiescence clock unavailable');return pair

def forward(start,end):
 need(all(finite(start.get(k)) and finite(end.get(k)) and end[k]>=start[k] for k in ('epoch','monotonic')),'quiescence clock reversal')

def observe_known(known,factory,no_such,unavailable,*,zombie='zombie',wall=time.time,monotonic=time.monotonic):
 start=clock_pair(wall,monotonic);previous=start;rows=[]
 for expected in known:
  outcome='unknown';birth=None;status=None
  try:
   process=factory(expected['pid']);birth=process.create_time();status=process.status();again=process.create_time()
   if finite(birth) and birth>0 and finite(again) and birth==again and type(status) is str and status in STATUSES:
    outcome='zombie' if status==zombie else 'nonmatching-birth' if birth!=expected['birthEpoch'] else 'alive-matching'
   else:birth=None;status=None
  except no_such:outcome='gone';birth=None;status=None
  except unavailable:outcome='unknown';birth=None;status=None
  now=clock_pair(wall,monotonic);forward(previous,now);previous=now
  rows.append(dict(expected,classification=outcome,observedBirthEpoch=birth,status=status,observedAtEpoch=now['epoch'],observedMonotonic=now['monotonic']))
 end=clock_pair(wall,monotonic);forward(previous,end)
 return {'started':start,'completed':end,'observations':rows,'classification':'known-identities-quiescent' if all(r['classification'] in QUIET for r in rows) else 'refused-alive-or-unknown','scope':SCOPE,'fullProcessTreeExit':'unknown'}

def live_observe(known):
 import psutil
 return observe_known(known,psutil.Process,psutil.NoSuchProcess,(psutil.AccessDenied,OSError),zombie=psutil.STATUS_ZOMBIE)

def validate_observation(observation,known):
 exact(observation,('started','completed','observations','classification','scope','fullProcessTreeExit'))
 need(observation['scope']==SCOPE and observation['fullProcessTreeExit']=='unknown','quiescence scope')
 for name in ('started','completed'):exact(observation[name],('epoch','monotonic'))
 forward(observation['started'],observation['completed']);need(type(observation['observations']) is list and len(observation['observations'])==len(known),'known identity coverage')
 previous=observation['started']
 for row,expected in zip(observation['observations'],known):
  exact(row,('registry','pid','birthEpoch','classification','observedBirthEpoch','status','observedAtEpoch','observedMonotonic'))
  need({k:row[k] for k in ('registry','pid','birthEpoch')}==expected and type(row['pid']) is int and type(row['birthEpoch']) in (int,float),'known identity mismatch')
  now={'epoch':row['observedAtEpoch'],'monotonic':row['observedMonotonic']};forward(previous,now);forward(now,observation['completed']);previous=now
  need(row['classification'] in (*QUIET,'alive-matching','unknown'),'quiescence outcome')
  if row['classification'] in ('gone','unknown'):need(row['observedBirthEpoch'] is None and row['status'] is None,'absent/unknown observation fields')
  else:
   need(finite(row['observedBirthEpoch']) and row['observedBirthEpoch']>0 and type(row['status']) is str and row['status'] in STATUSES,'process observation fields')
   need((row['classification']=='zombie' and row['status']=='zombie') or (row['classification']=='nonmatching-birth' and row['status']!='zombie' and row['observedBirthEpoch']!=row['birthEpoch']) or (row['classification']=='alive-matching' and row['status']!='zombie' and row['observedBirthEpoch']==row['birthEpoch']),'process observation contradiction')
 expected_class='known-identities-quiescent' if all(r['classification'] in QUIET for r in observation['observations']) else 'refused-alive-or-unknown'
 need(observation['classification']==expected_class,'quiescence classification contradiction')
 return observation

def fresh_at(receipt,now):
 start=receipt['observation']['started'];end=receipt['observation']['completed'];forward(end,now)
 need(all(now[k]-start[k]<=60 for k in ('epoch','monotonic')),'quiescence receipt stale')

def all_known():
 b,h,records=history();groups=[known_from_closed(loads(check_ref(b['historical']['oldMarker'])),loads(check_ref(b['historical']['oldFailure'])))]
 for prefix in ('second','third'):
  marker=records[prefix+'Marker'];result=records[prefix+'Failure'];attempt=records[prefix+'Attempt']
  need(marker['oneUse'] is True and marker['scenario']=='baseline' and marker['attemptSHA256']==h['records'][prefix+'Attempt']['sha256']==result['attemptSHA256'] and result['kind']=='guarded-ordinary-qualification' and result['classification']=='failed-or-indeterminate' and type(result['workerExitCode']) is int and result['automaticNextRun'] is False and result['fullProcessTreeExit']=='unknown','historical known attempt unclosed')
  for key in ('sequenceId','attemptId','productTIP','toolTIP','runtimeManifestSHA256'):need(marker[key]==result[key]==attempt[key],'historical marker/result/attempt mismatch')
  groups.append(recorded_identities(result))
 rows=[dict(row,registry=str(i+1)+':'+row['registry']) for i,group in enumerate(groups) for row in group];need(len(rows)==21 and len({(r['pid'],r['birthEpoch']) for r in rows})==21,'exact three-failure21 identity coverage');return sorted(rows,key=lambda r:(r['registry'],r['pid'],r['birthEpoch']))

def receipt_value(m,frozen_sha,phase,apply_sha,observation):
 known=all_known();validate_observation(observation,known);need(observation['classification']=='known-identities-quiescent','alive or unknown known attempt')
 need(phase in ('apply','reload') and (apply_sha is None if phase=='apply' else valid_sha(apply_sha)),'quiescence phase')
 return {'schemaVersion':1,'kind':'root-three-failure-quiescence','packageManifestSHA256':m['packageManifestSHA256'],'frozenSHA256':frozen_sha,'sourceTIP':m['tip'],'deploymentId':m['deploymentId'],'phase':phase,'applySHA256':apply_sha,'failedHistory':FAILURES,'knownIdentities':known,'observation':observation,'scope':SCOPE,'fullProcessTreeExit':'unknown'}

def receipt_file(f,m,frozen_sha,path,digest,phase,apply_sha,*,fresh):
 need(pathlib.Path(path).resolve(strict=True)==f/('quiescence-'+phase+'.json'),'quiescence exact path');v=private_json(path,digest,65536)
 exact(v,('schemaVersion','kind','packageManifestSHA256','frozenSHA256','sourceTIP','deploymentId','phase','applySHA256','failedHistory','knownIdentities','observation','scope','fullProcessTreeExit'))
 expected=receipt_value(m,frozen_sha,phase,apply_sha,v['observation']);need(v==expected and type(v['schemaVersion']) is int,'quiescence exact bindings/identity list')
 if fresh:fresh_at(v,clock_pair(time.time,time.monotonic))
 return v,v['knownIdentities']

def before_action(f,m,frozen_sha,path,digest,phase,apply_sha,label,checks):
 need((phase=='apply' and re.fullmatch('copy-[0-9]{3}',label)) or (phase=='reload' and label=='reload'),'fixed quiescence action')
 v,known=receipt_file(f,m,frozen_sha,path,digest,phase,apply_sha,fresh=True);ob=live_observe(known);validate_observation(ob,known)
 output=f/'quiescence-checks'/(label+'.json');dg=jsonwrite(output,{'receiptSHA256':digest,'frozenSHA256':frozen_sha,'label':label,'observation':ob});checks.append({'path':str(output),'sha256':dg,'classification':ob['classification']})
 fresh_at(v,ob['completed']);need(ob['classification']=='known-identities-quiescent','known attempt alive/unknown before action');fresh_at(v,clock_pair(time.time,time.monotonic))

def validate_action_evidence(f,m,frozen_sha,value,phase,apply_sha,labels):
 exact(value,('receiptSHA256','checks','scope','fullProcessTreeExit'));need(value['scope']==SCOPE and value['fullProcessTreeExit']=='unknown' and type(value['checks']) is list and len(value['checks'])==len(labels),'historical quiescence coverage')
 receipt,known=receipt_file(f,m,frozen_sha,f/('quiescence-'+phase+'.json'),value['receiptSHA256'],phase,apply_sha,fresh=False)
 for ref,label in zip(value['checks'],labels):
  exact(ref,('path','sha256','classification'));need(pathlib.Path(ref['path']).resolve(strict=True)==f/'quiescence-checks'/(label+'.json'),'action evidence path')
  row=private_json(ref['path'],ref['sha256'],65536);exact(row,('receiptSHA256','frozenSHA256','label','observation'))
  need(row['receiptSHA256']==value['receiptSHA256'] and row['frozenSHA256']==frozen_sha and row['label']==label,'action evidence bindings');validate_observation(row['observation'],known);fresh_at(receipt,row['observation']['completed'])
  need(row['observation']['classification']==ref['classification']=='known-identities-quiescent','action was not quiescent')
 return value
