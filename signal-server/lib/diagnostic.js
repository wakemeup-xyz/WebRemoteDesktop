const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

const DIAG_MAX_AGE_DAYS = 7;
const DIAG_MAX_PER_VIEWER = 3;
const DIAG_MAX_TOTAL = 50;

function redactDiagnosticPayload(payload) {
  const recentLogs = Array.isArray(payload.logs) ? payload.logs.slice(-120) : [];
  const network = payload.network && typeof payload.network === 'object'
    ? {
        ...payload.network,
        candidateSummary: payload.network.candidateSummary
          ? {
              local: payload.network.candidateSummary.local || {},
              remote: payload.network.candidateSummary.remote || {},
              samples: payload.network.candidateSummary.samples || { local: [], remote: [] },
            }
          : undefined,
      }
    : null;
  const inputState = payload.inputState
    ? {
        keyboardMode: payload.inputState.keyboardMode || null,
        isActive: payload.inputState.isActive == null ? null : Boolean(payload.inputState.isActive),
        hasLease: payload.inputState.hasLease == null ? null : Boolean(payload.inputState.hasLease),
        leaseEpoch: Number(payload.inputState.leaseEpoch || 0) || 0,
        gate: payload.inputState.gate && typeof payload.inputState.gate === 'object'
          ? {
              enabled: Boolean(payload.inputState.gate.enabled),
              hasActiveControl: Boolean(payload.inputState.gate.hasActiveControl),
              mediaState: payload.inputState.gate.mediaState || null,
              runtimePhase: payload.inputState.gate.runtimePhase || null,
              currentConnectionAttemptId: payload.inputState.gate.currentConnectionAttemptId || null,
              mediaReadyConnectionAttemptId: payload.inputState.gate.mediaReadyConnectionAttemptId || null,
              blockedReasons: Array.isArray(payload.inputState.gate.blockedReasons)
                ? payload.inputState.gate.blockedReasons.slice(0, 8).map(String)
                : [],
            }
          : null,
        pendingKeys: Array.isArray(payload.inputState.pendingKeys)
          ? payload.inputState.pendingKeys.length
          : payload.inputState.pendingKeys || 0,
        lastReleaseAllReason: payload.inputState.lastReleaseAllReason || null,
        lastKeyboardResetReason: payload.inputState.lastKeyboardResetReason
          || payload.inputState.keyboard?.lastResetReason
          || null,
        keyboard: payload.inputState.keyboard && typeof payload.inputState.keyboard === 'object'
          ? {
              leaseState: payload.inputState.keyboard.leaseState || null,
              epoch: Number(payload.inputState.keyboard.epoch || 0) || 0,
              lastSent: Number(payload.inputState.keyboard.lastSent || 0) || 0,
              lastApplied: Number(payload.inputState.keyboard.lastApplied || 0) || 0,
              pendingCount: Number(payload.inputState.keyboard.pendingCount || 0) || 0,
              pressedCount: Number(payload.inputState.keyboard.pressedCount || 0) || 0,
              adapter: payload.inputState.keyboard.adapter || null,
              lastResetReason: payload.inputState.keyboard.lastResetReason || null,
            }
          : null,
        recentInputEvents: Array.isArray(payload.inputState.recentInputEvents)
          ? payload.inputState.recentInputEvents.slice(-20)
          : [],
      }
    : null;

  return {
    ...payload,
    logs: recentLogs,
    network,
    keyboardDebug: [],
    inputState,
  };
}

function getDiagDir() {
  // Prefer a stable absolute path so operators/agents can find uploads without
  // chasing macOS per-user os.tmpdir() folders. Override with WRD_DIAG_DIR.
  const override = String(process.env.WRD_DIAG_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join('/tmp', 'wrd-diag');
}

function persistDiagnostic(filename, report) {
  const dir = getDiagDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(report, null, 2), 'utf8');
}

