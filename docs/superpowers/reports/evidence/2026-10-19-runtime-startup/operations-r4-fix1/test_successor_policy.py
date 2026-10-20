"""Pure actual AST functions with injected historical JSON/clock/process fixtures."""
import ast,copy,hashlib,json,math,pathlib,re,types,unittest
ROOT=pathlib.Path(__file__).resolve().parent

def definitions(name,names,scope):
 tree=ast.parse((ROOT/name).read_bytes());nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
 if len(nodes)!=len(names):raise AssertionError('exact AST definitions')
 exec(compile(ast.Module(body=nodes,type_ignores=[]),name,'exec'),scope)
 return scope

def need(ok,why):
 if not ok:raise ValueError(why)

def exact(v,keys):need(type(v) is dict and set(v)==set(keys),'keys')

class Policy(unittest.TestCase):
 def setUp(self):
  tree=ast.parse((ROOT/'policy.py').read_bytes());self.s={};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.Assign,ast.FunctionDef))],type_ignores=[]),'policy-pure','exec'),self.s);self.paths=self.s['COPY_PATHS']
 def rows(self):return [{'path':'docs/superpowers/reports/new.md','status':'A','oldMode':'000000','newMode':'100644'}]+[{'path':n,'status':'M','oldMode':'100644','newMode':'100644'} for n in self.paths]
 def test_four_existing_and_docs_complement(self):self.assertEqual(len(self.s['validate_partition'](self.rows(),list(self.paths),['docs/superpowers/reports/new.md'])),5)
 def test_no_extra_executable_or_missing_docs(self):
  rows=self.rows();rows[0]['path']='scripts/extra.py'
  with self.assertRaises(ValueError):self.s['validate_partition'](rows,list(self.paths),['scripts/extra.py'])
  with self.assertRaises(ValueError):self.s['validate_partition'](self.rows(),list(self.paths),[])
 def test_no_new_copy_paths_or_duplicate(self):
  rows=self.rows();rows[1]['status']='A';rows[1]['oldMode']='000000'
  with self.assertRaises(ValueError):self.s['validate_partition'](rows,list(self.paths),['docs/superpowers/reports/new.md'])
  rows=self.rows();rows.append(rows[-1])
  with self.assertRaises(ValueError):self.s['validate_partition'](rows,list(self.paths),['docs/superpowers/reports/new.md'])
 def test_known_map_1016_same_keys_actual_modes(self):
  before={n:{'sha256':'a'*64,'filesystemMode':420} for n in self.paths};before.update({str(n):{'sha256':'b'*64,'filesystemMode':384} for n in range(1012)})
  replacements={n:{'sha256':'c'*64,'filesystemMode':420} for n in self.paths};after=self.s['derive_post_map'](before,replacements);self.assertEqual(set(after),set(before));self.assertEqual(before[self.paths[0]]['sha256'],'a'*64)
  replacements[self.paths[0]]['filesystemMode']=384
  with self.assertRaises(ValueError):self.s['derive_post_map'](before,replacements)
 def test_build_closure_broader_than_publication_rejects_dist(self):
  paths=set(self.s['BUILD_INPUTS'])|{'web-client/js/webrtc.js','web-client/js/unchanged.js'};self.assertIn('web-client/js/unchanged.js',self.s['build_input_paths'](paths))
  with self.assertRaises(ValueError):self.s['build_input_paths'](paths|{'web-client/dist/index.html'})
 def test_unbound_final_refuses_without_git(self):
  def private_json(*a,**k):raise FileNotFoundError('required final binding absent')
  s=definitions('bindings.py',{'final_binding','final_source_tip','viewer_source_tip'},dict(private_json=private_json,R=pathlib.Path('/fake'),exact=exact,need=need))
  with self.assertRaises(FileNotFoundError):s['final_source_tip']()

class HistoricalFixtures(unittest.TestCase):
 def test_actual_historical_json_map_and_21_known_identities(self):
  # Load only bounded named immutable JSON evidence. All extracted functions below
  # consume this in-memory fixture; no operational imports, Git, process or status.
  files={str(ROOT/n):(ROOT/n).read_bytes() for n in ('legacy-deployed-reference.json','legacy-tool-history.json','deployment-history.json')}
  base=json.loads(files[str(ROOT/'legacy-deployed-reference.json')]);old=json.loads(files[str(ROOT/'legacy-tool-history.json')]);new=json.loads(files[str(ROOT/'deployment-history.json')])
  refs=list(base['historical'].values())+list(old['records'].values())+list(new['records'].values())
  for ref in refs:
   raw=pathlib.Path(ref['path']).read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),ref['sha256']);files[ref['path']]=raw
  rec={k:json.loads(files[v['path']]) for k,v in dict(old['records'],**new['records']).items()}
  review=rec['r5AssetReview']['independentReview'];files[review['path']]=pathlib.Path(review['path']).read_bytes();self.assertEqual(hashlib.sha256(files[review['path']]).hexdigest(),review['sha256'])
  class Blob:
   def __init__(self,sha):self.sha=sha
  hashes={}
  for n,row in rec['toolSequence']['tools'].items():hashes[(rec['toolSequence']['toolTIP'],n)]=row['sha256']
  for n,row in rec['r5Frozen']['candidateFiles'].items():hashes[(rec['r5Frozen']['tip'],n)]=row['sha256']
  def check_ref(v):raw=files[v['path']];need(hashlib.sha256(raw).hexdigest()==v['sha256'],'fixture digest');return raw
  s=dict(R=ROOT,readjson=lambda p:json.loads(files[str(p)]),check_ref=check_ref,loads=json.loads,sha=lambda b:b.sha if isinstance(b,Blob) else hashlib.sha256(b).hexdigest(),blob=lambda tip,n:Blob(hashes[tip,n]),json=json,need=need,exact=exact)
  tree=ast.parse((ROOT/'bindings.py').read_bytes());constants=[n for n in tree.body if isinstance(n,ast.Assign) and isinstance(n.value,(ast.Constant,ast.Tuple,ast.List))]
  exec(compile(ast.Module(body=constants,type_ignores=[]),'constants-only','exec'),s)
  s.update(PRODUCT=base['productTIP'],DOCBASE=base['docBaseTIP'])
  definitions('bindings.py',{'base_reference','history'},s);b,h,records=s['history']();self.assertEqual(len(b['regularFiles']),1016);self.assertEqual(len(b['assets']['exactFinalFileMap']),14);self.assertEqual(b['regularFiles']['scripts/ordinary_session_recovery.py']['filesystemMode'],384)
  s.update(math=math,valid_sha=lambda v:type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None)
  definitions('known_attempt_quiescence.py',{'finite','known_from_closed','recorded_identities','all_known'},s);known=s['all_known']();self.assertEqual(len(known),21);self.assertEqual(len({(r['pid'],r['birthEpoch']) for r in known}),21)

if __name__=='__main__':unittest.main()
