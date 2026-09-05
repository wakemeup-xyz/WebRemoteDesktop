#!/usr/bin/env node
/**
 * Automated TURN relay media proof against a running local WRD stack.
 * It refuses to launch a replacement Viewer while an existing Viewer is active.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export function parseProofArgs(argv = []) {
  const result = { durationSeconds: 45, output: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--duration-seconds') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 600) {
        throw new Error('--duration-seconds must be an integer from 1 to 600');
      }
      result.durationSeconds = value;
    } else if (arg === '--output') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('--output requires a path');
      result.output = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

export function redactSelectedPair(pair = {}) {
  const rtt = Number(pair.rttMs);
  return {
    type: String(pair.localType || pair.type || '').toLowerCase(),
    protocol: String(pair.protocol || '').toLowerCase(),
    rttMs: Number.isFinite(rtt) && rtt >= 0 ? rtt : null,
  };
}

export function selectedPairIsRelay(pair = {}) {
  return redactSelectedPair(pair).type === 'relay';
}

export function assertNoActiveViewer(status = {}) {
  const viewerCount = Number(status.viewerCount || 0);
  if (Number.isFinite(viewerCount) && viewerCount > 0) {
    throw new Error(`active Viewer present (viewerCount=${viewerCount}); refusing headless proof`);
  }
}

function printUsage() {
  console.log('Usage: node scripts/prove-turn-relay.mjs [--duration-seconds 1..600] [--output path]');
}

function loadViewerPassword() {
  if (process.env.VIEWER_ACCESS_PASSWORD) return process.env.VIEWER_ACCESS_PASSWORD;
  if (process.env.ACCESS_PASSWORD) return process.env.ACCESS_PASSWORD;
  try {
    require('dotenv').config({ path: path.join(projectRoot, 'signal-server', '.env') });
  } catch (_err) {
    require(path.join(projectRoot, 'signal-server', 'node_modules', 'dotenv')).config({
      path: path.join(projectRoot, 'signal-server', '.env'),
    });
  }
  return process.env.VIEWER_ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || '';
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function short(value) {
  return String(value || '').slice(0, 12);
}

function writeResult(result, output) {
  const serialized = JSON.stringify(result, null, 2);
  if (output) fs.writeFileSync(output, `${serialized}\n`, 'utf8');
  console.log(serialized);
}

async function main(options) {
  const baseUrl = String(process.env.WRD_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const password = loadViewerPassword();
  if (!password) throw new Error('Missing VIEWER_ACCESS_PASSWORD / ACCESS_PASSWORD');
  const result = {
    baseUrl,
    durationSeconds: options.durationSeconds,
    login: false,
    activeViewer: null,
    webrtcConfig: null,
    serverSelfTest: null,
    browser: null,
  };

  const login = await jsonFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (!login.response.ok || !login.body?.token) throw new Error(`login failed: HTTP ${login.response.status}`);
  result.login = true;
  const token = login.body.token;

  const status = await jsonFetch(`${baseUrl}/api/status`);
  if (!status.response.ok) throw new Error(`status failed: HTTP ${status.response.status}`);
  result.activeViewer = { viewerCount: Number(status.body.viewerCount || 0) };
  assertNoActiveViewer(status.body);

  const cfg = await jsonFetch(`${baseUrl}/api/webrtc-config`, { headers: { Authorization: `Bearer ${token}` } });
  if (!cfg.response.ok) throw new Error(`webrtc-config failed: HTTP ${cfg.response.status}`);
  result.webrtcConfig = {
    turnConfigured: cfg.body.turnConfigured,
    turnSource: cfg.body.turnSource,
    hostTurnReady: cfg.body.hostTurnReady,
    fingerprintMatch: cfg.body.turnFingerprint === cfg.body.hostTurnFingerprint,
    turnFingerprint: short(cfg.body.turnFingerprint),
    hostTurnFingerprint: short(cfg.body.hostTurnFingerprint),
  };
  if (!cfg.body.turnConfigured) throw new Error('turnConfigured=false');
  if (!cfg.body.hostTurnReady) throw new Error('hostTurnReady=false');
  if (cfg.body.turnFingerprint !== cfg.body.hostTurnFingerprint) throw new Error('viewer/host fingerprint mismatch');

  const selftest = await jsonFetch(`${baseUrl}/api/turn-selftest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutMs: 12000 }),
  });
  result.serverSelfTest = {
    status: selftest.response.status, ok: selftest.body.ok, code: selftest.body.code,
    relayCandidateCount: selftest.body.relayCandidateCount, reason: selftest.body.reason,
    durationMs: selftest.body.durationMs, fingerprintMatch: selftest.body.fingerprintMatch,
  };
  if (!selftest.body.ok) throw new Error(`server selftest failed: ${selftest.body.code || selftest.body.reason}`);

  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (_err) { chromium = null; }
  if (!chromium) {
    result.browser = { skipped: true, reason: 'playwright-not-installed' };
    writeResult({ ok: true, partial: true, ...result }, options.output);
    console.log('PROOF_PARTIAL_NO_PLAYWRIGHT');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript((authToken) => {
      localStorage.setItem('wrd_token', authToken);
      localStorage.setItem('wrdNetworkMode', 'relay');
    }, token);
    await page.goto(`${baseUrl}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate((authToken) => {
      for (const key of ['wrd_token', 'token', 'accessToken', 'wrdAccessToken']) localStorage.setItem(key, authToken);
      localStorage.setItem('wrdNetworkMode', 'relay');
      if (typeof WebRTC !== 'undefined' && typeof WebRTC.setNetworkMode === 'function') WebRTC.setNetworkMode('relay');
    }, token);

    const deadline = Date.now() + options.durationSeconds * 1000;
    let snapshot = null;
    while (Date.now() < deadline) {
      snapshot = await page.evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent || '';
        const selected = typeof WebRTC !== 'undefined' ? WebRTC.selectedCandidatePair : null;
        const rtt = Number(selected?.rttMs);
        return {
          dom: {
            fpsDisplay: text('fpsDisplay'),
            candidateDisplay: text('candidateDisplay'),
            connectionStatus: text('connectionStatus'),
          },
          fps: Number(text('fpsDisplay').replace(/[^\d.]/g, '')) || 0,
          selectedPair: {
            type: String(selected?.localType || '').toLowerCase(),
            protocol: String(selected?.protocol || '').toLowerCase(),
            rttMs: Number.isFinite(rtt) && rtt >= 0 ? rtt : null,
          },
        };
      });
      if (snapshot.fps > 0 && snapshot.selectedPair.type === 'relay') {
        result.browser = { ...snapshot, ok: true, selectedRelay: true };
        writeResult({ ok: true, ...result }, options.output);
        console.log('PROOF_RELAY_MEDIA_OK');
        return;
      }
      await page.waitForTimeout(1000);
    }
    result.browser = { ...(snapshot || {}), ok: false, selectedRelay: false };
    writeResult({ ok: false, ...result }, options.output);
    throw new Error('timed out waiting for selected local relay pair and FPS>0');
  } finally {
    await browser.close();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseProofArgs(process.argv.slice(2));
    if (options.help) printUsage();
    else await main(options);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}