function cleanupDiagLogs(logger = console) {
  const dir = getDiagDir();
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        return { name, filePath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const now = Date.now();
    const maxAgeMs = DIAG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (now - file.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file.filePath);
      }
    }

    const remaining = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const viewerId = name.replace(/^.+_/, '').replace('.json', '');
        return { name, filePath, viewerId, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const viewerCounts = {};
    for (const file of remaining) {
      viewerCounts[file.viewerId] = (viewerCounts[file.viewerId] || 0) + 1;
      if (viewerCounts[file.viewerId] > DIAG_MAX_PER_VIEWER) {
        fs.unlinkSync(file.filePath);
        viewerCounts[file.viewerId] -= 1;
      }
    }

    const finalFiles = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    while (finalFiles.length > DIAG_MAX_TOTAL) {
      const oldest = finalFiles.shift();
      fs.unlinkSync(oldest.filePath);
    }
  } catch (error) {
    logger.error?.('[DIAGNOSTIC] cleanup failed:', error.message);
  }
}

function loadRecentDiagnostics(limit = 50, options = {}) {
  const dir = getDiagDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const logger = options.logger || console;

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const filePath = path.join(dir, name);
      try {
        return [{
          name,
          filePath,
          mtimeMs: fs.statSync(filePath).mtimeMs,
        }];
      } catch (error) {
        logger.warn?.(`[DIAGNOSTIC] Skip unreadable file ${name}: ${error.message}`);
        return [];
      }
    })
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return b.name.localeCompare(a.name);
    })
    .slice(0, Math.max(0, Number(limit) || 0))
    .flatMap((entry) => {
      try {
        return [JSON.parse(fs.readFileSync(entry.filePath, 'utf8'))];
      } catch (error) {
        logger.warn?.(`[DIAGNOSTIC] Skip malformed file ${entry.name}: ${error.message}`);
        return [];
      }
    });
}

function dedupeDiagnosticsByAttempt(items = []) {
  const deduped = [];
  const seenAttemptIds = new Set();

  items.forEach((item, index) => {
    const rawAttemptId = String(item?.connectionAttemptId || '').trim();
    const attemptKey = rawAttemptId || `missing-attempt-${index}`;
    if (seenAttemptIds.has(attemptKey)) {
      return;
    }
    seenAttemptIds.add(attemptKey);
    deduped.push(item);
  });

  return deduped;
}

function buildConnectionSummary(items = []) {
  const attempts = dedupeDiagnosticsByAttempt(items);
  const summary = {
    total: attempts.length,
    failures: {},
    nextSuggestions: {
      relay: 0,
      tunnel: 0,
    },
    modes: {},
    latestAttempt: attempts[0] || null,
  };

  attempts.forEach((item) => {
    const reason = String(item?.traceSummary?.reason || item?.reason || 'unknown');
    summary.failures[reason] = (summary.failures[reason] || 0) + 1;

    const nextSuggestedMode = String(item?.recommendation?.nextSuggestedMode || '').trim();
    if (nextSuggestedMode) {
      summary.nextSuggestions[nextSuggestedMode] = (summary.nextSuggestions[nextSuggestedMode] || 0) + 1;
    }

    const mode = String(item?.mode || 'unknown').trim() || 'unknown';
    summary.modes[mode] = (summary.modes[mode] || 0) + 1;
  });

  return summary;
}

function buildDiagnosticSummaryEvent(report, options = {}) {
  const persisted = Boolean(options.persisted);
  return {
    domain: 'viewer',
    event: 'diagnostic_uploaded',
    message: 'Viewer uploaded diagnostic bundle',
    correlation: {
      browserSessionId: report.browserSessionId || null,
      connectionAttemptId: report.connectionAttemptId || null,
      viewerId: report.viewerId || null,
      socketId: options.socketId || null,
    },
    meta: {
      trigger: report.trigger || 'manual',
      reason: report.reason || null,
      type: report.type || 'diagnostic',
      logCount: report.logCount || 0,
      persisted,
    },
  };
}

