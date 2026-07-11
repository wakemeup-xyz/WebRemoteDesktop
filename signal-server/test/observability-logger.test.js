const assert = require('node:assert/strict');
const test = require('node:test');

const { createStructuredLogger } = require('../lib/observability/logger');
const { redactValue } = require('../lib/observability/redact');
const { createRecentEventStore } = require('../lib/observability/store');

test('createStructuredLogger emits a stable envelope with correlation and meta fields', () => {
  const written = [];
  const logger = createStructuredLogger({
    write(line) {
      written.push(JSON.parse(line));
    },
    now: () => new Date('2026-07-12T00:00:00.000Z'),
  });

  logger.info({
    domain: 'terminal',
    event: 'terminal_session_created',
    message: 'Terminal session created',
    correlation: { terminalSessionId: 'term-1', clientId: 'client-1' },
    meta: { cols: 120, rows: 40 },
  });

  assert.equal(written.length, 1);
  assert.deepEqual(written[0], {
    ts: '2026-07-12T00:00:00.000Z',
    level: 'info',
    domain: 'terminal',
    event: 'terminal_session_created',
    message: 'Terminal session created',
    source: 'signal-server',
    schemaVersion: 1,
    correlation: {
      terminalSessionId: 'term-1',
      clientId: 'client-1',
    },
    meta: {
      cols: 120,
      rows: 40,
    },
    redactionVersion: 1,
  });
});

test('redactValue removes secret-bearing fields recursively', () => {
  const redacted = redactValue({
    token: 'abc',
    nested: {
      authorization: 'Bearer secret',
      password: 'top-secret',
      safe: 'ok',
    },
    url: 'https://example.com/path?token=secret&safe=1',
  });

  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.equal(redacted.nested.password, '[redacted]');
  assert.equal(redacted.nested.safe, 'ok');
  assert.match(redacted.url, /token=(%5Bredacted%5D|\[redacted\])/);
  assert.match(redacted.url, /safe=1/);
});

test('createRecentEventStore keeps a bounded recent window and grouped summary', () => {
  const store = createRecentEventStore({ capacity: 3 });
  store.append({ domain: 'server', event: 'started', level: 'info' });
  store.append({ domain: 'viewer', event: 'diagnostic_uploaded', level: 'warn' });
  store.append({ domain: 'terminal', event: 'terminal_session_created', level: 'info' });
  store.append({ domain: 'terminal', event: 'terminal_session_closed', level: 'info' });

  const recent = store.recent({ limit: 10 });
  const summary = store.summary();

  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map((item) => [item.domain, item.event]), [
    ['viewer', 'diagnostic_uploaded'],
    ['terminal', 'terminal_session_created'],
    ['terminal', 'terminal_session_closed'],
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.byDomain.terminal, 2);
  assert.equal(summary.byEvent['terminal.terminal_session_closed'], 1);
  assert.equal(summary.byLevel.info, 2);
  assert.equal(summary.byLevel.warn, 1);
});
