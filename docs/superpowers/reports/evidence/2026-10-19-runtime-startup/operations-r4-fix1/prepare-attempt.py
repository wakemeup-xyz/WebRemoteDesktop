"""Future root-only fresh entry/manifest attestation. No browser/admission or retry."""
import urllib.request
from continuation_common import *

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def fetch(opener,url,cap):
 request=urllib.request.Request(url,headers={'Cache-Control':'no-cache','Accept-Encoding':'identity','User-Agent':'Mozilla/5.0'})
 with opener.open(request,timeout=5) as response:
  need(response.status==200 and response.geturl()==url,'entry status/redirect');data=response.read(cap+1);need(len(data)<=cap,'entry byte cap');return data

def html_matches(local,public):
 if public==local:return b''
 boundary=local.rfind(b'</body>');delta=len(public)-len(local)
 need(0<delta<=4096 and boundary>=len(local)-32 and public[:boundary]==local[:boundary] and public[boundary+delta:]==local[boundary:],'public application bytes differ')
 edge=public[boundary:boundary+delta];need(b'<script' in edge and b'</script>' in edge and (b'cloudflareinsights' in edge or b'cloudflare-static' in edge) and all(x not in edge.lower() for x in (b'<base',b'<meta',b'<iframe')),'unreviewed footer shape');return edge

def attest_origin(ref,origin,fetcher=fetch):
 local=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect());public=urllib.request.build_opener(NoRedirect())
 status=[loads(fetcher(opener,url,65536)) for opener,url in ((local,'http://127.0.0.1:8080/api/status'),(public,origin+'/api/status'),(local,'http://127.0.0.1:8080/api/status'))]
 host=status[0].get('hostId');need(type(host) is str and 0<len(host.encode())<=128 and all(v.get('hostId')==host for v in status),'current public/local Host mismatch')
 for value in status:need(value.get('hostOnline') is True and type(value.get('viewerCount')) is int and value['viewerCount']==0 and type(value.get('relayViewerCount')) is int and value['relayViewerCount']==0,'entry strict idle required')
 need(loads(fetcher(public,origin+'/health',65536)).get('status')=='ok','entry health')
 publichtml=fetcher(public,origin+'/viewer.html',65536);localhtml,_=regular(P/'web-client/dist/viewer.html',65536);edge=html_matches(localhtml,publichtml)
 cores=[n for n in ref['assets']['exactFinalFileMap'] if re.fullmatch(r'assets/desktop-core\.[a-f0-9]{16}\.js',n)];manifest=loads(regular(P/'web-client/dist/asset-manifest.json')[0]);core=manifest['assets']['desktopJs'];need(core in cores,'current desktop entry');corebytes=fetcher(public,origin+'/'+core,1048576);need(sha(corebytes)==ref['assets']['exactFinalFileMap'][core]['sha256'],'public current core mismatch')
 return {'scope':'root-verified-formal-entry-to-current-local-instance','checkedAtEpochMs':int(time.time()*1000),'origin':origin,'hostIdEquality':True,'hostIdHash':sha(secrets.token_bytes(16)+host.encode())[:16],'hostOnline':True,'viewerCount':0,'relayViewerCount':0,'viewerBuildId':ref['assets']['buildId'],'publicViewerHtmlSha256':sha(publichtml),'localViewerHtmlSha256':sha(localhtml),'htmlApplicationBytesExact':True,'edgeFooterInsertionBytes':len(edge),'edgeFooterInsertionSha256':sha(edge) if edge else None,'publicCoreSha256':sha(corebytes),'readinessClientUserAgent':'Mozilla/5.0','browserUserAgentOverridden':False,'sourceEvidence':'root-attested'}

def main():
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
 for key in ('sequence-dir','sequence-sha256','decision','decision-sha256'):p.add_argument('--'+key,required=True)
 args=p.parse_args();f,m,ref=sequence(args.sequence_dir,args.sequence_sha256);d=decision_and_predecessor(f,m,args.decision,args.decision_sha256)
 folder=reserve_attempt(f,d,args.decision_sha256);failure=None;digest=None
 try:
  integrity=deployed_gate(ref,None);origin=attest_origin(ref,d['origin']);originsha=jsonwrite(folder/'origin-evidence.json',origin)
  deployment={'kind':'root-verified-local-deployment','sourceEvidence':'root-attested','productTIP':PRODUCT,'toolTIP':m['toolTIP'],'sequenceId':m['sequenceId'],'readinessSHA256':m['readinessSHA256'],'sourceTIP':m['sourceTIP'],'failedHistory':FAILURES,'newIdentity':ref['expectedServices'],'viewerBuildId':ref['assets']['buildId'],'actualViewerBuiltAt':ref['assets']['builtAt'],'componentSourceTreeSha256':ref['componentTrees'],'originEvidenceSHA256':originsha,'freshIntegrity':integrity}
  deploysha=jsonwrite(folder/'deployment-evidence.json',deployment);log=pathlib.Path(ref['signalLogPath']);st=log.lstat();need(stat.S_ISREG(st.st_mode),'configured Signal log not regular');now=int(time.time()*1000)
  manifest={'schemaVersion':1,'runNonce':d['runNonce'],'createdAtEpochMs':now,'validUntilEpochMs':now+21600000,'scenario':d['scenario'],'mode':d['mode'],'originSource':'formal-configured','originEvidenceSha256':originsha,'originSha256':sha(d['origin'].encode()),'deploymentEvidence':{'kind':'root-verified-local-deployment','sha256':deploysha},'signal':{'sourceCommit':PRODUCT,'sourceTreeSha256':ref['componentTrees']['signal']},'host':{'sourceCommit':PRODUCT,'sourceTreeSha256':ref['componentTrees']['host']},'viewer':{'sourceCommit':viewer_source_tip(),'buildId':ref['assets']['buildId']},'signalLog':{'path':str(log),'device':st.st_dev,'inode':st.st_ino}}
  pins={}
  for rel in RUNTIME:
   data,_=checked_file(P,rel);need(data==blob(m['sourceTIP'],rel),'runtime tool Git/blob mismatch');pins[rel]=sha(data)
  source_assets_guard(ref,None);deployed_gate(ref,None);msha=jsonwrite(folder/'runtime-manifest.json',manifest)
  a={'schemaVersion':1,'sequenceDirectory':str(f),'sequenceSHA256':args.sequence_sha256,'sequenceId':m['sequenceId'],'attemptId':d['attemptId'],'toolTIP':m['toolTIP'],'productTIP':PRODUCT,'readinessSHA256':m['readinessSHA256'],'decision':{'path':str(pathlib.Path(args.decision).resolve()),'sha256':args.decision_sha256},'runtimeManifestSHA256':msha,'sourceFiles':pins,'scenario':d['scenario'],'mode':d['mode'],'origin':d['origin'],'runNonce':d['runNonce'],'priorFailureSHA256':PRIOR_FAILURE,'sourceTIP':m['sourceTIP'],'failedHistory':FAILURES}
  digest=jsonwrite(folder/'attempt.json',a)
 except BaseException as exc:failure=type(exc).__name__
 jsonwrite(folder/'preparation-result.json',{'classification':'attempt-prepared-not-run' if failure is None else 'failed-or-indeterminate','errorClass':failure,'attemptSHA256':digest,'automaticLaunch':False,'scenarioReservationConsumed':True})
 print(json.dumps({'attemptDirectory':str(folder),'attemptSHA256':digest,'errorClass':failure}));return 0 if failure is None else 2
if __name__=='__main__':raise SystemExit(main())
