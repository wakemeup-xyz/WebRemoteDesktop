import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[5] / 'web-client'
html = (root / 'viewer.html').read_text()
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S | re.I)
html = re.sub(r'<link\b[^>]*>', '', html, flags=re.I)
css = '\n'.join((root / 'css' / name).read_text() for name in ['tokens.css', 'viewer.css'])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height, inset in [(375,812,0),(375,812,300),(768,1024,300),(1024,1366,300)]:
        page = browser.new_page(viewport={'width':width,'height':height})
        page.route('**/*', lambda route: route.abort())
        page.set_content(html)
        page.add_style_tag(content=css)
        page.add_style_tag(content='* { transition: none !important; animation: none !important; }')
        page.evaluate('document.fonts.ready')
        page.add_script_tag(content=(root / 'js/chrome-layout.js').read_text())
        result = page.evaluate('''({inset}) => {
          document.body.classList.add('stream-connected');
          ChromeLayout.applyCapabilities({uiPhase:'connected',streamReady:true,activeControl:true,transportReady:true});
          document.getElementById('loading').classList.add('hidden');
          document.getElementById('mobileTextInputBtn').hidden = false;
          document.getElementById('mobileInputDock').hidden = inset === 0;
          document.body.classList.toggle('mobile-input-visible', inset > 0);
          const s = document.documentElement.style;
          s.setProperty('--chrome-top', document.getElementById('statusBar').getBoundingClientRect().height + 'px');
          s.setProperty('--mobile-keyboard-bottom', inset + 'px');
          s.setProperty('--mobile-dock-height', document.getElementById('chromeDocks').getBoundingClientRect().height + 'px');
          const rect = selector => {
            const el = document.querySelector(selector), r = el.getBoundingClientRect(), c = getComputedStyle(el);
            return {top:r.top,bottom:r.bottom,height:r.height,display:c.display,paddingBottom:c.paddingBottom};
          };
          return {viewport:[innerWidth,innerHeight],syntheticKeyboardInset:inset,viewer:rect('.viewer-container'),docks:rect('#chromeDocks'),keys:rect('#mobileKeySurface'),text:rect('#mobileInputDock')};
        }''', {'inset':inset})
        print(json.dumps(result))
        page.close()
    page = browser.new_page()
    page.route('**/*', lambda route: route.abort())
    page.set_content(html)
    page.add_style_tag(content=css)
    page.evaluate('''() => {
      globalThis.WebRTC = {socket:{connected:true,emit(){}},sendInput:()=>false,canEnableDesktopInput:()=>true};
    }''')
    for name in ['input-geometry.js','keyboard-transport.js','remote-keyboard-controller.js','mobile-text-input.js','input.js']:
        page.add_script_tag(content=(root / 'js' / name).read_text())
    focus_result = page.evaluate('''() => {
      Input.videoElement = document.getElementById('remoteVideo');
      Input.initKeyboardController();
      Input.setupEventListeners();
      Input.setupTextInput();
      Input.setControlLease({leaseId:'lease-review-isolated',leaseEpoch:1});
      Input.setActive(true);
      document.getElementById('mobileInputDock').hidden = false;
      Input.mobileTextInputAdapter.show();
      const before = document.activeElement.id;
      Input.setActive(true);
      const after = document.activeElement.id;
      const viewer = document.querySelector('.viewer-container');
      return {before,after,mobileDockInsideFullscreenTarget:viewer.contains(document.getElementById('mobileInputDock')),keysInsideFullscreenTarget:viewer.contains(document.getElementById('mobileKeySurface'))};
    }''')
    print(json.dumps({'isolatedDOMFocus':focus_result}))
    assert focus_result['before'] == 'mobileTextInput'
    assert focus_result['after'] == 'remoteVideo'
    page.close()
    browser.close()
