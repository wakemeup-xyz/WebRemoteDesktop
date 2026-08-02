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

function sanitizeTurnId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/[^a-zA-Z0-9._一-鿿-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return '';
  return cleaned.slice(0, 64);
}

function slugFromRemark(remark) {
  const text = String(remark || '').trim();
  if (!text) return '';
  if (/阿里云|aliyun/i.test(text)) return 'aliyun';
  if (/海外|overseas|abroad|intl/i.test(text)) return 'overseas';
  return sanitizeTurnId(text.toLowerCase().replace(/\s+/g, '-'));
}

function slugFromRealm(realm) {
  const text = String(realm || '').trim().toLowerCase();
  if (!text) return '';
  const hostLabel = text.split('.')[0] || '';
  return sanitizeTurnId(hostLabel);
}

function slugFromHost(host) {
  const text = String(host || '').trim().toLowerCase();
  if (!text) return '';
  return sanitizeTurnId(text.replace(/\./g, '-'));
}

function isPreferredAliyun(server = {}) {
  const region = String(server.region || '').trim().toLowerCase();
  if (['cn', 'aliyun', 'china'].includes(region)) return true;
  const blob = [server.id, server.remark, server.label, server.realm, server.host]
    .map((item) => String(item || ''))
    .join(' ');
  return /阿里云|aliyun|ali\.yun/i.test(blob);
}

function entryConfigured(entry) {
  return Boolean(
    Array.isArray(entry?.urls)
    && entry.urls.length
    && entry.username
    && entry.credential,
  );
}

