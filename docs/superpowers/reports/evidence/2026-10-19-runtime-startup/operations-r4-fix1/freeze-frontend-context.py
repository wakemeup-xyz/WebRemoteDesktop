"""Future root source freeze only. Requires final F receipt, never current HEAD inference."""
from deployment import *
def main():
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
 for key in ('source-review','source-review-sha256','decision','decision-sha256'):p.add_argument('--'+key,required=True)
 a=p.parse_args();pkg=package_guard();review=source_review(a.source_review,a.source_review_sha256);decision=private_json(a.decision,a.decision_sha256);validate_deployment_decision(decision,pkg,a.source_review_sha256)
 need(decision['windowLowerMs']>=int(time.time()*1000),'future window required');b,h,records=history();source_map_gate(b);old_dist_gate(b);tip=review['sourceTIP'];tr,_=tree(tip)
 f=R/('deployment-'+decision['deploymentId']);f.mkdir(mode=0o700);jsonwrite(f/'freeze-started.json',{'sourceReviewSHA256':a.source_review_sha256,'rootDecisionSHA256':a.decision_sha256,'primaryMutated':False});candidate={};inputs={}
 for rel in review['copyPaths']:
  data=blob(tip,rel);old=b['regularFiles'].get(rel);need(old is not None,'four existing source paths required')
  if old is None:need(nodeinfo(P/rel)=={'type':'absent'},'new source already exists')
  write(f/'candidate'/rel,data);candidate[rel]={'sha256':sha(data),'filesystemMode':old['filesystemMode'] if old else 0o600,'oldSha256':old['sha256'] if old else None,'oldMode':old['filesystemMode'] if old else None,'gitMode':tr[rel]['gitMode'],'objectId':tr[rel]['objectId']}
 for rel in sorted({n for n in tr if n.startswith('web-client/')}|BUILD_INPUTS):
  need(tr[rel]['kind']=='blob' and tr[rel]['gitMode'] in ('100644','100755'),'regular build input');data=blob(tip,rel);old=b['regularFiles'].get(rel);need(old is not None,'four existing source paths required');mode=old['filesystemMode'] if old else 0o600;write(f/'build-inputs'/rel,data,mode);inputs[rel]={'sha256':sha(data),'filesystemMode':mode}
 for rel,row in b['assets']['exactFinalFileMap'].items():
  data,mode=checked_file(P/'web-client/dist',rel);need(sha(data)==row['sha256'] and mode==row['filesystemMode'],'old asset changed');write(f/'old-dist'/rel,data,mode)
 code={n:dg for n,dg in private_json(R/'SHA256SUMS.json',pkg).items() if n.endswith(('.py','.js'))}
 m={'schemaVersion':1,'deploymentId':decision['deploymentId'],'packageManifestSHA256':pkg,'tip':tip,'toolTIP':TOOL_TIP,'productTIP':PRODUCT,'sourceReview':{'path':str(pathlib.Path(a.source_review).resolve()),'sha256':a.source_review_sha256},'rootDecision':{'path':str(pathlib.Path(a.decision).resolve()),'sha256':a.decision_sha256},'failedHistory':FAILURES,'preMapSHA256':sha(json.dumps(b['regularFiles'],sort_keys=True,separators=(',',':')).encode()),'candidateFiles':candidate,'buildInputs':inputs,'windowLowerMs':decision['windowLowerMs'],'windowUpperMs':decision['windowUpperMs'],'oldDistMap':b['assets']['exactFinalFileMap'],'codeHashes':code,'expectedPostCount':len(set(b['regularFiles'])|set(candidate))}
 source_map_gate(b);old_dist_gate(b);digest=jsonwrite(f/'frozen.json',m);frozen(f,digest);print(json.dumps({'frozenDirectory':str(f),'frozenSHA256':digest,'primaryMutated':False}));return 0
if __name__=='__main__':raise SystemExit(main())
