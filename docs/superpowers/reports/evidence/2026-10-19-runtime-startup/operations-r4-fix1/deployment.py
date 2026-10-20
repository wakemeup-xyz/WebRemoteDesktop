"""New deployed-state derivation. Entry points are explicit future operations only."""
import argparse,sys,math
from bindings import *
from asset_template import *

def args_parser(description,assets=True):
 p=argparse.ArgumentParser(description=description)
 for key in ('frozen-dir','frozen-sha256'):p.add_argument('--'+key,required=True)
 if assets:
  for key in ('asset-review','asset-review-sha256'):p.add_argument('--'+key,required=True)
 return p

def frozen(folder,digest,*,applied=False,dist=True):
 pkg=package_guard();folder=pathlib.Path(folder).resolve(strict=True);need(folder.parent==R and folder.name.startswith('deployment-'),'private deployment path')
 m=private_json(folder/'frozen.json',digest,16*1024*1024)
 exact(m,('schemaVersion','deploymentId','packageManifestSHA256','tip','toolTIP','productTIP','sourceReview','rootDecision','failedHistory','preMapSHA256','candidateFiles','buildInputs','windowLowerMs','windowUpperMs','oldDistMap','codeHashes','expectedPostCount'))
 need(type(m['schemaVersion']) is int and m['schemaVersion']==1 and m['packageManifestSHA256']==pkg and m['productTIP']==PRODUCT and m['toolTIP']==TOOL_TIP and m['failedHistory']==FAILURES,'deployment identity')
 hex32(m['deploymentId']);need(folder.name=='deployment-'+m['deploymentId'],'deployment ID');review=source_review(m['sourceReview']['path'],m['sourceReview']['sha256']);need(review['sourceTIP']==m['tip'],'source review TIP')
 decision=private_json(m['rootDecision']['path'],m['rootDecision']['sha256']);validate_deployment_decision(decision,pkg,m['sourceReview']['sha256'])
 for key in ('deploymentId','windowLowerMs','windowUpperMs'):need(m[key]==decision[key],'decision drift')
 b,h,records=history();need(m['preMapSHA256']==sha(json.dumps(b['regularFiles'],sort_keys=True,separators=(',',':')).encode()) and m['oldDistMap']==b['assets']['exactFinalFileMap'],'deployed pre-state lineage')
 need(list(m['candidateFiles'])==review['copyPaths']==list(COPY_PATHS),'candidate exact four allowlist');changes={}
 candidate_tree,_=tree(m['tip'])
 for rel,row in m['candidateFiles'].items():
  exact(row,('sha256','filesystemMode','oldSha256','oldMode','gitMode','objectId'));data,mode=checked_file(folder/'candidate',rel);old=b['regularFiles'].get(rel);need(old is not None,'new primary paths forbidden')
  need(mode==0o600 and sha(data)==row['sha256']==sha(blob(m['tip'],rel)) and row['gitMode']=='100644' and row['objectId']==candidate_tree[rel]['objectId'],'frozen candidate bytes')
  need(row['oldSha256']==(old['sha256'] if old else None) and row['oldMode']==(old['filesystemMode'] if old else None) and row['filesystemMode']==(old['filesystemMode'] if old else 0o600),'candidate baseline modes')
  if not applied and old is None:need(nodeinfo(P/rel)=={'type':'absent'},'addition already exists')
  changes[rel]={'sha256':row['sha256'],'filesystemMode':row['filesystemMode']}
 tr,_=tree(m['tip']);inputset={n for n in tr if n.startswith('web-client/')}|BUILD_INPUTS;need(set(m['buildInputs'])==inputset and not any(n.startswith('web-client/dist/') for n in inputset),'complete frozen build inputs')
 for rel,row in m['buildInputs'].items():
  data,mode=checked_file(folder/'build-inputs',rel);old=b['regularFiles'].get(rel)
  need(tr[rel]['kind']=='blob' and tr[rel]['gitMode'] in ('100644','100755') and sha(data)==row['sha256']==sha(blob(m['tip'],rel)) and mode==row['filesystemMode']==(old['filesystemMode'] if old else 0o600),'build input pin/mode')
 need(m['expectedPostCount']==len(b['regularFiles'])==len(set(b['regularFiles'])|set(changes))==1016,'four replacements preserve known map')
 source_map_gate(b,changes if applied else None)
 expected_code={n:dg for n,dg in private_json(R/'SHA256SUMS.json',pkg).items() if n.endswith(('.py','.js'))};need(m['codeHashes']==expected_code,'complete frozen code closure')
 for name,dg in m['codeHashes'].items():need(sha(checked_file(R,name)[0])==dg,'frozen code pin')
 need(distmap(folder/'old-dist')==m['oldDistMap'],'frozen old dist')
 if dist:old_dist_gate(b)
 return folder,m,b,changes

