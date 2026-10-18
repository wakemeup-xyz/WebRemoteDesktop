"""Actual immutable blob/parser and validator methods; no real Git/process calls."""
import ast,copy,hashlib,pathlib,re,types,unittest
from test_source_receipt_flow import fixture,extract
ROOT=pathlib.Path(__file__).resolve().parent
R3=pathlib.Path('/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r3-_77m0ogi')
TIP='a'*40

def oid(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def frame(key,data):return key.encode()+b' blob '+str(len(data)).encode()+b'\n'+data+b'\n'

class Timeout(Exception):pass

class FakeGit:
 def __init__(self):
  self.data={'a.bin':b'\0binary\nend\xff','b.txt':b'','same.bin':b'\0binary\nend\xff'};self.calls=[];self.mutate=lambda raw:raw;self.exit=0;self.error=None;self.row_mutate=lambda rows:rows
 def tree(self,revision):
  self.calls.append(('tree',revision));return self.row_mutate({n:{'kind':'blob','gitMode':'100644','objectId':oid(d)} for n,d in self.data.items()})
 def command(self,args):
  assert args==['git','--no-replace-objects','-C','/fake/source','ls-tree','-r','-z','--full-tree',args[-1]]
  rows=self.tree(args[-1]);return b''.join((row['gitMode']+' '+row['kind']+' '+row['objectId']+'\t'+name).encode()+b'\0' for name,row in rows.items())
 def run(self,args,**kw):
  self.calls.append(('batch',args,kw));assert args==['git','--no-replace-objects','-C','/fake/source','cat-file','--batch']
  assert kw['timeout']==30 and kw['env']=={} and kw['stdout']=='PIPE' and kw['stderr']=='PIPE'
  if self.error:raise self.error
  objects={oid(d):d for d in self.data.values()};keys=kw['input'].decode().splitlines();assert len(keys)==len(set(keys))
  return types.SimpleNamespace(returncode=self.exit,stdout=self.mutate(b''.join(frame(k,objects[k]) for k in keys)),stderr=b'')

def methods(fake):
 s={'re':re,'pathlib':pathlib,'hashlib':hashlib,'S':pathlib.Path('/fake/source'),'ENV':{},'MAX_FILE':32*1024*1024,'_BLOB_CACHE':{},'_BLOB_CACHE_ENTRIES':1024,'_BLOB_CACHE_BYTES':128*1024*1024,'command':fake.command,'subprocess':types.SimpleNamespace(run=fake.run,PIPE='PIPE')}
 extract('core.py',{'need','relative','raw_blob_tree','prime_blobs','blob'},s);return s

class BlobBatch(unittest.TestCase):
 def test_binary_empty_shared_oid_equivalence_and_warm_no_fork(self):
  f=FakeGit();s=methods(f);s['prime_blobs'](TIP,list(f.data))
  for name,expected in f.data.items():self.assertEqual(s['blob'](TIP,name),expected)
  self.assertEqual([x[0] for x in f.calls],['tree','batch']);self.assertEqual(len(s['_BLOB_CACHE']),3)
  self.assertEqual(s['_BLOB_CACHE'][('/fake/source',TIP,'a.bin')][0],oid(f.data['a.bin']))
  s['blob']('b'*40,'a.bin');self.assertEqual(len(f.calls),4)
 def test_failure_atomicity_complete_frame_exit_timeout_and_hash(self):
  def bad_size(raw):return raw.replace(b' blob 13\n',b' blob 99\n',1) if b' blob 13\n' in raw else raw.replace(b' blob 0\n',b' blob 99\n',1)
  cases=[lambda r:r[:-1],lambda r:r+b'extra',lambda r:r+r,lambda r:r.replace(b' blob ',b' tree ',1),lambda r:b'f'*40+r[40:],lambda r:r.replace(b' blob 0\n',b' blob 00\n'),lambda r:r.replace(b'binary',b'BINARY'),lambda r:b'bad missing\n',lambda r:r[:r.index(b'\n')+1],bad_size,lambda r:r.replace(b' blob 0\n',b' blob 33554433\n')]
  for change in cases:
   with self.subTest(change=cases.index(change)):
    f=FakeGit();s=methods(f);s['prime_blobs']('c'*40,['b.txt']);before=dict(s['_BLOB_CACHE']);f.mutate=change
    with self.assertRaises(RuntimeError):s['prime_blobs'](TIP,list(f.data))
    self.assertEqual(s['_BLOB_CACHE'],before)
  for exitcode,error in [(2,None),(0,Timeout('fake timeout'))]:
   f=FakeGit();f.exit=exitcode;f.error=error;s=methods(f)
   with self.assertRaises((RuntimeError,Timeout)):s['prime_blobs'](TIP,['a.bin'])
   self.assertEqual(s['_BLOB_CACHE'],{})
 def test_safe_exact_revision_paths_and_tree_binding(self):
  for rev,names in [('HEAD',['a.bin']),('a'*39,['a.bin']),(TIP,['../x']),(TIP,['a.bin','a.bin']),(TIP,['absent'])]:
   s=methods(FakeGit())
   with self.assertRaises(RuntimeError):s['prime_blobs'](rev,names)
   self.assertEqual(s['_BLOB_CACHE'],{})
  for field,value in [('kind','commit'),('gitMode','160000'),('objectId','bad'),('objectId','b'*40)]:
   f=FakeGit();s=methods(f)
   def mutate(rows):rows['a.bin'][field]=value;return rows
   f.row_mutate=mutate
   # Unknown object in fake transport raises KeyError; real Git emits missing,
   # covered by the parser negative above. Neither populates the cache.
   with self.assertRaises((RuntimeError,KeyError)):s['prime_blobs'](TIP,['a.bin'])
   self.assertEqual(s['_BLOB_CACHE'],{})
 def test_cache_entry_byte_and_response_bounds_are_atomic(self):
  for key,value in [('_BLOB_CACHE_ENTRIES',1),('_BLOB_CACHE_BYTES',1),('MAX_FILE',1)]:
   f=FakeGit();s=methods(f);s[key]=value
   with self.assertRaises(RuntimeError):s['prime_blobs'](TIP,list(f.data))
   self.assertEqual(s['_BLOB_CACHE'],{})
  f=FakeGit();s=methods(f);s['_BLOB_CACHE_BYTES']=1;f.mutate=lambda raw:b'x'*1000
  with self.assertRaises(RuntimeError):s['prime_blobs'](TIP,['b.txt'])
  self.assertEqual(s['_BLOB_CACHE'],{})
 def test_actual_source_validator_live_head_and_dirty_guards_repeat(self):
  s,v,b,seen=fixture();requests=[];s['prime_blobs']=lambda revision,names:requests.append((revision,tuple(sorted(names))))
  validate=s['validate_source_review'];ref=b['sourceReview'];out=validate(ref['path'],ref['sha256']);self.assertEqual(out['copyPaths'],list(s['COPY_PATHS']))
  first=len(seen);validate(ref['path'],ref['sha256']);self.assertGreater(len(seen),first);self.assertEqual(len(requests),10)
  original_git=s['git'];s['git']=lambda repo,*args:b'0'*40+b'\n' if args==('rev-parse','HEAD') else original_git(repo,*args)
  with self.assertRaisesRegex(ValueError,'held final checkout'):validate(ref['path'],ref['sha256'])
  s['git']=original_git;original_file=s['checked_file'];s['checked_file']=lambda root,name:(b'changed',384)
  with self.assertRaisesRegex(ValueError,'dirty source docs preserved'):validate(ref['path'],ref['sha256'])
 def test_actual_source_gate_request_equivalence_and_batch_coverage(self):
  old,current,b,_=fixture();new,v,_,_=fixture();calls_old=[];calls_new=[];primes=[]
  fn=old['blob'];old['blob']=lambda revision,path:(calls_old.append((revision,path)) or fn(revision,path))
  fn2=new['blob'];new['blob']=lambda revision,path:(calls_new.append((revision,path)) or fn2(revision,path))
  new['prime_blobs']=lambda revision,names:primes.extend((revision,n) for n in names)
  tree=ast.parse((R3/'source_review_gate.py').read_bytes());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='validate_source_review');exec(compile(ast.Module(body=[node],type_ignores=[]),'original-gate','exec'),old)
  ref=b['sourceReview'];self.assertEqual(old['validate_source_review'](ref['path'],ref['sha256']),new['validate_source_review'](ref['path'],ref['sha256']))
  self.assertEqual(calls_old,calls_new)
  # old preimages are warmed by unchanged history's two new prime calls.
  missing=set(calls_new)-set(primes);self.assertTrue(all(r in (new['OLD_TOOL_TIP'],new['VIEWER_TIP']) for r,p in missing))
 def test_raw_tree_complete_path_binding_failure_no_cache(self):
  for bad in [b'100644 blob '+b'a'*40+b'\ta.bin',b'broken\0',b'100644 blob '+b'a'*40+b'\t../a.bin\0',2*(b'100644 blob '+b'a'*40+b'\ta.bin\0')]:
   f=FakeGit();s=methods(f);s['command']=lambda args:bad
   with self.assertRaises((RuntimeError,ValueError)):s['prime_blobs'](TIP,['a.bin'])
   self.assertEqual(s['_BLOB_CACHE'],{})
 def test_replace_mapping_cannot_supply_raw_cached_or_new_bytes(self):
  f=FakeGit();s=methods(f);original=dict(f.data);s['prime_blobs'](TIP,['a.bin'])
  # Fake replace refs affect ordinary calls only; the actual reader must use
  # --no-replace-objects for both raw tree binding and blob payload retrieval.
  raw_command=f.command;raw_run=f.run;ordinary=[]
  def replacing_command(args):
   if '--no-replace-objects' not in args:ordinary.append(args);return b'100644 blob '+b'f'*40+b'\ta.bin\0'
   return raw_command(args)
  def replacing_run(args,**kw):
   if '--no-replace-objects' not in args:ordinary.append(args);return types.SimpleNamespace(returncode=0,stdout=frame('f'*40,b'replacement'))
   return raw_run(args,**kw)
  s['command']=replacing_command;s['subprocess']=types.SimpleNamespace(run=replacing_run,PIPE='PIPE')
  self.assertEqual(s['blob'](TIP,'a.bin'),original['a.bin']);s['prime_blobs'](TIP,['b.txt','same.bin'])
  self.assertEqual(s['blob'](TIP,'same.bin'),original['same.bin']);self.assertEqual(ordinary,[])
  # Fixed source content pins remain a separate constraint; a substituted
  # expected payload cannot equal raw bytes merely because replace refs exist.
  with self.assertRaises(RuntimeError):s['need'](s['blob'](TIP,'a.bin')==b'replacement','fixed content pin mismatch')
 def test_unchanged_live_gates_and_deadlines_ast(self):
  for filename,names in [('core.py',{'commit','tree','command','service_set','preserved_gate','health','regular','checked_file','distmap'}),('bindings.py',{'source_map_gate','old_dist_gate','old_service_gate','check_ref','package_guard'})]:
   def nodes(path):return {n.name:ast.dump(n,include_attributes=False) for n in ast.parse(path.read_bytes()).body if isinstance(n,ast.FunctionDef) and n.name in names}
   self.assertEqual(nodes(ROOT/filename),nodes(R3/filename))
  for filename in ('deployment.py','known_attempt_quiescence.py','apply-frontend-context.py','restart-signal-frontend.py','build_primitives.py'):
   self.assertEqual((ROOT/filename).read_bytes(),(R3/filename).read_bytes())

if __name__=='__main__':unittest.main()
