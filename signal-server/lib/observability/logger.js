const DEFAULT_SOURCE = 'signal-server';
const fs = require('node:fs');
const path = require('node:path');
const { redactValue } = require('./redact');

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_BACKUP_COUNT = 3;

function createRotatingFileSink(options = {}) {
  const filePath = String(options.filePath || '').trim();
  if (!filePath) {
    return { write() {} };
  }
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_LOG_MAX_BYTES));
  const backupCount = Math.max(0, Number(options.backupCount ?? DEFAULT_LOG_BACKUP_COUNT));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function rotate() {
    if (backupCount === 0) {
      fs.writeFileSync(filePath, '', 'utf8');
      return;
    }
    for (let index = backupCount; index >= 1; index -= 1) {
      const destination = `${filePath}.${index}`;
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
      if (!fs.existsSync(source)) continue;
      fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    }
  }

  return {
    write(value) {
      const line = String(value ?? '');
      const nextBytes = Buffer.byteLength(line, 'utf8');
      const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (currentBytes > 0 && currentBytes + nextBytes > maxBytes) {
        rotate();
      }
      fs.appendFileSync(filePath, line, 'utf8');
    },
  };
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeEvent(input = {}, level = 'info', options = {}) {
  const now = options.now || (() => new Date());
  const source = String(options.source || DEFAULT_SOURCE);

  return redactValue({
    ts: now().toISOString(),
    level,
    domain: String(input.domain || 'server'),
    event: String(input.event || 'unknown'),
    message: String(input.message || ''),
    source,
    schemaVersion: 1,
    correlation: cloneObject(input.correlation),
    meta: cloneObject(input.meta),
    redactionVersion: 1,
  });
}

function createStructuredLogger(options = {}) {
  const write = typeof options.write === 'function'
    ? options.write
    : (line) => process.stdout.write(line + '\n');
  const now = options.now || (() => new Date());
  const source = String(options.source || DEFAULT_SOURCE);

  function emit(level, input = {}) {
    const event = normalizeEvent(input, level, { now, source });
    write(JSON.stringify(event));
    return event;
  }

  return {
    debug(input) {
      return emit('debug', input);
    },
    info(input) {
      return emit('info', input);
    },
    warn(input) {
      return emit('warn', input);
    },
    error(input) {
      return emit('error', input);
    },
  };
}

module.exports = {
  DEFAULT_LOG_BACKUP_COUNT,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_SOURCE,
  createRotatingFileSink,
  createStructuredLogger,
  normalizeEvent,
};
