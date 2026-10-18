"""Pure fake-page/route and bounded Node-VM tests; no browser or network."""
import asyncio
import copy
import importlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

from scripts import ordinary_session_recovery as runner

NODE = os.environ.get('WRD_TEST_NODE', '/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node')
ORIGIN = 'https://owned.example'
WS = 'wss://owned.example/socket.io/?EIO=4&transport=websocket'
HTTP = ORIGIN + '/socket.io/?EIO=4&transport=polling&t=abc-123&sid=session_canary'


def adapter_module():
    return importlib.import_module('scripts.ordinary_recovery_fault')


class FakePage:
    def __init__(self):
        self.scripts = []; self.routes = []; self.ws_routes = []; self.unroutes = []
        self.results = ['triggered']; self.evaluations = []
    async def add_init_script(self, script): self.scripts.append(script)
    async def evaluate(self, script):
        self.evaluations.append(script)
        return self.results.pop(0) if self.results else 'disarmed'
    async def route(self, matcher, handler): self.routes.append((matcher, handler))
    async def route_web_socket(self, matcher, handler): self.ws_routes.append((matcher, handler))
    async def unroute(self, matcher, handler): self.unroutes.append((matcher, handler))


class FakeWebSocketRoute:
    def __init__(self, url=WS):
        self.url = url; self.connections = 0; self.closes = []; self.error = False; self.wait = None
    def connect_to_server(self):
        self.connections += 1
        if self.error: raise RuntimeError('raw-error-canary')
        return object()  # The public call is synchronous, not a handshake ACK.
    async def close(self, *, code=None, reason=None):
        if self.wait is not None: await self.wait.wait()
        if self.error: raise RuntimeError('raw-error-canary')
        self.closes.append((code, reason))
    def on_message(self, *args): raise AssertionError('must retain automatic forwarding')
    def on_close(self, *args): raise AssertionError('must retain automatic forwarding')


class FakeHttpRoute:
    def __init__(self, url=HTTP):
        self.request = types.SimpleNamespace(url=url); self.aborts = 0; self.continues = 0; self.error = False
    async def abort(self):
        if self.error: raise RuntimeError('raw-error-canary')
        self.aborts += 1
    async def continue_(self): self.continues += 1


def fake_api(**overrides):
    api = types.ModuleType('playwright.async_api')
    api.Page = FakePage; api.WebSocketRoute = FakeWebSocketRoute
    for name, value in overrides.items(): setattr(api, name, value)
    pkg = types.ModuleType('playwright'); pkg.async_api = api
    return patch.dict(sys.modules, {'playwright': pkg, 'playwright.async_api': api})


