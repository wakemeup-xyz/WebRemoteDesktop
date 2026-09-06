#!/usr/bin/env node
/** Automated TURN relay proof with server-owned Viewer admission. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
let outputSequence = 0;

export function parseProofArgs(argv = []) {
  const result = { durationSeconds: 45, output: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--duration-seconds') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 600) throw new Error('--duration-seconds must be an integer from 1 to 600');
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
  return { type: String(pair.localType || pair.type || '').toLowerCase(), protocol: String(pair.protocol || '').toLowerCase(), rttMs: Number.isFinite(rtt) && rtt >= 0 ? rtt : null };
}
export function selectedPairIsRelay(pair = {}) { return redactSelectedPair(pair).type === 'relay'; }
export function assertNoActiveViewer(status = {}) {
  const viewerCount = Number(status.viewerCount || 0);
  if (Number.isFinite(viewerCount) && viewerCount > 0) throw new Error(`active Viewer present (viewerCount=${viewerCount}); refusing headless proof`);
}
export function proofSnapshotPasses(snapshot = {}) {
  return Number(snapshot.fps) > 0 && snapshot.socketConnected === true
    && snapshot.pcConnectionState === 'connected'
    && String(snapshot.dom?.connectionStatus || '').trim() === '已连接'
    && selectedPairIsRelay(snapshot.selectedPair);
}
export function buildFailedProofResult(base = {}, error = null) {
  const message = error instanceof Error ? error.message : String(error || 'proof failed');
  return { ...base, ok: false, proofComplete: false, error: { message } };
}
export function createProofRunId() { return `proof-${randomUUID()}`; }
export function writeResultAtomically(result, output, operations = fs) {
  if (!output) return;
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = operations.openSync(temporary, 'wx', 0o600);
    operations.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = null;
    operations.renameSync(temporary, output);
  } catch (error) {
    if (fd !== null) try { operations.closeSync(fd); } catch (_closeError) { /* best effort */ }
    try { operations.unlinkSync(temporary); } catch (_unlinkError) { /* no new result remains */ }
    throw error;
  }
}
export function isolateOutputTarget(output, operations = fs) {
  if (!output) return null;
  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${Date.now()}.${outputSequence += 1}.stale`,
  );
  try {
    operations.renameSync(output, backup);
    return backup;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
export function cleanupIsolatedOutput(backup, operations = fs) {
  if (!backup) return;
  try { operations.unlinkSync(backup); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
export function overwriteOutputInPlace(result, output, operations = fs) {
  if (!output) return;
  let fd = null;
  try {
    // Explicit fd truncation makes the stale success untrustworthy before the
    // structured failure is written.
    fd = operations.openSync(output, 'r+');
    operations.ftruncateSync(fd, 0);
    operations.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = null;
  } finally {
    if (fd !== null) try { operations.closeSync(fd); } catch (_closeError) { /* best effort */ }
  }
}
export function outputUntrustedMarker(runId, output) {
  return `OUTPUT_UNTRUSTED runId=${runId} path=${output}`;
}
export function secureOutputTarget(output, baseResult = {}, operations = fs) {
  if (!output) return { state: 'none', backup: null };
  try {
    return { state: 'isolated', backup: isolateOutputTarget(output, operations) };
  } catch (isolationError) {
    const result = {
      ...buildFailedProofResult(baseResult, isolationError),
      stage: 'output-isolation',
    };
    try {
      overwriteOutputInPlace(result, output, operations);
      return { state: 'overwritten', backup: null, result, error: isolationError };
    } catch (overwriteError) {
      return { state: 'untrusted', backup: null, result, error: overwriteError };
    }
  }
}

function printUsage() {
  console.log('Usage: node scripts/prove-turn-relay.mjs [--duration-seconds 1..600] [--output path]');
  console.log('Trust --output only when this runId matches and ok=true and proofComplete=true.');
}
function outputFromArgv(argv = []) {
  const index = argv.indexOf('--output');
  return index >= 0 ? String(argv[index + 1] || '').trim() || null : null;
}
function loadViewerPassword() {
  if (process.env.VIEWER_ACCESS_PASSWORD) return process.env.VIEWER_ACCESS_PASSWORD;
  if (process.env.ACCESS_PASSWORD) return process.env.ACCESS_PASSWORD;
  try { require('dotenv').config({ path: path.join(projectRoot, 'signal-server', '.env') }); }
  catch (_error) { require(path.join(projectRoot, 'signal-server', 'node_modules', 'dotenv')).config({ path: path.join(projectRoot, 'signal-server', '.env') }); }
  return process.env.VIEWER_ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || '';
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function short(value) { return String(value || '').slice(0, 12); }

async function runProof(options) {
  const baseUrl = String(process.env.WRD_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const result = { runId: options.runId, baseUrl, durationSeconds: options.durationSeconds, login: false, activeViewer: null, admission: null, webrtcConfig: null, serverSelfTest: null, browser: null };
  let browser = null;
  try {
    const password = loadViewerPassword();
    if (!password) throw new Error('Missing VIEWER_ACCESS_PASSWORD / ACCESS_PASSWORD');
    const login = await jsonFetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!login.response.ok || !login.body?.token) throw new Error(`login failed: HTTP ${login.response.status}`);
    result.login = true;
    const token = login.body.token;
    const status = await jsonFetch(`${baseUrl}/api/status`);
    if (!status.response.ok) throw new Error(`status failed: HTTP ${status.response.status}`);
    result.activeViewer = { viewerCount: Number(status.body.viewerCount || 0), viewerEpoch: Number(status.body.viewerEpoch || 0) };
    assertNoActiveViewer(status.body);
    const admission = await jsonFetch(`${baseUrl}/api/proof-admission`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!admission.response.ok || !admission.body?.admission?.token) throw new Error(`proof admission failed: HTTP ${admission.response.status}`);
    result.admission = { epoch: Number(admission.body.admission.epoch) };
    const cfg = await jsonFetch(`${baseUrl}/api/webrtc-config`, { headers: { Authorization: `Bearer ${token}` } });
    if (!cfg.response.ok) throw new Error(`webrtc-config failed: HTTP ${cfg.response.status}`);
    result.webrtcConfig = { turnConfigured: cfg.body.turnConfigured, turnSource: cfg.body.turnSource, hostTurnReady: cfg.body.hostTurnReady, fingerprintMatch: cfg.body.turnFingerprint === cfg.body.hostTurnFingerprint, turnFingerprint: short(cfg.body.turnFingerprint), hostTurnFingerprint: short(cfg.body.hostTurnFingerprint) };
    if (!cfg.body.turnConfigured || !cfg.body.hostTurnReady || cfg.body.turnFingerprint !== cfg.body.hostTurnFingerprint) throw new Error('TURN configuration is not ready');
    const selftest = await jsonFetch(`${baseUrl}/api/turn-selftest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 12000 }) });
    result.serverSelfTest = { status: selftest.response.status, ok: selftest.body.ok, code: selftest.body.code, relayCandidateCount: selftest.body.relayCandidateCount, reason: selftest.body.reason, durationMs: selftest.body.durationMs, fingerprintMatch: selftest.body.fingerprintMatch };
    if (!selftest.body.ok) throw new Error(`server selftest failed: ${selftest.body.code || selftest.body.reason}`);
    let chromium = null;
    try { ({ chromium } = require('playwright')); } catch (_error) { chromium = null; }
    if (!chromium) { result.browser = { available: false, reason: 'playwright-not-installed' }; throw new Error('Playwright/Chromium is unavailable; proof is incomplete'); }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(({ authToken, proofAdmission }) => {
      localStorage.setItem('wrd_token', authToken); localStorage.setItem('wrdNetworkMode', 'relay'); sessionStorage.setItem('wrdProofAdmission', JSON.stringify(proofAdmission));
    }, { authToken: token, proofAdmission: admission.body.admission });
    await page.goto(`${baseUrl}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + options.durationSeconds * 1000;
    let snapshot = null;
    while (Date.now() < deadline) {
      snapshot = await page.evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent || '';
        const selected = typeof WebRTC !== 'undefined' ? WebRTC.selectedCandidatePair : null;
        const client = typeof WebRTC !== 'undefined' ? WebRTC : null;
        return { dom: { fpsDisplay: text('fpsDisplay'), connectionStatus: text('connectionStatus') }, fps: Number(text('fpsDisplay').replace(/[^\d.]/g, '')) || 0, socketConnected: Boolean(client?.socket?.connected), pcConnectionState: String(client?.pc?.connectionState || ''), selectedPair: redactSelectedPair(selected || {}) };
      });
      if (proofSnapshotPasses(snapshot)) { result.browser = { ...snapshot, selectedRelay: true }; return { ...result, ok: true, proofComplete: true }; }
      await page.waitForTimeout(1000);
    }
    result.browser = { ...(snapshot || {}), selectedRelay: false };
    throw new Error('timed out waiting for current connected relay media snapshot');
  } catch (error) { return buildFailedProofResult(result, error); }
  finally { if (browser) await browser.close().catch(() => {}); }
}
async function main(options) { return runProof(options); }

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runId = createProofRunId();
  let options = { durationSeconds: null, output: outputFromArgv(process.argv.slice(2)), runId };
  let result;
  let isolatedOutput = null;
  let outputState = 'none';
  try {
    options = parseProofArgs(process.argv.slice(2));
    options.runId = runId;
    if (options.help) printUsage();
    else {
      const secured = secureOutputTarget(options.output, { runId });
      outputState = secured.state;
      isolatedOutput = secured.backup;
      if (secured.state === 'overwritten' || secured.state === 'untrusted') result = secured.result;
      else {
        outputState = 'proof';
        // Proof work starts only after the requested result path is isolated.
        // An output-isolation failure above never reaches this call.
      result = await main(options);
      }
    }
  } catch (error) {
    const secured = secureOutputTarget(options.output, { runId });
    outputState = secured.state;
    isolatedOutput = secured.backup;
    if (secured.state === 'overwritten' || secured.state === 'untrusted') {
      result = secured.result;
    } else {
      result = buildFailedProofResult({ durationSeconds: options.durationSeconds, runId }, error);
    }
  }
  if (result) {
    let outputWritten = true;
    if (outputState === 'untrusted') {
      console.error(outputUntrustedMarker(runId, options.output));
      outputWritten = false;
      process.exitCode = 1;
    } else if (outputState === 'overwritten') {
      console.error(`OUTPUT_ISOLATION_FAILED runId=${runId} path=${options.output}; failure record written in place`);
    } else {
      try {
        writeResultAtomically(result, options.output);
        cleanupIsolatedOutput(isolatedOutput);
        isolatedOutput = null;
      } catch (error) { console.error(`proof result write failed runId=${runId}: ${error instanceof Error ? error.message : error}`); outputWritten = false; process.exitCode = 1; }
    }
    if (outputWritten) {
      console.log(JSON.stringify(result, null, 2));
      if (result.ok) console.log(`PROOF_RELAY_MEDIA_OK runId=${runId}`); else process.exitCode = 1;
    } else {
      console.log(`PROOF_OUTPUT_UNTRUSTED runId=${runId}`);
    }
  }
}
