const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticStore } = require('../lib/diagnostic-store');
const DAY = 86400000;
function fixture(t, retention = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-diag-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 17);
  const store = createDiagnosticStore({ dir, now: () => clock, retention });
  return { dir, store, tick: (ms = 1000) => clock += ms,
    write: (id, viewerHash = 'fixture-viewer', extra = {}) => store.write({ schemaVersion: 3,
      diagnosticId: id, viewerHash, receivedAt: new Date(clock).toISOString(), reason: 'input-ack-timeout', ...extra }) };
}
const raws = dir => fs.readdirSync(path.join(dir, 'raw')).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(dir, 'raw', n), 'utf8')));

test('old cleanup actual-file counterexample deletes newest fourth and keeps first three', t => {
  const { dir } = fixture(t);
  for (let i = 1; i <= 4; i++) { const file = path.join(dir, `${i}_viewer.json`); fs.writeFileSync(file, '{}'); fs.utimesSync(file, i, i); }
  // Exact former per-viewer algorithm (ascending mtime and delete current row).
  const remaining = fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(name => ({ name,
    viewerId: name.replace(/^.+_/, '').replace('.json', ''), mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a,b) => a.mtimeMs-b.mtimeMs);
  const counts = {};
  for (const file of remaining) { counts[file.viewerId] = (counts[file.viewerId] || 0)+1;
    if (counts[file.viewerId] > 3) { fs.unlinkSync(path.join(dir, file.name)); counts[file.viewerId]--; } }
  assert.deepEqual(fs.readdirSync(dir), ['1_viewer.json','2_viewer.json','3_viewer.json']);
});

test('actual store retains newest three for the same viewer and all five summaries', async t => {
  const f = fixture(t);
  for (let i=1;i<=5;i++) { f.tick(); await f.write(`fixture-${i}`); }
  assert.deepEqual(raws(f.dir).map(r=>r.diagnosticId).sort(), ['fixture-3','fixture-4','fixture-5']);
  assert.equal((await f.store.listSummary({from:0,to:Infinity})).records.length,5);
});

test('fifty-first write is bounded after publish while summary preserves evicted raw', async t => {
  const f = fixture(t);
  for (let i=0;i<51;i++) { f.tick(); await f.write(`id-${i}`, `viewer-${i}`); }
  assert.equal(raws(f.dir).length,50);
  const result = f.store.listSummary({from:0,to:Infinity});
  assert.equal(result.records.length,51); assert.equal(result.records.filter(r=>r.rawAvailable).length,50);
});

test('same diagnostic ID uses shared durable receipts even after raw removal', t => {
  const f = fixture(t);
  f.write('same'); for(const file of fs.readdirSync(path.join(f.dir,'raw'))) fs.unlinkSync(path.join(f.dir,'raw',file));
  assert.equal(f.write('same').duplicate,true);
  assert.equal(f.store.listSummary({from:0,to:Infinity}).records.length,1);
  const reloaded = createDiagnosticStore({dir:f.dir,now:()=>f.tick(0)});
  assert.equal(reloaded.write({diagnosticId:'same', receivedAt:new Date(f.tick(0)).toISOString()}).duplicate,true);
});

test('UTC seven-day retention and daily row eviction expose gaps and bounded dedupe horizon', t => {
  const f = fixture(t,{maxSummaryRows:2,maxPerViewer:1});
  f.write('a'); f.tick(); f.write('b'); f.tick(); f.write('c');
  let result=f.store.listSummary({from:0,to:Infinity});
  assert.equal(result.records.length,2); assert.equal(result.coverage.droppedSummaryCount,1);
  assert.ok(result.coverage.gaps.some(g=>g.reason==='daily-capacity'));
  assert.equal(result.coverage.dedupe.maxEntries,10000); assert.equal(result.coverage.dedupe.ttlMs,DAY);
  f.tick(6*DAY); f.write('day7'); assert.equal(f.store.listSummary({from:0,to:Infinity}).records.length,3);
  f.tick(DAY); f.store.cleanup(); result=f.store.listSummary({from:0,to:Infinity});
  assert.equal(result.records.length,1); assert.ok(result.coverage.gaps.some(g=>g.reason==='summary-expired'));
});

test('daily byte budget counts actual NDJSON bytes', t => {
  const f=fixture(t,{maxSummaryBytes:850});
  for(let i=0;i<8;i++) {f.tick(); f.write(`byte-${i}`);}
  const files=fs.readdirSync(path.join(f.dir,'summary')).filter(n=>n.endsWith('.ndjson'));
  assert.ok(files.every(n=>fs.statSync(path.join(f.dir,'summary',n)).size<=850));
  assert.ok(f.store.listSummary({from:0,to:Infinity}).coverage.droppedSummaryCount>0);
});

test('legacy files use receivedAt then explicit mtime fallback; malformed files isolated, symlinks untouched', t => {
  const f=fixture(t);
  const outside=path.join(f.dir,'outside'); fs.writeFileSync(outside,'DO NOT TOUCH');
  fs.symlinkSync(outside,path.join(f.dir,'linked.json'));
  fs.writeFileSync(path.join(f.dir,'malformed.json'),'{bad');
  const legacy = path.join(f.dir,'old.json');
  fs.writeFileSync(legacy,JSON.stringify({viewerHash:'fixture-viewer',reason:'manual'}));
  // Keep the fallback mtime inside the fixture clock window rather than the
  // machine's wall clock, otherwise the bounded retention policy correctly
  // classifies this synthetic legacy file as outside the query window.
  fs.utimesSync(legacy, new Date(Date.UTC(2026, 9, 17)), new Date(Date.UTC(2026, 9, 17)));
  for(let i=1;i<=4;i++) {f.tick();f.write(`new-${i}`);}
  assert.equal(fs.readFileSync(outside,'utf8'),'DO NOT TOUCH'); assert.ok(fs.lstatSync(path.join(f.dir,'linked.json')).isSymbolicLink());
  const result=f.store.listSummary({from:0,to:Infinity});
  assert.ok(result.coverage.gaps.some(g=>g.reason==='malformed-raw'));
  assert.ok(result.records.some(r=>r.receivedAtSource==='mtime-fallback'));
});

test('raw rename failure cannot clean existing records or acknowledge and retry writes one summary', t => {
  const f=fixture(t); for(let i=1;i<=3;i++){f.tick(); f.write(`old-${i}`);}
  const rename=fs.renameSync;
  try { fs.renameSync=function(a,b){if(String(b).includes('/raw/')) throw Error('injected-rename'); return rename(a,b);};
    f.tick(); assert.throws(()=>f.write('failure'),/injected-rename/);
  } finally { fs.renameSync=rename; }
  assert.equal(raws(f.dir).length,3);
  assert.equal(f.write('failure').persisted,true);
  assert.equal(f.store.listSummary({from:0,to:Infinity}).records.length,4);
});

test('summary persistence precedes raw publication; summary failures never publish raw', t => {
  const f=fixture(t); const rename=fs.renameSync; const order=[];
  try { fs.renameSync=function(a,b){order.push(b);return rename(a,b);}; f.write('ordered'); }
  finally {fs.renameSync=rename;}
  assert.ok(order.findIndex(n=>n.endsWith('.ndjson'))<order.findIndex(n=>n.includes('/raw/')));
  const before=raws(f.dir).length;
  try {fs.renameSync=function(a,b){if(b.endsWith('.ndjson'))throw Error('summary-failed');return rename(a,b);};f.tick();assert.throws(()=>f.write('failed'),/summary-failed/);}
  finally {fs.renameSync=rename;}
  assert.equal(raws(f.dir).length,before);
});

test('query interval is half-open and receipt TTL boundary is inclusive with explicit expiry gap', t => {
  const f=fixture(t); const at=f.tick(0);f.write('boundary');
  assert.equal(f.store.listSummary({from:at,to:at+1}).records.length,1);
  assert.equal(f.store.listSummary({from:0,to:at}).records.length,0);
  f.tick(DAY);assert.equal(f.write('boundary').duplicate,true);
  f.tick(1);assert.equal(f.write('boundary').duplicate,false);
  const result=f.store.listSummary({from:0,to:Infinity});
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].rawAvailable,true);
  assert.equal(result.records[0].receivedAt,new Date(at).toISOString());
  assert.equal(f.store.listSummary({from:at,to:at+DAY}).records.length,1);
  assert.equal(f.store.listSummary({from:at+DAY+1,to:at+DAY+2}).records.length,0);
  assert.ok(result.coverage.gaps.some(g=>g.reason==='receipt-horizon'));
});

