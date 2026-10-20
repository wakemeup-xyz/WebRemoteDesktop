"""Definition-only, bounded file/runtime primitives. No operation on import."""
import hashlib,json,os,pathlib,re,stat,subprocess,tempfile,time,types
P=pathlib.Path('/Users/macstudio1/AI/Claude/WebRemoteDesktop')
S=pathlib.Path('/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop')
R=pathlib.Path(__file__).resolve().parent
ENV=dict(os.environ,GIT_OPTIONAL_LOCKS='0',PYTHONDONTWRITEBYTECODE='1')
MAX_FILE=32*1024*1024
PRODUCT='dfb15434e79da90b803b763c533836e16c080c71'
DOCBASE='eebf9bdb0bd5ed96ebf2fe719afe85012420aec5'
SUP=pathlib.Path('/tmp/wrd-owned-turn-probe-private/supervisor.py')
SUP_SHA='d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b'
INHERENT={'polling-may-miss-fast-orphan','macos-check-to-signal-race','no-CDP-no-manager-proxy'}
PRESERVED={'tunnel':{'pid':84671,'birthEpoch':1792151067.803588},'watcher':{'pid':897,'birthEpoch':1790840870.948583}}

def need(ok,reason):
 if not ok:raise RuntimeError(reason)

def sha(data):return hashlib.sha256(data).hexdigest()

def valid_sha(value):return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None

def relative(value):
 need(isinstance(value,str) and 0<len(value.encode())<=1024,'invalid relative path')
 p=pathlib.PurePosixPath(value)
 need(not p.is_absolute() and str(p)==value and all(x not in ('','..','.','.git') for x in p.parts),'unsafe relative path')
 need(not any(ord(x)<32 for x in value),'control character path');return value

def regular(path,limit=MAX_FILE):
 path=pathlib.Path(path);st=path.lstat();need(stat.S_ISREG(st.st_mode),'plain regular file required')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 with os.fdopen(fd,'rb') as f:
  now=os.fstat(f.fileno());need(now.st_ino==st.st_ino and now.st_dev==st.st_dev,'file identity drift')
  data=f.read(limit+1);need(len(data)<=limit,'file byte bound')
 end=path.lstat();need((end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns)==(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns),'file changed during read')
 return data,stat.S_IMODE(st.st_mode)

def checked_file(root,rel):
 relative(rel);root=pathlib.Path(root);need(stat.S_ISDIR(root.lstat().st_mode),'plain root required');current=root
 for item in pathlib.PurePosixPath(rel).parts[:-1]:
  current=current/item;need(stat.S_ISDIR(current.lstat().st_mode),'plain ancestor required')
 return regular(root/rel)

def nodeinfo(path):
 try:st=path.lstat()
 except FileNotFoundError:return {'type':'absent'}
 row={'type':'symlink' if stat.S_ISLNK(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'other','mode':stat.S_IMODE(st.st_mode)}
 if stat.S_ISLNK(st.st_mode):row['target']=os.readlink(path)
 return row

def pairs(rows):
 out={}
 for key,value in rows:
  need(key not in out,'duplicate JSON key');out[key]=value
 return out

def loads(data):return json.loads(data,object_pairs_hook=pairs,parse_constant=lambda value:(_ for _ in ()).throw(RuntimeError('nonfinite JSON')))

def readjson(path,expected=None):
 data,_=regular(path,16*1024*1024)
 if expected is not None:need(valid_sha(expected) and sha(data)==expected,'JSON receipt digest drift')
 return loads(data)

def write(path,data,mode=0o600):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 need(stat.S_ISDIR(path.parent.lstat().st_mode),'plain private parent required')
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),mode)
 with os.fdopen(fd,'wb') as f:
  os.fchmod(f.fileno(),mode);f.write(data if isinstance(data,bytes) else data.encode());f.flush();os.fsync(f.fileno())
 return sha(regular(path)[0])

def jsonwrite(path,data):return write(path,json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+'\n')

