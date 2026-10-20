"""Future two-time private build only. No primary output publication."""
from deployment import *
from build_primitives import *
def fixture(f,out,m,b,label):
 root=pathlib.Path(tempfile.mkdtemp(prefix=label+'-',dir=out));root.chmod(0o700)
 for rel,row in m['buildInputs'].items():
  data,mode=checked_file(f/'build-inputs',rel);write(root/rel,data,mode)
 for rel,row in m['oldDistMap'].items():
  data,mode=checked_file(f/'old-dist',rel);write(root/'web-client/dist'/rel,data,mode)
 os.symlink(str(P/'signal-server/node_modules'),root/'signal-server/node_modules');need(nodeinfo(P/'signal-server/node_modules')==b['primaryNodeModules'],'trusted install metadata drift');return root

def main():
 os.umask(0o077);a=args_parser(__doc__,assets=False).parse_args();f,m,b,changes=frozen(a.frozen_dir,a.frozen_sha256);old_service_gate(b);need(int(time.time()*1000)<m['windowUpperMs'],'window expired');need(not (f/'build-started.json').exists() and not (f/'build-result.json').exists(),'build consumed');owned=load_owned()
 jsonwrite(f/'build-started.json',{'frozenSHA256':a.frozen_sha256,'windowLowerMs':m['windowLowerMs'],'windowUpperMs':m['windowUpperMs'],'primaryMutated':False});out=pathlib.Path(tempfile.mkdtemp(prefix='two-time-template-',dir=f));out.chmod(0o700);children=[];failure=None;template_sha=None
 try:
  roots=[]
  for label,stamp in (('lower',m['windowLowerMs']),('upper',m['windowUpperMs'])):
   frozen(f,a.frozen_sha256);old_service_gate(b);root=fixture(f,out,m,b,label);roots.append(root);result,ok=child_owned(root,stamp,owned);children.append({'endpoint':label,'result':result});jsonwrite(out/(label+'-child-result.json'),result);need(ok,'private build lifecycle failed')
  need(int(time.time()*1000)<m['windowUpperMs'],'window expired during build');template=compare_outputs(roots[0],roots[1],m,out);template['frozenSHA256']=a.frozen_sha256;template['codeHashes']=m['codeHashes'];template_sha=jsonwrite(out/'template.json',template)
  for root in roots:verify_rendered_dist(out,template_sha,root/'web-client/dist')
  frozen(f,a.frozen_sha256);old_service_gate(b)
 except BaseException as exc:failure=type(exc).__name__
 result={'schemaVersion':1,'frozenSHA256':a.frozen_sha256,'templateDirectory':str(out),'templateSHA256':template_sha,'children':children,'errorClass':failure,'classification':'private-two-time-template-frozen' if failure is None and template_sha else 'failed-or-indeterminate','primaryMutation':False,'fullProcessTreeExit':'unknown'};dg=jsonwrite(f/'build-result.json',result);print(json.dumps({'record':str(f/'build-result.json'),'sha256':dg,'classification':result['classification']}));return 0 if failure is None else 2
if __name__=='__main__':raise SystemExit(main())
