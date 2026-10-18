"""One-use read-only reconciliation eligibility; original failure remains immutable."""
from deployment import *
from readiness_records import reload_record

def main():
 os.umask(0o077);p=args_parser(__doc__);p.add_argument('--reload-sha256',required=True);a=p.parse_args();f,m,b,changes,d,t,ts=asset_context(a,applied=True,dist=False);r=reload_record(f,m,a.frozen_sha256,a.reload_sha256)
 need(r['assetReviewSHA256']==a.asset_review_sha256,'asset review drift');need(not (f/'readiness-started.json').exists() and not (f/'readiness-result.json').exists(),'readiness one-use')
 ms=jsonwrite(f/'readiness-started.json',{'frozenSHA256':a.frozen_sha256,'reloadSHA256':a.reload_sha256,'epoch':time.time(),'readOnly':True});failure=None;runtime=None
 try:runtime=runtime_gate(a,r['newIdentity'])
 except BaseException as exc:failure=type(exc).__name__
 result={'schemaVersion':1,'classification':'runtime-ready-observed' if failure is None else 'failed-or-indeterminate','frozenSHA256':a.frozen_sha256,'reloadSHA256':a.reload_sha256,'startedSHA256':ms,'assetReviewSHA256':a.asset_review_sha256,'newIdentity':r['newIdentity'],'runtimeValidation':runtime,'reloadClassificationPreserved':r['classification'],'helperLifecycleAcceptable':r['helper']['lifecycleAcceptable'],'errorClass':failure,'currentReadiness':readiness_facts(),'fullProcessTreeExit':'unknown','readOnly':True,'automaticRollbackOrRetry':False}
 dg=jsonwrite(f/'readiness-result.json',result);print(json.dumps({'resultSHA256':dg,'classification':result['classification']}));return 0 if failure is None else 2
if __name__=='__main__':raise SystemExit(main())
