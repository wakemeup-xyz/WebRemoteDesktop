from core import *
TOKEN=b'__WRD_REVIEWED_CURRENT_BUILT_AT__'

def current_value_span(text,key):
 """Return the single top-level JSON value span, rejecting duplicate keys recursively."""
 obj=loads(text);need(isinstance(obj,dict) and key in obj,'JSON object/key required')
 dec=json.JSONDecoder(object_pairs_hook=pairs);pos=0
 while text[pos].isspace():pos+=1
 need(text[pos]=='{','object opening required');pos+=1;found=[]
 while True:
  while text[pos].isspace():pos+=1
  if text[pos]=='}':break
  name,end=dec.raw_decode(text,pos);need(isinstance(name,str),'JSON key required');pos=end
  while text[pos].isspace():pos+=1
  need(text[pos]==':','JSON colon required');pos+=1
  while text[pos].isspace():pos+=1
  start=pos;value,end=dec.raw_decode(text,pos)
  if name==key:found.append((start,end))
  pos=end
  while text[pos].isspace():pos+=1
  if text[pos]=='}':break
  need(text[pos]==',','JSON comma required');pos+=1
 need(len(found)==1,'one top-level value required');return found[0]

def manifest_info(folder):
 data,_=checked_file(folder,'asset-manifest.json');need(len(data)<=65536,'manifest bound');m=loads(data)
 need(set(m)=={'schemaVersion','buildId','builtAt','assets','retainedReleases'} and m['schemaVersion']==2,'exact schema2 manifest required')
 need(isinstance(m['retainedReleases'],list) and len(m['retainedReleases'])<=2,'retention bound');ids=[];paths=set()
 for release in [m]+m['retainedReleases']:
  if release is not m:need(set(release)=={'buildId','builtAt','assets'},'retained release schema')
  stamp=release['builtAt'];need(type(stamp) is int and 0<=stamp<=9007199254740991,'safe build timestamp required')
  assets=release['assets'];need(isinstance(assets,dict) and 0<len(assets)<=32,'asset mapping bound')
  for key,rel in assets.items():
   need(re.fullmatch('[A-Za-z][A-Za-z0-9]{0,63}',key) is not None and isinstance(rel,str) and re.fullmatch(r'assets/[a-z0-9-]+\.[a-f0-9]{16}\.(js|css)',rel) is not None,'asset path/key rejected')
   content,_=checked_file(folder,rel);need(sha(content)[:16]==rel.split('.')[1],'asset name/content digest mismatch');paths.add(rel)
  identity=sha(json.dumps(dict(sorted(assets.items())),separators=(',',':'),ensure_ascii=True).encode())[:16]
  need(release['buildId']==identity,'asset graph/build ID mismatch');ids.append(identity)
 need(len(set(ids))==len(ids),'duplicate retained build ID')
 expected=paths|{'asset-manifest.json','index.html','viewer.html','css/login.css','css/tokens.css','THIRD_PARTY_LICENSES.txt'}
 need(set(distmap(folder))==expected,'dist exact graph/static path coverage mismatch');return m

def normalized_file(name,data,stamp,buildid):
 if name=='asset-manifest.json':
  text=data.decode();obj=loads(text);need(obj['builtAt']==stamp,'current manifest timestamp mismatch');a,b=current_value_span(text,'builtAt');need(text[a:b]==str(stamp),'canonical integer timestamp required')
  result=text[:a]+TOKEN.decode()+text[b:]
 elif name in ('index.html','viewer.html'):
  text=data.decode();matches=list(re.finditer(r'window\.__WRD_BUILD__=(\{[^<>\r\n]*\})</script>',text));need(len(matches)==1 and text.count('window.__WRD_BUILD__')==1,'exactly one inline build JSON required')
  match=matches[0];inline=match.group(1);obj=loads(inline);need(set(obj)=={'id','builtAt'} and obj['id']==buildid and type(obj['builtAt']) is int and obj['builtAt']==stamp,'HTML current build mismatch')
  a,b=current_value_span(inline,'builtAt');need(inline[a:b]==str(stamp),'canonical HTML integer timestamp required');a+=match.start(1);b+=match.start(1);result=text[:a]+TOKEN.decode()+text[b:]
 else:return data
 out=result.encode();need(out.count(TOKEN)==1 and TOKEN not in data,'timestamp template token count mismatch');return out

def verify_rendered_dist(template_folder,template_sha,actual_folder):
 """Future wrapper primitive only. Reads actual files; never builds/restarts/promotes."""
 template_folder=pathlib.Path(template_folder);m=readjson(template_folder/'template.json',template_sha)
 need(m['schemaVersion']==1 and m['kind']=='frontend-two-time-template','template identity mismatch')
 actual_folder=pathlib.Path(actual_folder);actual=manifest_info(actual_folder);stamp=actual['builtAt']
 need(type(stamp) is int and m['windowLowerMs']<=stamp<=m['windowUpperMs'] and actual['buildId']==m['buildId'],'startup timestamp/window/build mismatch')
 observed=distmap(actual_folder);need(set(observed)==set(m['files']),'startup output path mismatch')
 need(directory_modes(actual_folder)==m['directoryModes'],'startup directory path/mode mismatch')
 for rel,row in m['files'].items():
  data,mode=checked_file(actual_folder,rel);expect,private_mode=checked_file(template_folder/'expected',rel)
  need(private_mode==0o600 and sha(expect)==row['templateSha256'] and mode==row['filesystemMode'],'template integrity/output mode mismatch')
  if row['timestampTemplate']:
   need(expect.count(TOKEN)==1,'one frozen timestamp token required');expect=expect.replace(TOKEN,str(stamp).encode())
  need(data==expect,'startup exact rendered output mismatch: '+rel)
 return {'buildId':actual['buildId'],'builtAt':stamp,'exactFinalFileMap':observed,'fullProcessTreeExit':'unknown'}