test('corrupt summary is isolated with explicit gap and receipt corruption fails closed', t => {
  const f=fixture(t);f.write('ok');
  const summary=path.join(f.dir,'summary','2026-10-17.ndjson');fs.writeFileSync(summary,'{bad');
  let result=f.store.listSummary({from:0,to:Infinity});assert.equal(result.records.length,1);
  assert.ok(result.coverage.gaps.some(g=>g.reason==='malformed-summary'));
  fs.writeFileSync(path.join(f.dir,'.receipt-index'),'{bad');f.tick();
  assert.throws(()=>f.write('never-acknowledged'));
  assert.equal(raws(f.dir).length,1);
});

test('oversized new report fails before summary or raw publication', t => {
  const f=fixture(t);assert.throws(()=>f.write('oversized','viewer',{extra:'x'.repeat(128*1024)}),/diagnostic-too-large/);
  assert.equal(raws(f.dir).length,0);assert.equal(f.store.listSummary({from:0,to:Infinity}).records.length,0);
});

test('same-directory competing writer is rejected without publishing or guessing stale ownership', t => {
  const f=fixture(t);f.write('prior');const lock=path.join(f.dir,'.writer-lock');fs.writeFileSync(lock,'held');
  assert.throws(()=>f.write('blocked'),{code:'EEXIST'});assert.equal(raws(f.dir).length,1);
  assert.equal(fs.readFileSync(lock,'utf8'),'held');fs.unlinkSync(lock);
  assert.equal(f.write('next').persisted,true);
});

