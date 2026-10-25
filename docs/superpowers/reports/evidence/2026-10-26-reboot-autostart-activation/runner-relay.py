#!/usr/bin/env python3
"""Operator-run acceptance against an already-running origin; no service lifecycle.
No screenshots, console, credentials, raw inputs, clipboard, addresses or session IDs are persisted.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path('/Users/macstudio1/AI/Claude/WebRemoteDesktop')

def secret(name):
    if os.environ.get(name):
        return os.environ[name]
    for line in (ROOT / 'signal-server/.env').read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    raise RuntimeError('runtime-credential-unavailable')

INIT = r"""() => {
  window.__startupSmoke = { count: 0, lastAt: null, mediaTime: null, presented: null };
  const bind = () => {
    const video = document.getElementById('remoteVideo');
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    const s = window.__startupSmoke;
    const frame = (now, meta) => {
      s.count += 1; s.lastAt = now;
      s.mediaTime = Number(meta.mediaTime); s.presented = Number(meta.presentedFrames);
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once: true});
  else bind();
}"""

SNAPSHOT = r"""async () => {
  const w = window.WebRTC;
  const v = document.getElementById('remoteVideo');
  const p = window.__startupSmoke || {};
  const i = window.Input?.getDiagnosticState?.() || {};
  let framesDecoded = 0, bytesReceived = 0, selected = null;
  if (w?.pc) {
    const all = await w.pc.getStats();
    const byId = new Map(); all.forEach(s => byId.set(s.id,s));
    all.forEach(s => {
      if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
        framesDecoded = Math.max(framesDecoded,Number(s.framesDecoded || 0));
        bytesReceived = Math.max(bytesReceived,Number(s.bytesReceived || 0));
      }
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = byId.get(s.selectedCandidatePairId);
        const local = byId.get(pair?.localCandidateId), remote = byId.get(pair?.remoteCandidateId);
        selected = {localType: local?.candidateType || null, remoteType: remote?.candidateType || null,
          protocol: local?.protocol || null, relayProtocol: local?.relayProtocol || null};
      }
    });
  }
  let nonBlackRatio = 0;
  const drawable = w?.tunnelRelayActive ? document.getElementById('relayImage') : v;
  if (drawable && (drawable.videoWidth || drawable.naturalWidth)) {
    try {
      const c = document.createElement('canvas'); c.width=64;c.height=36;
      const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(drawable,0,0,64,36);
      const a=ctx.getImageData(0,0,64,36).data;let nonBlack=0;
      for(let n=0;n<a.length;n+=4) if(a[n]+a[n+1]+a[n+2]>24) nonBlack++;
      nonBlackRatio=nonBlack/(a.length/4);
    } catch (_) {}
  }
  const marks = window.__WRD_STARTUP_SNAPSHOT__?.().marks || [];
  const known = new Set(['html-shell','core-interactive','start-click','signal-connected','first-frame','active']);
  return {
    signalConnected: !!w?.socket?.connected, hostOnline: !!w?.controlState?.hostOnline,
    controlState: w?.controlState?.state || null, controller: !!w?.controlState?.controller,
    hasLease: !!w?.controlState?.lease, inputAllowed: i.effectiveGate?.allowed === true,
    inputDiagnostic: {isActive:i.isActive ?? null, blockedReasons:i.effectiveGate?.blockedReasons || [],
      keyboardState:i.keyboard?.leaseState || null, keyboardTransport:i.keyboard?.adapter || null,
      keyboardLastSent:i.keyboard?.lastSent ?? null, keyboardLastApplied:i.keyboard?.lastApplied ?? null,
      pendingMouseReset:i.pendingMouseReset ?? null, recovery:i.recovery || null,
      mediaGate:i.gate || null},
    keyboardPending: i.keyboard?.pendingCount ?? null, pressedKeys: i.keyboard?.pressedCount ?? null,
    pressedMouseButtons: i.pressedMouseButtonCount ?? null,
    mediaPhase: w?.getMediaAppliedPhase?.() || null, networkMode: w?.networkMode || null,
    transport: w?.tunnelRelayActive ? 'socketio-image-relay' : 'webrtc',
    pcState: w?.pc?.connectionState || null, candidate: selected,
    videoWidth: v?.videoWidth || 0, videoHeight: v?.videoHeight || 0,
    readyState: v?.readyState || 0, paused: v?.paused ?? null,
    callbacks: p.count || 0, callbackAgeMs: p.lastAt == null ? null : Math.round(performance.now()-p.lastAt),
    mediaTime: p.mediaTime ?? null, presentedFrames: p.presented ?? null,
    productFrameSeq: Number(w?._videoFrameSeq || 0),
    relayLoadedAtMs: w?._relayLastLoadedAtMs ?? null, relayStale: w?._relayFrameStale ?? null,
    framesDecoded, bytesReceived, nonBlackRatio,
    startupMarks: marks.filter(m => known.has(m.name)).map(m => ({name:m.name, atMs:m.atMs})),
  };
}"""

RESET = r"""() => {
  const w=WebRTC,i=Input;
  if(!w.hasActiveControl() || !i.getEffectiveInputGate().allowed) return false;
  const probe = window.__smokeResets = {targets:{},results:{}};
  for (const [kind,name] of [['mouse','acceptMouseAck'],['keyboard','acceptKeyboardAck']]) {
    const original = i[name];
    i[name] = function(ack,...rest) {
      const result = original.call(this,ack,...rest), target=probe.targets[kind];
      if (target && ack?.schemaVersion===2 && ack.inputType===kind
          && ack.leaseEpoch===target.epoch && ack.inputIds?.includes(target.id)
          && Number.isSafeInteger(ack.appliedSeq) && ack.appliedSeq>=target.seq) {
        probe.results[kind] = {status: result?.status || null,
          accepted: ['applied','duplicate'].includes(result?.status),
          elapsedMs: Math.round(performance.now()-target.started),
          transport: rest[0]?.transport || null};
      }
      return result;
    };
  }
  const started=performance.now();
  const id=i.sendInput('mouse','reset',{reason:'manual'});
  const mouse=id && i._desktopWritePending.get(id);
  if(mouse) probe.targets.mouse={id,epoch:mouse.leaseEpoch,seq:mouse.seq,started};
  const sent=i.resetKeyboard('manual');
  const keyboard=sent && i.keyboardTransport?.getPendingReset?.();
  if(keyboard) probe.targets.keyboard={id:keyboard.inputId,epoch:keyboard.leaseEpoch,seq:keyboard.seq,started};
  return !!mouse && !!keyboard;
}"""

TERMINAL = r"""async password => {
  const result={auth:false,bootstrap:false,created:false,marker:false,inputAck:false,exited:false,closed:false};
  const response=await fetch('/api/auth/login/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  result.authHttpStatus=response.status;
  const auth=await response.json().catch(()=>({}));
  result.auth=response.ok && auth.role==='admin' && typeof auth.token==='string';
  if(!result.auth) return result;
  const bootstrap=await fetch('/api/terminal/bootstrap',{headers:{Authorization:'Bearer '+auth.token}});
  result.bootstrapHttpStatus=bootstrap.status;
  const boot=await bootstrap.json().catch(()=>({})); result.bootstrap=bootstrap.ok && boot.enabled===true;
  if(!result.bootstrap) return result;
  return await new Promise(resolve=>{
    const requestId='smoke-'+crypto.randomUUID(), clientId='smoke-'+crypto.randomUUID();
    const marker='WRD_SMOKE_'+crypto.randomUUID().replaceAll('-','');
    let sid=null,buf='',sent=false,finishing=false;
    const socket=io(location.origin+'/terminal',{auth:{token:auth.token,clientId},transports:['websocket'],reconnection:false,timeout:10000});
    const finish=()=>{ if(finishing)return;finishing=true;clearTimeout(timer);socket.close();resolve(result); };
    const close=()=>{ if(sid) socket.emit('terminal:close_session',{sessionId:sid,reason:'user-close',operationId:requestId+'-close'});else finish(); };
    const send=()=>{if(sent||!sid)return;sent=true;
      socket.emit('terminal:input',{sessionId:sid,inputId:requestId+'-input',data:"printf '%s\\n' '"+marker+"'; exit\n"});};
    const created=s=>{if(s.requestId!==requestId||sid||!s.sessionId)return;sid=s.sessionId;result.created=true;if(s.processStatus==='running')send();};
    socket.on('connect',()=>socket.emit('terminal:create_session',{cols:80,rows:24,title:'Startup acceptance temporary probe',requestId}));
    socket.on('connect_error',()=>finish());
    socket.on('terminal:session_created',created);socket.on('terminal:created',created);
    socket.on('terminal:output',(p,ack)=>{
      if(p.sessionId===sid){buf=(buf+String(p.data||'')).slice(-8192);
        result.marker=buf.split(/\r?\n/).some(line=>line.trim()===marker);send();}
      if(typeof ack==='function')ack();
    });
    socket.on('terminal:input_ack',p=>{if(p.sessionId===sid&&p.inputId===requestId+'-input')result.inputAck=true;});
    socket.on('terminal:exit',p=>{if(p.sessionId===sid){result.exited=true;close();}});
    const closed=p=>{if(p.sessionId===sid){result.closed=true;finish();}};
    socket.on('terminal:session_closed',closed);socket.on('terminal:closed',closed);
    const timer=setTimeout(()=>{close();setTimeout(finish,3000);},15000);
  });
}"""

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--origin',required=True)
    p.add_argument('--network-mode',choices=['auto','relay'],default='auto')
    p.add_argument('--duration',type=int,default=8)
    p.add_argument('--reset-ack',action='store_true',help='Apply only mouse and keyboard reset, no key/click/text')
    p.add_argument('--terminal',action='store_true',help='Admin authenticate and create printf/exit temporary session')
    p.add_argument('--out',required=True)
    args=p.parse_args()
    parsed=urlsplit(args.origin)
    if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.path not in ('','/') or parsed.query or parsed.fragment:
        raise SystemExit('origin-only-required')
    origin=args.origin.rstrip('/')
    report={'schemaVersion':1,'startedAt':datetime.now(timezone.utc).isoformat(),'origin':origin,
      'networkModeRequested':args.network_mode,'singleMachine':True,'physicalRemoteNetwork':'NOT RUN',
      'nativeKeyboardMouseVisibleEffect':'NOT RUN','longSessionAndReboot':'NOT RUN','gates':{}}
    stage='setup'; browser=None; page=None; context=None
    started=time.monotonic()
    try:
      with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,args=['--no-proxy-server'])
        context=browser.new_context(ignore_https_errors=False,viewport={'width':1280,'height':800})
        stage='preflight'
        for path in ['/health','/api/status']:
            r=context.request.get(origin+path,timeout=20000,max_redirects=0)
            body=r.json() if r.ok else {}
            report['gates'][path]={'httpStatus':r.status,'statusOk':body.get('status')=='ok'}
            if path=='/api/status':
                report['preflight']={k:body.get(k) for k in ('hostOnline','viewerCount','relayViewerCount')}
            if not r.ok or body.get('status')!='ok':raise RuntimeError('preflight-failed')
        if not report['preflight']['hostOnline']: raise RuntimeError('host-offline')
        if (report['preflight']['viewerCount'] or 0)>0 or (report['preflight']['relayViewerCount'] or 0)>0:
            raise RuntimeError('existing-viewer-present')
        context.add_init_script('('+INIT+')();')
        context.add_init_script("localStorage.setItem('wrdNetworkMode',"+json.dumps(args.network_mode)+");")
        page=context.new_page();stage='password-form-login'
        page.goto(origin+'/',wait_until='domcontentloaded',timeout=45000)
        page.fill('#password',secret('VIEWER_ACCESS_PASSWORD'))
        with page.expect_response(lambda r: urlsplit(r.url).path=='/api/auth/login' and r.request.method=='POST',timeout=30000) as auth_response:
            page.click('#loginForm button[type="submit"]')
        report['gates']['passwordLogin']={'httpStatus':auth_response.value.status,'usedRealForm':True}
        if auth_response.value.status!=200:raise RuntimeError('form-login-rejected')
        page.wait_for_url('**/viewer.html**',wait_until='domcontentloaded',timeout=45000)
        page.wait_for_function('() => !!window.WebRTC && !!window.Input',timeout=20000)
        stage='start-media-control'
        page.click('#startBtn')
        page.wait_for_function("() => WebRTC.socket?.connected && WebRTC.controlState?.hostOnline",timeout=30000)
        # Automatic control acquisition is non-takeover in product code. Do not steal a lease.
        page.evaluate('() => WebRTC.requestControl({allowTakeover:false})')
        stage='input-gate-ready'
        try:
            page.wait_for_function("() => WebRTC.hasActiveControl() && Input.getEffectiveInputGate().allowed",timeout=45000)
        except Exception:
            report['readinessFailureSnapshot']=page.evaluate(SNAPSHOT)
            raise
        first=page.evaluate(SNAPSHOT);stage='fresh-media-window'
        page.wait_for_timeout(max(3000,min(30,args.duration)*1000))
        final=page.evaluate(SNAPSHOT)
        if final['transport']=='webrtc':
            fresh=final['callbacks']>first['callbacks'] and final['productFrameSeq']>first['productFrameSeq'] and final['framesDecoded']>first['framesDecoded'] and final['bytesReceived']>first['bytesReceived'] and final['callbackAgeMs'] is not None and final['callbackAgeMs']<2000
        else:
            fresh=final['relayLoadedAtMs'] is not None and (first['relayLoadedAtMs'] is None or final['relayLoadedAtMs']>first['relayLoadedAtMs']) and final['relayStale'] is not True
        report['media']={'before':first,'after':final}
        report['gates']['freshMedia']={'pass':fresh and final['nonBlackRatio']>0.05,'observationSeconds':max(3,min(30,args.duration))}
        report['gates']['controlLease']={'pass':final['controller'] and final['hasLease'] and final['inputAllowed']}
        if args.reset_ack:
            stage='reset-ack';sent=page.evaluate(RESET)
            if sent:
                try:page.wait_for_function("() => __smokeResets.results.mouse?.accepted && __smokeResets.results.keyboard?.accepted",timeout=10000)
                except Exception:pass
            result=page.evaluate('() => window.__smokeResets?.results || {}')
            report['afterReset']=page.evaluate(SNAPSHOT)
            report['gates']['resetAck']={'sent':sent,'results':result,'pass':sent and all(result.get(k,{}).get('accepted') for k in ('mouse','keyboard')),'meaning':'validated reset ACK; no real key/click/text or visible-effect claim'}
        if args.terminal:
            stage='temporary-terminal'
            result=page.evaluate(TERMINAL,secret('WRD_TERMINAL_ADMIN_PASSWORD'))
            report['gates']['temporaryTerminal']={'pass':all(result.get(k) for k in ('auth','bootstrap','created','marker','inputAck','exited','closed')),'result':result}
        report['postProbe']=page.evaluate(SNAPSHOT)
        stage='cleanup'
        page.evaluate("() => WebRTC.releaseControl('viewer-disconnect')")
        context.close();context=None;browser.close();browser=None
        report['pass']=all(g.get('pass',g.get('statusOk',g.get('httpStatus')==200)) for g in report['gates'].values())
    except Exception as error:
        # Never stringify Playwright exceptions: their call log can include form values.
        report['pass']=False;report['failure']={'stage':stage,'type':type(error).__name__}
    finally:
        try:
            if page and not page.is_closed():page.evaluate("() => WebRTC?.releaseControl?.('viewer-disconnect')")
        except Exception:pass
        try:
            if context:context.close()
            if browser:browser.close()
        except Exception:pass
        report['elapsedSeconds']=round(time.monotonic()-started,3)
        report['endedAt']=datetime.now(timezone.utc).isoformat()
        out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as handle:json.dump(report,handle,ensure_ascii=True,indent=2);handle.write('\n')
        print(json.dumps({'pass':report['pass'],'failure':report.get('failure'),'artifact':str(out)}))
    return 0 if report['pass'] else 2

if __name__=='__main__':raise SystemExit(main())
