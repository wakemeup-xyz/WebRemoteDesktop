const { createRotatingFileSink, normalizeEvent } = require('../observability/logger');
const { redactValue } = require('../observability/redact');

function normalizeOptions(input) {
  if (
    input
    && typeof input === 'object'
    && !Array.isArray(input)
    && (
      'logger' in input
      || 'structuredLogger' in input
      || 'recentEventStore' in input
      || 'auditLogPath' in input
      || 'auditLog' in input
    )
  ) {
    return input;
  }
  return { logger: input || console };
}

function writeAuditLine(auditSink, event, logger) {
  try {
    auditSink.write(JSON.stringify(event) + '\n');
  } catch (error) {
    logger?.error?.('[terminal-audit] Failed to append audit log', error);
  }
}

function createTerminalAudit(input = {}) {
  const options = normalizeOptions(input);
  const logger = options.logger || console;
  const structuredLogger = options.structuredLogger || null;
  const recentEventStore = options.recentEventStore || null;
  const auditLogPath = String(options.auditLogPath || options.auditLog || '').trim();
  const auditSink = createRotatingFileSink({
    filePath: auditLogPath,
    maxBytes: options.maxBytes,
    backupCount: options.backupCount,
  });

  function emit(level, event, meta = {}) {
    const safeMeta = redactValue(meta);
    const payload = {
      domain: 'terminal',
      event,
      message: event,
      correlation: {
        terminalSessionId: safeMeta.sessionId || safeMeta.terminalSessionId || null,
        clientId: safeMeta.clientId || null,
        socketId: safeMeta.socketId || null,
      },
      meta: safeMeta,
    };

    const emitted = structuredLogger && typeof structuredLogger[level] === 'function'
      ? structuredLogger[level](payload)
      : normalizeEvent(payload, level);

    if (!structuredLogger) {
      if (typeof logger[level] === 'function') {
        logger[level](emitted);
      } else {
        logger.log?.(emitted);
      }
    }

    recentEventStore?.append(emitted);
    writeAuditLine(auditSink, emitted, logger);
    return emitted;
  }

  return {
    info(event, meta = {}) {
      return emit('info', event, meta);
    },
    warn(event, meta = {}) {
      return emit('warn', event, meta);
    },
    error(event, meta = {}) {
      return emit('error', event, meta);
    },
  };
}

module.exports = {
  createTerminalAudit,
};