test('later-clock retry keeps canonical first receipt in both ranges before and after raw eviction', t => {
  const f=fixture(t);const first=f.tick(0);const rename=fs.renameSync;
  const captured={wallTime:'2026-10-16T23:59:00Z',monotonicMs:900000,bootIdHash:'c'.repeat(32)};
  try {fs.renameSync=function(a,b){if(b.includes('/raw/'))throw Error('partial');return rename(a,b);};assert.throws(()=>f.write('canonical','fixture-viewer',{captured}),/partial/);}
  finally {fs.renameSync=rename;}
  const retry=f.tick(5000);f.write('canonical','fixture-viewer',{captured});
  const check=()=>{
    const oldRange=f.store.listSummary({from:first,to:retry});
    assert.equal(oldRange.records.length,1);assert.equal(oldRange.records[0].receivedAt,new Date(first).toISOString());
    assert.deepEqual(oldRange.records[0].captured,captured);
    assert.equal(f.store.listSummary({from:retry,to:retry+1}).records.length,0);
    assert.equal(f.store.listSummary({from:0,to:Infinity}).records[0].receivedAt,new Date(first).toISOString());
  };
  check();
  for(const name of fs.readdirSync(path.join(f.dir,'raw')))fs.unlinkSync(path.join(f.dir,'raw',name));
  check();
});

test('durable reads remain available under an identity-free legacy lock without mutating files', t => {
  const f=fixture(t);f.write('readable');const lock=path.join(f.dir,'.writer-lock');fs.writeFileSync(lock,'');
  fs.writeFileSync(path.join(f.dir,'bad.json'),'{bad');
  const before=fs.readdirSync(f.dir).sort();
  assert.equal(f.store.listSummary({from:0,to:Infinity}).records.length,1);
  assert.equal(f.store.recent().length,1);
  assert.deepEqual(fs.readdirSync(f.dir).sort(),before);
  assert.equal(fs.readFileSync(path.join(f.dir,'bad.json'),'utf8'),'{bad');
  assert.throws(()=>f.write('unknown-owner'));
  assert.equal(fs.readFileSync(lock,'utf8'),'');
});