class CapabilityTests(unittest.TestCase):
    def test_no_fault_never_loads_adapter(self):
        with patch.object(runner, '_load_fault', wraps=runner._load_fault):
            with patch('builtins.__import__', side_effect=AssertionError('no optional import')):
                self.assertIsNone(runner._load_fault('baseline'))
                self.assertIsNone(runner._load_fault('continuity'))

    def test_constructor_is_sync_and_scenario_specific(self):
        mod = adapter_module()
        route_free = type('RouteFreePage', (), {'add_init_script': FakePage.add_init_script, 'evaluate': FakePage.evaluate})
        with fake_api(Page=route_free, WebSocketRoute=None):
            fault = mod.BrowserLocalFault(scenario='within-grace')
            self.assertFalse(asyncio.iscoroutine(fault))
            self.assertEqual(fault.snapshot(), dict(capability='available', status='ready', instrumentation='native-direct',
                triggerCount=0, blockedHttp=0, blockedWebSocket=0, blockSeconds=0))
            with self.assertRaisesRegex(ValueError, '^fault-capability-unavailable$'):
                mod.BrowserLocalFault(scenario='after-grace')

    def test_missing_api_and_invalid_scenario_fail_before_page(self):
        mod = adapter_module()
        for scenario in ('baseline', 'continuity', 'invalid', None):
            with self.subTest(scenario=scenario), self.assertRaisesRegex(ValueError, '^fault-capability-unavailable$'):
                mod.BrowserLocalFault(scenario=scenario)
        for name in ('route', 'route_web_socket', 'unroute', 'add_init_script', 'evaluate'):
            page = type('Missing', (FakePage,), {name: None})
            with self.subTest(name=name), fake_api(Page=page), self.assertRaisesRegex(ValueError, '^fault-capability-unavailable$'):
                mod.BrowserLocalFault(scenario='after-grace')
        for name in ('connect_to_server', 'close'):
            route = type('Missing', (FakeWebSocketRoute,), {name: None})
            with self.subTest(name=name), fake_api(WebSocketRoute=route), self.assertRaisesRegex(ValueError, '^fault-capability-unavailable$'):
                mod.BrowserLocalFault(scenario='after-grace')
        with patch.dict(sys.modules, {'playwright.async_api': None}), self.assertRaisesRegex(ValueError, '^fault-capability-unavailable$'):
            mod.BrowserLocalFault(scenario='within-grace')

    def test_snapshot_copy_and_read_only_scenario(self):
        with fake_api(): fault = adapter_module().BrowserLocalFault(scenario='after-grace')
        with self.assertRaises(AttributeError): fault.scenario = 'within-grace'
        snap = fault.snapshot(); snap['instrumentation'] = 'native-direct'; snap['blockSeconds'] = 0
        self.assertEqual(fault.snapshot()['instrumentation'], 'playwright-routed')
        self.assertEqual(fault.snapshot()['blockSeconds'], 12)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def make(self, scenario='after-grace'):
        with fake_api(): fault = adapter_module().BrowserLocalFault(scenario=scenario)
        page = FakePage(); await fault.install(page, ORIGIN, scenario=scenario)
        return fault, page

    async def test_native_never_installs_routes_and_disarms_closure(self):
        fault, page = await self.make('within-grace')
        self.assertEqual((page.routes, page.ws_routes), ([], [])); self.assertEqual(len(page.scripts), 1)
        await fault.trigger_once(page)
        self.assertEqual(fault.snapshot()['triggerCount'], 1)
        with self.assertRaisesRegex(ValueError, '^fault-already-triggered$'): await fault.trigger_once(page)
        self.assertEqual(len(page.evaluations), 1)
        await fault.disarm(); self.assertEqual(fault.snapshot()['status'], 'disarmed')
        self.assertEqual(page.unroutes, [])

    async def test_install_binding_is_immutable_and_requires_owned_page(self):
        with fake_api(): fault = adapter_module().BrowserLocalFault(scenario='within-grace')
        page = FakePage()
        with self.assertRaisesRegex(ValueError, '^fault-target-unavailable$'):
            await fault.install(page, ORIGIN, scenario='after-grace')
        self.assertEqual(page.scripts, [])
        fault, page = await self.make()
        with self.assertRaisesRegex(ValueError, '^fault-target-unavailable$'): await fault.install(page, ORIGIN, scenario='after-grace')
        with self.assertRaisesRegex(ValueError, '^fault-target-unavailable$'): await fault.trigger_once(FakePage())
        self.assertEqual(page.evaluations, [])

    async def test_invalid_origin_is_fixed_and_installs_nothing(self):
        for origin in (None, [], True, 'https://user@owned.example', 'https://owned.example/path', 'https://owned.example/?token=canary', 'https://owned.example/#fragment', 'https://owned.example:bad', 'https://owned.example/\\escape', 'https://owned.example/ path'):
            with self.subTest(kind=type(origin).__name__):
                with fake_api(): fault=adapter_module().BrowserLocalFault(scenario='after-grace')
                page=FakePage()
                with self.assertRaisesRegex(ValueError,'^fault-target-unavailable$'):
                    await fault.install(page,origin,scenario='after-grace')
                self.assertEqual((page.routes,page.ws_routes,page.scripts),([],[],[]))

    async def test_trigger_cancellation_clears_block_without_detached_work(self):
        fault,page=await self.make(); entered=asyncio.Event(); finished=asyncio.Event()
        async def evaluate(_):
            entered.set()
            try: await asyncio.Event().wait()
            finally: finished.set()
        page.evaluate=evaluate
        task=asyncio.create_task(fault.trigger_once(page)); await entered.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(finished.is_set()); self.assertIsNone(fault._block_until)
        self.assertEqual(fault.failure_reason,'fault-handler-failed')
        self.assertEqual(fault.snapshot()['status'],'failed')

    async def test_noncooperative_route_close_is_retained_and_disarm_cannot_pass(self):
        fault,page=await self.make(); release=asyncio.Event(); entered=asyncio.Event()
        route=FakeWebSocketRoute()
        async def close(**kw):
            entered.set()
            while not release.is_set():
                try: await release.wait()
                except asyncio.CancelledError: pass
        route.close=close
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            await fault.trigger_once(page)
            task=asyncio.create_task(page.ws_routes[0][1](route)); await entered.wait()
            try:
                await task
                self.assertTrue(fault._operations); self.assertEqual(fault.snapshot()['status'],'failed')
                with self.assertRaisesRegex(ValueError,'^fault-handler-failed$'): await fault.disarm()
                self.assertTrue(fault._operations); self.assertIsNone(fault._block_until)
                self.assertEqual(fault.failure_reason,'fault-handler-failed')
            finally:
                pending=set(fault._operations); release.set()
                if pending: await asyncio.gather(*pending,return_exceptions=True)
                await asyncio.sleep(0)
        self.assertFalse(fault._operations); self.assertFalse(fault._handlers)

    async def test_strict_route_matchers(self):
        _, page = await self.make(); http = page.routes[0][0]; ws = page.ws_routes[0][0]
        self.assertTrue(http(HTTP)); self.assertTrue(ws(WS)); self.assertTrue(ws(WS+'&sid=ABC_-&t=a.1'))
        self.assertFalse(http(WS)); self.assertFalse(ws(HTTP))
        for url in (WS.replace('owned.example','foreign.example'), WS.replace('/socket.io/','/socket.io'),
                    WS.replace('EIO=4','EIO=3'), WS.replace('websocket','webtransport'), WS+'&EIO=4',
                    WS+'&unknown=token-canary', WS+'&sid='+('a'*129), WS+'&sid=', WS+'#fragment',
                    WS.replace('wss://','ws://'), WS.replace('owned.example','user@owned.example'), WS+'&b64=2',
                    WS+'&sid=a%2Fb', WS.replace('/socket.io/','/prefix/socket.io/')):
            with self.subTest(url=url): self.assertFalse(ws(url))
        self.assertTrue(http(ORIGIN+'/socket.io/?EIO=4&transport=polling&b64=1'))

    async def test_open_forwarding_is_public_sync_and_has_no_message_hooks(self):
        fault, page = await self.make(); route = FakeWebSocketRoute()
        await page.ws_routes[0][1](route)
        self.assertEqual((route.connections,route.closes),(1,[])); self.assertEqual(fault.snapshot()['blockedWebSocket'],0)
        request = FakeHttpRoute(); await page.routes[0][1](request)
        self.assertEqual((request.aborts,request.continues),(0,1))

    async def test_twelve_second_fixed_deadline_polling_abort_and_no_ws_upstream(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)): await fault.trigger_once(page)
        deadline=fault._block_until
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:111.999)):
            ws=FakeWebSocketRoute(); await page.ws_routes[0][1](ws)
            http=FakeHttpRoute(); await page.routes[0][1](http)
        self.assertEqual(ws.connections,0); self.assertEqual(ws.closes,[(1000,'wrd-local-recovery-check')])
        self.assertEqual((http.aborts,http.continues),(1,0)); self.assertEqual(fault._block_until,deadline)
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:112)):
            ws2=FakeWebSocketRoute(); await page.ws_routes[0][1](ws2)
            http2=FakeHttpRoute(); await page.routes[0][1](http2)
        self.assertEqual(ws2.connections,1); self.assertEqual(http2.continues,1)
        self.assertEqual((fault.snapshot()['blockedHttp'],fault.snapshot()['blockedWebSocket']),(1,1))
        self.assertEqual(fault.snapshot()['instrumentation'],'playwright-routed')

    async def test_combined_attempt_cap_clears_block_and_failure_is_sticky(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            await fault.trigger_once(page)
            for n in range(32):
                if n%2: await page.routes[0][1](FakeHttpRoute())
                else: await page.ws_routes[0][1](FakeWebSocketRoute())
            overflow=FakeWebSocketRoute(); await page.ws_routes[0][1](overflow)
        self.assertEqual(fault.snapshot()['status'],'failed'); self.assertEqual(fault.failure_reason,'fault-attempt-cap')
        self.assertEqual(fault.snapshot()['blockedHttp']+fault.snapshot()['blockedWebSocket'],32)
        self.assertIsNone(fault._block_until); self.assertEqual(overflow.connections,1)
        await fault.disarm(); self.assertEqual(fault.snapshot()['status'],'failed')

    async def test_foreign_route_bypasses_block_and_never_counts(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            await fault.trigger_once(page)
            ws=FakeWebSocketRoute(WS.replace('owned.example','elsewhere.example')); await page.ws_routes[0][1](ws)
            http=FakeHttpRoute(ORIGIN+'/api/status'); await page.routes[0][1](http)
        self.assertEqual((ws.connections,http.continues),(1,1))
        self.assertEqual(fault.snapshot()['blockedHttp']+fault.snapshot()['blockedWebSocket'],0)

    async def test_trigger_denied_or_exception_clears_armed_block(self):
        for result in ('fault-target-unavailable','unexpected-private-data-canary',RuntimeError('private-error-canary')):
            with self.subTest(result=type(result).__name__):
                fault,page=await self.make()
                if isinstance(result,Exception): page.evaluate=unittest.mock.AsyncMock(side_effect=result)
                else: page.results=[result]
                with self.assertRaisesRegex(ValueError,'^fault-(target-unavailable|handler-failed)$'):
                    await fault.trigger_once(page)
                self.assertEqual(fault.snapshot()['triggerCount'],0); self.assertIsNone(fault._block_until)
                self.assertEqual(fault.snapshot()['status'],'failed')

    async def test_failure_clears_block_and_http_unroute_uses_exact_saved_pair(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            await fault.trigger_once(page); route=FakeWebSocketRoute(); route.error=True
            await page.ws_routes[0][1](route)
        self.assertEqual(fault.snapshot()['status'],'failed'); self.assertIsNone(fault._block_until)
        await fault.disarm(); self.assertEqual(page.unroutes,[page.routes[0]])
        self.assertEqual(len(page.ws_routes),1)  # Remains forwarding until owned context teardown.
        await fault.disarm(); self.assertEqual(len(page.unroutes),1)

    async def test_disarm_clears_before_settlement_and_owns_inflight_handlers(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)): await fault.trigger_once(page)
        route=FakeWebSocketRoute(); route.wait=asyncio.Event()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            task=asyncio.create_task(page.ws_routes[0][1](route)); await asyncio.sleep(0)
        cleanup=asyncio.create_task(fault.disarm()); await asyncio.sleep(0)
        self.assertIsNone(fault._block_until); self.assertFalse(cleanup.done())
        route.wait.set(); await task; await cleanup
        self.assertFalse(fault._handlers); self.assertEqual(fault.snapshot()['status'],'disarmed')

    async def test_cancelled_handler_or_trigger_is_failed_and_block_cleared(self):
        fault,page=await self.make()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)): await fault.trigger_once(page)
        route=FakeWebSocketRoute(); route.wait=asyncio.Event()
        with patch.object(adapter_module(),'time',types.SimpleNamespace(monotonic=lambda:100)):
            task=asyncio.create_task(page.ws_routes[0][1](route)); await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertIsNone(fault._block_until); self.assertFalse(fault._handlers)
        self.assertEqual(fault.snapshot()['status'],'failed')


