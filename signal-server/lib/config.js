const REQUIRED_MIN_SECRET_LEN = 8;
const { parseTerminalConfig } = require('./terminal/config');
const {
  mergeTurnConfig,
  resolveTurnServer,
  toPublicTurnServer,
} = require('./turn-config');

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function ensureSecret(name, value, minLength = 1) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`[config] Missing required env: ${name}`);
  }
  if (normalized.includes('replace-')) {
    throw new Error(`[config] ${name} is still using example placeholder`);
  }
  if (normalized.length < minLength) {
    throw new Error(`[config] ${name} must be at least ${minLength} chars`);
  }
  return normalized;
}

function loadConfig() {
  const jwtSecret = ensureSecret('JWT_SECRET', process.env.JWT_SECRET, REQUIRED_MIN_SECRET_LEN);
  const viewerAccessPassword = ensureSecret(
    'VIEWER_ACCESS_PASSWORD or ACCESS_PASSWORD',
    firstDefined(process.env.VIEWER_ACCESS_PASSWORD, process.env.ACCESS_PASSWORD),
    8,
  );
  const hostSharedSecret = ensureSecret(
    'HOST_SHARED_SECRET or HOST_PASSWORD or ACCESS_PASSWORD',
    firstDefined(process.env.HOST_SHARED_SECRET, process.env.HOST_PASSWORD, process.env.ACCESS_PASSWORD),
    8,
  );
  const terminal = parseTerminalConfig(process.env);
  const turn = mergeTurnConfig({ env: process.env });
  const turnCatalog = turn.catalog || {
    servers: [],
    defaultId: turn.selectedTurnServerId || '',
    source: turn.source,
    jsonPath: turn.jsonPath,
    jsonLoaded: turn.jsonLoaded,
    jsonError: turn.jsonError,
  };

  return {
    port: Number(process.env.PORT || 8080),
    nodeEnv: process.env.NODE_ENV || 'production',
    jwtSecret,
    viewerAccessPassword,
    hostSharedSecret,
    corsOrigins: splitCsv(process.env.CORS_ORIGIN),
    stunUrls: splitCsv(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
    turnUrls: turn.urls,
    turnUsername: turn.username,
    turnCredential: turn.credential,
    turnSource: turn.source,
    turnFingerprint: turn.fingerprint,
    turnJsonPath: turn.jsonPath,
    turnCatalog,
    selectedTurnServerId: turn.selectedTurnServerId || turnCatalog.defaultId || '',
    defaultTurnServerId: turn.defaultTurnServerId || turnCatalog.defaultId || '',
    publicEntryUrl: String(process.env.WRD_PUBLIC_ENTRY_URL || 'https://link.stockhub.wiki').trim() || 'https://link.stockhub.wiki',
    enableDiagPersist: process.env.WRD_ENABLE_DIAG_PERSIST === '1',
    logLevel: String(process.env.WRD_LOG_LEVEL || 'info').trim() || 'info',
    logFormat: String(process.env.WRD_LOG_FORMAT || 'jsonl').trim() || 'jsonl',
    logDir: String(process.env.WRD_LOG_DIR || '').trim(),
    logMaxBytes: Math.max(1, Number(process.env.WRD_LOG_MAX_BYTES || 10 * 1024 * 1024)),
    logBackupCount: Math.max(0, Number(process.env.WRD_LOG_BACKUP_COUNT || 3)),
    hostVerboseDiagnostics: process.env.WRD_HOST_VERBOSE_DIAGNOSTICS === '1',
    enableTerminal: terminal.enabled,
    terminalAdminPassword: terminal.adminPassword,
    terminalShell: terminal.shell,
    terminalCwd: terminal.cwd,
    terminalPathEntries: terminal.pathEntries,
    terminalSoftWarnSessionCount: terminal.softWarnSessionCount,
    terminalMaxSessions: terminal.maxSessions,
    terminalReplayBufferBytes: terminal.replayBufferBytes,
    terminalIdleTimeoutMs: terminal.idleTimeoutMs,
    terminalStartupTimeoutMs: terminal.startupTimeoutMs,
    terminalInputRate: terminal.inputRate,
    terminalInputBytesPerSecond: terminal.inputRate.bytesPerSecond,
    terminalInputBurstBytes: terminal.inputRate.burstBytes,
    terminalMaxObserverQueueBytes: terminal.maxObserverQueueBytes,
    terminalMaxInFlightChunks: terminal.maxInFlightChunks,
    terminalMaxInFlightBytes: terminal.maxInFlightBytes,
    terminalAllowPolling: terminal.allowPolling,
    terminalAuditLog: terminal.auditLog,
    terminalRecordIoMetadata: terminal.recordIoMetadata,
    terminalRecordIo: terminal.recordIoMetadata,
  };
}

function resolveTurnSelection(configLike = {}, turnServerId = '') {
  const catalog = configLike.turnCatalog && typeof configLike.turnCatalog === 'object'
    ? configLike.turnCatalog
    : null;
  if (catalog && Array.isArray(catalog.servers) && catalog.servers.length) {
    const selected = resolveTurnServer(catalog, turnServerId || configLike.selectedTurnServerId || catalog.defaultId);
    if (selected) {
      return {
        id: selected.id || '',
        urls: Array.isArray(selected.urls) ? selected.urls.slice() : [],
        username: String(selected.username || '').trim(),
        credential: String(selected.credential || '').trim(),
        fingerprint: String(selected.fingerprint || '').trim(),
        source: String(selected.source || configLike.turnSource || catalog.source || 'none'),
        realm: String(selected.realm || ''),
        label: String(selected.label || selected.remark || selected.host || selected.id || ''),
      };
    }
  }

  return {
    id: String(configLike.selectedTurnServerId || configLike.defaultTurnServerId || '').trim(),
    urls: Array.isArray(configLike.turnUrls) ? configLike.turnUrls.slice() : [],
    username: String(configLike.turnUsername || '').trim(),
    credential: String(configLike.turnCredential || '').trim(),
    fingerprint: String(configLike.turnFingerprint || '').trim(),
    source: String(configLike.turnSource || 'none').trim() || 'none',
    realm: '',
    label: '',
  };
}

function getTurnStatus(configLike = {}, options = {}) {
  const turnServerId = options && typeof options === 'object'
    ? String(options.turnServerId || '').trim()
    : '';
  const selected = resolveTurnSelection(configLike, turnServerId);
  const turnUrls = selected.urls;
  const turnUsername = selected.username;
  const turnCredential = selected.credential;
  const turnSource = String(selected.source || configLike.turnSource || (turnUrls.length ? 'env' : 'none')).trim() || 'none';
  const turnFingerprint = String(selected.fingerprint || '').trim();
  const selectedTurnServerId = String(selected.id || '').trim();
  const defaultTurnServerId = String(
    configLike.defaultTurnServerId
    || configLike.turnCatalog?.defaultId
    || '',
  ).trim();

  if (!turnUrls.length) {
    return {
      turnConfigured: false,
      turnMisconfigured: false,
      turnStatus: 'missing',
      turnSource: turnSource === 'none' ? 'none' : turnSource,
      turnFingerprint: '',
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      selectedTurnServerId,
      defaultTurnServerId,
    };
  }

  if (!turnUsername || !turnCredential) {
    return {
      turnConfigured: false,
      turnMisconfigured: true,
      turnStatus: 'misconfigured',
      turnSource,
      turnFingerprint,
      turnUrls,
      turnUsername,
      turnCredential,
      selectedTurnServerId,
      defaultTurnServerId,
    };
  }

  return {
    turnConfigured: true,
    turnMisconfigured: false,
    turnStatus: 'configured',
    turnSource,
    turnFingerprint,
    turnUrls,
    turnUsername,
    turnCredential,
    selectedTurnServerId,
    defaultTurnServerId,
  };
}

function listPublicTurnServers(configLike = {}, selectedId = '') {
  const servers = Array.isArray(configLike.turnCatalog?.servers)
    ? configLike.turnCatalog.servers
    : [];
  const defaultId = String(
    configLike.defaultTurnServerId
    || configLike.turnCatalog?.defaultId
    || '',
  ).trim();
  if (servers.length) {
    return servers.map((server) => toPublicTurnServer(server, {
      selectedId,
      defaultId,
    }));
  }

  // Legacy single-server config without catalog: synthesize one public entry.
  const fallback = resolveTurnSelection(configLike, selectedId);
  if (!fallback.urls.length && !fallback.username && !fallback.credential) {
    return [];
  }
  const configured = Boolean(fallback.urls.length && fallback.username && fallback.credential);
  const id = fallback.id || 'default';
  return [toPublicTurnServer({
    id,
    label: fallback.label || id,
    host: '',
    port: 0,
    transport: 'udp',
    realm: fallback.realm || '',
    priority: 0,
    preferred: false,
    configured,
    fingerprint: fallback.fingerprint || '',
    urls: fallback.urls,
    username: fallback.username,
    credential: fallback.credential,
  }, { selectedId: selectedId || id, defaultId: defaultId || id })];
}

function getPublicEntryConfig(configLike = {}) {
  const formalEntryUrl = String(configLike.publicEntryUrl || 'https://link.stockhub.wiki').trim()
    || 'https://link.stockhub.wiki';
  return {
    formalEntryUrl,
    formalEntryMode: 'fixed-domain',
    quickTunnelRecommended: false,
  };
}

function getMediaModeCapabilities(configLike = {}) {
  const turnState = getTurnStatus(configLike);
  return {
    directAvailable: true,
    turnConfigured: turnState.turnConfigured,
    tunnelAvailable: true,
    recommendedMode: 'auto',
    manualFallbackChain: turnState.turnConfigured
      ? ['auto', 'relay', 'tunnel']
      : ['auto', 'tunnel'],
  };
}

module.exports = {
  REQUIRED_MIN_SECRET_LEN,
  getMediaModeCapabilities,
  getPublicEntryConfig,
  getTurnStatus,
  listPublicTurnServers,
  resolveTurnSelection,
  splitCsv,
  loadConfig,
};
