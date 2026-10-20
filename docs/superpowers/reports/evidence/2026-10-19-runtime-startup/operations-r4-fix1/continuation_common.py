"""Fresh mixed-component continuation; no old promotion/freeze replay."""
import argparse,secrets,sys,types
from deployment import *
# Latest failure remains immediate predecessor; all three are separately bound.
PRIOR_FAILURE=THIRD_FAILURE

def deployment_args(m):return types.SimpleNamespace(**m['deployment'])

def ready_context(m):
 a=deployment_args(m);f,fm,b,changes,d,t,ts=asset_context(a,applied=True,dist=False)
 r=private_json(f/'readiness-result.json',m['readinessSHA256'],1048576)
 need(r['classification']=='runtime-ready-observed' and r['errorClass'] is None and r['frozenSHA256']==a.frozen_sha256 and r['assetReviewSHA256']==a.asset_review_sha256,'fresh deployment readiness required')
 # Independently trace the successful or narrowly reconciled original reload.
 from readiness_records import reload_record
 reload=reload_record(f,fm,a.frozen_sha256,r['reloadSHA256'])
 need(r['newIdentity']==reload['newIdentity'] and all(r['runtimeValidation'][k]==reload['runtimeValidation'][k] for k in ('assets','identities','sourceTIP','frozenSHA256','componentPins')),'readiness/reload exact runtime snapshot')
 assets=r['runtimeValidation']['assets'];ref=dict(b,regularFiles=dict(b['regularFiles'],**changes),expectedServices=r['newIdentity'],assets=assets,directoryModes=t['directoryModes'],sourceTIP=fm['tip'])
 ref['_deployment']=m['deployment'];return ref

def sequence(folder,digest):
 pkg=package_guard();folder=pathlib.Path(folder).resolve(strict=True);need(folder.parent==R and folder.name.startswith('sequence-') and stat.S_IMODE(folder.stat().st_mode)==0o700,'new private sequence')
 m=private_json(folder/'sequence.json',digest)
 exact(m,('schemaVersion','sequenceId','packageManifestSHA256','productTIP','toolTIP','sourceTIP','deployment','readinessSHA256','rootDecision','offlineIntegrationEvidence','failedHistory'))
 need(type(m['schemaVersion']) is int and m['schemaVersion']==1 and m['packageManifestSHA256']==pkg and m['productTIP']==PRODUCT and m['toolTIP']==TOOL_TIP and m['sourceTIP']==final_source_tip() and m['failedHistory']==FAILURES,'mixed sequence pins')
 hex32(m['sequenceId']);need(folder.name=='sequence-'+m['sequenceId'],'sequence ID')
 exact(m['deployment'],('frozen_dir','frozen_sha256','asset_review','asset_review_sha256'));ref=ready_context(m)
 d=private_json(m['rootDecision']['path'],m['rootDecision']['sha256']);validate_sequence_decision(d,pkg,m['deployment'],m['readinessSHA256'],m['offlineIntegrationEvidence'])
 need(d['sequenceId']==m['sequenceId'],'sequence decision');integration(m['offlineIntegrationEvidence'],ref)
 return folder,m,ref

def integration(reference,ref):
 v=loads(check_ref(reference));exact(v,('schemaVersion','kind','sourceTIP','toolTIP','viewerBuildId','componentPins','checker','independentReview','result','actualExitCode','classification'))
 need(type(v['schemaVersion']) is int and v['schemaVersion']==1 and v['kind']=='root-mixed-native-pure-integration' and v['sourceTIP']==final_source_tip() and v['toolTIP']==TOOL_TIP and v['viewerBuildId']==ref['assets']['buildId'],'new mixed integration pins')
 need(v['componentPins']=={'signal':PRODUCT,'host':PRODUCT,'viewer':viewer_source_tip(),'tools':TOOL_TIP} and type(v['actualExitCode']) is int and v['actualExitCode']==0 and v['classification']=='passed-offline-only','actual mixed integration receipt')
 for key in ('checker','independentReview','result'):check_ref(v[key])
 need(v['checker']['sha256']==sha(regular(R/'mixed-native-integration.py')[0]),'exact prepared checker')
 result=loads(check_ref(v['result']));need(result=={'result':'pure-native-startup-integration-only','methods':4,'accepted':2,'rejected':10,'rows':1262,'sourceTIP':final_source_tip(),'viewerBuildId':ref['assets']['buildId'],'componentPins':v['componentPins']},'actual mixed checker result')
 return v