function ingestDiagnosticPayload(options = {}) {
  const {
    role,
    viewerId,
    userAgent,
    data,
    socketId = null,
    config = loadConfig(),
    logger = console,
  } = options;

  if (role !== 'viewer') {
    return { accepted: false, error: 'viewer-only' };
  }

  const redacted = redactDiagnosticPayload(data || {});
  const receivedAt = new Date().toISOString();
  const connectionAttemptId = String(redacted.connectionAttemptId || '').trim() || `attempt-${Date.now()}`;
  const logs = Array.isArray(redacted.logs) ? redacted.logs : [];
  const schemaVersion = Number.parseInt(redacted.schemaVersion, 10);
  const traceSummary = redacted.traceSummary && typeof redacted.traceSummary === 'object'
    ? { ...redacted.traceSummary }
    : {
        trigger: redacted.trigger || 'manual',
        reason: redacted.reason || null,
      };
  const trigger = typeof redacted.trigger === 'string' && redacted.trigger
    ? redacted.trigger
    : traceSummary.trigger || 'manual';
  const reason = typeof redacted.reason === 'string' || redacted.reason === null
    ? redacted.reason
    : (traceSummary.reason ?? null);
  const report = {
    type: String(redacted.type || 'diagnostic'),
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 1,
    receivedAt,
    viewerId,
    userAgent: redacted.userAgent || userAgent || 'unknown',
    screen: redacted.screen || 'unknown',
    browserSessionId: typeof redacted.browserSessionId === 'string' ? redacted.browserSessionId : null,
    connectionAttemptId,
    mode: typeof redacted.mode === 'string' ? redacted.mode : null,
    entrypoint: typeof redacted.entrypoint === 'string' ? redacted.entrypoint : null,
    logCount: logs.length,
    logs,
    keyboardDebug: Array.isArray(redacted.keyboardDebug) ? redacted.keyboardDebug : [],
    trigger,
    reason,
    traceSummary,
    recommendation: redacted.recommendation && typeof redacted.recommendation === 'object'
      ? { ...redacted.recommendation }
      : null,
    events: Array.isArray(redacted.events) ? redacted.events : [],
    network: redacted.network && typeof redacted.network === 'object' ? redacted.network : null,
    inputState: redacted.inputState || null,
    probeResults: Array.isArray(redacted.probeResults) ? redacted.probeResults : [],
    inputChannelTimeline: Array.isArray(redacted.inputChannelTimeline) ? redacted.inputChannelTimeline : [],
  };

  if (redacted.failureCategory != null) {
    report.failureCategory = redacted.failureCategory;
  }
  if (redacted.latency != null) {
    report.latency = redacted.latency;
  }
  if (redacted.mediaPolicy != null) {
    report.mediaPolicy = redacted.mediaPolicy;
  }
  if (redacted.selectedCandidatePair && typeof redacted.selectedCandidatePair === 'object') {
    report.selectedCandidatePair = redacted.selectedCandidatePair;
  }
  if (redacted.pc && typeof redacted.pc === 'object') {
    report.pc = redacted.pc;
  }
  if (redacted.ice && typeof redacted.ice === 'object') {
    report.ice = redacted.ice;
  }
  if (redacted.candidate != null) {
    report.candidate = redacted.candidate;
  }
  if (redacted.adaptiveMedia && typeof redacted.adaptiveMedia === 'object') {
    report.adaptiveMedia = redacted.adaptiveMedia;
  }
  if (redacted.redaction && typeof redacted.redaction === 'object') {
    report.redaction = redacted.redaction;
  }

  let persisted = false;
  if (config.enableDiagPersist) {
    try {
      cleanupDiagLogs(logger);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${ts}_${viewerId}.json`;
      persistDiagnostic(filename, report);
      persisted = true;
      logger.log?.(`[DIAGNOSTIC] Saved → ${path.join(getDiagDir(), filename)}`);
    } catch (error) {
      logger.error?.('[DIAGNOSTIC] Failed to write log file:', error.message);
    }
  }

  return {
    accepted: true,
    connectionAttemptId,
    report,
    summaryEvent: buildDiagnosticSummaryEvent(report, { persisted, socketId }),
  };
}

module.exports = {
  redactDiagnosticPayload,
  getDiagDir,
  persistDiagnostic,
  cleanupDiagLogs,
  loadRecentDiagnostics,
  dedupeDiagnosticsByAttempt,
  buildConnectionSummary,
  buildDiagnosticSummaryEvent,
  ingestDiagnosticPayload,
};