# Host harness imports vm; the evaluated context contains fake globals only.
VM_HARNESS = r'''
const vm=require('node:vm');
let raw=''; process.stdin.on('data',x=>raw+=x); process.stdin.on('end',()=>{
 const {script,cases,instrumentation}=JSON.parse(raw); const rows=[];
 for(const name of cases){
  const box={URL}; vm.createContext(box);
  vm.runInContext(`
   globalThis.window=globalThis; globalThis.calls=[]; globalThis.productCalls=0;
   class NativeSocket { constructor(url){this.url=url;this.readyState=1;} close(code,reason){calls.push({kind:'native',exact:this===target,code,reason});} }
   class Wrapper { constructor(url){this.url=url;this.readyState=1;} close(code,reason){calls.push({kind:'wrapper',exact:this===target,code,reason,synthetic:true});} }
   globalThis.NativeSocket=NativeSocket; globalThis.Wrapper=Wrapper;
   globalThis.WebSocket=${instrumentation==='native-direct'?'NativeSocket':'Wrapper'};
   WebSocket.OPEN=1;
   globalThis.location={origin:'https://owned.example',pathname:'/viewer.html',search:'?wrdAdmission=vacant-only-v1'};
   globalThis.state={authCurrent:true,ownerCurrent:true,selectorValid:true,proofPresent:false,queuedStart:false,
    startClickMarks:1,htmlShellMarks:1,coreInteractiveMarks:1,authVerified:true,authCaptured:true,
    coreInstalled:true,socketPresent:true,pcPresent:true,attemptPresent:true,sessionId:'owner',socketId:'socket',admissionId:'admission'};
   globalThis.gate={status:'observed',allowed:true,inputActive:true,hasInputLease:true,viewportSupported:true,
    hasPaintedFrame:true,currentAttemptReady:true,hasActiveControl:true,socketConnected:true,blockedReasons:[],
    manualDisconnect:false,superseded:false,mouseResetPending:false,draftComposing:false,draftPending:false,draftUncertain:false,
    firstFrameTimerHandlePresent:false,uiPhase:'connected',desiredMediaState:'active',mediaRuntimePhase:'active',
    keyboardControllerState:'READY',keyboardTransportState:'ready',surfaceState:'settled',desktopWriteRecoveryState:'none',recoveryState:'idle'};
   globalThis.__wrdOrdinaryObservation=()=>({...state});
   globalThis.__wrdPassiveSampler={evidenceSnapshot:()=>({inputGate:{...gate}})};
  `,box,{timeout:500});
  vm.runInContext(script,box,{timeout:500}); // Before application socket creation.
  vm.runInContext(`
   globalThis.target=new WebSocket('wss://owned.example/socket.io/?EIO=4&transport=websocket');
   globalThis.WebRTC={socket:{id:'socket',connected:true,io:{engine:{transport:{name:'websocket',ws:target}}}},controlState:{hostOnline:true}};
   WebRTC.socket.disconnect=WebRTC.socket.connect=WebRTC.socket.io.close=WebRTC.socket.io.open=WebRTC.socket.io.engine.close=()=>productCalls++;
  `,box,{timeout:500});
  const changes={
   owner:'state.ownerCurrent=false',auth:'state.authCurrent=false',host:'WebRTC.controlState.hostOnline=false',
   socket:'WebRTC.socket.connected=false',socketId:"state.socketId='foreign'",path:"target.url=target.url.replace('/socket.io/','/other/')",
   origin:"target.url=target.url.replace('owned.example','foreign.example')",transport:"WebRTC.socket.io.engine.transport.name='polling'",
   readyState:'target.readyState=0',gate:'gate.allowed=false',proof:'state.proofPresent=true',
   constructor:'globalThis.WebSocket=class Other {}',prototype:'WebSocket.prototype.close=()=>productCalls++',
   fakeInstance:"WebRTC.socket.io.engine.transport.ws={url:target.url,readyState:1,close(){productCalls++}}",
   instanceClose:'target.close=()=>productCalls++',
   ownerRace:'__wrdPassiveSampler.evidenceSnapshot=()=>{WebRTC={...WebRTC};return {inputGate:gate}}',
   socketRace:'__wrdPassiveSampler.evidenceSnapshot=()=>{WebRTC.socket={...WebRTC.socket};return {inputGate:gate}}',
   wsRace:'__wrdPassiveSampler.evidenceSnapshot=()=>{WebRTC.socket.io.engine.transport.ws=new WebSocket(target.url);return {inputGate:gate}}',
   disarmed:'__wrdLocalRecoveryFault.disarm()',duplicate:''};
  if(changes[name]) vm.runInContext(changes[name],box,{timeout:500});
  const result=vm.runInContext('__wrdLocalRecoveryFault.trigger()',box,{timeout:500});
  const again=vm.runInContext('__wrdLocalRecoveryFault.trigger()',box,{timeout:500});
  rows.push(JSON.parse(vm.runInContext('JSON.stringify({calls,productCalls,wasInstance:target instanceof WebSocket,native:target instanceof NativeSocket})',box,{timeout:500})));
  rows.at(-1).name=name; rows.at(-1).result=result; rows.at(-1).again=again;
 }
 process.stdout.write(JSON.stringify(rows));
});
'''


