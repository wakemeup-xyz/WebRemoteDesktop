import json,time,pathlib,urllib.request,sys,subprocess,os
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path('/Users/macstudio1/AI/Claude/WebRemoteDesktop')
OUT=pathlib.Path(sys.argv[1]); seconds720=int(sys.argv[2]); seconds1080=int(sys.argv[3])
env={}
for line in (ROOT/'signal-server/.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1);env[k.strip()]=v.strip().strip('\"\'')
def api(route,data=None,token=None):
 headers={'Content-Type':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 req=urllib.request.Request('http://127.0.0.1:8080'+route,data=None if data is None else json.dumps(data).encode(),headers=headers)
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
def cpu():
 roots={os.getpid()}
 for file in ['/tmp/wrd-host.pid','/tmp/wrd-safe-host.pid']:
  try:roots.add(int(pathlib.Path(file).read_text().strip()))
  except (ValueError,OSError):pass
 try:roots.update(map(int,subprocess.check_output(['lsof','-tiTCP:8080','-sTCP:LISTEN'],text=True).split()))
 except subprocess.CalledProcessError:pass
 todo=list(roots)
 while todo:
  pid=todo.pop()
  try:children=set(map(int,subprocess.check_output(['pgrep','-P',str(pid)],text=True).split()))-roots
  except subprocess.CalledProcessError:children=set()
  roots.update(children);todo.extend(children)
 out=subprocess.check_output(['ps','-p',','.join(map(str,sorted(roots))),'-o','pid=,%cpu='],text=True)
 rows=[{'pid':int(a),'cpu':float(b)} for a,b in (line.split() for line in out.splitlines())]
 return {'scope':'project Host Signal and this test/browser descendants only','sum':round(sum(x['cpu']for x in rows),2),'processes':rows}
r={'startedAt':time.time(),'phases':[],'ok':False,'scope':'local Chromium actual TURN; desktop content uncontrolled; no desktop input injection'}
def save():OUT.write_text(json.dumps(r,indent=2))
def snap(page):
 return page.evaluate('''async()=>{const c=globalThis.WebRTC,v=document.querySelector('video');const stats=c?.pc?await c.pc.getStats():new Map();let video=null;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video')video={framesDecoded:s.framesDecoded,keyFramesDecoded:s.keyFramesDecoded,framesDropped:s.framesDropped,framesReceived:s.framesReceived,freezeCount:s.freezeCount,totalFreezesDuration:s.totalFreezesDuration,jitter:s.jitter,jitterBufferDelay:s.jitterBufferDelay,jitterBufferEmittedCount:s.jitterBufferEmittedCount,packetsLost:s.packetsLost,packetsReceived:s.packetsReceived,bytesReceived:s.bytesReceived,nackCount:s.nackCount,pliCount:s.pliCount,firCount:s.firCount}});const pair=c?.selectedCandidatePair||{};return {at:Date.now(),status:document.querySelector('#connectionStatus')?.textContent,connection:c?.pc?.connectionState,pair:{type:pair.localType||pair.type,protocol:pair.protocol,rttMs:pair.rttMs},video,width:v?.videoWidth,height:v?.videoHeight,paint:globalThis.__paint||null,paintObservation:c?._lastPaintObservation||null}}''')
try:
 status=api('/api/status');assert status.get('viewerCount')==0,'Viewer active; refused'
 token=api('/api/auth/login',{'password':env.get('VIEWER_ACCESS_PASSWORD') or env.get('ACCESS_PASSWORD')})['token']
 admission=api('/api/proof-admission',{},token)['admission']
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  try:
   page=browser.new_page(viewport={'width':1440,'height':1000})
   page.add_init_script('localStorage.setItem("wrd_token",'+json.dumps(token)+');localStorage.setItem("wrdNetworkMode","relay");sessionStorage.setItem("wrdProofAdmission",'+json.dumps(json.dumps(admission))+');')
   page.goto('http://127.0.0.1:8080/viewer.html',wait_until='networkidle',timeout=45000)
   print(page.locator('body').inner_text()[:2500],flush=True)
   if page.locator('#startBtn').is_visible():page.locator('#startBtn').click()
   print(page.evaluate('()=>({w:typeof globalThis.WebRTC,url:location.pathname})'),flush=True)
   page.wait_for_function("globalThis.WebRTC?.pc?.connectionState==='connected' && document.querySelector('video')?.videoWidth>0",timeout=60000)
   r['controls']=page.locator('button').evaluate_all('(els)=>els.map(e=>({id:e.id,text:e.textContent.trim()}))')
   page.evaluate('''()=>{const v=document.querySelector('video');globalThis.__paint={count:0,maxGapMs:0,lastAt:null};const cb=(now)=>{const s=globalThis.__paint;if(s.lastAt!==null)s.maxGapMs=Math.max(s.maxGapMs,now-s.lastAt);s.lastAt=now;s.count++;v.requestVideoFrameCallback(cb)};v.requestVideoFrameCallback(cb)}''')
   for height,duration in [(720,seconds720),(1080,seconds1080)]:
    if duration<=0:continue
    
    if '显示' in page.locator('#toggleControlsBtn').inner_text():page.locator('#toggleControlsBtn').dispatch_event('click')
    page.locator('#resolutionBtn').click();page.locator('input[name=resolution][value="'+str(height)+'p"]').check();page.locator('#applyResolution').click()
    page.wait_for_function('(h)=>document.querySelector("video")?.videoHeight===h',arg=height,timeout=45000)
    page.wait_for_timeout(5000)
    phase={'height':height,'seconds':duration,'samples':[]};r['phases'].append(phase)
    page.evaluate('()=>{globalThis.__paint.maxGapMs=0}')
    until=time.monotonic()+duration
    while time.monotonic()<until:
     sample=snap(page)
     if len(phase['samples'])%15==0:sample['projectCpu']=cpu()
     phase['samples'].append(sample);save();page.wait_for_timeout(1000)
    print('phase complete',height,len(phase['samples']),flush=True)
   r['beforePause']=snap(page)
   if '显示' in page.locator('#toggleControlsBtn').inner_text():page.locator('#toggleControlsBtn').dispatch_event('click')
   page.locator('#pauseBtn').click();page.wait_for_timeout(4000);r['paused']=snap(page)
   page.wait_for_timeout(3000);r['pausedLater']=snap(page)
   
   if '显示' in page.locator('#toggleControlsBtn').inner_text():page.locator('#toggleControlsBtn').dispatch_event('click')
   page.locator('#pauseBtn').click();page.wait_for_timeout(8000);r['resumed']=snap(page)
   r['lossEmulation']={'method':'Chromium CDP WebRTC packetLoss; does not change Host or machine network','before':snap(page)}
   cdp=page.context.new_cdp_session(page)
   conditions={'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1,'packetLoss':2,'packetQueueLength':0,'packetReordering':False}
   try:
    cdp.send('Network.enable')
    cdp.send('Network.emulateNetworkConditions',conditions)
    page.wait_for_timeout(20000)
    r['lossEmulation']['during']=snap(page)
   finally:
    cdp.send('Network.emulateNetworkConditions',{**conditions,'packetLoss':0})
   page.wait_for_timeout(10000)
   r['lossEmulation']['after']=snap(page)
   r['lossEmulation']['observedLostDelta']=r['lossEmulation']['after']['video']['packetsLost']-r['lossEmulation']['before']['video']['packetsLost']
   r['ok']=all(s['pair']['type']=='relay' and s['connection']=='connected' for phase in r['phases'] for s in phase['samples'])
  finally:browser.close()
except Exception as e:r['error']=str(e)
finally:r['endedAt']=time.time();save();print(json.dumps({k:v for k,v in r.items() if k not in ('controls','phases')}),flush=True)
