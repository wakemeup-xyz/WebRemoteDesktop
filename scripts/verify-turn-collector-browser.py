#!/usr/bin/env python3
"""Verify real browser paint callbacks with synthetic video; never opens a Viewer."""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('collector', root / 'scripts/turn_runtime_collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1000, 'height': 700})
        page.route('**/*', lambda route: route.abort())
        page.set_content('<video id="remoteVideo" autoplay muted playsinline style="width:640px;height:360px"></video>')
        page.evaluate('''async () => {
          const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
          const ctx=canvas.getContext('2d'); const video=document.getElementById('remoteVideo');
          let sequence=0; window.draw=()=>{ctx.fillStyle=sequence++%2?'#183b51':'#467c92';ctx.fillRect(0,0,320,180);};
          window.draw(); video.srcObject=canvas.captureStream(20); await video.play();
          window.start=()=>{window.timer=setInterval(window.draw,50)}; window.stop=()=>clearInterval(window.timer);window.start();
          window.WebRTC={currentConnectionAttemptId:'synthetic',getMediaAppliedPhase:()=> 'active',socket:{connected:true}};
        }''')
        page.evaluate(collector.PAINT_PHASE_START_JS)
        page.evaluate(collector.SAMPLE_JS)
        page.wait_for_timeout(1100)
        healthy = page.evaluate(collector.SAMPLE_JS)
        assert healthy['firstPaintObserved'] and healthy['maxPaintGapMs'] < 1000, healthy
        page.evaluate('window.stop()')
        page.wait_for_timeout(1600)
        stalled = page.evaluate(collector.SAMPLE_JS)
        assert stalled['maxPaintGapMs'] > 1000, stalled
        page.evaluate('window.start()')
        page.wait_for_timeout(300)
        resumed = page.evaluate(collector.SAMPLE_JS)
        assert resumed['paintAgeMs'] < 500 and resumed['maxPaintGapMs'] > 1000, resumed
        page.evaluate("document.getElementById('remoteVideo').style.transform='translateX(3px)'")
        page.wait_for_timeout(150)
        page.evaluate("document.getElementById('remoteVideo').style.transform='none'")
        page.wait_for_timeout(150)
        geometry = page.evaluate(collector.SAMPLE_JS)
        assert geometry['geometry']['rangeX'] >= 3, geometry
        print(json.dumps({'scope':'isolated synthetic browser only; no network or real Viewer',
          'healthyMaxGapMs':healthy['maxPaintGapMs'],'stalledMaxGapMs':stalled['maxPaintGapMs'],
          'resumedPaintAgeMs':resumed['paintAgeMs'],'resumedMaxGapMs':resumed['maxPaintGapMs'],
          'geometryRangeX':geometry['geometry']['rangeX'],'ok':True}))
    finally:
        browser.close()