class InitClosureTests(unittest.TestCase):
    def vm(self,instrumentation,cases):
        script=adapter_module()._init_script(ORIGIN,instrumentation)
        result=subprocess.run([NODE,'-e',VM_HARNESS],input=json.dumps(dict(script=script,instrumentation=instrumentation,cases=cases)),
            text=True,capture_output=True,timeout=5,check=True)
        self.assertEqual(result.stderr,''); return json.loads(result.stdout)

    def test_actual_native_init_closure_checks_exact_target_and_captured_references(self):
        invalid=['owner','auth','host','socket','socketId','path','origin','transport','readyState','gate','proof',
                 'constructor','prototype','fakeInstance','ownerRace','socketRace','wsRace','disarmed']
        rows=self.vm('native-direct',['duplicate','instanceClose',*invalid])
        for row in rows:
            with self.subTest(case=row['name']):
                self.assertEqual(row['productCalls'],0)
                if row['name'] in ('duplicate','instanceClose'):
                    self.assertEqual(row['result'],'triggered'); self.assertEqual(row['again'],'fault-already-triggered')
                    self.assertEqual(row['calls'],[dict(kind='native',exact=True,code=1000,reason='wrd-local-recovery-check')])
                else:
                    self.assertEqual(row['result'],'fault-target-unavailable'); self.assertEqual(row['calls'],[])

    def test_routed_wrapper_passes_global_instanceof_but_never_claims_native(self):
        rows=self.vm('playwright-routed',['duplicate','owner','auth','origin','transport','wsRace','fakeInstance'])
        for row in rows:
            with self.subTest(case=row['name']):
                self.assertTrue(row['wasInstance']); self.assertFalse(row['native']); self.assertEqual(row['productCalls'],0)
                if row['name']=='duplicate':
                    self.assertEqual(row['result'],'triggered'); self.assertEqual(row['calls'][0]['kind'],'wrapper')
                    self.assertTrue(row['calls'][0]['synthetic']); self.assertEqual(row['again'],'fault-already-triggered')
                else: self.assertEqual(row['calls'],[])


