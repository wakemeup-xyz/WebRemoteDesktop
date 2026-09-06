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
  const transcriptSecret = randomSecret();
  const issuedContexts = new Map();
  // A proof admission is intentionally consumed by the Viewer socket.  The
  // Host context therefore transitions into this server-owned session instead
  // of re-checking an admission that must no longer exist.
  const labSessions = new Map();
  const runtime = createServerApp({
    config: labConfig(credentials, options.runtimeDir || ''),
    signalingRuntimeContext: createRuntimeContext({
      maxProofAdmissions: options.maxProofAdmissions ?? 1,
      realm,
      requireViewerProof: true,
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
  function checkControlledBindingAuth(req, res, body) {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.status(403).json({ error: 'lab binding denied' }); return false;
    }
    const token = String(req.get('x-wrd-lab-proof-token') || '');
    const session = body && labSessions.get(`${body.realm}|${body.runId}`);
    if (req.get('x-wrd-lab-host-secret') !== credentials.hostSecret
      || !body || body.realm !== realm || !Number.isInteger(body.epoch) || body.epoch < 0
      || !token || !session || session.phase !== 'host-attached'
      || session.proofToken !== token || session.admissionEpoch !== body.epoch) {
      res.status(403).json({ error: 'lab binding denied' }); return false;
    }
    const viewers = [...runtime.signalingRuntime.connections.viewers.values()];
    if (viewers.length !== 1 || runtime.signalingRuntime.viewerEpoch() <= session.admissionEpoch) {
      res.status(403).json({ error: 'lab viewer session is not bound' }); return false;
    }
    const viewer = viewers[0];
    if (session.viewerSocketId && session.viewerSocketId !== viewer.id) {
      res.status(403).json({ error: 'lab viewer identity changed' }); return false;
    }
    session.viewerSocketId = viewer.id;
    session.viewerEpoch = runtime.signalingRuntime.viewerEpoch();
    return session;
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
    const admission = { token: context.proofToken, epoch: context.epoch, realm: context.realm };
    const admissionActive = runtime.signalingRuntime.hasProofAdmission(admission);
    const proofWasConsumedByViewer = !admissionActive
      && runtime.signalingRuntime.viewerEpoch() > context.epoch;
    if (!admissionActive && !proofWasConsumedByViewer) {
      return res.status(409).json({ error: 'lab context proof is neither active nor viewer-consumed' });
    }
    const sessionKey = `${context.realm}|${context.runId}`;
    if (labSessions.has(sessionKey)) return res.status(409).json({ error: 'lab session already attached' });
    labSessions.set(sessionKey, {
      realm: context.realm, runId: context.runId, proofToken: context.proofToken,
      admissionEpoch: context.epoch, phase: 'host-attached', viewerSocketId: null,
      viewerEpoch: null, bindings: new Map(),
    });
    return res.status(200).json({ context });
  });
  runtime.app.post('/api/lab-controlled-input/bind', (req, res) => {
    const body = req.body || {};
    const allowed = new Set(['realm', 'runId', 'epoch', 'inputId', 'leaseId', 'leaseEpoch', 'fixtureId', 'actionDigest']);
    const session = checkControlledBindingAuth(req, res, body);
    if (!session) return;
    if (Object.keys(body).length !== allowed.size || Object.keys(body).some((key) => !allowed.has(key))
      || ![body.inputId, body.leaseId, body.fixtureId].every((value) => typeof value === 'string' && value.length > 0)
      || !Number.isSafeInteger(body.leaseEpoch) || body.leaseEpoch < 0
      || typeof body.actionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.actionDigest)) {
      return res.status(400).json({ error: 'invalid controlled binding' });
    }
    const key = body.inputId;
    if (session.bindings.has(key)) return res.status(409).json({ error: 'controlled input already bound' });
    session.bindings.set(key, { ...body, proofToken: session.proofToken, viewerSocketId: session.viewerSocketId,
      viewerEpoch: session.viewerEpoch, expiresAt: Date.now() + 30_000 });
    return res.status(201).json({ binding: { inputId: body.inputId } });
  });
  runtime.app.post('/api/lab-controlled-input/claim', (req, res) => {
    const body = req.body || {};
    const allowed = new Set(['realm', 'runId', 'epoch', 'inputId', 'leaseId', 'leaseEpoch', 'actionDigest']);
    const session = checkControlledBindingAuth(req, res, body);
    if (!session) return;
    if (Object.keys(body).length !== allowed.size || Object.keys(body).some((key) => !allowed.has(key))
      || typeof body.inputId !== 'string' || !body.inputId || !Number.isSafeInteger(body.leaseEpoch)
      || typeof body.actionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.actionDigest)) return res.status(400).json({ error: 'invalid controlled claim' });
    const binding = session.bindings.get(body.inputId);
    session.bindings.delete(body.inputId);
    if (!binding || binding.expiresAt < Date.now() || binding.proofToken !== session.proofToken
      || binding.viewerSocketId !== session.viewerSocketId || binding.viewerEpoch !== session.viewerEpoch
      || binding.leaseId !== body.leaseId || binding.leaseEpoch !== body.leaseEpoch
      || binding.actionDigest !== body.actionDigest) return res.status(409).json({ error: 'controlled binding absent' });
    return res.status(200).json({ binding });
  });
  runtime.io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      for (const session of labSessions.values()) {
        if (session.viewerSocketId === socket.id) {
          session.bindings.clear();
          session.phase = 'viewer-disconnected';
        }
      }
    });
  });
  return {
    runtime, origin, credentials, realm, contextSecret, transcriptSecret,
    async close() {
      for (const session of labSessions.values()) session.bindings.clear();
      labSessions.clear();
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
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ origin: lab.origin, realm: lab.realm, hostSecret: lab.credentials.hostSecret, viewerPassword: lab.credentials.viewerPassword, contextSecret: lab.contextSecret, transcriptSecret: lab.transcriptSecret })}\n`);
  const close = async () => { await lab.close(); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exit(1); });

module.exports = { assertLabOrigin, createLabRuntime };
