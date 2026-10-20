"""Definition-only tool continuation history and immutable mixed deployment."""
from core import *
TOOLS=('scripts/ordinary_session_recovery.py','scripts/test_ordinary_session_recovery.py')
OLD_TOOL_TIP='59bca14209eed299b0e94da58decb8b85e5ce70c'
VIEWER_TIP='c802a68362459b46b84593c7e8921575e0783394'
MODULE_TIP='35c6f972d30b8c225c2d9feac2773ddb21b43cd0'
OLD_FAILURE='2f0f2a2a0774b15f8b62adef72bb997d5deeae298a06640e71583d2d3cd33242'
SECOND_FAILURE='af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6'
THIRD_FAILURE='5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9'
FAILURES=[OLD_FAILURE,SECOND_FAILURE,THIRD_FAILURE]
PRIOR_FAILURE=THIRD_FAILURE
SCENARIOS=('baseline','within-grace','after-grace','continuity')
BUDGET={'baseline':300,'within-grace':390,'after-grace':390,'continuity':10800}
RUNTIME=('scripts/ordinary_session_recovery.py','scripts/ordinary_recovery_fault.py','scripts/passive_session_soak.py','scripts/passive_session_sampler.js','scripts/process_observation_diagnostics.py')

def exact(value,keys):need(type(value) is dict and set(value)==set(keys),'exact keys required')

def hex32(value):need(type(value) is str and re.fullmatch('[a-f0-9]{32}',value),'fresh identity syntax')

def private_json(path,digest=None,limit=1048576):
 p=pathlib.Path(path);need(p.is_absolute(),'absolute private path required')
 literal=str(p);literal='/private'+literal if literal.startswith(('/var/','/tmp/')) else literal
 need(str(p.resolve(strict=True))==literal,'private symlink ancestor')
 data,mode=regular(p,limit)
 need(mode==0o600 and p.lstat().st_uid==os.getuid(),'private file ownership/mode')
 if digest is not None:need(valid_sha(digest) and sha(data)==digest,'private digest mismatch')
 return loads(data)

def check_ref(ref):
 exact(ref,('path','sha256'));need(type(ref['path']) is str and pathlib.Path(ref['path']).is_absolute() and len(ref['path'].encode())<=1024 and valid_sha(ref['sha256']),'absolute bounded reference/hash');data,_=regular(pathlib.Path(ref['path']));need(sha(data)==ref['sha256'],'historical/review reference drift');return data

def base_reference():
 value=readjson(R/'legacy-deployed-reference.json');need(value['productTIP']==PRODUCT and value['docBaseTIP']==DOCBASE,'product reference')
 h={name:loads(check_ref(ref)) for name,ref in value['historical'].items() if name!='oldRows'};check_ref(value['historical']['oldRows'])
 need(value['historical']['oldFailure']['sha256']==OLD_FAILURE and h['oldFailure']['classification']=='failed-or-indeterminate','historical failure binding')
 need(h['frozen']['tip']==PRODUCT and h['apply']['tip']==PRODUCT and h['apply']['classification']=='source-applied','historical source binding')
 need(h['reload']['classification']=='completed' and h['reload']['frozenSHA256']==value['historical']['frozen']['sha256'] and h['reload']['applySHA256']==value['historical']['apply']['sha256'],'reload binding')
 need(h['readiness']['classification']=='runtime-ready-observed' and h['readiness']['reloadSHA256']==value['historical']['reload']['sha256'] and h['readiness']['newIdentity']==value['expectedServices']==h['reload']['newIdentity'],'readiness identity binding')
 need(h['readiness']['runtimeValidation']['assets']==value['assets'] and h['template']['directoryModes']==value['directoryModes'],'historical exact assets')
 need(h['oldMarker']['frozenSHA256']==value['historical']['frozen']['sha256'] and h['oldFailure']['frozenSHA256']==h['oldMarker']['frozenSHA256'],'failed attempt identity')
 derived={rel:{'sha256':row['sha256'],'filesystemMode':row['filesystemMode']} for rel,row in h['baseline']['regularFiles'].items()}
 for rel,row in h['frozen']['candidateFiles'].items():derived[rel]={'sha256':row['sha256'],'filesystemMode':row['targetFilesystemMode']}
 need(value['regularFiles']==derived and len(derived)==989 and len(value['assets']['exactFinalFileMap'])==14,'derived expected map coverage')
 for key in ('head','indexSha256','indexMetadataSha256'):need(value[key]==h['baseline'][key],'primary baseline metadata binding')
 need(value['exceptions']==h['baseline']['explicitPreservedExceptions'] and value['primaryNodeModules']==h['baseline']['primaryNodeModulesMetadataOnly'] and value['sourceNodeModules']==h['baseline']['sourceNodeModulesMetadataOnly'],'preserved exception/dependency metadata')
 return value

