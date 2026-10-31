// The single synchronous writer for diagnostic files and the shared receipt ledger.
// No services, network, timers or native collectors are started by this module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeControlHeartbeat, sanitizeDiagnosticAdmission } = require('../../web-client/js/runtime-diagnostic');
const DAY = 86400000;
const RECEIPT_TTL_MS = DAY;
const RECEIPT_MAX_ENTRIES = 10000;
const digest = value => typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value) ? value : null;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const identity = value => hash(value).slice(0,32);
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const enumValue = (value, allowed) => allowed.includes(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const knownCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const LOG_RECEIPT_STATES = new Set(['empty', 'valid', 'unknown', 'truncated', 'failed']);
const TRACE_LOSS_FIELDS = ['droppedEvents', 'droppedHashCount', 'evictedPendingAcks', 'expiredPendingAcks', 'ackTimeoutCount'];
const FRAME_TRACE_LOSS_FIELDS = ['droppedTraceCount', 'invalidBatchCount', 'staleTraceCount', 'conflictingTraceCount'];
function deidentifyNested(value) {
  if (Array.isArray(value)) return value.map(item => deidentifyNested(item));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'viewerId') { result.viewerHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    if (key === 'connectionAttemptId') { result.attemptHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    if (key === 'browserSessionId') { result.browserSessionHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    if (key === 'viewerHash') { result.viewerHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    if (key === 'attemptHash') { result.attemptHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    if (key === 'browserSessionHash') { result.browserSessionHash = digest(item) || (typeof item === 'string' && item ? identity(item) : null); continue; }
    result[key] = deidentifyNested(item);
  }
  return result;
}
function deidentifyReport(value) {
  let report;
  try { report = JSON.parse(JSON.stringify(value || {})); }
  catch (_error) { report = { ...(value || {}) }; }
  const stableHash = (existing, raw) => digest(existing)
    || (typeof existing === 'string' && existing.length > 0 ? identity(existing)
      : (typeof raw === 'string' && raw.length > 0 ? identity(raw) : null));
  report.viewerHash = stableHash(report.viewerHash, report.viewerId || 'unknown');
  report.attemptHash = stableHash(report.attemptHash, report.connectionAttemptId);
  report.browserSessionHash = stableHash(report.browserSessionHash, report.browserSessionId);
  delete report.viewerId;
  delete report.connectionAttemptId;
  delete report.browserSessionId;
  return deidentifyNested(report);
}
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
function atomicText(target, text, owner) {
  if(!owner)throw Error('diagnostic-writer-required');
  const temporary=`${target}.${owner.pid}.${owner.nonce}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary,text,{encoding:'utf8',flag:'wx'});
    const file=fs.openSync(temporary,'r'); try {fs.fsyncSync(file);} finally {fs.closeSync(file);}
    fs.renameSync(temporary,target);
    const dir=fs.openSync(path.dirname(target),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function createDiagnosticStore({dir=getDiagDir(),now=Date.now,retention={}}={}) {
  const opts={maxPerViewer:3,maxTotal:50,summaryDays:7,maxSummaryBytes:8*1024*1024,maxSummaryRows:10000,...retention};
  for(const name of Object.keys(opts)) if(!Number.isSafeInteger(opts[name]) || opts[name]<1)throw Error(`invalid-retention-${name}`);
  // Every contender publishes an immutable, fully initialized unique owner
  // before checking for peers. At least one of two concurrent contenders must
  // see the other; live/uncertain ownership always rejects the new write. Unique
  // names let dead-owner recovery remove only that owner's files, without a
  // shared-lock check/unlink race that could accidentally steal a new writer.
  const rawDir=path.join(dir,'raw'), summaryDir=path.join(dir,'summary');
  const init=()=>{ensureDirectory(dir);ensureDirectory(rawDir);ensureDirectory(summaryDir);};
  let writer=null;
  const writeText=(target,text)=>atomicText(target,text,writer);
  const atomicJson=(target,value)=>writeText(target,JSON.stringify(value));
  const ownerPattern=/^\.writer-owner_(\d+)_([a-f0-9]{32})$/;
  const preparingPattern=/^\.writer-preparing_(\d+)_([a-f0-9]{32})$/;
  function ownerFromFile(file,match) {
    const value=JSON.parse(regularRead(file,1024));
    if(value.schemaVersion!==1 || !Number.isSafeInteger(value.pid) || value.pid<1
      || value.pid!==Number(match[1]) || value.nonce!==match[2])throw Error('unknown-diagnostic-writer');
    return value;
  }
  function ownerDead(owner) {
    try {process.kill(owner.pid,0);return false;}
    catch(error) {return error.code==='ESRCH';} // EPERM and PID reuse are uncertain/live.
  }
  function removeOwnedTemps(owner) {
    const suffix=new RegExp(`\\.${owner.pid}\\.${owner.nonce}\\.[a-f0-9]{16}\\.tmp$`);
    const preparing=path.join(dir,`.writer-preparing_${owner.pid}_${owner.nonce}`);
    for(const folder of [dir,rawDir,summaryDir]) {
      for(const name of fs.readdirSync(folder)) {
        const isPreparing=path.join(folder,name)===preparing;
        const match=suffix.exec(name);
        const target=match?name.slice(0,match.index):null;
        const allowed=folder===rawDir
          ? /^(?:runtime_[a-f0-9]{32}_[a-f0-9]{32}|scope-ended_[a-f0-9]{16,64})\.json$/.test(target || '')
          : folder===summaryDir ? /^\d{4}-\d\d-\d\d\.ndjson$/.test(target || '')
            : ['.receipt-index','.summary-state'].includes(target) || /^[^/]+\.json$/.test(target || '');
        if(!isPreparing && (!match || !allowed))continue;
        const file=path.join(folder,name);
        try {const stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink())fs.unlinkSync(file);}
        catch(error) {if(error.code!=='ENOENT')throw error;}
      }
    }
  }
  function withWriter(operation) {
    init();
    // Old identity-free locks cannot establish dead ownership. They never block
    // read-only inspection, and this protocol never creates an empty lock.
    if(fs.existsSync(path.join(dir,'.writer-lock'))) {
      const error=Error('unknown-legacy-diagnostic-writer');error.code='EEXIST';throw error;
    }
    const owner={schemaVersion:1,pid:process.pid,nonce:crypto.randomBytes(16).toString('hex')};
    const preparing=path.join(dir,`.writer-preparing_${owner.pid}_${owner.nonce}`);
    const candidate=path.join(dir,`.writer-owner_${owner.pid}_${owner.nonce}`);
    let published=false;
    try {
      fs.writeFileSync(preparing,JSON.stringify(owner),{flag:'wx'});
      const fd=fs.openSync(preparing,'r');try {fs.fsyncSync(fd);}finally {fs.closeSync(fd);}
      fs.linkSync(preparing,candidate);published=true;fs.unlinkSync(preparing);
      for(const name of fs.readdirSync(dir)) {
        const pending=preparingPattern.exec(name);
        if(pending) {
          // A fully initialized preparation file can also survive before owner
          // publication. Incomplete/unverifiable preparations are inert and are
          // left untouched, never guessed at or treated as an active writer.
          let abandoned;
          try {abandoned=ownerFromFile(path.join(dir,name),pending);}catch(_error){continue;}
          if(ownerDead(abandoned))removeOwnedTemps(abandoned);
          continue;
        }
        const match=ownerPattern.exec(name);if(!match || path.join(dir,name)===candidate)continue;
        const file=path.join(dir,name);let other;
        try {other=ownerFromFile(file,match);}catch(error) {if(error.code==='ENOENT')continue;throw error;}
        if(!ownerDead(other))throw Error('diagnostic-writer-active-or-uncertain');
        removeOwnedTemps(other);
        try {fs.unlinkSync(file);}catch(error) {if(error.code!=='ENOENT')throw error;}
      }
      writer=owner;
      return operation();
    } finally {
      writer=null;
      if(published && fs.existsSync(candidate))fs.unlinkSync(candidate);
      if(fs.existsSync(preparing))fs.unlinkSync(preparing);
    }
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
  function readRaw({mutate=true,issues=[]}={}) {
    const entries=[];
    for(const folder of [dir,rawDir]) {
      if(!fs.existsSync(folder))continue;
      const stat=fs.lstatSync(folder);if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('invalid-diagnostic-directory');
      for(const name of fs.readdirSync(folder).filter(n=>n.endsWith('.json'))) {
        const file=path.join(folder,name);let stat;
        try {
          stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink())continue;
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
          if(error.code==='ENOENT')continue;
          if(!stat)throw error;
          if(mutate) {
            gap('malformed-raw',1,stat.mtimeMs);
            if(stat.size<=128*1024)fs.renameSync(file,path.join(folder,'.malformed-raw'));else fs.unlinkSync(file);
          } else issues.push({reason:'malformed-raw',count:1,from:stat.mtimeMs,to:stat.mtimeMs});
        }
      }
    }
    return entries;
  }
  function summaryRow(entry) {
    const r=entry.report;
    const metrics=r.latency?.metrics;
    const inputTraceLoss=Object.fromEntries(TRACE_LOSS_FIELDS.map(key => [key, knownCount(r.inputTraceLoss?.[key] ?? r.inputTrace?.counters?.[key])]));
    const summaryGapCount=knownCount(r.summaryGapCount ?? r.summaryGaps?.count ?? r.coverage?.summaryGapCount);
    const ringDropCount=knownCount(r.ringDropCount ?? r.ringDropped ?? r.heartbeat?.ringDropped);
    const lossValues=TRACE_LOSS_FIELDS.map(key => inputTraceLoss[key]);
    const lossCount=lossValues.every(value => value !== null) ? lossValues.reduce((total,value) => total + value, 0) : null;
    const coverageSignal=count => ({state:count === null ? 'unknown' : count > 0 ? 'nonzero' : 'observed',count});
    return {diagnosticIdHash:identity(r.diagnosticId || entry.rawSha),rawSha:entry.rawSha,
      receivedAt:new Date(entry.receivedAtMs).toISOString(),receivedAtSource:entry.receivedAtSource,
      captured:{wallTime:time(r.captured?.wallTime)===null?null:r.captured.wallTime,
        monotonicMs:typeof r.captured?.monotonicMs==='number' && Number.isFinite(r.captured.monotonicMs) && r.captured.monotonicMs>=0?r.captured.monotonicMs:null,
        bootIdHash:digest(r.captured?.bootIdHash)},
      build:{id:digest(r.build?.id),builtAt:Number.isSafeInteger(r.build?.builtAt) && r.build.builtAt>=0?r.build.builtAt:(time(r.build?.builtAt)===null?null:r.build.builtAt)},
      reason:enumValue(r.reason || r.traceSummary?.reason,['manual','input-ack-timeout','recovery-failed','pc-failed','pc-disconnected','ice-disconnected','dc-error','dc-stuck','direct-failed-suggest-relay','relay-failed-suggest-tunnel']),
      state:enumValue(r.inputState?.gate?.runtimePhase,['active','suspending','suspended','resuming']),
      mode:enumValue(r.mode,['auto','direct','relay','tunnel','stun','turn']),
      // The durable daily summary outlives raw eviction. Keep only measured
      // counts, and never reconstruct a client log count from redacted zero.
      logContentPolicy:r.schemaVersion===3?'metadata-only':enumValue(r.logContentPolicy,['metadata-only']),
      reportedLogCount:knownCount(r.reportedLogCount),
      retainedLogCount:knownCount(r.retainedLogCount)??(Array.isArray(r.logs)?r.logs.length:knownCount(r.logCount)),
      redactedLogCount:knownCount(r.redactedLogCount),
      logReceipt: r.logReceipt && typeof r.logReceipt === 'object'
        ? { state: enumValue(r.logReceipt.state, [...LOG_RECEIPT_STATES]) || 'unknown',
          reported: knownCount(r.logReceipt.reported), retained: knownCount(r.logReceipt.retained),
          redacted: knownCount(r.logReceipt.redacted), dropped: knownCount(r.logReceipt.dropped) }
        : { state: 'unknown', reported: knownCount(r.reportedLogCount), retained: knownCount(r.retainedLogCount),
          redacted: knownCount(r.redactedLogCount), dropped: null },
      inputTraceEventCount:Array.isArray(r.inputTrace?.events)?r.inputTrace.events.length:knownCount(r.inputTraceEventCount),
      inputTraceLoss,
      summaryGapCount,
      ringDropCount,
      coverageSignals: {
        summaryGap: coverageSignal(summaryGapCount),
        ringDrop: coverageSignal(ringDropCount),
        inputTrace: coverageSignal(lossCount),
      },
      coverageStatus: enumValue(r.coverageStatus ?? r.coverage?.status, ['complete', 'partial', 'unavailable']),
      frameTrace: r.traceSummary?.frameTrace && typeof r.traceSummary.frameTrace === 'object'
        ? { acceptanceState: enumValue(r.traceSummary.frameTrace.acceptanceState, ['PENDING', 'UNALIGNED']) || 'PENDING',
          pendingFrames: knownCount(r.traceSummary.frameTrace.pendingFrames), pendingTraces: knownCount(r.traceSummary.frameTrace.pendingTraces),
          matchedCount: knownCount(r.traceSummary.frameTrace.matchedCount),
          droppedTraceCount: knownCount(r.traceSummary.frameTrace.droppedTraceCount),
          invalidBatchCount: knownCount(r.traceSummary.frameTrace.invalidBatchCount),
          staleTraceCount: knownCount(r.traceSummary.frameTrace.staleTraceCount),
          conflictingTraceCount: knownCount(r.traceSummary.frameTrace.conflictingTraceCount),
          ...(r.traceSummary.frameTrace.stageCoverage && typeof r.traceSummary.frameTrace.stageCoverage === 'object'
            ? { stageCoverage: {
              sampleCount: knownCount(r.traceSummary.frameTrace.stageCoverage.sampleCount),
              observed: Object.fromEntries(['grab', 'age_at_recv', 'worker_queue', 'prepare', 'build',
                'reformat', 'encode', 'packetize', 'encode_total']
                .map(stage => [stage, knownCount(r.traceSummary.frameTrace.stageCoverage.observed?.[stage])])),
            } } : {}) }
        : null,
      ...((r.traceSummary?.controlHeartbeat || r.traceSummary?.diagnosticAdmission) ? { traceSummary: {
        ...(r.traceSummary?.controlHeartbeat ? { controlHeartbeat: sanitizeControlHeartbeat(r.traceSummary.controlHeartbeat) } : {}),
        ...(sanitizeDiagnosticAdmission(r.traceSummary?.diagnosticAdmission)
          ? { diagnosticAdmission: sanitizeDiagnosticAdmission(r.traceSummary.diagnosticAdmission) } : {}),
      } } : {}),
      sampleCount:metrics && typeof metrics==='object'?Object.values(metrics).reduce((n,item)=>Math.min(Number.MAX_SAFE_INTEGER,n+count(item?.count)),0):0};
  }
  const dayStart=at=>Math.floor(at/DAY)*DAY;
  function summaryFiles() {
    if(!fs.existsSync(summaryDir))return [];
    const stat=fs.lstatSync(summaryDir);if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('invalid-summary-directory');
    return fs.readdirSync(summaryDir).filter(n=>/^\d{4}-\d\d-\d\d\.ndjson$/.test(n)).map(name=>({name,file:path.join(summaryDir,name),day:Date.parse(name.slice(0,10)+'T00:00:00Z')})).filter(e=>{try{const s=fs.lstatSync(e.file);return s.isFile()&&!s.isSymbolicLink();}catch(error){if(error.code==='ENOENT')return false;throw error;}});
  }
  function readRows(file) {
    const text=regularRead(file,opts.maxSummaryBytes);
    if(text.split('\n').filter(Boolean).length>opts.maxSummaryRows)throw Error('invalid-summary-row-count');
    return text.split('\n').filter(Boolean).map(line=>{const row=JSON.parse(line);if(!digest(row.diagnosticIdHash)||!digest(row.rawSha)||time(row.receivedAt)===null)throw Error('invalid-summary-row');return row;});
  }
  function allSummaryRows({mutate=true,issues=[]}={}) {
    return summaryFiles().flatMap(entry=>{
      try{return readRows(entry.file);}
      catch(error){
        if(error.code==='ENOENT')return [];
        if(mutate){gap('malformed-summary',1,entry.day,entry.day+DAY-1);fs.renameSync(entry.file,path.join(summaryDir,'.malformed-summary'));}
        else issues.push({reason:'malformed-summary',count:1,from:entry.day,to:entry.day+DAY-1});
        return [];
      }
    });
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
        writeText(existingFile,rows.map(r=>JSON.stringify(r)+'\n').join(''));
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
    writeText(file,text);
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
    report = deidentifyReport(report);
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
    writeText(path.join(rawDir,`runtime_${reportKey}_${identity(viewerHash)}.json`),text);
    // Clean only after summary and raw are durable; a failed rename leaves all
    // prior records intact. Completion is acknowledged only after ledger commit.
    cleanup();
    index.records.push({kind:'report',key:reportKey,at,eventIdHashes});saveDiagnosticReceipts(index);
    return {persisted:true,duplicate:false,eventIdHashes,receiptKey:reportKey};
  }
  function listSummary({from=0,to=now()}={}) {
    const cutoff=dayStart(now())-(opts.summaryDays-1)*DAY,issues=[];
    const raw=readRaw({mutate:false,issues});
    const rows=allSummaryRows({mutate:false,issues}).filter(r=>Date.parse(r.receivedAt)>=cutoff);
    // Durable summaries own canonical first-receipt/capture fields. Merge raw
    // availability by identity/SHA before sorting or applying the query interval.
    const byId=new Map(),bySha=new Map(),canonical=[];
    function merge(row,rawAvailable) {
      const existing=byId.get(row.diagnosticIdHash)||bySha.get(row.rawSha);
      if(existing) {
        existing.rawAvailable ||= rawAvailable;
        byId.set(row.diagnosticIdHash,existing);bySha.set(row.rawSha,existing);
      } else {
        const item={...row,rawAvailable};canonical.push(item);
        byId.set(row.diagnosticIdHash,item);bySha.set(row.rawSha,item);
      }
    }
    for(const row of rows.sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt)))merge(row,false);
    for(const entry of raw)if(entry.report.type!=='scope-ended' && entry.receivedAtMs>=cutoff)merge(summaryRow(entry),true);
    canonical.sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
    const records=canonical.filter(row=>{const at=Date.parse(row.receivedAt);return at>=from && at<to && at<dayStart(now())+DAY;});
    const value=state();
    const gaps = [...value.gaps, ...issues];
    const gapTotalCount = gaps.reduce((total, item) => total + (knownCount(item?.count) ?? 0), 0);
    return {records,coverage:{droppedSummaryCount:value.droppedSummaryCount,gapTotalCount,gaps,
      earliestRetainedAt:canonical.length?canonical.at(-1).receivedAt:null,
      retainedFrom:new Date(cutoff).toISOString(),dedupe:{maxEntries:RECEIPT_MAX_ENTRIES,ttlMs:RECEIPT_TTL_MS}}};
  }
  function recent(limit=50) {return readRaw({mutate:false}).sort((a,b)=>b.receivedAtMs-a.receivedAtMs || b.name.localeCompare(a.name)).slice(0,Math.max(0,Number(limit)||0)).map(e=>e.report);}
  function persistLegacy(filename,report) {ensureDirectory(dir);atomicJson(path.join(dir,path.basename(filename)),deidentifyReport(report));}
  return {
    write: report => withWriter(() => write(report)),
    listSummary,
    cleanup: () => withWriter(cleanup),
    recent,
    loadDiagnosticReceipts,
    saveDiagnosticReceipts: index => withWriter(() => saveDiagnosticReceipts(index)),
    persistLegacy: (filename,report) => withWriter(() => persistLegacy(filename,report)),
  };
}
module.exports={createDiagnosticStore,getDiagDir};
