// The single synchronous writer for diagnostic files and the shared receipt ledger.
// No services, network, timers or native collectors are started by this module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DAY = 86400000;
const RECEIPT_TTL_MS = DAY;
const RECEIPT_MAX_ENTRIES = 10000;
const digest = value => typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value) ? value : null;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const identity = value => hash(value).slice(0,32);
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const enumValue = (value, allowed) => allowed.includes(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function getDiagDir() { return process.env.WRD_DIAG_DIR?.trim() ? path.resolve(process.env.WRD_DIAG_DIR.trim()) : '/tmp/wrd-diag'; }
function ensureDirectory(dir) {
  fs.mkdirSync(dir,{recursive:true});
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid-diagnostic-directory');
}
function regularRead(file, maxBytes=128*1024) {
  const descriptor=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {const stat=fs.fstatSync(descriptor); if(!stat.isFile() || stat.size>maxBytes) throw Error('invalid-diagnostic-file'); return fs.readFileSync(descriptor,'utf8');}
  finally {fs.closeSync(descriptor);}
}
function atomicText(target, text) {
  const temporary=`${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary,text,{encoding:'utf8',flag:'wx'});
    const file=fs.openSync(temporary,'r'); try {fs.fsyncSync(file);} finally {fs.closeSync(file);}
    fs.renameSync(temporary,target);
    const dir=fs.openSync(path.dirname(target),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
const atomicJson=(target,value)=>atomicText(target,JSON.stringify(value));
function createDiagnosticStore({dir=getDiagDir(),now=Date.now,retention={}}={}) {
  const opts={maxPerViewer:3,maxTotal:50,summaryDays:7,maxSummaryBytes:8*1024*1024,maxSummaryRows:10000,...retention};
  for(const name of Object.keys(opts)) if(!Number.isSafeInteger(opts[name]) || opts[name]<1)throw Error(`invalid-retention-${name}`);
  // Synchronous APIs preserve existing HTTP/Socket durable acknowledgements. A
  // directory lock also rejects competing process writers; a crash leaves a
  // visible stale lock and fails closed rather than guessing at ownership.
  const rawDir=path.join(dir,'raw'), summaryDir=path.join(dir,'summary');
  const init=()=>{ensureDirectory(dir);ensureDirectory(rawDir);ensureDirectory(summaryDir);};
  function withWriter(operation) {
    init();
    const lock=path.join(dir,'.writer-lock');
    const descriptor=fs.openSync(lock,'wx');
    try {fs.closeSync(descriptor);return operation();}
    finally {fs.unlinkSync(lock);}
  }
  const statePath=path.join(dir,'.summary-state');
  function state() {
    if(!fs.existsSync(statePath))return {schemaVersion:1,droppedSummaryCount:0,gaps:[]};
    const value=JSON.parse(regularRead(statePath,64*1024));
    if(value.schemaVersion!==1 || !Array.isArray(value.gaps))throw Error('invalid-summary-state');
    return value;
  }
  function gap(reason,number=1,from=now(),to=from) {
    const value=state(); const previous=value.gaps.find(g=>g.reason===reason);
    if(previous){previous.count+=number;previous.from=Math.min(previous.from,from);previous.to=Math.max(previous.to,to);}
    else value.gaps.push({reason,count:number,from,to});
    if(['daily-capacity','summary-expired','malformed-summary'].includes(reason))value.droppedSummaryCount+=number;
    atomicJson(statePath,value);
  }
  function loadDiagnosticReceipts(at=now()) {
    const target=path.join(dir,'.receipt-index');
    if(!fs.existsSync(target))return {schemaVersion:1,records:[]};
    const index=JSON.parse(regularRead(target,4*1024*1024));
    if(index.schemaVersion!==1 || !Array.isArray(index.records))throw Error('invalid-receipt-index');
    const valid=index.records.filter(row=>row && ['report','scope-ended'].includes(row.kind) && digest(row.key)
      && Number.isSafeInteger(row.at) && row.at>=0 && row.at<=at && at-row.at<=RECEIPT_TTL_MS);
    return {schemaVersion:1,records:valid.slice(-RECEIPT_MAX_ENTRIES).map(row=>({kind:row.kind,key:row.key,at:row.at,
      ...(row.kind==='report'?{eventIdHashes:(Array.isArray(row.eventIdHashes)?row.eventIdHashes:[]).filter(digest).slice(0,4)}:{})})),
      expired:index.records.length-valid.length,overflow:Math.max(0,valid.length-RECEIPT_MAX_ENTRIES)};
  }
  function saveDiagnosticReceipts(index) {
    init();
    if(index.expired)gap('receipt-horizon',index.expired);
    const overflow=(index.overflow || 0)+Math.max(0,index.records.length-RECEIPT_MAX_ENTRIES);
    if(overflow)gap('receipt-capacity',overflow);
    atomicJson(path.join(dir,'.receipt-index'),{schemaVersion:1,records:index.records.slice(-RECEIPT_MAX_ENTRIES)});
  }
  function readRaw() {
    const entries=[];
    for(const folder of [dir,rawDir]) {
      if(!fs.existsSync(folder))continue;
      const stat=fs.lstatSync(folder);if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('invalid-diagnostic-directory');
      for(const name of fs.readdirSync(folder).filter(n=>n.endsWith('.json'))) {
        const file=path.join(folder,name); const stat=fs.lstatSync(file);
        if(!stat.isFile() || stat.isSymbolicLink())continue;
        try {
          const text=regularRead(file);const report=JSON.parse(text);
          if(!report || typeof report!=='object' || Array.isArray(report))throw Error('invalid-report');
          const receivedAtMs=time(report.receivedAt);
          if(report.receivedAt !== undefined && receivedAtMs===null)throw Error('invalid-received-at');
          entries.push({file,name,report,rawSha:hash(text),receivedAtMs:receivedAtMs??stat.mtimeMs,
            receivedAtSource:receivedAtMs===null?'mtime-fallback':'receivedAt',
            viewerHash:report.viewerHash || identity(report.viewerId || name.replace(/^.+_/,'').replace('.json',''))});
        } catch(error) {
          // Quarantine in this same directory with a non-JSON suffix; never follow
          // symlinks or make malformed files count toward valid-report eviction.
          gap('malformed-raw',1,stat.mtimeMs);
          if(stat.size<=128*1024)fs.renameSync(file,path.join(folder,'.malformed-raw'));else fs.unlinkSync(file);
        }
      }
    }
    return entries;
  }
  function summaryRow(entry) {
    const r=entry.report;
    const metrics=r.latency?.metrics;
    return {diagnosticIdHash:identity(r.diagnosticId || entry.rawSha),rawSha:entry.rawSha,
      receivedAt:new Date(entry.receivedAtMs).toISOString(),receivedAtSource:entry.receivedAtSource,
      captured:{wallTime:time(r.captured?.wallTime)===null?null:r.captured.wallTime,
        monotonicMs:typeof r.captured?.monotonicMs==='number' && Number.isFinite(r.captured.monotonicMs) && r.captured.monotonicMs>=0?r.captured.monotonicMs:null,
        bootIdHash:digest(r.captured?.bootIdHash)},
      build:{id:digest(r.build?.id),builtAt:Number.isSafeInteger(r.build?.builtAt) && r.build.builtAt>=0?r.build.builtAt:(time(r.build?.builtAt)===null?null:r.build.builtAt)},
      reason:enumValue(r.reason || r.traceSummary?.reason,['manual','input-ack-timeout','pc-failed','pc-disconnected','ice-disconnected','dc-error','dc-stuck','direct-failed-suggest-relay','relay-failed-suggest-tunnel']),
      state:enumValue(r.inputState?.runtimePhase,['active','suspending','suspended','resuming']),
      mode:enumValue(r.mode,['auto','direct','relay','tunnel','stun','turn']),
      sampleCount:metrics && typeof metrics==='object'?Object.values(metrics).reduce((n,item)=>Math.min(Number.MAX_SAFE_INTEGER,n+count(item?.count)),0):0};
  }
  const dayStart=at=>Math.floor(at/DAY)*DAY;
  function summaryFiles() {
    if(!fs.existsSync(summaryDir))return [];
    const stat=fs.lstatSync(summaryDir);if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('invalid-summary-directory');
    return fs.readdirSync(summaryDir).filter(n=>/^\d{4}-\d\d-\d\d\.ndjson$/.test(n)).map(name=>({name,file:path.join(summaryDir,name),day:Date.parse(name.slice(0,10)+'T00:00:00Z')})).filter(e=>{const s=fs.lstatSync(e.file);return s.isFile()&&!s.isSymbolicLink();});
  }
  function readRows(file) {
    const text=regularRead(file,opts.maxSummaryBytes);
    if(text.split('\n').filter(Boolean).length>opts.maxSummaryRows)throw Error('invalid-summary-row-count');
    return text.split('\n').filter(Boolean).map(line=>{const row=JSON.parse(line);if(!digest(row.diagnosticIdHash)||!digest(row.rawSha)||time(row.receivedAt)===null)throw Error('invalid-summary-row');return row;});
  }
  function allSummaryRows() {
    return summaryFiles().flatMap(entry=>{try{return readRows(entry.file);}catch(error){gap('malformed-summary',1,entry.day,entry.day+DAY-1);fs.renameSync(entry.file,path.join(summaryDir,'.malformed-summary'));return [];}});
  }
  function appendSummary(entry) {
    if(entry.report.type==='scope-ended')return;
    const row=summaryRow(entry);
    const day=dayStart(entry.receivedAtMs),cutoff=dayStart(now())-(opts.summaryDays-1)*DAY;
    if(day<cutoff || day>dayStart(now())){gap('summary-outside-window',1,entry.receivedAtMs);return;}
    // Also recognize a summary that was durable before a raw/receipt failure.
    const existing=allSummaryRows().find(r=>r.diagnosticIdHash===row.diagnosticIdHash || r.rawSha===row.rawSha);
    if(existing) {
      if(existing.rawSha!==row.rawSha) {
        // A failed raw/ledger write may be retried with a later receipt time.
        // Keep the first receipt summary and refresh its exact raw digest before
        // publishing the replacement; this is still one incident row.
        const existingFile=path.join(summaryDir,`${existing.receivedAt.slice(0,10)}.ndjson`);
        const rows=readRows(existingFile).map(r=>r.diagnosticIdHash===existing.diagnosticIdHash?{...r,rawSha:row.rawSha}:r);
        atomicText(existingFile,rows.map(r=>JSON.stringify(r)+'\n').join(''));
      }
      return;
    }
    const file=path.join(summaryDir,`${row.receivedAt.slice(0,10)}.ndjson`);
    const rows=fs.existsSync(file)?readRows(file):[]; rows.push(row);
    rows.sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt));
    let text=rows.map(r=>JSON.stringify(r)+'\n').join(''),dropped=[];
    while(rows.length>opts.maxSummaryRows || Buffer.byteLength(text)>opts.maxSummaryBytes) {
      dropped.push(rows.shift());text=rows.map(r=>JSON.stringify(r)+'\n').join('');
    }
    // Persist loss metadata before replacing rows so a failed publish cannot hide
    // an eviction. An interrupted write can overstate loss, never claim coverage.
    if(dropped.length)gap('daily-capacity',dropped.length,Date.parse(dropped[0].receivedAt),Date.parse(dropped.at(-1).receivedAt));
    atomicText(file,text);
  }
  function cleanup() {
    init();
    const entries=readRaw();
    for(const entry of entries)if(path.dirname(entry.file)===dir)appendSummary(entry); // Migrate only legacy root reports before deletion; never resurrect capacity-evicted summaries from new raw.
    const ordered=entries.sort((a,b)=>b.receivedAtMs-a.receivedAtMs || b.name.localeCompare(a.name));
    const perViewer=new Map();let kept=0;
    for(const entry of ordered){const n=perViewer.get(entry.viewerHash)||0;
      if(n>=opts.maxPerViewer || kept>=opts.maxTotal || entry.receivedAtMs<dayStart(now())-(opts.summaryDays-1)*DAY)fs.unlinkSync(entry.file);
      else {perViewer.set(entry.viewerHash,n+1);kept++;}}
    const cutoff=dayStart(now())-(opts.summaryDays-1)*DAY;
    for(const entry of summaryFiles())if(entry.day<cutoff){const rows=readRows(entry.file);if(rows.length)gap('summary-expired',rows.length,entry.day,entry.day+DAY-1);fs.unlinkSync(entry.file);}
    return {rawCount:kept};
  }
  function write(report) {
    init();
    const at=now(); const index=loadDiagnosticReceipts(at);
    const text=JSON.stringify(report);
    if(Buffer.byteLength(text)>128*1024)throw Error('diagnostic-too-large');
    const rawSha=hash(text);
    const reportKey=identity(report.diagnosticId || rawSha);
    const existing=index.records.find(row=>row.kind==='report' && row.key===reportKey);
    if(existing)return {persisted:true,duplicate:true,eventIdHashes:existing.eventIdHashes||[],receiptKey:reportKey};
    const receivedAtMs=time(report.receivedAt);if(receivedAtMs===null)throw Error('invalid-received-at');
    const viewerHash=report.viewerHash || identity(report.viewerId || 'unknown');
    const entry={report,rawSha,receivedAtMs,receivedAtSource:'receivedAt'};
    appendSummary(entry);
    const eventIdHashes=[];
    for(const event of report.scopeEnded?.events || []) {
      if(!digest(event.eventIdHash))throw Error('invalid-event-hash');
      if(!index.records.some(row=>row.kind==='scope-ended' && row.key===event.eventIdHash)) {
        atomicJson(path.join(rawDir,`scope-ended_${event.eventIdHash}.json`),{type:'scope-ended',schemaVersion:3,viewerHash,receivedAt:report.receivedAt,eventIdHash:event.eventIdHash,endedAtMs:event.endedAtMs,snapshot:event.snapshot});
        index.records.push({kind:'scope-ended',key:event.eventIdHash,at});
      }eventIdHashes.push(event.eventIdHash);
    }
    atomicText(path.join(rawDir,`runtime_${reportKey}_${identity(viewerHash)}.json`),text);
    // Clean only after summary and raw are durable; a failed rename leaves all
    // prior records intact. Completion is acknowledged only after ledger commit.
    cleanup();
    index.records.push({kind:'report',key:reportKey,at,eventIdHashes});saveDiagnosticReceipts(index);
    return {persisted:true,duplicate:false,eventIdHashes,receiptKey:reportKey};
  }
  function listSummary({from=0,to=now()}={}) {
    init();
    const cutoff=dayStart(now())-(opts.summaryDays-1)*DAY;
    const raw=readRaw();const rows=allSummaryRows().filter(r=>Date.parse(r.receivedAt)>=cutoff);
    for(const entry of raw)if(entry.report.type!=='scope-ended' && entry.receivedAtMs>=cutoff)rows.push(summaryRow(entry));
    const seenIds=new Set(),seenShas=new Set(),records=[];
    for(const row of rows.sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt))) {
      if(seenIds.has(row.diagnosticIdHash)||seenShas.has(row.rawSha))continue;
      seenIds.add(row.diagnosticIdHash);seenShas.add(row.rawSha);
      const at=Date.parse(row.receivedAt);if(at<from || at>=to || at>=dayStart(now())+DAY)continue;
      records.push({...row,rawAvailable:raw.some(e=>e.rawSha===row.rawSha)});
    }
    const value=state();
    return {records,coverage:{droppedSummaryCount:value.droppedSummaryCount,gaps:value.gaps,
      earliestRetainedAt:rows.length?new Date(Math.min(...rows.map(r=>Date.parse(r.receivedAt)))).toISOString():null,
      retainedFrom:new Date(cutoff).toISOString(),dedupe:{maxEntries:RECEIPT_MAX_ENTRIES,ttlMs:RECEIPT_TTL_MS}}};
  }
  function recent(limit=50) {return readRaw().sort((a,b)=>b.receivedAtMs-a.receivedAtMs || b.name.localeCompare(a.name)).slice(0,Math.max(0,Number(limit)||0)).map(e=>e.report);}
  function persistLegacy(filename,report) {ensureDirectory(dir);atomicJson(path.join(dir,path.basename(filename)),report);}
  return {
    write: report => withWriter(() => write(report)),
    listSummary: options => withWriter(() => listSummary(options)),
    cleanup: () => withWriter(cleanup),
    recent: limit => withWriter(() => recent(limit)),
    loadDiagnosticReceipts,
    saveDiagnosticReceipts: index => withWriter(() => saveDiagnosticReceipts(index)),
    persistLegacy: (filename,report) => withWriter(() => persistLegacy(filename,report)),
  };
}
module.exports={createDiagnosticStore,getDiagDir};
