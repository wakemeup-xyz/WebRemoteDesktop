"""Future fresh sequence only; no automatic browser or subsequent attempt."""
from continuation_common import *
def main():
 os.umask(0o077);p=args_parser(__doc__)
 for key in ('readiness-sha256','decision','decision-sha256','integration-evidence','integration-evidence-sha256'):p.add_argument('--'+key,required=True)
 a=p.parse_args();pkg=package_guard();dep={k:getattr(a,k) for k in ('frozen_dir','frozen_sha256','asset_review','asset_review_sha256')};offline={'path':str(pathlib.Path(a.integration_evidence).resolve()),'sha256':a.integration_evidence_sha256};d=private_json(a.decision,a.decision_sha256);validate_sequence_decision(d,pkg,dep,a.readiness_sha256,offline)
 m={'schemaVersion':1,'sequenceId':d['sequenceId'],'packageManifestSHA256':pkg,'productTIP':PRODUCT,'toolTIP':TOOL_TIP,'sourceTIP':final_source_tip(),'deployment':dep,'readinessSHA256':a.readiness_sha256,'rootDecision':{'path':str(pathlib.Path(a.decision).resolve()),'sha256':a.decision_sha256},'offlineIntegrationEvidence':offline,'failedHistory':FAILURES}
 ref=ready_context(m);integration(offline,ref);deployed_gate(ref)
 folder=R/('sequence-'+m['sequenceId']);folder.mkdir(mode=0o700);digest=jsonwrite(folder/'sequence.json',m);sequence(folder,digest);print(json.dumps({'sequenceDirectory':str(folder),'sequenceSHA256':digest,'automaticLaunch':False}));return 0
if __name__=='__main__':raise SystemExit(main())