class ScopeTests(unittest.TestCase):
    def test_scopes_are_fixed_and_emitted_from_preflight(self):
        expected={'baseline':'native-passive-continuity','continuity':'native-passive-continuity',
                  'within-grace':'ordinary-functional-native-direct-close','after-grace':'ordinary-functional-playwright-routed-stimulus'}
        for scenario,scope in expected.items():
            with self.subTest(scenario=scenario):
                value=runner.OrdinaryRecoverySummary(scenario,'stun').result(cleanup_complete=False)
                self.assertEqual(value['qualificationEvidenceScope'],scope)
                self.assertEqual(value['ordinaryRecovery']['qualificationEvidenceScope'],scope)
                self.assertEqual(value['nativeAfterGraceQualification'],'NOT_RUN')
                runner.validate_summary(value)
                for field in ('qualificationEvidenceScope','nativeAfterGraceQualification'):
                    bad=copy.deepcopy(value); bad[field]='PASS'
                    with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_summary(bad)
                bad=copy.deepcopy(value); bad['ordinaryRecovery']['qualificationEvidenceScope']='native-passive-continuity'
                if scenario in ('within-grace','after-grace'):
                    with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_summary(bad)
                bad=copy.deepcopy(value); bad['fault']['instrumentation']='native-direct' if scenario!='within-grace' else 'playwright-routed'
                with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_summary(bad)

    def test_pass_remains_its_scenario_scope_and_row_promotion_is_rejected(self):
        from scripts.test_ordinary_session_recovery import ClassifierTests, model_row, ready_sample
        helper=ClassifierTests()
        for scenario in ('within-grace','after-grace'):
            model=helper.model(scenario)
            model.observe(model_row(model,302)); model.confirm_fault(302); model.transition('recovering')
            after=scenario=='after-grace'
            model.observe(model_row(model,303,events=helper.events(after),socket='e'*16,sample=ready_sample(400,5 if after else 3)))
            for n in range(304,334): model.observe(model_row(model,n,socket='e'*16,sample=ready_sample(100+n,5 if after else 3)))
            result=model.result(cleanup_complete=True)
            self.assertEqual(result['ordinaryRecovery']['status'],'PASS')
            self.assertEqual(result['qualificationEvidenceScope'],runner.SCOPES[scenario])
            self.assertEqual(result['ordinaryRecovery']['qualificationEvidenceScope'],runner.SCOPES[scenario])
            self.assertEqual(result['nativeAfterGraceQualification'],'NOT_RUN')
            result['fault'].update(capability='available',status='disarmed',triggerCount=1)
            result['lifecycle'].update(captureStatus='ok',cleanupStatus='api-finished-exit-unknown')
            runner.validate_summary(result)
            for scope in set(runner.SCOPES.values())-{runner.SCOPES[scenario]}:
                bad=copy.deepcopy(result); bad['qualificationEvidenceScope']=scope; bad['ordinaryRecovery']['qualificationEvidenceScope']=scope
                with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_summary(bad)
            result['fault']['status']='failed'
            with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_summary(result)
        row=dict(schemaVersion=1,scenario='after-grace',elapsedSeconds=0,phase='preflight',
            qualificationEvidenceScope=runner.SCOPES['after-grace'],hostObservation=runner.HostContinuityObserver(b'x'*16).snapshot(),
            sample=None,identity=dict(sessionHash=None,socketHash=None,admissionHash=None),serverEvents=[])
        runner.validate_recovery_row(row)
        row['qualificationEvidenceScope']=runner.SCOPES['within-grace']
        with self.assertRaisesRegex(ValueError,'^schema-rejected$'): runner.validate_recovery_row(row)



class FailureIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def test_failure_property_is_allowlisted_and_snapshot_schema_unchanged(self):
        value=runner.empty_fault('after-grace'); value.update(capability='available',status='failed')
        for reason in ('fault-attempt-cap','fault-handler-failed'):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError,'^'+reason+'$'):
                runner._raise_fault_failure(types.SimpleNamespace(failure_reason=reason),value)
        with self.assertRaisesRegex(ValueError,'^fault-handler-failed$'):
            runner._raise_fault_failure(object(),value)
        for reason in ('none','private-error-canary',None,[],True):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError,'^schema-rejected$'):
                runner._raise_fault_failure(types.SimpleNamespace(failure_reason=reason),value)
        self.assertEqual(set(value),set(runner.empty_fault('after-grace')))

    async def test_capability_unavailable_is_not_run_before_browser_factory(self):
        from scripts.test_ordinary_session_recovery import RuntimeRunTests
        RuntimeRunTests.setUp(self)
        self.args.scenario='after-grace'; manifest=json.loads(self.manifest.read_text()); manifest['scenario']='after-grace'
        self.manifest.write_text(json.dumps(manifest)); self.args.runtime_manifest_sha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        calls=[]; route_free=type('RouteFreePage',(FakePage,),{'route_web_socket':None})
        with fake_api(Page=route_free):
            result=await runner.run(self.args,manager_factory=lambda:calls.append('factory'),status_reader=RuntimeRunTests.status.__get__(self))
        self.assertEqual(result,1); self.assertEqual(calls,[])
        summary=json.loads((Path(self.args.output_dir)/'summary.json').read_text())
        self.assertEqual(summary['ordinaryRecovery']['status'],'NOT_RUN')
        self.assertEqual(summary['failure']['reason'],'fault-capability-unavailable')
        self.assertEqual(summary['lifecycle']['cleanupStatus'],'incomplete')

    async def test_real_recovery_loop_vetoes_tick_disarm_and_postclose_fault_preserves_first_failure(self):
        from scripts.test_ordinary_session_recovery import RuntimeRunTests, RuntimePage, RuntimeManager, ready_sample, ui_state, event
        # Use the existing runtime setup without inheriting/re-running its tests.
        RuntimeRunTests.setUp(self)
        original_time=runner.time; original_sleep=asyncio.sleep
        for mode in ('success','tick','disarm','postclose','earlier'):
            with self.subTest(mode=mode):
                self.log.write_bytes(b''); self.args.scenario='after-grace'; self.args.output_dir=str(self.root/mode)
                manifest=json.loads(self.manifest.read_text()); manifest['scenario']='after-grace'
                self.manifest.write_text(json.dumps(manifest)); self.args.runtime_manifest_sha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest()
                class Fault:
                    def __init__(inner): inner.value=runner.empty_fault('after-grace'); inner.value.update(capability='available',status='ready'); inner.failure_reason='none'; inner.triggered=False
                    def snapshot(inner): return dict(inner.value)
                    async def install(inner,*a,**kw): pass
                    async def trigger_once(inner,*a):
                        inner.triggered=True; inner.value.update(triggerCount=1,status='triggered')
                        events=[event(viewer='socket-canary'),event('viewer_disconnect_grace_expired',viewer='socket-canary',meta=dict(leaseEpoch=4,state='REVOKING',reason='viewer-disconnect-timeout')),
                            event('control_reset_completed',meta=dict(leaseEpoch=4,state='FREE',status='applied'))]
                        events[-1]['correlation']={}
                        with self.log.open('a') as log:
                            for item in events: log.write(json.dumps(item)+'\n')
                    def fail(inner): inner.value['status']='failed'; inner.failure_reason='fault-attempt-cap'
                    async def disarm(inner):
                        if mode in ('disarm','earlier'): inner.fail()
                        elif inner.value['status']!='failed': inner.value['status']='disarmed'
                fault=Fault()
                class Page(RuntimePage):
                    async def evaluate(inner,script):
                        if 'window.__wrdPassiveSampler.sample()' not in script: return await super().evaluate(script)
                        inner.samples+=1
                        if fault.triggered and mode=='tick': fault.fail()
                        if fault.triggered and mode=='earlier' and 'finalize' not in script: raise ValueError('human-priority')
                        state=ui_state(); state['startClickMarks']=int(inner.clicks>0)
                        state.update(sessionId='session-canary',socketId='socket-new' if fault.triggered else 'socket-canary',admissionId='admission-canary')
                        sample=ready_sample(10+inner.samples,5 if fault.triggered else 3); sample.pop('attemptHash'); sample['attempt']='attempt-canary'
                        result=dict(state=state,sample=sample)
                        if 'finalize' in script: result['diagnostic']=runner.empty_diagnostic()
                        return result
                page=Page(); manager=RuntimeManager(page); original_close=manager.close
                async def close():
                    await original_close()
                    if mode=='postclose': fault.fail()
                manager.close=close
                clock=[0.125]
                async def sleep(delay): clock[0]+=delay; await original_sleep(0)
                async_proxy=types.SimpleNamespace(**{name:getattr(asyncio,name) for name in dir(asyncio)}); async_proxy.sleep=sleep
                async def status(): return dict(hostOnline=True,hostId='host-canary')
                with patch.object(runner,'_load_fault',return_value=fault), patch.object(runner,'time',types.SimpleNamespace(monotonic=lambda:clock[0],time=original_time.time)), patch.object(runner,'asyncio',async_proxy):
                    exit_code=await runner.run(self.args,manager_factory=lambda:manager,status_reader=status)
                summary=json.loads((Path(self.args.output_dir)/'summary.json').read_text())
                self.assertEqual(page.clicks,1); self.assertIn('close',manager.calls); self.assertIn('stop',manager.calls)
                self.assertEqual(summary['nativeAfterGraceQualification'],'NOT_RUN')
                self.assertEqual(summary['qualificationEvidenceScope'],'ordinary-functional-playwright-routed-stimulus')
                if mode=='success': self.assertEqual(exit_code,0); self.assertEqual(summary['ordinaryRecovery']['status'],'PASS')
                else:
                    self.assertEqual(exit_code,1); self.assertNotEqual(summary['ordinaryRecovery']['status'],'PASS')
                    self.assertEqual(summary['fault']['status'],'failed')
                    self.assertEqual(summary['failure']['reason'],'human-priority' if mode=='earlier' else 'fault-attempt-cap')


if __name__=='__main__': unittest.main()

