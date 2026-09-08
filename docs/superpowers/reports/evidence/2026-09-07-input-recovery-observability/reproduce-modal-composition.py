"""Remaining R4 acceptance gate: exit 1 until modal composition owns its trace.

Run from the repository root. Uses the existing offline Chromium fixture;
does not read credentials, connect to services, or invoke native input.
The result contains only booleans and counts, never the synthetic text.
"""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('offline', Path.cwd() / 'scripts/mobile_input_interaction_acceptance.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
with sync_playwright() as runtime:
    browser = runtime.chromium.launch(headless=True)
    fixture = suite.OfflineFixture(browser, touch=False, show_mobile=False, include_diagnostics=True)
    page = fixture.page
    try:
        page.evaluate("WebRTC.currentConnectionAttemptId = 'offline-root-modal-composition'")
        fixture.settle()
        page.locator('#textInputBtn').click()
        page.locator('#remoteTextInput').dispatch_event('compositionstart', {'bubbles': True})
        page.locator('#remoteTextInput').fill('ROOT_MODAL_COMPOSITION_CANARY')
        page.evaluate('window.__rootTraceStart = Diagnostic.getInputTraceSnapshot().events.length')
        page.locator('#remoteTextInput').dispatch_event('compositionend', {'bubbles': True})
        page.wait_for_timeout(3300)
        observed = page.evaluate("""() => {
          const trace = Diagnostic.getInputTraceSnapshot();
          const events = trace.events.slice(window.__rootTraceStart);
          const sends = events.filter(e => e.stage === 'transport-send' && e.accepted && e.action !== 'reset');
          const domIds = new Set(events.filter(e => e.stage === 'dom-received').map(e => e.eventId));
          return {writes:sends.length, originatingDom:sends.length > 0 && sends.every(e => Number.isSafeInteger(e.eventId) && domIds.has(e.eventId)),
            timeouts:events.filter(e => e.stage === 'ack-timeout').length,
            incidents:Diagnostic._pendingInputIncidents.length,
            contextCleared:Input._inputTraceContext === null,
            artifactSafe:!JSON.stringify(trace).includes('ROOT_MODAL_COMPOSITION_CANARY')};
        }""")
        print(json.dumps({'scope': 'offline-synthetic', 'case': 'modal-compositionend', **observed, 'network': suite.OFFLINE_NETWORK_STATS}))
        assert observed['writes'] > 0 and observed['originatingDom'] and observed['timeouts'] > 0
        assert observed['incidents'] == 1 and observed['contextCleared'] and observed['artifactSafe']
        assert suite.OFFLINE_NETWORK_STATS == {'requests': 0, 'sensitivePayloads': 0}
    finally:
        fixture.close()
        browser.close()
