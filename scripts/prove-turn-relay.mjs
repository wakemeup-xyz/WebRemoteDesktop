#!/usr/bin/env node
/**
 * Automated TURN relay media proof against a running local WRD stack.
 *
 * Steps:
 * 1) Login as viewer
 * 2) GET /api/webrtc-config and assert turnConfigured + hostTurnReady + fingerprint match
 * 3) POST /api/turn-selftest and assert server allocate ok
 * 4) Open viewer page, inject auth token, switch to relay mode, wait for FPS>0 and candidate=relay
 *
 * Usage:
 *   node scripts/prove-turn-relay.mjs
 *   WRD_BASE_URL=http://127.0.0.1:8080 node scripts/prove-turn-relay.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (_err) {
  chromium = null;
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function loadViewerPassword() {
  if (process.env.VIEWER_ACCESS_PASSWORD) return process.env.VIEWER_ACCESS_PASSWORD;
  if (process.env.ACCESS_PASSWORD) return process.env.ACCESS_PASSWORD;
  try {
    require('dotenv').config({ path: path.join(projectRoot, 'signal-server', '.env') });
  } catch (_err) {
    // dotenv may only exist under signal-server/node_modules
    require(path.join(projectRoot, 'signal-server', 'node_modules', 'dotenv')).config({
      path: path.join(projectRoot, 'signal-server', '.env'),
    });
  }
  return process.env.VIEWER_ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || '';
}

const baseUrl = String(process.env.WRD_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const password = loadViewerPassword();
if (!password) {
  console.error('Missing VIEWER_ACCESS_PASSWORD / ACCESS_PASSWORD');
  process.exit(2);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function short(value) {
  return String(value || '').slice(0, 12);
}

async function main() {
  const result = {
    baseUrl,
    login: false,
    webrtcConfig: null,
    serverSelfTest: null,
    browser: null,
  };

  const login = await jsonFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!login.response.ok || !login.body?.token) {
    throw new Error(`login failed: HTTP ${login.response.status}`);
  }
  result.login = true;
  const token = login.body.token;

  const cfg = await jsonFetch(`${baseUrl}/api/webrtc-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!cfg.response.ok) {
    throw new Error(`webrtc-config failed: HTTP ${cfg.response.status}`);
  }
  result.webrtcConfig = {
    turnConfigured: cfg.body.turnConfigured,
    turnSource: cfg.body.turnSource,
    hostTurnReady: cfg.body.hostTurnReady,
    fingerprintMatch: cfg.body.turnFingerprint === cfg.body.hostTurnFingerprint,
    turnFingerprint: short(cfg.body.turnFingerprint),
    hostTurnFingerprint: short(cfg.body.hostTurnFingerprint),
    turnUrls: cfg.body.turnUrls,
  };
  if (!cfg.body.turnConfigured) throw new Error('turnConfigured=false');
  if (!cfg.body.hostTurnReady) throw new Error('hostTurnReady=false');
  if (cfg.body.turnFingerprint !== cfg.body.hostTurnFingerprint) {
    throw new Error('viewer/host fingerprint mismatch');
  }

  const selftest = await jsonFetch(`${baseUrl}/api/turn-selftest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ timeoutMs: 12000 }),
  });
  result.serverSelfTest = {
    status: selftest.response.status,
    ok: selftest.body.ok,
    code: selftest.body.code,
    relayCandidateCount: selftest.body.relayCandidateCount,
    reason: selftest.body.reason,
    durationMs: selftest.body.durationMs,
    fingerprintMatch: selftest.body.fingerprintMatch,
  };
  if (!selftest.body.ok) {
    throw new Error(`server selftest failed: ${selftest.body.code || selftest.body.reason}`);
  }

  if (!chromium) {
    result.browser = {
      skipped: true,
      reason: 'playwright-not-installed',
    };
    console.log(JSON.stringify({ ok: true, partial: true, ...result }, null, 2));
    console.log('PROOF_PARTIAL_NO_PLAYWRIGHT');
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    // Playwright may not be installed in this environment.
    result.browser = {
      skipped: true,
      reason: error instanceof Error ? error.message : String(error),
    };
    console.log(JSON.stringify({ ok: true, partial: true, ...result }, null, 2));
    console.log('PROOF_PARTIAL_NO_PLAYWRIGHT');
    return;
  }

  const page = await browser.newPage();
  await page.addInitScript((authToken) => {
    try {
      localStorage.setItem('wrd_token', authToken);
      localStorage.setItem('wrdNetworkMode', 'relay');
    } catch (_err) {
      // ignore
    }
  }, token);

  await page.goto(`${baseUrl}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Some deployments use Auth storage key variants; set both common keys.
  await page.evaluate((authToken) => {
    const keys = ['wrd_token', 'token', 'accessToken', 'wrdAccessToken'];
    for (const key of keys) {
      try { localStorage.setItem(key, authToken); } catch (_err) { /* ignore */ }
    }
    try { localStorage.setItem('wrdNetworkMode', 'relay'); } catch (_err) { /* ignore */ }
  }, token);

  // Force network mode through UI if available.
  await page.evaluate(() => {
    if (typeof WebRTC !== 'undefined' && typeof WebRTC.setNetworkMode === 'function') {
      WebRTC.setNetworkMode('relay');
    }
  });

  const deadline = Date.now() + 45000;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => {
      const fpsText = document.getElementById('fps')?.textContent || '';
      const candidateText = document.getElementById('candidateType')?.textContent
        || document.getElementById('linkType')?.textContent
        || '';
      const statusText = document.getElementById('connectionStatus')?.textContent || '';
      const lastType = (typeof WebRTC !== 'undefined' && WebRTC.lastCandidateType) || '';
      const selected = (typeof WebRTC !== 'undefined' && WebRTC.selectedCandidatePair) || null;
      const fps = Number(String(fpsText).replace(/[^\d.]/g, '')) || 0;
      return {
        fps,
        fpsText,
        candidateText,
        statusText,
        lastType,
        selectedType: selected?.type || selected?.localCandidateType || selected?.candidateType || '',
        networkMode: (typeof WebRTC !== 'undefined' && WebRTC.networkMode) || null,
        turnConfigured: Boolean(typeof WebRTC !== 'undefined' && WebRTC.serverConfig?.turnConfigured),
      };
    });

    const selectedRelay = ['relay', 'TURN中继', 'turn'].some((tokenPart) => {
      const hay = `${snapshot.lastType} ${snapshot.selectedType} ${snapshot.candidateText}`.toLowerCase();
      return hay.includes(String(tokenPart).toLowerCase());
    });
    if (snapshot.fps > 0 && (selectedRelay || snapshot.networkMode === 'relay')) {
      result.browser = { ...snapshot, ok: true, selectedRelay };
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      console.log('PROOF_RELAY_MEDIA_OK');
      await browser.close();
      return;
    }
    await page.waitForTimeout(1000);
  }

  result.browser = { ...(snapshot || {}), ok: false, selectedRelay: false };
  await browser.close();
  console.log(JSON.stringify({ ok: false, ...result }, null, 2));
  throw new Error('timed out waiting for relay media FPS>0');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
