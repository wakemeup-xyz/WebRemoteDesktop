"""Future one-use pinned restart-signal. Host identity must remain unchanged."""
from deployment import *
from known_attempt_quiescence import receipt_file,before_action,SCOPE
from owned_reload import owned_helper

def new_services(old,observed,started):
 exact(observed,('signal','host'));need(observed['host']==old['host'],'Host identity changed')
 need(observed['signal']!=old['signal'] and observed['signal']['birthEpoch']>=started-2,'new Signal identity required')
 return observed

def main():
 os.umask(0o077);p=args_parser(__doc__)
 for key in ('apply-sha256','quiescence-receipt','quiescence-sha256'):p.add_argument('--'+key,required=True)
 a=p.parse_args();f,m,b,changes,d,t,ts=asset_context(a,applied=True);ap=applied_record(f,m,a.frozen_sha256,a.apply_sha256);need(ap['assetReviewSHA256']==a.asset_review_sha256,'apply asset review pin');old_service_gate(b)
 receipt_file(f,m,a.frozen_sha256,a.quiescence_receipt,a.quiescence_sha256,'reload',a.apply_sha256,fresh=True)
 need(m['windowLowerMs']<=int(time.time()*1000)<=m['windowUpperMs']-10000,'startup window insufficient')
 need(not (f/'reload-started.json').exists() and not (f/'reload-result.json').exists(),'reload already consumed')
 start=time.time();marker={'frozenSHA256':a.frozen_sha256,'applySHA256':a.apply_sha256,'assetReviewSHA256':a.asset_review_sha256,'epoch':start,'oldIdentity':b['expectedServices'],'operation':'restart-signal','quiescenceReceiptSHA256':a.quiescence_sha256,'oneUse':True};ms=jsonwrite(f/'reload-started.json',marker)
 checks=[];helper=None;new=None;runtime=None;failure=None
 try:
  old_service_gate(b);before_action(f,m,a.frozen_sha256,a.quiescence_receipt,a.quiescence_sha256,'reload',a.apply_sha256,'reload',checks)
  helper=owned_helper()
  # Read-only readiness polling does not retry helper or alter Host/service state.
  deadline=time.monotonic()+90;last=None
  while True:
   try:
    new=new_services(b['expectedServices'],service_set(),start);runtime=runtime_gate(a,new);break
   except Exception as exc:
    last=type(exc).__name__
    if time.monotonic()>=deadline:raise ValueError('Signal/unchanged Host readiness unavailable: '+last)
    time.sleep(.5)
  need(helper['lifecycleAcceptable'] is True,'helper lifecycle incomplete')
 except BaseException as exc:failure=type(exc).__name__
 result={'schemaVersion':1,'classification':'completed' if failure is None else 'failed-or-indeterminate','frozenSHA256':a.frozen_sha256,'applySHA256':a.apply_sha256,'assetReviewSHA256':a.asset_review_sha256,'startedSHA256':ms,'operation':'restart-signal','oldIdentity':b['expectedServices'],'newIdentity':new,'helper':helper,'runtimeValidation':runtime,'quiescence':{'receiptSHA256':a.quiescence_sha256,'checks':checks,'scope':SCOPE,'fullProcessTreeExit':'unknown'},'errorClass':failure,'currentReadiness':readiness_facts(),'automaticRollbackOrRetry':False,'passwordsPersisted':False}
 digest=jsonwrite(f/'reload-result.json',result);print(json.dumps({'resultSHA256':digest,'classification':result['classification'],'rootMustReportCurrentPasswordsChatOnly':True}));return 0 if failure is None else 2
if __name__=='__main__':raise SystemExit(main())
