"""Actual validator/check_ref AST with in-memory Git/filesystem adapters only.
No operational imports, process/network/browser/build calls or live state probes.
"""
import ast,copy,hashlib,json,pathlib,re,unittest
ROOT=pathlib.Path(__file__).resolve().parent

def extract(file,names,scope):
 tree=ast.parse((ROOT/file).read_bytes());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
 assert len(nodes)==len(names)
 exec(compile(ast.Module(body=nodes,type_ignores=[]),file,'exec'),scope)

def need(ok,message):
 if not ok:raise ValueError(message)

class Blob:
 def __init__(self,digest,size=0):self.digest=digest;self.size=size
 def __len__(self):return self.size
 def __eq__(self,other):return self.digest==(other.digest if isinstance(other,Blob) else hashlib.sha256(other).hexdigest())

def fixture():
 # Only fixture construction reads named immutable local JSON/reference bytes.
 # The real validator below receives an entirely in-memory fake filesystem/Git.
 binding=json.loads((ROOT/'FINAL-BINDING.json').read_bytes());original=json.loads((ROOT/'FINAL-SOURCE-REVIEW.json').read_bytes());files={};seen=[]
 def add_refs(value):
  if isinstance(value,dict):
   if 'path' in value and 'sha256' in value:
    raw=pathlib.Path(value['path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==value['sha256'];files[str(pathlib.Path(value['path']))]=raw
   for child in value.values():add_refs(child)
  elif isinstance(value,list):
   for child in value:add_refs(child)
 add_refs(original);add_refs(binding)
 b=json.loads((ROOT/'legacy-deployed-reference.json').read_bytes());legacy=json.loads((ROOT/'legacy-tool-history.json').read_bytes());new=json.loads((ROOT/'deployment-history.json').read_bytes());refs=dict(legacy['records'],**new['records']);add_refs(refs);records={k:json.loads(files[v['path']]) for k,v in refs.items()}
 b['regularFiles']=dict(b['regularFiles'])
 for name,row in records['toolSequence']['tools'].items():b['regularFiles'][name]={'sha256':row['sha256'],'filesystemMode':row['filesystemMode']}
 for name,row in records['r5Frozen']['candidateFiles'].items():b['regularFiles'][name]={'sha256':row['sha256'],'filesystemMode':row['filesystemMode']}
 b['expectedServices']=records['r5Readiness']['newIdentity'];b['assets']=records['r5Readiness']['runtimeValidation']['assets']
 current=copy.deepcopy(original);scope={'pathlib':pathlib,'re':re,'need':need,'sha':lambda x:x.digest if isinstance(x,Blob) else hashlib.sha256(x).hexdigest(),'valid_sha':lambda v:type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None,'S':pathlib.Path(original['sourceCheckout']),'R':ROOT}
 tree=ast.parse((ROOT/'bindings.py').read_bytes());constants=[n for n in tree.body if isinstance(n,ast.Assign) and isinstance(n.value,(ast.Constant,ast.Tuple,ast.List))];exec(compile(ast.Module(body=constants,type_ignores=[]),'constants-only','exec'),scope)
 policy=ast.parse((ROOT/'policy.py').read_bytes());exec(compile(ast.Module(body=[n for n in policy.body if isinstance(n,(ast.Assign,ast.FunctionDef))],type_ignores=[]),'pure-policy','exec'),scope)
 scope['PRODUCT']=original['backendTIP']
 def regular(path,*args):
  seen.append(str(path));return files[str(path)],384
 scope['regular']=regular;extract('bindings.py',{'exact','check_ref'},scope)
 scope['final_binding']=lambda:copy.deepcopy(binding)
 def private_json(path,digest,*args):
  assert str(path)==binding['sourceReview']['path'] and digest==binding['sourceReview']['sha256'];return current
 scope['private_json']=private_json;scope['commit']=lambda tip:tip;scope['history']=lambda:(b,{'records':refs},records)
 patch=files[original['canonicalPatch']['path']];rows=[]
 # Exact row path/mode/status values from the real pinned canonical patch headers.
 for block in patch.decode().split('diff --git ')[1:]:
  lines=block.splitlines();name=lines[0].split(' b/',1)[1];added=lines[1].startswith('new file mode ');rows.append({'path':name,'status':'A' if added else 'M','oldMode':'000000' if added else '100644','newMode':'100644'})
 assert [r['path'] for r in rows]==original['canonicalPaths']
 scope['raw_diff']=lambda base,tip:rows if base==original['codeReviewBase'] else [r for r in rows if r['path'].startswith('docs/superpowers/')]
 def git(repo,*args):
  if args[:2]==('merge-base','--is-ancestor'):return b''
  if args==('rev-parse','HEAD'):return original['sourceTIP'].encode()+b'\n'
  if args[0]=='rev-parse':
   component=args[1].split(':')[1];return (original['viewerTreeOID'] if component=='web-client' else original['unchangedComponentTrees'][component]['treeOID']).encode()+b'\n'
  if args[:4]==('diff','--binary','--full-index','--no-renames'):return patch
  if args==('diff','--name-only','-z'):return b'\0'.join(n.encode() for n in b['exceptions'][:4])+b'\0'
  if args==('diff','--cached','--name-only','-z'):return b''
  if args==('ls-files','--others','--exclude-standard','-z'):return b'signal-server/node_modules\0'
  raise AssertionError(('unexpected fake Git call',args))
 scope['git']=git
 def blob(tip,name):
  if name in original['fileSources']:
   row=original['fileSources'][name];old=tip==row['oldSourceTIP'];return Blob(row['oldSha256'] if old else row['sha256'],row['oldBytes'] if old else row['bytes'])
  return Blob(b['regularFiles'][name]['sha256'])
 scope['blob']=blob;scope['tree']=lambda tip:({n:{} for n in b['regularFiles'] if n.startswith('web-client/')},None)
 scope['checked_file']=lambda base,name:(Blob(b['regularFiles'][name]['sha256']),b['regularFiles'][name]['filesystemMode'])
 scope['nodeinfo']=lambda path:b['sourceNodeModules']
 files[str(ROOT/'process_observation_diagnostics.py')]=(ROOT/'process_observation_diagnostics.py').read_bytes()
 extract('source_review_gate.py',{'validate_source_review'},scope)
 return scope,current,binding,seen

class SourceReceiptFlow(unittest.TestCase):
 def test_actual_validator_fix3_ref_flow_accepts(self):
  s,v,b,seen=fixture();out=s['validate_source_review'](b['sourceReview']['path'],b['sourceReview']['sha256']);self.assertEqual(out['copyPaths'],list(s['COPY_PATHS']));self.assertIn(v['canonicalPatch']['path'],seen);self.assertIn(v['actualPreimageObservation']['path'],seen);self.assertIn(v['finalReviewPackage']['path'],seen)
  for item in v['toolReviews'].values():self.assertIn(item['path'],seen)
  for item in v['viewerReviews'].values():self.assertIn(item['path'],seen)
 def test_actual_validator_rejects_canonical_extra_keys(self):
  _,actual,_,_=fixture();fix2=json.loads(pathlib.Path(actual['supersedesReceipt']['path']).read_bytes())
  self.assertEqual(set(fix2['canonicalPatch']),{'path','sha256','bytes','gitDiffFlags'})
  cases=[fix2['canonicalPatch'],actual['canonicalPatch']|{'bytes':508881},actual['canonicalPatch']|{'gitDiffFlags':['--binary','--full-index','--no-renames']}]
  for malformed in cases:
   s,v,b,seen=fixture();v['canonicalPatch']=copy.deepcopy(malformed)
   with self.assertRaisesRegex(ValueError,'exact keys required'):s['validate_source_review'](b['sourceReview']['path'],b['sourceReview']['sha256'])
   self.assertNotIn(v['canonicalPatch']['path'],seen)
 def test_other_direct_references_keep_strict_shape(self):
  for field in ('actualPreimageObservation','finalReviewPackage'):
   s,v,b,seen=fixture();v[field]['extraAnnotation']='not a reference key'
   with self.assertRaisesRegex(ValueError,'exact keys required'):s['validate_source_review'](b['sourceReview']['path'],b['sourceReview']['sha256'])

if __name__=='__main__':unittest.main()