def validate_deployment_decision(d,pkg,source_sha):
 exact(d,('schemaVersion','kind','deploymentId','packageManifestSHA256','sourceReviewSHA256','failedHistory','windowLowerMs','windowUpperMs','operation'))
 need(type(d['schemaVersion']) is int and d['schemaVersion']==1 and d['kind']=='root-new-frontend-deployment' and d['packageManifestSHA256']==pkg and d['sourceReviewSHA256']==source_sha and d['failedHistory']==FAILURES and d['operation']=='source-copy-and-restart-signal-only','explicit frontend decision')
 hex32(d['deploymentId']);lo,hi=d['windowLowerMs'],d['windowUpperMs'];need(type(lo) is int and type(hi) is int and 0<=lo<hi<=9007199254740991 and hi-lo<=600000,'fresh600s window')

def validate_builder_diagnostics(value):
 """Exact bounded schema2 evidence; supported events alone do not veto Registry."""
 exact(value,('schemaVersion','scope','role','events','dropped','failed','expectedStateExitCounts','gaps','gapsDropped','overflow','limits'))
 need(type(value['schemaVersion']) is int and value['schemaVersion']==2 and value['scope']=='diagnostic-only' and value['role']=='worker' and value['failed'] is False,'builder diagnostics schema/failed')
 stages=('worker-loop','cleanup','result');contexts=('state','scan','signal','outside');maximum=2147483647
 def integer(v,lo=0):return type(v) is int and lo<=v<=maximum
 def number(v):return type(v) in (int,float) and math.isfinite(v) and v>=0
 for key in ('dropped','gapsDropped'):need(type(value[key]) is int and value[key]==0,'builder diagnostic drops')
 exact(value['overflow'],('events','gaps','contexts','counters'));need(all(v is False for v in value['overflow'].values()),'builder diagnostic overflow')
 exact(value['limits'],('events','gaps','contextDepth','counter'));need(all(type(v) is int for v in value['limits'].values()) and value['limits']=={'events':32,'gaps':32,'contextDepth':8,'counter':maximum},'builder diagnostic bounds')
 exact(value['expectedStateExitCounts'],stages);need(all(integer(v) for v in value['expectedStateExitCounts'].values()),'expected exit counters')
 for key in ('events','gaps'):need(type(value[key]) is list and len(value[key])<=32,'builder diagnostic list bounds')
 events={};last=0
 for event in value['events']:
  exact(event,('eventId','scanId','role','stage','context','operation','pid','birth','exception','errno','monotonic','wall'))
  need(integer(event['eventId'],1) and event['eventId']>last,'unique ordered event IDs');last=event['eventId'];events[last]=event
  need(event['scanId'] is None or integer(event['scanId'],1),'event scan ID')
  need(event['role']=='worker' and event['stage'] in stages and event['context'] in contexts and event['operation'] in ('resolve','pid','create_time','status','children','ppid','terminate','kill'),'bounded event tags')
  need(event['exception'] in ('NoSuchProcess','AccessDenied','OSError'),'supported event classification')
  need(event['context']!='scan' or event['scanId'] is not None,'scan event context')
  need(event['pid'] is None or integer(event['pid'],1),'event PID');need(event['birth'] is None or number(event['birth']),'event birth')
  need(event['errno'] is None or type(event['errno']) is int and -maximum<=event['errno']<=maximum,'event errno')
  need(number(event['monotonic']) and number(event['wall']),'event clocks')
 for gap in value['gaps']:
  exact(gap,('scanId','eventId','association','reason','role','stage','monotonic','wall'))
  need(gap['scanId'] is None or integer(gap['scanId'],1),'gap scan ID')
  need(gap['role']=='worker' and gap['stage'] in stages and gap['reason']=='observation-unavailable' and gap['association'] in ('direct-scan-error','unassociated'),'bounded gap tags')
  need(number(gap['monotonic']) and number(gap['wall']),'gap clocks')
  if gap['association']=='unassociated':need(gap['eventId'] is None,'unassociated gap')
  else:
   need(integer(gap['eventId'],1) and gap['eventId'] in events,'gap event identity');event=events[gap['eventId']]
   need(event['context']=='scan' and event['scanId']==gap['scanId'],'direct scan association')
 need(len(json.dumps(value,allow_nan=False,separators=(',',':')).encode())<=32768,'builder diagnostic serialized bound')
 return value