def command(args,timeout=30):
 r=subprocess.run(args,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 need(r.returncode==0,'read-only Git command failed');return r.stdout

def git(repo,*args):return command(['git','-C',str(repo),*args])

def commit(value):
 need(isinstance(value,str) and re.fullmatch('[a-f0-9]{40}',value) is not None,'exact40hex commit required')
 need(git(S,'rev-parse',value+'^{commit}').decode().strip()==value,'immutable commit resolution drift');return value

def tree(revision):
 out={};raw=git(S,'ls-tree','-r','-z','--full-tree',revision)
 for part in raw.split(b'\0'):
  if not part:continue
  fields,name=part.split(b'\t',1);mode,kind,oid=fields.decode().split();rel=relative(name.decode())
  need(rel not in out and mode in ('100644','100755','160000'),'unsupported tree entry')
  out[rel]={'gitMode':mode,'kind':kind,'objectId':oid}
 return out,raw

# Successful immutable object bytes only; no HEAD/tree/live file or receipt cache.
_BLOB_CACHE={}
_BLOB_CACHE_ENTRIES=1024
_BLOB_CACHE_BYTES=128*1024*1024

def raw_blob_tree(revision):
 # Only this object reader bypasses replace refs; all live Git gates stay intact.
 raw=command(['git','--no-replace-objects','-C',str(S),'ls-tree','-r','-z','--full-tree',revision]);out={}
 need(type(raw) is bytes and len(raw)<=MAX_FILE and (not raw or raw.endswith(b'\0')),'raw tree output bound/termination')
 for part in raw.split(b'\0'):
  if not part:continue
  fields,name=part.split(b'\t',1);mode,kind,oid=fields.decode().split();rel=relative(name.decode())
  need(rel not in out and mode in ('100644','100755','160000'),'unsupported raw tree entry')
  out[rel]={'gitMode':mode,'kind':kind,'objectId':oid}
 return out

def prime_blobs(revision,rels):
 need(type(revision) is str and re.fullmatch('[a-f0-9]{40}',revision) is not None,'immutable blob revision required')
 need(type(rels) in (list,tuple,set) and len(rels)<=_BLOB_CACHE_ENTRIES,'bounded blob path request')
 paths=[relative(n) for n in rels];need(len(paths)==len(set(paths)),'duplicate blob path request')
 missing=sorted(n for n in paths if (str(S),revision,n) not in _BLOB_CACHE)
 if not missing:return
 need(len(_BLOB_CACHE)+len(missing)<=_BLOB_CACHE_ENTRIES,'blob cache entry bound')
 entries=raw_blob_tree(revision);requests=[]
 for name in missing:
  row=entries.get(name);need(type(row) is dict and row.get('kind')=='blob' and row.get('gitMode') in ('100644','100755') and type(row.get('objectId')) is str and re.fullmatch('[a-f0-9]{40}',row['objectId']) is not None,'exact tree path/blob binding')
  requests.append((name,row['objectId']))
 # Repeated OIDs across distinct paths are legitimate; fetch once, bind each path.
 oids=list(dict.fromkeys(oid for _,oid in requests));payload=('\n'.join(oids)+'\n').encode()
 result=subprocess.run(['git','--no-replace-objects','-C',str(S),'cat-file','--batch'],input=payload,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 need(result.returncode==0,'Git batch failed')
 raw=result.stdout;need(type(raw) is bytes and len(raw)<=_BLOB_CACHE_BYTES+len(oids)*128,'Git batch response bound')
 values={};offset=0;total=0
 for oid in oids:
  end=raw.find(b'\n',offset);need(end>=0 and end-offset<=127,'Git batch header bound')
  fields=raw[offset:end].split(b' ');need(len(fields)==3 and fields[0]==oid.encode() and fields[1]==b'blob' and re.fullmatch(b'0|[1-9][0-9]*',fields[2]) is not None,'Git batch exact OID/type/size')
  size=int(fields[2]);need(size<=MAX_FILE,'Git batch blob bound');start=end+1;stop=start+size
  need(stop<len(raw) and raw[stop:stop+1]==b'\n','Git batch truncated frame')
  data=raw[start:stop];need(hashlib.sha1(b'blob '+str(size).encode()+b'\0'+data).hexdigest()==oid,'Git blob object hash mismatch')
  values[oid]=data;total+=size;need(total<=_BLOB_CACHE_BYTES,'Git batch byte bound');offset=stop+1
 need(offset==len(raw),'Git batch extra response bytes')
 pending={(str(S),revision,name):(oid,values[oid]) for name,oid in requests}
 need(sum(len(v[1]) for v in _BLOB_CACHE.values())+sum(len(v[1]) for v in pending.values())<=_BLOB_CACHE_BYTES,'blob cache byte bound')
 # Publish only after every frame and the complete batch passed all checks.
 _BLOB_CACHE.update(pending)

def blob(revision,rel):
 name=relative(rel);prime_blobs(revision,[name]);return _BLOB_CACHE[(str(S),revision,name)][1]

def distmap(folder):
 need(stat.S_ISDIR(folder.lstat().st_mode),'plain dist root required');out={};total=0
 for base,dirs,files in os.walk(folder,followlinks=False):
  for name in dirs:need(stat.S_ISDIR((pathlib.Path(base)/name).lstat().st_mode),'nonplain dist directory')
  for name in files:
   path=pathlib.Path(base)/name;rel=relative(str(path.relative_to(folder)));data,mode=checked_file(folder,rel);total+=len(data)
   out[rel]={'sha256':sha(data),'filesystemMode':mode,'bytes':len(data)}
   need(len(out)<=512 and total<=128*1024*1024,'dist bounds exceeded')
 return out

def directory_modes(folder):
 out={'.':stat.S_IMODE(folder.lstat().st_mode)}
 for base,dirs,files in os.walk(folder,followlinks=False):
  for name in dirs:
   path=pathlib.Path(base)/name;need(stat.S_ISDIR(path.lstat().st_mode),'nonplain output directory');out[str(path.relative_to(folder))]=stat.S_IMODE(path.lstat().st_mode)
 return out

def process_identity(pid,kind=None):
 import psutil
 need(type(pid) is int and pid>0,'invalid PID');p=psutil.Process(pid);birth=p.create_time()
 need(p.status()!=psutil.STATUS_ZOMBIE,'process not live')
 if kind in ('host','signal'):
  need(pathlib.Path(p.cwd()).resolve()==P/('python-host' if kind=='host' else 'signal-server'),'service cwd mismatch')
  need(any(pathlib.Path(x).name==('host.py' if kind=='host' else 'server.js') for x in p.cmdline()),'service entry mismatch')
 need(p.create_time()==birth,'process identity raced');return {'pid':pid,'birthEpoch':birth}

def preserved_gate():
 for kind,row in PRESERVED.items():need(process_identity(row['pid'])==row,'preserved process identity changed')
 need(nodeinfo(pathlib.Path('/tmp/wrd-safe-current-url.txt'))=={'type':'absent'},'quick URL presence changed')
 return {'identities':PRESERVED,'quickURL':'absent'}

def service_set():
 import psutil
 out={}
 for kind in ('signal','host'):
  data,_=regular(pathlib.Path('/tmp/wrd-safe-'+kind+'.pid'),64);need(data.strip().isdigit(),'service PID file invalid');pid=int(data.strip())
  if kind=='host':need(regular(pathlib.Path('/tmp/wrd-host.pid'),64)[0].strip()==data.strip(),'Host PID files disagree')
  out[kind]=process_identity(pid,kind)
  names='server\\.js' if kind=='signal' else 'host\\.py'
  r=subprocess.run(['/usr/bin/pgrep','-f',names],env=ENV,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5)
  need(r.returncode in (0,1),'candidate observation failed');matched=[]
  for value in r.stdout.split():
   try:
    q=psutil.Process(int(value))
    if pathlib.Path(q.cwd()).resolve()==P/('signal-server' if kind=='signal' else 'python-host') and any(pathlib.Path(x).name==('server.js' if kind=='signal' else 'host.py') for x in q.cmdline()) and q.status()!=psutil.STATUS_ZOMBIE:matched.append(int(value))
   except psutil.NoSuchProcess:continue
   except (psutil.AccessDenied,OSError):raise RuntimeError('candidate observation unavailable')
  need(sorted(set(matched))==[pid],'service owners ambiguous')
 listener=command(['/usr/sbin/lsof','-nP','-t','-iTCP:8080','-sTCP:LISTEN'],5).split()
 need(set(listener)=={str(out['signal']['pid']).encode()},'8080 listener identity mismatch')
 return out

def health(*,require_idle=True):
 values={}
 for route in ('/health','/api/status'):
  raw=command(['/usr/bin/curl','--silent','--fail','--noproxy','*','--connect-timeout','1','--max-time','3','--max-filesize','65536','http://127.0.0.1:8080'+route],5)
  need(len(raw)<=65536,'health body too large');values[route]=loads(raw)
 status=values['/api/status'];probe=values['/health']
 need(isinstance(probe,dict) and isinstance(status,dict) and probe.get('status')=='ok' and status.get('hostOnline') is True,'healthy online Host required')
 for key in ('viewerCount','relayViewerCount'):
  need(type(status.get(key)) is int and 0<=status[key]<=9007199254740991,'bounded integer occupancy required')
 if require_idle:need(status['viewerCount']==0 and status['relayViewerCount']==0,'healthy online idle required')
 return {'healthy':True,'hostOnline':True,'viewerCount':status['viewerCount'],'relayViewerCount':status['relayViewerCount'],'observedAtEpoch':time.time()}

def readiness_facts():
 out={'observedAtEpoch':time.time(),'health':None,'identities':None,'preserved':None,'errors':{}}
 for name,fn in (('health',health),('identities',service_set),('preserved',preserved_gate)):
  try:out[name]=fn()
  except BaseException as exc:out['errors'][name]=type(exc).__name__
 return out

def load_owned():
 data,_=regular(SUP);need(sha(data)==SUP_SHA,'immutable Registry hash changed')
 module=types.ModuleType('pinned_continuation_registry');module.__file__=str(SUP)
 exec(compile(data,str(SUP),'exec'),module.__dict__)
 return module