test('interrupted child writer is proven dead and restart recovers only its owned temporary files', async t => {
  const {fork}=require('node:child_process');const {once}=require('node:events');
  const f=fixture(t);f.write('existing');
  const script=path.join(f.dir,'writer-child.cjs');
  fs.writeFileSync(script,`
    const fs=require('node:fs');const {createDiagnosticStore}=require(${JSON.stringify(require.resolve('../lib/diagnostic-store'))});
    const rename=fs.renameSync;
    fs.renameSync=function(a,b){if(b.includes('/raw/')){process.send({held:true,temp:a});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return rename(a,b);};
    createDiagnosticStore({dir:process.argv[2],now:()=>${f.tick(0)}}).write({diagnosticId:'interrupted',receivedAt:${JSON.stringify(new Date(f.tick(0)).toISOString())},reason:'manual'});
  `);
  const child=fork(script,[f.dir],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  const message=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('child did not acquire writer')),5000);
    child.once('message',value=>{clearTimeout(timer);resolve(value);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`child exited before interruption: ${code}`));});
  });
  assert.equal(message.held,true);assert.ok(fs.existsSync(message.temp));
  const snapshot=f.store.listSummary({from:0,to:Infinity});assert.ok(snapshot.records.some(r=>r.rawAvailable));
  assert.throws(()=>f.write('blocked-by-live-owner'));
  const unrelated=path.join(f.dir,'unrelated.tmp');fs.writeFileSync(unrelated,'KEEP');
  const suffix=path.basename(message.temp).match(/\.\d+\.[a-f0-9]{32}\.[a-f0-9]{16}\.tmp$/)[0];
  const lookalike=path.join(f.dir,`unrelated${suffix}`);fs.writeFileSync(lookalike,'KEEP TOO');
  const linked=path.join(f.dir,'raw',`runtime_${'0'.repeat(32)}_${'1'.repeat(32)}.json${suffix}`);
  fs.symlinkSync(unrelated,linked);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  const orphanPreparation=path.join(f.dir,`.writer-preparing_${child.pid}_${'a'.repeat(32)}`);
  fs.writeFileSync(orphanPreparation,JSON.stringify({schemaVersion:1,pid:child.pid,nonce:'a'.repeat(32)}));
  const unknownPreparation=path.join(f.dir,`.writer-preparing_${child.pid}_${'b'.repeat(32)}`);
  fs.writeFileSync(unknownPreparation,'partial-unverifiable');
  // A distinct restarted process has no in-memory knowledge of the dead writer.
  const resumedScript=path.join(f.dir,'resumed.cjs');
  fs.writeFileSync(resumedScript,`
    const {createDiagnosticStore}=require(${JSON.stringify(require.resolve('../lib/diagnostic-store'))});
    const result=createDiagnosticStore({dir:process.argv[2],now:()=>${f.tick(0)}}).write({diagnosticId:'resumed',receivedAt:${JSON.stringify(new Date(f.tick(0)).toISOString())},reason:'manual'});
    if(!result.persisted)process.exit(2);
  `);
  const resumed=fork(resumedScript,[f.dir],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';resumed.stderr.on('data',data=>stderr+=data);
  const [code]=await once(resumed,'exit');assert.equal(code,0,stderr);
  assert.equal(fs.existsSync(message.temp),false);assert.equal(fs.existsSync(orphanPreparation),false);
  assert.equal(fs.readFileSync(unknownPreparation,'utf8'),'partial-unverifiable');
  assert.equal(fs.readFileSync(unrelated,'utf8'),'KEEP');
  assert.equal(fs.readFileSync(lookalike,'utf8'),'KEEP TOO');assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(f.store.recent().length,2);
});