def asset_context(args,*,applied=False,dist=True):
 f,m,b,changes=frozen(args.frozen_dir,args.frozen_sha256,applied=applied,dist=dist);v=private_json(args.asset_review,args.asset_review_sha256,32768)
 exact(v,('schemaVersion','frozenSHA256','templateRelativePath','templateSHA256','buildResultSHA256','independentReview'))
 need(type(v['schemaVersion']) is int and v['schemaVersion']==1 and v['frozenSHA256']==args.frozen_sha256,'asset review binding');check_ref(v['independentReview']);rel=relative(v['templateRelativePath']);need('/' not in rel and rel.startswith('two-time-template-'),'template path')
 d=f/rel;t=private_json(d/'template.json',v['templateSHA256'],1048576);result=private_json(f/'build-result.json',v['buildResultSHA256'],1048576)
 need(result['classification']=='private-two-time-template-frozen' and result['frozenSHA256']==args.frozen_sha256 and result['templateSHA256']==v['templateSHA256'] and result['templateDirectory']==str(d),'actual build result binding')
 need(t['codeHashes']==m['codeHashes'],'template executable closure')
 need(type(result['children']) is list and [v['endpoint'] for v in result['children']]==['lower','upper'],'two actual endpoint records')
 for child in result['children']:
  cr=child['result'];validate_builder_diagnostics(cr.get('processDiagnostics'));need('diagnosticsErrorClass' in cr and cr['diagnosticsErrorClass'] is None,'builder diagnostic snapshot failure');need(cr['classification']=='observed-private-build-completed' and cr['intervened'] is False and cr['helperExit']==0 and cr['timedOut'] is False and all(cr[k] is None for k in ('errorClass','cleanupErrorClass','ownershipErrorClass')) and cr['unexpectedCoverage']==[],'endpoint lifecycle evidence');validate_owned_coverage(cr['ownership']);validate_no_signals(cr['ownership'])
 need(t['kind']=='frontend-two-time-template' and t['tip']==m['tip'] and t['frozenSHA256']==args.frozen_sha256 and t['windowLowerMs']==m['windowLowerMs'] and t['windowUpperMs']==m['windowUpperMs'],'template source/window')
 need(all(mode==0o755 for mode in t['directoryModes'].values()) and all(row['filesystemMode']==0o644 for row in t['files'].values()),'strict output mode profile')
 for rel,row in t['files'].items():need(sha(checked_file(d/'expected',rel)[0])==row['templateSha256'],'template data drift')
 return f,m,b,changes,d,t,v['templateSHA256']

