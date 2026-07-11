const DEFAULT_SOURCE = 'signal-server';

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeEvent(input = {}, level = 'info', options = {}) {
  const now = options.now || (() => new Date());
  const source = String(options.source || DEFAULT_SOURCE);

  return {
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
  };
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
  DEFAULT_SOURCE,
  createStructuredLogger,
  normalizeEvent,
};