def validate_sequence_decision(d,pkg,deployment,readiness_sha,offline):
 exact(d,('schemaVersion','kind','sequenceId','packageManifestSHA256','sourceTIP','toolTIP','deployment','readinessSHA256','offlineIntegrationEvidence','failedHistory','automaticLaunch'))
 need(type(d['schemaVersion']) is int and d['schemaVersion']==1 and d['kind']=='root-new-frontend-context-sequence' and d['packageManifestSHA256']==pkg and d['sourceTIP']==final_source_tip() and d['toolTIP']==TOOL_TIP and d['deployment']==deployment and d['readinessSHA256']==readiness_sha and d['offlineIntegrationEvidence']==offline and d['failedHistory']==FAILURES and d['automaticLaunch'] is False,'explicit new sequence decision');hex32(d['sequenceId'])
 _,_,hist=history();need(d['sequenceId'] not in (hist['secondAttempt']['sequenceId'],hist['thirdAttempt']['sequenceId']),'old sequence reused')

def source_assets_guard(ref,tools=None):
 a=types.SimpleNamespace(**ref['_deployment']);f,m,b,changes,d,t,ts=asset_context(a,applied=True,dist=False);assets=verify_rendered_dist(d,ts,P/'web-client/dist');need(assets==ref['assets'],'deployed assets changed');return assets

def deployed_gate(ref,tools=None,*,require_idle=True):
 return runtime_gate(types.SimpleNamespace(**ref['_deployment']),ref['expectedServices'],require_idle=require_idle)

def reference():return base_reference()

def validate_attempt_decision(d,m,previous=None):
 exact(d,('schemaVersion','kind','sequenceId','attemptId','runNonce','scenario','mode','origin','productTIP','toolTIP','priorFailureSHA256','failedHistory','sourceTIP','previousResult'))
 need(type(d['schemaVersion']) is int and d['schemaVersion']==1 and d['kind']=='root-one-scenario-attempt' and d['sequenceId']==m['sequenceId'] and d['productTIP']==PRODUCT and d['toolTIP']==m['toolTIP'] and d['priorFailureSHA256']==PRIOR_FAILURE and d['failedHistory']==FAILURES and d['sourceTIP']==m['sourceTIP'],'attempt decision binding')
 for key in ('sequenceId','attemptId','runNonce'):hex32(d[key])
 need(len({d['sequenceId'],d['attemptId'],d['runNonce']})==3 and d['scenario'] in SCENARIOS and d['mode']=='relay' and d['origin']=='https://link.stockhub.wiki','fresh separate identities and fixed qualified entry')
 index=SCENARIOS.index(d['scenario'])
 if index==0:need(d['previousResult'] is None,'new baseline follows failed history, no passed predecessor')
 else:
  need(type(previous) is dict and type(d['previousResult']) is dict,'prior scenario result required');exact(d['previousResult'],('path','sha256'));need(previous.get('classification')=='observed-qualification-completed' and previous.get('scenario')==SCENARIOS[index-1] and previous.get('sequenceId')==m['sequenceId'] and previous.get('productTIP')==PRODUCT and previous.get('toolTIP')==m['toolTIP'] and previous.get('sourceTIP')==m['sourceTIP'] and previous.get('failedHistory')==FAILURES,'same sequence predecessor must pass')
 return d