def runtime_gate(args,expected,*,require_idle=True):
 f,m,b,changes,d,t,ts=asset_context(args,applied=True,dist=False);preserved_gate();need(service_set()==expected,'current service identities');need(expected['host']==b['expectedServices']['host'],'Host replacement forbidden')
 assets=verify_rendered_dist(d,ts,P/'web-client/dist');h=health(require_idle=require_idle);preserved_gate();need(service_set()==expected,'service identity raced')
 return {'health':h,'identities':expected,'assets':assets,'preserved':True,'sourceTIP':m['tip'],'frozenSHA256':args.frozen_sha256,'componentPins':{'signal':PRODUCT,'host':PRODUCT,'viewer':viewer_source_tip(),'tools':TOOL_TIP}}

def applied_record(f,m,frozen_sha,digest):
 r=private_json(f/'apply-result.json',digest,1048576)
 exact(r,('schemaVersion','classification','frozenSHA256','tip','startedSHA256','assetReviewSHA256','appliedPaths','quiescence','errorClass','integrity','currentReadiness','automaticRollbackOrRetry'))
 need(type(r['schemaVersion']) is int and r['schemaVersion']==1 and r['automaticRollbackOrRetry'] is False,'apply result schema')
 marker=private_json(f/'apply-started.json',r['startedSHA256']);exact(marker,('frozenSHA256','tip','epoch','paths','quiescenceReceiptSHA256','scope','oneUse'))
 need(marker['frozenSHA256']==frozen_sha and marker['tip']==m['tip'] and marker['paths']==list(m['candidateFiles']) and marker['oneUse'] is True and marker['quiescenceReceiptSHA256']==r['quiescence']['receiptSHA256'],'apply started binding')
 from known_attempt_quiescence import validate_action_evidence,SCOPE
 need(marker['scope']==SCOPE,'apply scope');validate_action_evidence(f,m,frozen_sha,r['quiescence'],'apply',None,['copy-%03d'%i for i in range(len(m['candidateFiles']))])
 need(r['classification']=='source-applied' and r['frozenSHA256']==frozen_sha and r['tip']==m['tip'] and r['appliedPaths']==list(m['candidateFiles']) and r['errorClass'] is None,'exact successful apply')
 for rel,row in m['candidateFiles'].items():
  if row['oldSha256'] is not None:need(sha(checked_file(f/'backups',rel)[0])==row['oldSha256'],'source backup drift')
 return r

def copy_one(rel,row,data,before_replace):
 need(sha(data)==row['sha256'],'frozen copy bytes');parent=P
 for part in pathlib.PurePosixPath(relative(rel)).parts[:-1]:
  parent=parent/part
  try:parent.mkdir(mode=0o700)
  except FileExistsError:pass
  need(stat.S_ISDIR(parent.lstat().st_mode),'plain copy ancestor')
 dest=P/rel
 def check():
  if row['oldSha256'] is None:need(nodeinfo(dest)=={'type':'absent'},'addition raced')
  else:
   old,mode=checked_file(P,rel);need(sha(old)==row['oldSha256'] and mode==row['oldMode'],'copy old bytes/mode')
 check();fd,name=tempfile.mkstemp(prefix='.wrd-viewer-',dir=parent);tmp=pathlib.Path(name)
 try:
  with os.fdopen(fd,'wb') as stream:os.fchmod(stream.fileno(),row['filesystemMode']);stream.write(data);stream.flush();os.fsync(stream.fileno())
  check();before_replace()
  if row['oldSha256'] is None:os.link(tmp,dest,follow_symlinks=False);tmp.unlink()
  else:os.replace(tmp,dest)
  actual,mode=checked_file(P,rel);need(sha(actual)==row['sha256'] and mode==row['filesystemMode'],'copied bytes/mode')
 finally:
  if tmp.exists():tmp.unlink()
