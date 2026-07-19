const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultTurnJsonPath(env = process.env) {
  const configured = String(env.WRD_TURN_JSON || '').trim();
  if (configured) return configured;
  return path.join(os.homedir(), '.StockHub', 'turn.json');
}

function normalizeTransport(value) {
  const transport = String(value || 'udp').trim().toLowerCase();
  if (transport === 'tcp' || transport === 'udp') return transport;
  return 'udp';
}

function buildTurnUrl({ host, port, transport }) {
  const safeHost = String(host || '').trim();
  const safePort = Number(port);
  if (!safeHost || !Number.isFinite(safePort) || safePort <= 0 || safePort > 65535) {
    return '';
  }
  return `turn:${safeHost}:${safePort}?transport=${normalizeTransport(transport)}`;
}

/**
 * Normalize TURN/TURNS URLs so env (`turn:host:3478`) and json
 * (`turn:host:3478?transport=udp`) share one fingerprint.
 */
function normalizeTurnUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(turns?):([^?]+)(?:\?(.*))?$/i);
  if (!match) return raw;
  const scheme = match[1].toLowerCase();
  const hostPort = match[2].trim();
  const query = String(match[3] || '');
  const params = new URLSearchParams(query);
  let transport = params.get('transport');
  if (!transport) {
    transport = 'udp';
  } else {
    transport = normalizeTransport(transport);
  }
  // Keep only transport for fingerprint stability; ignore unrelated query noise.
  return `${scheme}:${hostPort}?transport=${transport}`;
}

function normalizeTurnUrls(urls) {
  const list = Array.isArray(urls) ? urls : splitCsv(urls);
  const normalized = [];
  for (const item of list) {
    const value = normalizeTurnUrl(item);
    if (value && !normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function loadTurnFromJsonFile(filePath) {
  const resolved = String(filePath || '').trim();
  if (!resolved) {
    return {
      urls: [],
      username: '',
      credential: '',
      realm: '',
      sourcePath: '',
      loaded: false,
      error: 'missing-path',
    };
  }

  if (!fs.existsSync(resolved)) {
    return {
      urls: [],
      username: '',
      credential: '',
      realm: '',
      sourcePath: resolved,
      loaded: false,
      error: 'not-found',
    };
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    const turnServer = parsed && typeof parsed === 'object'
      ? (parsed.turnServer || parsed)
      : {};
    const urls = [];
    const built = buildTurnUrl({
      host: turnServer.host,
      port: turnServer.port,
      transport: turnServer.transport,
    });
    if (built) urls.push(built);
    for (const extra of splitCsv(turnServer.urls || turnServer.TURN_URLS || '')) {
      if (!urls.includes(extra)) urls.push(extra);
    }

    return {
      urls,
      username: String(turnServer.username || turnServer.user || '').trim(),
      credential: String(turnServer.password || turnServer.credential || '').trim(),
      realm: String(turnServer.realm || '').trim(),
      sourcePath: resolved,
      loaded: true,
      error: '',
    };
  } catch (error) {
    return {
      urls: [],
      username: '',
      credential: '',
      realm: '',
      sourcePath: resolved,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getTurnFingerprint({ urls = [], username = '' } = {}) {
  const normalizedUrls = normalizeTurnUrls(urls).slice().sort();
  if (!normalizedUrls.length) return '';
  const material = `${normalizedUrls.join(',')}|${String(username || '').trim()}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

function mergeTurnConfig({ env = process.env, jsonPath } = {}) {
  const resolvedPath = jsonPath == null ? defaultTurnJsonPath(env) : String(jsonPath || '').trim();
  const json = resolvedPath
    ? loadTurnFromJsonFile(resolvedPath)
    : {
      urls: [],
      username: '',
      credential: '',
      realm: '',
      sourcePath: '',
      loaded: false,
      error: 'missing-path',
    };

  const envUrls = normalizeTurnUrls(env.TURN_URLS);
  const envUsername = String(env.TURN_USERNAME || '').trim();
  const envCredential = String(env.TURN_CREDENTIAL || '').trim();
  const envHasUrls = envUrls.length > 0;
  const envHasCreds = Boolean(envUsername || envCredential);
  const envProvided = envHasUrls || envHasCreds;
  const jsonUrls = normalizeTurnUrls(json.urls || []);

  // Env fields override json field-by-field; empty env falls back to json.
  const urls = envHasUrls ? envUrls : jsonUrls;
  const username = envUsername || json.username || '';
  const credential = envCredential || json.credential || '';
  const usedJsonField = Boolean(
    json.loaded && (
      (!envHasUrls && jsonUrls.length)
      || (!envUsername && json.username)
      || (!envCredential && json.credential)
    ),
  );

  let source = 'none';
  if (urls.length || username || credential) {
    if (envProvided && usedJsonField) source = 'mixed';
    else if (envProvided) source = 'env';
    else if (json.loaded && (jsonUrls.length || json.username || json.credential)) source = 'json';
  }

  const fingerprint = getTurnFingerprint({ urls, username });

  return {
    urls,
    username,
    credential,
    realm: json.realm || '',
    source,
    fingerprint,
    jsonPath: json.sourcePath || resolvedPath || '',
    jsonLoaded: Boolean(json.loaded),
    jsonError: json.error || '',
  };
}

function describeTurnConfig(turn = {}) {
  return {
    turnSource: turn.source || 'none',
    turnFingerprint: turn.fingerprint || '',
    turnUrls: Array.isArray(turn.urls) ? turn.urls : [],
    turnConfigured: Boolean(turn.urls?.length && turn.username && turn.credential),
    turnMisconfigured: Boolean(turn.urls?.length && !(turn.username && turn.credential)),
  };
}

module.exports = {
  buildTurnUrl,
  defaultTurnJsonPath,
  describeTurnConfig,
  getTurnFingerprint,
  loadTurnFromJsonFile,
  mergeTurnConfig,
  normalizeTransport,
  normalizeTurnUrl,
  normalizeTurnUrls,
  splitCsv,
};
