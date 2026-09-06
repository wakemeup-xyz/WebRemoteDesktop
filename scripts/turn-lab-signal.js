'use strict';

/* A disposable Signal server for the local lab. It never calls startServer(). */

const crypto = require('node:crypto');
const { createServerApp } = require('../signal-server/server');
const { createRuntimeContext } = require('../signal-server/websocket/runtime-context');

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function assertLabOrigin(origin) {
  const url = new URL(origin);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  const port = Number(url.port);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(host)
    || !url.port || !Number.isInteger(port) || port < 1 || port > 65535
    || [8080, 5173].includes(port) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('lab origin must be a bare non-production loopback URL');
  }
  const canonical = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  if (origin !== canonical) throw new Error('lab origin must be canonical');
  return canonical;
}

function labConfig(credentials, runtimeDir = '') {
  return {
    port: 0,
    nodeEnv: 'test',
    jwtSecret: credentials.jwtSecret,
    viewerAccessPassword: credentials.viewerPassword,
    hostSharedSecret: credentials.hostSecret,
    corsOrigins: [],
    stunUrls: [], turnUrls: [], turnUsername: '', turnCredential: '', turnSource: 'lab', turnFingerprint: '',
    turnCatalog: { servers: [], defaultId: '', source: 'lab' }, selectedTurnServerId: '', defaultTurnServerId: '',
    publicEntryUrl: '', enableDiagPersist: false, logLevel: 'error', logFormat: 'jsonl', logDir: runtimeDir, logMaxBytes: 1024 * 1024, logBackupCount: 0,
    hostVerboseDiagnostics: false, enableTerminal: false, terminalAdminPassword: '', terminalShell: '', terminalCwd: '', terminalPathEntries: [],
    terminalSoftWarnSessionCount: 1, terminalMaxSessions: 1, terminalReplayBufferBytes: 1024, terminalIdleTimeoutMs: 1000,
    terminalStartupTimeoutMs: 1000, terminalPtyKillWaitMs: 1000, terminalInputRate: { bytesPerSecond: 1, burstBytes: 1 },
    terminalInputBytesPerSecond: 1, terminalInputBurstBytes: 1, terminalMaxObserverQueueBytes: 1024, terminalMaxInFlightChunks: 1,
    terminalMaxInFlightBytes: 1024, terminalAllowPolling: false, terminalAuditLog: '', terminalRecordIoMetadata: false, terminalRecordIo: false,
  };
}

async function createLabRuntime(options = {}) {
  const credentials = { jwtSecret: randomSecret(), viewerPassword: randomSecret(), hostSecret: randomSecret() };
  const realm = options.realm || `lab-${crypto.randomUUID()}`;
  const contextSecret = randomSecret();
  const issuedContexts = new Map();
  const runtime = createServerApp({
    config: labConfig(credentials, options.runtimeDir || ''),
    signalingRuntimeContext: createRuntimeContext({
      maxProofAdmissions: options.maxProofAdmissions ?? 1,
      realm,
    }),
    allowSourceFallback: options.allowSourceFallback === true,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(0, '127.0.0.1', resolve);
  });
  const address = runtime.server.address();
  const origin = assertLabOrigin(`http://127.0.0.1:${address.port}`);
  function checkContextSecret(req, res) {
    if (req.get('x-wrd-lab-context-secret') !== contextSecret) { res.status(403).json({ error: 'lab context denied' }); return false; }
    return true;
  }
  runtime.app.post('/api/lab-context/issue', (req, res) => {
    if (!checkContextSecret(req, res)) return;
    const body = req.body || {};
    const allowed = new Set(['origin', 'realm', 'proofToken', 'epoch', 'mode', 'runId', 'policyId']);
    if (Object.keys(body).length !== allowed.size || Object.keys(body).some((key) => !allowed.has(key))
      || body.origin !== origin || body.realm !== realm || body.mode !== 'legacy'
      || !body.runId || !body.policyId || !body.proofToken || !Number.isInteger(body.epoch) || body.epoch < 0
      || !runtime.signalingRuntime.hasProofAdmission({ token: body.proofToken, epoch: body.epoch, realm: body.realm })) {
      return res.status(400).json({ error: 'invalid lab context binding' });
    }
    const credential = crypto.randomUUID();
    issuedContexts.set(credential, { ...body, credential });
    return res.status(201).json({ context: { credential } });
  });
  runtime.app.post('/api/lab-context/consume', (req, res) => {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return res.status(403).json({ error: 'lab context denied' });
    const credential = String(req.body?.credential || '');
    const context = issuedContexts.get(credential);
    issuedContexts.delete(credential);
    if (!context) return res.status(409).json({ error: 'lab context absent or consumed' });
    return res.status(200).json({ context });
  });
  return {
    runtime, origin, credentials, realm, contextSecret,
    async close() {
      await runtime.close('lab:close');
      await new Promise((resolve) => runtime.io.close(() => runtime.server.close(() => resolve())));
    },
  };
}

async function main() {
  const realmIndex = process.argv.indexOf('--realm');
  const realm = realmIndex >= 0 ? process.argv[realmIndex + 1] : '';
  const runtimeIndex = process.argv.indexOf('--runtime-dir');
  const runtimeDir = runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : '';
  const lab = await createLabRuntime({ allowSourceFallback: true, realm, runtimeDir });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ origin: lab.origin, realm: lab.realm, hostSecret: lab.credentials.hostSecret, viewerPassword: lab.credentials.viewerPassword, contextSecret: lab.contextSecret })}\n`);
  const close = async () => { await lab.close(); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exit(1); });

module.exports = { assertLabOrigin, createLabRuntime };
