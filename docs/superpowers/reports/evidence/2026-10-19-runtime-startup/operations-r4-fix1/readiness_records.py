"""Definition-only reload lineage; preserves original failure classification."""
from deployment import *
from owned_reload import reconcilable_helper

def reload_record(f,m,fs,digest):
 r=private_json(f/'reload-result.json',digest,1048576)
 exact(r,('schemaVersion','classification','frozenSHA256','applySHA256','assetReviewSHA256','startedSHA256','operation','oldIdentity','newIdentity','helper','runtimeValidation','quiescence','errorClass','currentReadiness','automaticRollbackOrRetry','passwordsPersisted'));need(type(r['schemaVersion']) is int and r['schemaVersion']==1 and r['automaticRollbackOrRetry'] is False and r['passwordsPersisted'] is False,'reload result schema')
 marker=private_json(f/'reload-started.json',r['startedSHA256'])
 need(r['frozenSHA256']==fs==marker['frozenSHA256'] and r['operation']==marker['operation']=='restart-signal' and r['applySHA256']==marker['applySHA256'] and r['assetReviewSHA256']==marker['assetReviewSHA256'],'reload lineage')
 ap=applied_record(f,m,fs,r['applySHA256']);need(ap['assetReviewSHA256']==r['assetReviewSHA256'],'same asset review')
 from known_attempt_quiescence import validate_action_evidence
 validate_action_evidence(f,m,fs,r['quiescence'],'reload',r['applySHA256'],['reload'])
 need(marker['quiescenceReceiptSHA256']==r['quiescence']['receiptSHA256'] and marker['oneUse'] is True,'reload quiescence marker')
 b,_,_=history();need(r['oldIdentity']==marker['oldIdentity']==b['expectedServices'],'reload old identity');need(r['newIdentity'] is not None and r['newIdentity']['host']==b['expectedServices']['host'] and r['newIdentity']['signal']!=b['expectedServices']['signal'],'known new Signal/same Host')
 need(r['classification']=='completed' and r['errorClass'] is None and r['helper']['lifecycleAcceptable'] is True or r['classification']=='failed-or-indeterminate' and r['runtimeValidation'] is not None and reconcilable_helper(r['helper']),'specific reload ineligible')
 return r
