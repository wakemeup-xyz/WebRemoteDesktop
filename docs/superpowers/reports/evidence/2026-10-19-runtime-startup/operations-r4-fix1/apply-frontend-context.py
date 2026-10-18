"""Future root-only one-use source publication; never publishes dist or restarts."""
from deployment import *
from known_attempt_quiescence import receipt_file,before_action,SCOPE

def main():
 os.umask(0o077);p=args_parser(__doc__)
 for key in ('quiescence-receipt','quiescence-sha256'):p.add_argument('--'+key,required=True)
 a=p.parse_args();f,m,b,changes,d,t,ts=asset_context(a);old_service_gate(b)
 receipt_file(f,m,a.frozen_sha256,a.quiescence_receipt,a.quiescence_sha256,'apply',None,fresh=True)
 need(not (f/'apply-started.json').exists() and not (f/'apply-result.json').exists(),'apply already consumed')
 marker={'frozenSHA256':a.frozen_sha256,'tip':m['tip'],'epoch':time.time(),'paths':list(m['candidateFiles']),'quiescenceReceiptSHA256':a.quiescence_sha256,'scope':SCOPE,'oneUse':True}
 startedsha=jsonwrite(f/'apply-started.json',marker);copied=[];checks=[];failure=None;integrity=None
 try:
  for i,(rel,row) in enumerate(m['candidateFiles'].items()):
   if row['oldSha256'] is not None:
    old,mode=checked_file(P,rel);need(sha(old)==row['oldSha256'] and mode==row['oldMode'],'backup old pin');write(f/'backups'/rel,old)
   data,_=checked_file(f/'candidate',rel)
   def guard():
    preserved_gate();need(service_set()==b['expectedServices'],'service changed before publication');health();old_dist_gate(b)
    before_action(f,m,a.frozen_sha256,a.quiescence_receipt,a.quiescence_sha256,'apply',None,'copy-%03d'%i,checks)
   copy_one(rel,row,data,guard);copied.append(rel)
  asset_context(a,applied=True);old_service_gate(b);integrity={'knownRegularCount':source_map_gate(b,changes),'oldDistPreserved':True,'oldServicesPreserved':True}
 except BaseException as exc:failure=type(exc).__name__
 result={'schemaVersion':1,'classification':'source-applied' if failure is None else 'failed-or-indeterminate','frozenSHA256':a.frozen_sha256,'tip':m['tip'],'startedSHA256':startedsha,'assetReviewSHA256':a.asset_review_sha256,'appliedPaths':copied,'quiescence':{'receiptSHA256':a.quiescence_sha256,'checks':checks,'scope':SCOPE,'fullProcessTreeExit':'unknown'},'errorClass':failure,'integrity':integrity,'currentReadiness':readiness_facts(),'automaticRollbackOrRetry':False}
 digest=jsonwrite(f/'apply-result.json',result);print(json.dumps({'resultSHA256':digest,'classification':result['classification']}));return 0 if failure is None else 2
if __name__=='__main__':raise SystemExit(main())