function normalizeEntry(raw = {}, index = 0) {
  const host = String(raw.host || '').trim();
  const port = Number(raw.port) > 0 ? Number(raw.port) : 3478;
  const transport = normalizeTransport(raw.transport);
  const urls = [];
  const built = buildTurnUrl({ host, port, transport });
  if (built) urls.push(built);
  for (const extra of splitCsv(raw.urls || raw.TURN_URLS || '')) {
    const normalized = normalizeTurnUrl(extra);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  const username = String(raw.username || raw.user || '').trim();
  const credential = String(raw.password || raw.credential || '').trim();
  const remark = String(raw.remark || raw.label || '').trim();
  const realm = String(raw.realm || '').trim();
  const region = String(raw.region || '').trim();
  let priority = Number(raw.priority);
  if (!Number.isFinite(priority)) priority = 0;
  const explicitId = sanitizeTurnId(raw.id);
  const entry = {
    id: explicitId,
    host,
    port,
    transport,
    urls: normalizeTurnUrls(urls),
    username,
    credential,
    realm,
    remark,
    label: remark || host || explicitId || `turn-${index + 1}`,
    region,
    priority,
    source: raw.source || 'json',
  };
  entry.configured = entryConfigured(entry);
  entry.fingerprint = entry.urls.length
    ? getTurnFingerprint({ urls: entry.urls, username: entry.username })
    : '';
  entry.preferred = isPreferredAliyun(entry);
  return entry;
}

function assignStableTurnIds(entries = []) {
  const used = new Set();
  return entries.map((entry, index) => {
    const candidates = [
      entry.id,
      slugFromRemark(entry.remark),
      slugFromRealm(entry.realm),
      slugFromHost(entry.host),
      `turn-${index + 1}`,
    ].map((item) => sanitizeTurnId(item)).filter(Boolean);

    let base = candidates[0] || `turn-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      const next = `${base}-${suffix}`.slice(0, 64);
      id = next;
      suffix += 1;
    }
    used.add(id);
    const next = { ...entry, id };
    next.label = next.remark || next.host || id;
    next.preferred = isPreferredAliyun(next);
    return next;
  });
}

function dedupeKey(entry) {
  return [
    normalizeTurnUrls(entry.urls || []).slice().sort().join(','),
    String(entry.username || '').trim(),
  ].join('|');
}

function pickDefaultTurnServerId(servers = [], {
  env = {},
  defaultTurnServerId = '',
} = {}) {
  const configured = servers.filter((server) => server.configured);
  if (!configured.length) {
    return servers[0]?.id || '';
  }

  const envId = sanitizeTurnId(env.WRD_TURN_SERVER_ID || env.TURN_SERVER_ID || '');
  if (envId && configured.some((server) => server.id === envId)) {
    return envId;
  }

  const fileDefault = sanitizeTurnId(defaultTurnServerId);
  if (fileDefault && configured.some((server) => server.id === fileDefault)) {
    return fileDefault;
  }

  const aliyun = configured
    .filter((server) => isPreferredAliyun(server))
    .sort((a, b) => (b.priority - a.priority) || 0);
  if (aliyun.length) return aliyun[0].id;

  const byPriority = configured.slice().sort((a, b) => (b.priority - a.priority) || 0);
  return byPriority[0].id;
}

function toPublicTurnServer(server = {}, { selectedId = '', defaultId = '' } = {}) {
  const id = String(server.id || '').trim();
  return {
    id,
    label: String(server.label || server.remark || server.host || id),
    host: String(server.host || ''),
    port: Number(server.port) || 0,
    transport: normalizeTransport(server.transport),
    realm: String(server.realm || ''),
    priority: Number.isFinite(Number(server.priority)) ? Number(server.priority) : 0,
    preferred: Boolean(server.preferred || isPreferredAliyun(server)),
    configured: Boolean(server.configured),
    fingerprint: String(server.fingerprint || ''),
    selected: Boolean(id && id === selectedId),
    isDefault: Boolean(id && id === defaultId),
  };
}

function resolveTurnServer(catalog, turnServerId) {
  const servers = Array.isArray(catalog?.servers) ? catalog.servers : [];
  const requested = sanitizeTurnId(turnServerId);
  if (requested) {
    const hit = servers.find((server) => server.id === requested);
    if (hit) return hit;
  }
  const defaultId = String(catalog?.defaultId || '').trim();
  if (defaultId) {
    const fallback = servers.find((server) => server.id === defaultId);
    if (fallback) return fallback;
  }
  return servers.find((server) => server.configured) || servers[0] || null;
}

function readTurnJsonDocument(filePath) {
  const resolved = String(filePath || '').trim();
  if (!resolved) {
    return {
      entries: [],
      defaultTurnServerId: '',
      sourcePath: '',
      loaded: false,
      error: 'missing-path',
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      entries: [],
      defaultTurnServerId: '',
      sourcePath: resolved,
      loaded: false,
      error: 'not-found',
    };
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    const defaultTurnServerId = parsed && typeof parsed === 'object'
      ? String(parsed.defaultTurnServerId || '').trim()
      : '';
    const entries = [];

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.turnServers)) {
      parsed.turnServers.forEach((item, index) => {
        if (item && typeof item === 'object') {
          entries.push(normalizeEntry({ ...item, source: 'json' }, index));
        }
      });
    }

    if (parsed && typeof parsed === 'object' && parsed.turnServer && typeof parsed.turnServer === 'object') {
      const legacy = normalizeEntry({ ...parsed.turnServer, source: 'json' }, entries.length);
      if (!legacy.id) legacy.id = 'legacy';
      const key = dedupeKey(legacy);
      if (!entries.some((entry) => dedupeKey(entry) === key)) {
        entries.push(legacy);
      }
    }

    // Whole-file single object fallback (legacy shape without turnServer key).
    if (
      !entries.length
      && parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed.host || parsed.urls || parsed.TURN_URLS)
    ) {
      entries.push(normalizeEntry({ ...parsed, source: 'json' }, 0));
    }

    return {
      entries,
      defaultTurnServerId,
      sourcePath: resolved,
      loaded: true,
      error: '',
    };
  } catch (error) {
    return {
      entries: [],
      defaultTurnServerId: '',
      sourcePath: resolved,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadTurnFromJsonFile(filePath) {
  const doc = readTurnJsonDocument(filePath);
  if (!doc.loaded) {
    return {
      urls: [],
      username: '',
      credential: '',
      realm: '',
      sourcePath: doc.sourcePath || '',
      loaded: false,
      error: doc.error || 'not-loaded',
    };
  }

  const servers = assignStableTurnIds(doc.entries);
  const defaultId = pickDefaultTurnServerId(servers, {
    defaultTurnServerId: doc.defaultTurnServerId,
  });
  const selected = resolveTurnServer({ servers, defaultId }, defaultId) || servers[0] || null;
  return {
    urls: selected ? selected.urls.slice() : [],
    username: selected ? selected.username : '',
    credential: selected ? selected.credential : '',
    realm: selected ? selected.realm : '',
    sourcePath: doc.sourcePath,
    loaded: true,
    error: '',
    servers,
    defaultId,
    defaultTurnServerId: doc.defaultTurnServerId,
  };
}

function getTurnFingerprint({ urls = [], username = '' } = {}) {
  const normalizedUrls = normalizeTurnUrls(urls).slice().sort();
  if (!normalizedUrls.length) return '';
  const material = `${normalizedUrls.join(',')}|${String(username || '').trim()}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

function buildEnvServer(env = {}) {
  const urls = normalizeTurnUrls(env.TURN_URLS);
  const username = String(env.TURN_USERNAME || '').trim();
  const credential = String(env.TURN_CREDENTIAL || '').trim();
  if (!urls.length && !username && !credential) return null;
  return normalizeEntry({
    id: 'env',
    host: '',
    port: 3478,
    transport: 'udp',
    urls: urls.join(','),
    username,
    password: credential,
    remark: '环境变量',
    source: 'env',
    priority: 1000,
  }, 0);
}

function loadTurnCatalog({ env = process.env, jsonPath } = {}) {
  const resolvedPath = jsonPath == null ? defaultTurnJsonPath(env) : String(jsonPath || '').trim();
  const doc = resolvedPath
    ? readTurnJsonDocument(resolvedPath)
    : {
      entries: [],
      defaultTurnServerId: '',
      sourcePath: '',
      loaded: false,
      error: 'missing-path',
    };

  let servers = assignStableTurnIds(doc.entries.map((entry) => ({ ...entry })));
  const envUrls = normalizeTurnUrls(env.TURN_URLS);
  const envUsername = String(env.TURN_USERNAME || '').trim();
  const envCredential = String(env.TURN_CREDENTIAL || '').trim();
  const envHasUrls = envUrls.length > 0;
  const envHasCreds = Boolean(envUsername || envCredential);
  const envComplete = envHasUrls && envUsername && envCredential;
  const envProvided = envHasUrls || envHasCreds;

  // Full env TURN_* injects/overrides synthetic `env` server and becomes default.
  if (envComplete || (envProvided && !servers.length)) {
    const envServer = buildEnvServer(env);
    if (envServer) {
      // Ensure id stays `env`.
      envServer.id = 'env';
      envServer.label = '环境变量';
      envServer.preferred = false;
      envServer.configured = entryConfigured(envServer);
      envServer.fingerprint = envServer.urls.length
        ? getTurnFingerprint({ urls: envServer.urls, username: envServer.username })
        : '';
      const withoutEnv = servers.filter((server) => server.id !== 'env');
      servers = [envServer, ...withoutEnv];
    }
  } else if (envProvided && servers.length) {
    // Field-level override on the eventual default node (mixed semantics).
    const provisionalDefault = pickDefaultTurnServerId(servers, {
      env,
      defaultTurnServerId: doc.defaultTurnServerId,
    });
    const target = servers.find((server) => server.id === provisionalDefault) || servers[0];
    if (target) {
      if (envHasUrls) target.urls = envUrls.slice();
      if (envUsername) target.username = envUsername;
      if (envCredential) target.credential = envCredential;
      target.configured = entryConfigured(target);
      target.fingerprint = target.urls.length
        ? getTurnFingerprint({ urls: target.urls, username: target.username })
        : '';
      if (envHasUrls && (envUsername || envCredential) && !(target.source === 'json' && !envHasUrls)) {
        // source refined below on flat merge
      }
      if (envHasUrls || envUsername || envCredential) {
        target.source = target.source === 'json' ? 'mixed' : (target.source || 'env');
      }
    }
  }

  servers = assignStableTurnIds(servers).map((server) => {
    const next = { ...server };
    next.configured = entryConfigured(next);
    next.fingerprint = next.urls.length
      ? getTurnFingerprint({ urls: next.urls, username: next.username })
      : '';
    next.preferred = isPreferredAliyun(next);
    next.label = next.remark || next.host || next.id;
    return next;
  });

  // Re-assert env id if present (assignStableTurnIds may keep it).
  const envIdx = servers.findIndex((server) => server.remark === '环境变量' && server.source === 'env');
  if (envIdx >= 0 && envComplete) {
    servers[envIdx] = { ...servers[envIdx], id: 'env', label: '环境变量', preferred: false };
  }

  let defaultId = pickDefaultTurnServerId(servers, {
    env,
    defaultTurnServerId: doc.defaultTurnServerId,
  });
  if (envComplete) {
    defaultId = 'env';
    const envServer = servers.find((server) => server.id === 'env');
    if (envServer && envServer.fingerprint) {
      const twin = servers.find((server) => (
        server.id !== 'env'
        && server.configured
        && server.fingerprint === envServer.fingerprint
      ));
      if (twin && twin.id) defaultId = twin.id;
    }
  }

  let source = 'none';
  if (servers.some((server) => server.urls.length || server.username || server.credential)) {
    if (envComplete) source = 'env';
    else if (envProvided && doc.loaded && doc.entries.length) source = 'mixed';
    else if (envProvided && !doc.entries.length) source = 'env';
    else if (doc.loaded && doc.entries.length) source = 'json';
    else if (envProvided) source = 'env';
  }

  return {
    servers,
    defaultId,
    source,
    jsonPath: doc.sourcePath || resolvedPath || '',
    jsonLoaded: Boolean(doc.loaded),
    jsonError: doc.error || '',
    fileDefaultTurnServerId: doc.defaultTurnServerId || '',
  };
}

function mergeTurnConfig({ env = process.env, jsonPath } = {}) {
  const catalog = loadTurnCatalog({ env, jsonPath });
  const selected = resolveTurnServer(catalog, catalog.defaultId);
  const envUrls = normalizeTurnUrls(env.TURN_URLS);
  const envUsername = String(env.TURN_USERNAME || '').trim();
  const envCredential = String(env.TURN_CREDENTIAL || '').trim();
  const envHasUrls = envUrls.length > 0;
  const envHasCreds = Boolean(envUsername || envCredential);
  const envProvided = envHasUrls || envHasCreds;
  const usedJsonField = Boolean(
    catalog.jsonLoaded
    && selected
    && selected.source !== 'env'
    && (
      (!envHasUrls && selected.urls?.length)
      || (!envUsername && selected.username)
      || (!envCredential && selected.credential)
    ),
  );

  let source = 'none';
  const urls = selected ? selected.urls.slice() : [];
  const username = selected ? selected.username : '';
  const credential = selected ? selected.credential : '';
  if (urls.length || username || credential) {
    if (selected?.id === 'env' || (envProvided && !usedJsonField && envHasUrls)) source = 'env';
    else if (envProvided && usedJsonField) source = 'mixed';
    else if (envProvided && !catalog.jsonLoaded) source = 'env';
    else if (catalog.jsonLoaded) source = catalog.source === 'mixed' ? 'mixed' : 'json';
    else source = catalog.source || 'env';
  }

  // Preserve historical mixed detection for partial env overrides.
  if (source === 'json' && envProvided && usedJsonField) source = 'mixed';
  if (selected?.source === 'mixed') source = 'mixed';

  const fingerprint = getTurnFingerprint({ urls, username });

  return {
    urls,
    username,
    credential,
    realm: selected ? selected.realm : '',
    source,
    fingerprint,
    jsonPath: catalog.jsonPath || '',
    jsonLoaded: Boolean(catalog.jsonLoaded),
    jsonError: catalog.jsonError || '',
    catalog,
    selectedTurnServerId: selected ? selected.id : '',
    defaultTurnServerId: catalog.defaultId || '',
  };
}

function describeTurnConfig(turn = {}) {
  return {
    turnSource: turn.source || 'none',
    turnFingerprint: turn.fingerprint || '',
    turnUrls: Array.isArray(turn.urls) ? turn.urls : [],
    turnConfigured: Boolean(turn.urls?.length && turn.username && turn.credential),
    turnMisconfigured: Boolean(turn.urls?.length && !(turn.username && turn.credential)),
    selectedTurnServerId: turn.selectedTurnServerId || turn.defaultTurnServerId || '',
    defaultTurnServerId: turn.defaultTurnServerId || '',
  };
}

module.exports = {
  assignStableTurnIds,
  buildTurnUrl,
  defaultTurnJsonPath,
  describeTurnConfig,
  getTurnFingerprint,
  isPreferredAliyun,
  loadTurnCatalog,
  loadTurnFromJsonFile,
  mergeTurnConfig,
  normalizeTransport,
  normalizeTurnUrl,
  normalizeTurnUrls,
  pickDefaultTurnServerId,
  resolveTurnServer,
  splitCsv,
  toPublicTurnServer,
};