def decision_and_predecessor(folder,m,path,digest):
 d=private_json(path,digest,16384);previous=None
 if d.get('previousResult') is not None:
  previous=loads(check_ref(d['previousResult']));index=SCENARIOS.index(d['scenario']);binding=readjson(folder/('attempt-'+SCENARIOS[index-1]+'.json'))
  need(pathlib.Path(d['previousResult']['path']).resolve()==folder/'attempts'/binding['attemptId']/'qualification-result.json','foreign previous result')
 validate_attempt_decision(d,m,previous)
 old=reference()['historical']['oldRuntimeManifest'];_,_,hist=history();need(d['runNonce'] not in (loads(check_ref(old))['runNonce'],hist['secondAttempt']['runNonce'],hist['thirdAttempt']['runNonce']),'old runtime nonce reused')
 need(d['attemptId'] not in (hist['secondAttempt']['attemptId'],hist['thirdAttempt']['attemptId']) and d['sequenceId'] not in (hist['secondAttempt']['sequenceId'],hist['thirdAttempt']['sequenceId']),'old attempt/sequence reused')
 for scenario in SCENARIOS:
  p=folder/('attempt-'+scenario+'.json')
  if p.exists():
   prior=readjson(p);need(d['attemptId']!=prior['attemptId'] and d['runNonce']!=prior['runNonce'],'attempt identity reused')
 return d

def check_runtime_binding(manifest,m,ref,pins,*,admission=False):
 exact(manifest,('schemaVersion','runNonce','createdAtEpochMs','validUntilEpochMs','scenario','mode','originSource','originEvidenceSha256','originSha256','deploymentEvidence','signal','host','viewer','signalLog'))
 need(type(manifest['schemaVersion']) is int and manifest['schemaVersion']==1 and manifest['runNonce']==pins['runNonce'] and manifest['scenario']==pins['scenario'] and manifest['mode']==pins['mode'],'runtime scenario/nonce')
 for key in ('createdAtEpochMs','validUntilEpochMs'):need(type(manifest[key]) is int and 0<=manifest[key]<=9999999999999,'runtime clock type')
 now=int(time.time()*1000);need(manifest['createdAtEpochMs']<=now<=manifest['validUntilEpochMs'] and 0<manifest['validUntilEpochMs']-manifest['createdAtEpochMs']<=43200000,'runtime clock/expiry')
 if admission:need(now-manifest['createdAtEpochMs']<=900000 and manifest['validUntilEpochMs']-now>=(BUDGET[pins['scenario']]+120)*1000,'fresh runtime admission budget')
 for name in ('signal','host'):need(manifest[name]=={'sourceCommit':PRODUCT,'sourceTreeSha256':ref['componentTrees'][name]},'product/tool identity conflation')
 need(manifest['viewer']=={'sourceCommit':viewer_source_tip(),'buildId':ref['assets']['buildId']},'Viewer product identity')
 need(manifest['originSource']=='formal-configured' and manifest['originSha256']==sha(pins['origin'].encode()),'formal origin identity')
 exact(manifest['deploymentEvidence'],('kind','sha256'));need(manifest['deploymentEvidence']['kind']=='root-verified-local-deployment' and valid_sha(manifest['deploymentEvidence']['sha256']) and valid_sha(manifest['originEvidenceSha256']),'attestation hashes')
 log=manifest['signalLog'];exact(log,('path','device','inode'));need(log['path']==ref['signalLogPath'] and type(log['device']) is int and 0<=log['device']<=9007199254740991 and type(log['inode']) is int and 0<log['inode']<=9007199254740991,'configured log identity schema')
 return manifest

def parser(description):
 p=argparse.ArgumentParser(description=description);p.add_argument('--attempt-dir',required=True);p.add_argument('--attempt-sha256',required=True);return p