def raw_diff(base,tip):
 chunks=[x for x in git(S,'diff','--raw','--no-abbrev','--no-renames','-z',base,tip).split(b'\0') if x];need(len(chunks)%2==0,'raw diff structure');out=[]
 for i in range(0,len(chunks),2):
  fields=chunks[i].decode().split();need(len(fields)==5,'raw fields');out.append({'path':relative(chunks[i+1].decode()),'oldMode':fields[0][1:],'newMode':fields[1],'oldObject':fields[2],'newObject':fields[3],'status':fields[4]})
 return out

def validate_owned_coverage(*evidence):
 for row in evidence:need(row.get('allRecordedIdentitiesExited') is True and not (set(row.get('coverage',[]))-INHERENT),'owned lifecycle uncertainty')

def validate_no_signals(*evidence):
 for row in evidence:need(not row.get('signals'),'intervened child cannot qualify')

def source_map_gate(b,changes=None):
 need(git(P,'rev-parse','HEAD').decode().strip()==b['head'],'primary HEAD drift');index=pathlib.Path(git(P,'rev-parse','--git-path','index').decode().strip());index=index if index.is_absolute() else P/index
 need(sha(regular(index)[0])==b['indexSha256'] and sha(git(P,'ls-files','--stage','-z'))==b['indexMetadataSha256'],'index drift')
 expected=dict(b['regularFiles']);expected.update(changes or {})
 for rel,row in expected.items():
  data,mode=checked_file(P,rel);need(sha(data)==row['sha256'] and mode==row['filesystemMode'],'known source bytes/mode drift')
 need(nodeinfo(P/'signal-server/node_modules')==b['primaryNodeModules'] and nodeinfo(S/'signal-server/node_modules')==b['sourceNodeModules'],'dependency metadata drift')
 return len(expected)

def old_dist_gate(b):need(distmap(P/'web-client/dist')==b['assets']['exactFinalFileMap'] and directory_modes(P/'web-client/dist')==b['directoryModes'],'old exact dist drift')

def old_service_gate(b):preserved_gate();need(service_set()==b['expectedServices'],'original service identity drift');health();preserved_gate()

def package_guard():
 v=private_json(R/'EXECUTION-REVIEW.json',limit=32768);exact(v,('schemaVersion','scope','packageManifestSha256','independentReview'))
 need(type(v['schemaVersion']) is int and v['schemaVersion']==1 and v['scope']=='viewer-tools-successor-r1','new package review required');check_ref(v['independentReview'])
 sums=private_json(R/'SHA256SUMS.json',v['packageManifestSha256']);need(type(sums) is dict and 1<=len(sums)<=64,'package bound')
 for name,digest in sums.items():need(sha(checked_file(R,relative(name))[0])==digest,'package drift')
 return v['packageManifestSha256']

