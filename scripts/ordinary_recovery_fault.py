"""Page-owned intentional recovery stimuli, never natural-outage qualification.

Installed API evidence: Python Playwright 1.59.0 / bundled driver 1.59.1.
Routing replaces the global WebSocket with a wrapper, affects forwarding timing,
and can synthesize clean close metadata. connect_to_server() is synchronous and
is not a handshake ACK. HTTP unroute does not remove WebSocket instrumentation.
No private upstream or message/close forwarding overrides are used here.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from urllib.parse import parse_qsl, urlsplit

_REASON = 'wrd-local-recovery-check'


def _origin(value):
    try:
        if type(value) is not str or len(value)>512 or any(c.isspace() for c in value) or '\\' in value: raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username is not None or parsed.password is not None or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment or len(value) > 512): raise ValueError()
        parsed.port
        return value.rstrip('/')
    except (TypeError, ValueError): raise ValueError('fault-target-unavailable') from None


def _matches(url, origin, transport):
    """Exact owned Engine.IO v4 endpoint and bounded standard query fields."""
    if type(url) is not str or len(url) > 1024 or any(c.isspace() for c in url) or '\\' in url: return False
    try:
        target, owned = urlsplit(url), urlsplit(origin)
        scheme = ('wss' if owned.scheme == 'https' else 'ws') if transport == 'websocket' else owned.scheme
        if (target.scheme != scheme or target.netloc != owned.netloc or target.path != '/socket.io/'
            or target.fragment or target.username is not None or target.password is not None): return False
        pairs = parse_qsl(target.query, keep_blank_values=True, strict_parsing=True, max_num_fields=5)
        fields = dict(pairs)
        if len(fields) != len(pairs) or not {'EIO','transport'} <= fields.keys(): return False
        if fields['EIO'] != '4' or fields['transport'] != transport: return False
        if not fields.keys() <= {'EIO','transport','sid','t','b64'}: return False
        if 'b64' in fields and fields['b64'] != '1': return False
        return all(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', fields[k]) for k in ('sid','t') if k in fields)
    except (TypeError, ValueError): return False


def _init_script(origin, instrumentation):
    # This closure runs before application scripts. For native-direct, capturing
    # both original references and checking they remain unchanged is essential;
    # instanceof by itself cannot distinguish a Playwright wrapper from native.
    config = json.dumps(dict(origin=origin, native=instrumentation == 'native-direct'), separators=(',', ':'))
    return r'''(() => {
  'use strict';
  const config=CONFIG;
  const OriginalWebSocket=globalThis.WebSocket;
  const originalClose=OriginalWebSocket?.prototype?.close;
  let used=false, retired=false;
  const fail=()=>'fault-target-unavailable';
  const allowedUrl=value=>{
    if(typeof value!=='string'||value.length>1024||/[\s\\]/.test(value)) return false;
    try {
      const u=new URL(value), o=new URL(config.origin);
      if(u.protocol!==(o.protocol==='https:'?'wss:':'ws:')||u.host!==o.host||u.username||u.password
        ||u.pathname!=='/socket.io/'||u.hash) return false;
      const entries=[...u.searchParams], p=u.searchParams;
      if(entries.length>5||new Set(entries.map(([k])=>k)).size!==entries.length
        ||p.get('EIO')!=='4'||p.get('transport')!=='websocket') return false;
      return entries.every(([k,v])=>['EIO','transport'].includes(k)||
        (k==='b64'?v==='1':['sid','t'].includes(k)&&/^[A-Za-z0-9_.-]{1,128}$/.test(v)));
    } catch(_) { return false; }
  };
  const trigger=()=>{
    if(used) return 'fault-already-triggered';
    if(retired) return fail();
    try {
      const c=typeof WebRTC==='undefined'?null:WebRTC, socket=c?.socket, engine=socket?.io?.engine;
      const transport=engine?.transport, ws=transport?.ws;
      const state=window.__wrdOrdinaryObservation?.();
      const gate=window.__wrdPassiveSampler?.evidenceSnapshot?.()?.inputGate;
      if(!c||!socket||!ws||!state||!gate||state.authCurrent!==true||state.authVerified!==true
        ||state.authCaptured!==true||state.ownerCurrent!==true||state.selectorValid!==true
        ||state.proofPresent!==false||state.queuedStart!==false||state.startClickMarks!==1
        ||state.htmlShellMarks!==1||state.coreInteractiveMarks!==1||state.coreInstalled!==true
        ||state.socketPresent!==true||state.pcPresent!==true||state.attemptPresent!==true
        ||typeof state.sessionId!=='string'||!state.sessionId||typeof state.admissionId!=='string'||!state.admissionId
        ||state.socketId!==socket.id||socket.connected!==true||c.controlState?.hostOnline!==true
        ||transport.name!=='websocket'||ws.readyState!==1||!allowedUrl(ws.url)
        ||location.origin!==config.origin||location.pathname!=='/viewer.html'||location.search!=='?wrdAdmission=vacant-only-v1') return fail();
      const yes=['allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame','currentAttemptReady','hasActiveControl','socketConnected'];
      const no=['manualDisconnect','superseded','mouseResetPending','draftComposing','draftPending','draftUncertain','firstFrameTimerHandlePresent'];
      if(gate.status!=='observed'||!Array.isArray(gate.blockedReasons)||gate.blockedReasons.length
        ||yes.some(k=>gate[k]!==true)||no.some(k=>gate[k]!==false)||gate.uiPhase!=='connected'
        ||gate.desiredMediaState!=='active'||gate.mediaRuntimePhase!=='active'||gate.keyboardControllerState!=='READY'
        ||gate.keyboardTransportState!=='ready'||gate.surfaceState!=='settled'
        ||!['none','reconciled'].includes(gate.desktopWriteRecoveryState)||!['idle','recovered'].includes(gate.recoveryState)) return fail();
      // Getter reconciliation must not change the exact object about to close.
      if(c!==WebRTC||socket!==c.socket||engine!==socket.io?.engine||transport!==engine.transport||ws!==transport.ws) return fail();
      if(config.native){
        if(typeof OriginalWebSocket!=='function'||typeof originalClose!=='function'
          ||globalThis.WebSocket!==OriginalWebSocket||OriginalWebSocket.prototype.close!==originalClose
          ||!(ws instanceof OriginalWebSocket)) return fail();
        used=true;
        originalClose.call(ws,1000,'wrd-local-recovery-check');
      } else {
        // Wrapper membership is a routed-target check, never native provenance.
        if(typeof globalThis.WebSocket!=='function'||!(ws instanceof globalThis.WebSocket)||typeof ws.close!=='function') return fail();
        used=true;
        ws.close(1000,'wrd-local-recovery-check'); // Public routed wrapper close.
      }
      return 'triggered';
    } catch(_) { retired=true; return fail(); }
  };
  Object.defineProperty(window,'__wrdLocalRecoveryFault',{value:Object.freeze({trigger,
    snapshot:()=>used?'triggered':retired?'disarmed':'ready',
    disarm:()=>{retired=true;return 'disarmed';}}),writable:false,configurable:false});
})();'''.replace('CONFIG', config, 1)


class BrowserLocalFault:
    """One scenario, fresh owned page and one close. No product recovery calls."""
    def __init__(self, *, scenario):
        if scenario not in ('within-grace','after-grace'): raise ValueError('fault-capability-unavailable')
        try:
            from playwright.async_api import Page
            required = [(Page, 'add_init_script'), (Page, 'evaluate')]
            if scenario == 'after-grace':
                from playwright.async_api import WebSocketRoute
                required += [(Page, k) for k in ('route','route_web_socket','unroute')]
                required += [(WebSocketRoute, k) for k in ('connect_to_server','close')]
            if any(not callable(getattr(cls, name, None)) for cls, name in required): raise ImportError()
        except ImportError: raise ValueError('fault-capability-unavailable') from None
        self._scenario = scenario
        self._status, self._failure_reason = 'ready', 'none'
        self._page = self._origin = self._block_until = None
        self._triggered = self._attempted = self._disarmed = False
        self._http_installed = False
        self._blocked_http = self._blocked_ws = 0
        self._handlers, self._operations = set(), set()
        # Bound method identities are saved for exact HTTP unroute registration.
        self._http_handler, self._ws_handler = self._http, self._websocket
        self._http_matcher = self._ws_matcher = None

    @property
    def scenario(self): return self._scenario

    @property
    def failure_reason(self):
        """Direct adapter evidence only: none/fault-attempt-cap/fault-handler-failed."""
        return self._failure_reason

    def snapshot(self):
        return dict(capability='available',status=self._status,
            instrumentation='native-direct' if self.scenario=='within-grace' else 'playwright-routed',
            triggerCount=int(self._triggered),blockedHttp=self._blocked_http,blockedWebSocket=self._blocked_ws,
            blockSeconds=0 if self.scenario=='within-grace' else 12)

    def _fail(self, reason='fault-handler-failed'):
        if self._failure_reason == 'none': self._failure_reason = reason
        self._block_until = None; self._status = 'failed'

    def _settled(self, task):
        self._operations.discard(task)
        # A noncooperative operation may settle after its handler failed. Retain
        # failure and consume its exception without leaking a backend message.
        if not task.cancelled() and task.exception() is not None: self._fail()

    async def _bounded(self, operation):
        """Track public API tasks through settlement, including noncooperation."""
        task = asyncio.ensure_future(operation); self._operations.add(task)
        task.add_done_callback(self._settled)
        try:
            done, _ = await asyncio.wait({task}, timeout=.2)
            if not done: raise TimeoutError()
            return task.result()
        except BaseException:
            task.cancel()
            try: await asyncio.wait({task}, timeout=.05)
            except asyncio.CancelledError: pass
            if task.done():
                try: task.result()
                except BaseException: pass
            self._fail()
            raise

    async def install(self, page, origin, *, scenario):
        if scenario != self.scenario or self._page is not None or self._disarmed:
            raise ValueError('fault-target-unavailable')
        origin = _origin(origin); self._page, self._origin = page, origin
        try:
            if self.scenario == 'after-grace':
                self._http_matcher = lambda url: _matches(url, origin, 'polling')
                self._ws_matcher = lambda url: _matches(url, origin, 'websocket')
                await page.route(self._http_matcher, self._http_handler)
                self._http_installed = True
                await page.route_web_socket(self._ws_matcher, self._ws_handler)
            await page.add_init_script(_init_script(origin, self.snapshot()['instrumentation']))
        except BaseException:
            self._fail(); raise

    async def trigger_once(self, page):
        if self._attempted: raise ValueError('fault-already-triggered')
        if page is not self._page or self._disarmed or self._status != 'ready':
            raise ValueError('fault-target-unavailable')
        self._attempted = True
        if self.scenario == 'after-grace': self._block_until = time.monotonic()+12
        try:
            result = await page.evaluate('() => window.__wrdLocalRecoveryFault.trigger()')
            if result != 'triggered':
                raise ValueError('fault-target-unavailable' if result == 'fault-target-unavailable' else 'fault-handler-failed')
            if self._status == 'failed': raise ValueError(self.failure_reason)
            self._triggered = True; self._status = 'triggered'
        except BaseException as exc:
            self._fail()
            if isinstance(exc, asyncio.CancelledError): raise
            if type(exc) is ValueError and str(exc) in ('fault-target-unavailable','fault-handler-failed','fault-attempt-cap'): raise
            raise ValueError('fault-handler-failed') from None

    def _blocking(self, kind):
        if self._block_until is None or time.monotonic() >= self._block_until: return False
        if self._blocked_http+self._blocked_ws >= 32:
            self._fail('fault-attempt-cap'); return False
        if kind == 'http': self._blocked_http += 1
        else: self._blocked_ws += 1
        return True

    async def _http(self, route):
        task = asyncio.current_task(); self._handlers.add(task)
        try:
            if _matches(route.request.url, self._origin, 'polling') and self._blocking('http'):
                await self._bounded(route.abort())
            else: await self._bounded(route.continue_())
        except asyncio.CancelledError: self._fail(); raise
        except Exception: self._fail()
        finally: self._handlers.discard(task)

    async def _websocket(self, route):
        task = asyncio.current_task(); self._handlers.add(task)
        try:
            if _matches(route.url, self._origin, 'websocket') and self._blocking('websocket'):
                await self._bounded(route.close(code=1000,reason=_REASON))
            else: route.connect_to_server()  # Sync fire-and-schedule; no on_message/on_close override.
        except asyncio.CancelledError: self._fail(); raise
        except Exception: self._fail()
        finally: self._handlers.discard(task)

    async def disarm(self):
        self._block_until = None  # Clear before the first await, including failure paths.
        if self._disarmed: return
        self._disarmed = True
        try:
            if self._http_installed:
                await self._bounded(self._page.unroute(self._http_matcher,self._http_handler))
                self._http_installed = False
            if self._page is not None:
                await self._bounded(self._page.evaluate('() => window.__wrdLocalRecoveryFault?.disarm()'))
            pending = (self._handlers | self._operations) - {asyncio.current_task()}
            if pending:
                _, pending = await asyncio.wait(pending, timeout=.2)
                for task in pending: task.cancel()
                if pending:
                    _, pending = await asyncio.wait(pending, timeout=.05)
                    self._fail()
                    if pending: raise ValueError('fault-handler-failed')
            if self._status != 'failed': self._status = 'disarmed'
        except BaseException:
            self._fail(); raise