def attempt_context(args,*,admission=False):
 path=pathlib.Path(args.attempt_dir).resolve(strict=True);a=private_json(path/'attempt.json',args.attempt_sha256)
 exact(a,('schemaVersion','sequenceDirectory','sequenceSHA256','sequenceId','attemptId','toolTIP','productTIP','readinessSHA256','decision','runtimeManifestSHA256','sourceFiles','scenario','mode','origin','runNonce','priorFailureSHA256','sourceTIP','failedHistory'))
 prepared=private_json(path/'preparation-result.json');exact(prepared,('classification','errorClass','attemptSHA256','automaticLaunch','scenarioReservationConsumed'))
 need(prepared=={'classification':'attempt-prepared-not-run','errorClass':None,'attemptSHA256':args.attempt_sha256,'automaticLaunch':False,'scenarioReservationConsumed':True},'attempt preparation incomplete')
 f,m,ref=sequence(a['sequenceDirectory'],a['sequenceSHA256']);need(type(a['schemaVersion']) is int and a['schemaVersion']==1,'attempt schema version');need(path==f/'attempts'/a['attemptId'] and a['sequenceId']==m['sequenceId'] and a['toolTIP']==m['toolTIP'] and a['productTIP']==PRODUCT,'attempt location/source binding')
 d=private_json(a['decision']['path'],a['decision']['sha256'],16384);previous=loads(check_ref(d['previousResult'])) if d['previousResult'] is not None else None;validate_attempt_decision(d,m,previous)
 for key in ('attemptId','sequenceId','scenario','mode','origin','runNonce','toolTIP','productTIP','priorFailureSHA256','sourceTIP','failedHistory'):need(a[key]==d[key],'attempt decision drift')
 reservation=readjson(f/('attempt-'+a['scenario']+'.json'));need(reservation=={'attemptId':a['attemptId'],'runNonce':a['runNonce'],'decisionSHA256':a['decision']['sha256']},'one-use attempt reservation')
 if previous is not None:
  index=SCENARIOS.index(a['scenario']);pb=readjson(f/('attempt-'+SCENARIOS[index-1]+'.json'));need(pathlib.Path(d['previousResult']['path']).resolve()==f/'attempts'/pb['attemptId']/'qualification-result.json','prior result path')
 need(a['readinessSHA256']==m['readinessSHA256'],'readiness pin');need(set(a['sourceFiles'])==set(RUNTIME),'runtime import pin closure')
 for rel,digest in a['sourceFiles'].items():need(sha(blob(m['sourceTIP'],rel))==digest==sha(checked_file(P,rel)[0]),'tool runtime source drift')
 for rel in RUNTIME[1:4]:need(blob(m['sourceTIP'],rel)==blob(PRODUCT,rel),'immutable runtime dependency changed')
 args.runtime_manifest=str(path/'runtime-manifest.json');args.runtime_manifest_sha256=a['runtimeManifestSHA256'];args.sequence=m;args.reference=ref;args.attempt=a
 manifest=private_json(args.runtime_manifest,args.runtime_manifest_sha256,16384);check_runtime_binding(manifest,m,ref,a,admission=admission)
 need(sha(regular(path/'origin-evidence.json')[0])==manifest['originEvidenceSha256'] and sha(regular(path/'deployment-evidence.json')[0])==manifest['deploymentEvidence']['sha256'],'fresh evidence binding')
 return path,m,ref,a,manifest

def source_pins(args,m):
 _,current,_,a,_=attempt_context(args);need(current==m,'sequence drift');return a

def reserve_attempt(folder,decision,decision_sha):
 marker=folder/('attempt-'+decision['scenario']+'.json');need(not marker.exists(),'scenario preparation already consumed')
 path=folder/'attempts'/decision['attemptId'];path.parent.mkdir(mode=0o700,exist_ok=True)
 need(stat.S_ISDIR(path.parent.lstat().st_mode),'attempt parent not plain');path.mkdir(mode=0o700)
 jsonwrite(marker,{'attemptId':decision['attemptId'],'runNonce':decision['runNonce'],'decisionSHA256':decision_sha});return path

def current_gate(args,expected):
 _,m,ref,_,_=attempt_context(args);need(expected==ref['expectedServices'],'current services');return deployed_gate(ref)
def qualification_integrity(args,expected):
 _,m,ref,_,_=attempt_context(args);need(expected==ref['expectedServices'],'current services');return deployed_gate(ref,require_idle=False)
