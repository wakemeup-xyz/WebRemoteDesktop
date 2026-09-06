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
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('lab origin must be loopback http');
  }
  if (Number(url.port) === 8080) throw new Error('lab origin must never use production port 8080');
  return origin;
}

function labConfig(credentials) {
  return {
    port: 0,
    nodeEnv: 'test',
    jwtSecret: credentials.jwtSecret,
    viewerAccessPassword: credentials.viewerPassword,
    hostSharedSecret: credentials.hostSecret,
    corsOrigins: [],
    stunUrls: [], turnUrls: [], turnUsername: '', turnCredential: '', turnSource: 'lab', turnFingerprint: '',
    turnCatalog: { servers: [], defaultId: '', source: 'lab' }, selectedTurnServerId: '', defaultTurnServerId: '',
    publicEntryUrl: '', enableDiagPersist: false, logLevel: 'error', logFormat: 'jsonl', logDir: '', logMaxBytes: 1024 * 1024, logBackupCount: 0,
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
  const runtime = createServerApp({
    config: labConfig(credentials),
    signalingRuntimeContext: createRuntimeContext({ maxProofAdmissions: 1, realm, requireProofRealm: true }),
    allowSourceFallback: options.allowSourceFallback === true,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(0, '127.0.0.1', resolve);
  });
  const address = runtime.server.address();
  const origin = assertLabOrigin(`http://127.0.0.1:${address.port}`);
  return {
    runtime, origin, credentials, realm,
    async close() {
      await runtime.close('lab:close');
      await new Promise((resolve) => runtime.io.close(() => runtime.server.close(() => resolve())));
    },
  };
}

async function main() {
  const realmIndex = process.argv.indexOf('--realm');
  const realm = realmIndex >= 0 ? process.argv[realmIndex + 1] : '';
  const lab = await createLabRuntime({ allowSourceFallback: true, realm });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ origin: lab.origin, realm: lab.realm, hostSecret: lab.credentials.hostSecret, viewerPassword: lab.credentials.viewerPassword })}\n`);
  const close = async () => { await lab.close(); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exit(1); });

module.exports = { assertLabOrigin, createLabRuntime };