def history():
 b=base_reference();h=readjson(R/'legacy-tool-history.json');records={k:loads(check_ref(v)) for k,v in h['records'].items()};s=records['toolSequence'];p=records['toolPromotion']
 need(s['productTIP']==PRODUCT and s['toolTIP']==OLD_TOOL_TIP and p['classification']=='tools-promoted' and p['sequenceSHA256']==h['records']['toolSequence']['sha256'] and p['copied']==list(TOOLS) and p['servicesReloaded'] is False and p['errorClass'] is None,'actual old tool deployment linkage')
 need(h['records']['secondFailure']['sha256']==SECOND_FAILURE and records['secondFailure']['classification']=='failed-or-indeterminate' and records['secondFailure']['priorFailureSHA256']==OLD_FAILURE,'first two failures binding')
 need(records['secondMarker']['attemptSHA256']==h['records']['secondAttempt']['sha256']==records['secondFailure']['attemptSHA256'] and records['secondAttempt']['promotionSHA256']==h['records']['toolPromotion']['sha256'],'second attempt deployment linkage')
 expected=dict(b['regularFiles']);prime_blobs(OLD_TOOL_TIP,list(TOOLS))
 for name,row in s['tools'].items():
  need(name in TOOLS and row['oldSha256']==expected[name]['sha256'] and row['sha256']==sha(blob(OLD_TOOL_TIP,name)) and row['filesystemMode']==expected[name]['filesystemMode'],'actual old tool override')
  expected[name]={'sha256':row['sha256'],'filesystemMode':row['filesystemMode']}
 need(set(s['tools'])==set(TOOLS) and len(expected)==989,'old tool pre-map derivation')
 newer=readjson(R/'deployment-history.json');exact(newer,('schemaVersion','records'));need(type(newer['schemaVersion']) is int and newer['schemaVersion']==1,'history schema')
 records.update({k:loads(check_ref(v)) for k,v in newer['records'].items()});h={'records':dict(h['records'],**newer['records'])}
 frozen=records['r5Frozen'];applied=records['r5Apply'];reload=records['r5Reload'];ready=records['r5Readiness'];template=records['r5Template'];asset_review=records['r5AssetReview']
 need(frozen['tip']==VIEWER_TIP and frozen['toolTIP']==OLD_TOOL_TIP and frozen['productTIP']==PRODUCT and frozen['expectedPostCount']==1016,'actual Viewer deployment identity')
 need(frozen['preMapSHA256']==sha(json.dumps(expected,sort_keys=True,separators=(',',':')).encode()),'historical source pre-map')
 need(applied['classification']=='source-applied' and applied['errorClass'] is None and applied['frozenSHA256']==h['records']['r5Frozen']['sha256'] and applied['appliedPaths']==list(frozen['candidateFiles']) and applied['assetReviewSHA256']==h['records']['r5AssetReview']['sha256'],'actual Viewer source apply binding')
 need(reload['classification']=='completed' and reload['errorClass'] is None and reload['operation']=='restart-signal' and reload['frozenSHA256']==h['records']['r5Frozen']['sha256'] and reload['applySHA256']==h['records']['r5Apply']['sha256'] and reload['assetReviewSHA256']==h['records']['r5AssetReview']['sha256'],'actual historical reload binding')
 need(ready['classification']=='runtime-ready-observed' and ready['errorClass'] is None and ready['reloadSHA256']==h['records']['r5Reload']['sha256'] and ready['frozenSHA256']==h['records']['r5Frozen']['sha256'] and ready['assetReviewSHA256']==h['records']['r5AssetReview']['sha256'] and ready['newIdentity']==reload['newIdentity'],'actual historical readiness binding')
 for key in ('assets','identities','sourceTIP','frozenSHA256','componentPins'):need(ready['runtimeValidation'][key]==reload['runtimeValidation'][key],'historical runtime evidence drift')
 need(asset_review['frozenSHA256']==h['records']['r5Frozen']['sha256'] and asset_review['templateSHA256']==h['records']['r5Template']['sha256'],'historical asset approval binding');check_ref(asset_review['independentReview'])
 prime_blobs(VIEWER_TIP,list(frozen['candidateFiles']))
 for name,row in frozen['candidateFiles'].items():
  old=expected.get(name);need(row['oldSha256']==(old['sha256'] if old else None) and row['oldMode']==(old['filesystemMode'] if old else None),'historical source copy precondition')
  need(row['sha256']==sha(blob(VIEWER_TIP,name)) and row['filesystemMode']==(old['filesystemMode'] if old else 0o600),'historical exact source bytes/modes');expected[name]={'sha256':row['sha256'],'filesystemMode':row['filesystemMode']}
 need(len(expected)==1016 and len(frozen['candidateFiles'])==30,'historical known file coverage')
 assets=ready['runtimeValidation']['assets'];need(assets['buildId']=='bb581651b422e400' and assets['builtAt']==1792336142126 and len(assets['exactFinalFileMap'])==14,'actual retained Viewer assets')
 services={'signal':{'pid':33747,'birthEpoch':1792336141.182036},'host':{'pid':36877,'birthEpoch':1792322600.528357}}
 need(ready['newIdentity']==services and reload['oldIdentity']['host']==services['host'],'same Host and deployed Signal births')
 need(h['records']['thirdFailure']['sha256']==THIRD_FAILURE and records['thirdFailure']['classification']=='failed-or-indeterminate' and records['thirdFailure']['failedHistory']==FAILURES[:2] and records['thirdFailure']['priorFailureSHA256']==SECOND_FAILURE,'third failure preserved')
 third=records['thirdAttempt'];marker=records['thirdMarker'];failed=records['thirdFailure'];seq=records['thirdSequence']
 need(marker['attemptSHA256']==failed['attemptSHA256']==h['records']['thirdAttempt']['sha256'] and third['sequenceSHA256']==h['records']['thirdSequence']['sha256'] and seq['readinessSHA256']==h['records']['r5Readiness']['sha256'],'third attempt deployment lineage')
 for key in ('sequenceId','attemptId','productTIP','toolTIP','sourceTIP','runtimeManifestSHA256'):need(marker[key]==failed[key]==third[key],'third attempt marker/terminal binding')
 need(third['runtimeManifestSHA256']==h['records']['thirdRuntimeManifest']['sha256'],'third runtime nonce binding')
 b=dict(b,regularFiles=expected,expectedServices=services,assets=assets,directoryModes=template['directoryModes'],viewerSourceTIP=VIEWER_TIP)
 return b,h,records

def reference():return history()[0]

TOOL_TIP='2822441791b59a021556c7e4eb24715df9d5b277'
from policy import COPY_PATHS,BUILD_INPUTS

def final_binding():
 v=private_json(R/'FINAL-BINDING.json',limit=32768);exact(v,('schemaVersion','sourceTIP','viewerSourceTIP','toolTIP','sourceReview'))
 need(type(v['schemaVersion']) is int and v['schemaVersion']==1 and v['toolTIP']==TOOL_TIP,'final binding schema/tools')
 for key in ('sourceTIP','viewerSourceTIP'):need(type(v[key]) is str and re.fullmatch('[a-f0-9]{40}',v[key]),'full final source identity required')
 check_ref(v['sourceReview']);return v

def final_source_tip():return final_binding()['sourceTIP']
def viewer_source_tip():return final_binding()['viewerSourceTIP']

def source_review(path,digest):
 from source_review_gate import validate_source_review
 return validate_source_review(path,digest)
