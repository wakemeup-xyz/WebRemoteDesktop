const REQUIRED_MIN_SECRET_LEN = 8;

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

  return {
    port: Number(process.env.PORT || 8080),
    nodeEnv: process.env.NODE_ENV || 'production',
    jwtSecret,
    viewerAccessPassword,
    hostSharedSecret,
    corsOrigins: splitCsv(process.env.CORS_ORIGIN),
    stunUrls: splitCsv(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
    turnUrls: splitCsv(process.env.TURN_URLS),
    turnUsername: String(process.env.TURN_USERNAME || ''),
    turnCredential: String(process.env.TURN_CREDENTIAL || ''),
    publicEntryUrl: String(process.env.WRD_PUBLIC_ENTRY_URL || 'https://link.stockhub.wiki').trim() || 'https://link.stockhub.wiki',
    enableDiagPersist: process.env.WRD_ENABLE_DIAG_PERSIST === '1',
    logLevel: String(process.env.WRD_LOG_LEVEL || 'info').trim() || 'info',
    logFormat: String(process.env.WRD_LOG_FORMAT || 'jsonl').trim() || 'jsonl',
    logDir: String(process.env.WRD_LOG_DIR || '').trim(),
    enableTerminal: process.env.WRD_ENABLE_TERMINAL === '1',
    terminalAdminPassword: String(process.env.WRD_TERMINAL_ADMIN_PASSWORD || '').trim(),
    terminalShell: String(process.env.WRD_TERMINAL_SHELL || '/bin/zsh').trim() || '/bin/zsh',
    terminalCwd: String(process.env.WRD_TERMINAL_CWD || '').trim(),
    terminalSoftWarnSessionCount: Number(process.env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT || 4),
    terminalIdleTimeoutMs: Number(process.env.WRD_TERMINAL_IDLE_TIMEOUT_MS || 0),
    terminalStartupTimeoutMs: Number(process.env.WRD_TERMINAL_STARTUP_TIMEOUT_MS || 10000),
    terminalAuditLog: String(process.env.WRD_TERMINAL_AUDIT_LOG || '').trim(),
    terminalRecordIo: process.env.WRD_TERMINAL_RECORD_IO === '1',
  };
}

function getTurnStatus(configLike = {}) {
  const turnUrls = Array.isArray(configLike.turnUrls) ? configLike.turnUrls : [];
  const turnUsername = String(configLike.turnUsername || '').trim();
  const turnCredential = String(configLike.turnCredential || '').trim();

  if (!turnUrls.length) {
    return {
      turnConfigured: false,
      turnMisconfigured: false,
      turnStatus: 'missing',
    };
  }

  if (!turnUsername || !turnCredential) {
    return {
      turnConfigured: false,
      turnMisconfigured: true,
      turnStatus: 'misconfigured',
    };
  }

  return {
    turnConfigured: true,
    turnMisconfigured: false,
    turnStatus: 'configured',
  };
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
  splitCsv,
  loadConfig,
};
