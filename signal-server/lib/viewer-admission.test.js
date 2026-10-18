'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createViewerAdmission } = require('./viewer-admission');
const vacant = { viewerEpoch: 0, occupied: false, relayOccupied: false, hostOnline: true };
const guarded = context => ({ initialPolicy: 'vacant-only-v1', context });
const explicit = (a, ticket, session = 'session-guard', subject = 'subject', initialContext = vacant) =>
  a.admit({ subject, session, admission: { mode: 'explicit', ticket: ticket.ticket }, initialContext });

test('pending human Start survives a rejected guard', () => {
  const a = createViewerAdmission();
  const human = a.issue('subject', 'session-human');
  assert.equal(a.issue('subject', 'session-guard', guarded(vacant)).error, 'human-intent-pending');
  assert.equal(explicit(a, human, 'session-human').ok, true);
});
test('human owner survives vacancy and all ticket expiry', () => {
  let now = 0;
  const a = createViewerAdmission({ now: () => now });
  const human = a.issue('subject', 'session-human');
  const accepted = explicit(a, human, 'session-human');
  now = 120001;
  assert.equal(a.issue('subject', 'session-guard', guarded(vacant)).error, 'human-owner-retained');
  assert.equal(a.admit({ subject: 'subject', session: 'session-human',
    admission: { mode: 'resume', generation: accepted.generation } }).ok, true);
});

test('guard issue preserves the human fence: two guards at one epoch race at consume', () => {
  const a = createViewerAdmission();
  const first = a.issue('subject', 'session-first', guarded(vacant));
  const second = a.issue('subject', 'session-second', guarded(vacant));
  const owner = explicit(a, first, 'session-first');
  assert.equal(owner.ok, true, 'later guard issuance must not stale the earlier guard');
  assert.equal(explicit(a, second, 'session-second', 'subject', { ...vacant, viewerEpoch: 1 }).ok, false);
  assert.equal(a.admit({ subject: 'subject', session: 'session-first',
    admission: { mode: 'resume', generation: owner.generation } }).ok, true);
});

test('human later issue then expiry permanently invalidates pending guarded admission', () => {
  let now = 0;
  const a = createViewerAdmission({ now: () => now, viewerAdmissionTtlMs: 100 });
  const guard = a.issue('subject', 'session-guard', guarded(vacant));
  a.issue('subject', 'session-human');
  now = 101;
  assert.equal(explicit(a, guard).ok, false);
  assert.ok(a.issue('subject', 'session-fresh', guarded(vacant)).ticket);
});

test('older stale pending human intent also blocks guard issue', () => {
  const a = createViewerAdmission();
  const old = a.issue('subject', 'session-oldhuman');
  const current = a.issue('subject', 'session-human');
  assert.equal(explicit(a, old, 'session-oldhuman').ok, false);
  assert.equal(a.issue('subject', 'session-guard', guarded(vacant)).error, 'human-intent-pending');
  assert.equal(explicit(a, current, 'session-human').ok, true);
});

test('current epoch changes then vacancy rejects the initial guard without spending it', () => {
  const a = createViewerAdmission();
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  assert.equal(explicit(a, ticket, 'session-guard', 'subject', { ...vacant, viewerEpoch: 1 }).ok, false);
  assert.equal(explicit(a, ticket).ok, true);
});

for (const [field, value, error] of [
  ['occupied', true, 'viewer-occupied'],
  ['relayOccupied', true, 'relay-occupied'],
  ['hostOnline', false, 'host-unavailable'],
]) {
  test(`${field} change blocks issue and consume without spending guard`, () => {
    const a = createViewerAdmission();
    const changed = { ...vacant, [field]: value };
    assert.equal(a.issue('subject', 'session-guard', guarded(changed)).error, error);
    const ticket = a.issue('subject', 'session-guard', guarded(vacant));
    assert.equal(explicit(a, ticket, 'session-guard', 'subject', changed).ok, false);
    assert.equal(explicit(a, ticket).ok, true);
  });
}

test('malformed contexts and unknown policies fail closed without changing pristine compatibility', () => {
  for (const context of [null, {}, { ...vacant, viewerEpoch: -1 }, { ...vacant, viewerEpoch: 1.5 },
    { ...vacant, viewerEpoch: Number.MAX_SAFE_INTEGER + 1 }, { ...vacant, occupied: 0 },
    { ...vacant, relayOccupied: null }, { ...vacant, hostOnline: 1 }]) {
    const a = createViewerAdmission();
    assert.equal(a.issue('subject', 'session-guard', guarded(context)).error, 'admission-unavailable');
    assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
  }
  for (const initialPolicy of ['', false, 1, [], {}, 'unknown']) {
    const a = createViewerAdmission();
    assert.equal(a.issue('subject', 'session-guard', { initialPolicy, context: vacant }).error, 'invalid-initial-policy');
    assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
  }
});

test('prior guarded owner survives TTL and can yield to a new guarded generation', () => {
  let now = 0;
  const a = createViewerAdmission({ now: () => now, viewerAdmissionTtlMs: 10 });
  const first = explicit(a, a.issue('subject', 'session-guard', guarded(vacant)));
  now = 11;
  assert.equal(a.admit({ subject: 'subject', session: 'session-guard',
    admission: { mode: 'resume', generation: first.generation } }).ok, true);
  const second = a.issue('subject', 'session-nextguard', guarded({ ...vacant, viewerEpoch: 1 }));
  assert.ok(second.ticket);
  const accepted = explicit(a, second, 'session-nextguard', 'subject', { ...vacant, viewerEpoch: 1 });
  assert.equal(accepted.ok, true);
  assert.notEqual(accepted.generation, first.generation);
});

test('current consumed lost-welcome retry preserves guard policy and bypasses only its spent initial gate', () => {
  const a = createViewerAdmission();
  const guard = a.issue('subject', 'session-guard', guarded(vacant));
  const first = explicit(a, guard);
  const retry = explicit(a, guard, 'session-guard', 'subject', { ...vacant, occupied: true, viewerEpoch: 1 });
  assert.deepEqual(retry, first);
  assert.ok(a.issue('subject', 'session-nextguard', guarded({ ...vacant, viewerEpoch: 1 })).ticket);
});

test('a later pending human does not revoke current guard recovery or consumed replay evidence', () => {
  const a = createViewerAdmission({ maxViewerAdmissions: 2 });
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  const owner = explicit(a, ticket);
  assert.ok(a.issue('subject', 'session-human').ticket);
  assert.deepEqual(explicit(a, ticket, 'session-guard', 'subject', null), owner);
  assert.equal(a.admit({ subject: 'subject', session: 'session-guard',
    admission: { mode: 'resume', generation: owner.generation } }).ok, true);
  assert.equal(a.issue('subject', 'session-full').error, 'admission-capacity');
  assert.deepEqual(explicit(a, ticket), owner);
});

test('stale consumed retry and resume lose to newer human even after human ticket TTL', () => {
  let now = 0;
  const a = createViewerAdmission({ now: () => now, viewerAdmissionTtlMs: 10 });
  const guard = a.issue('subject', 'session-guard', guarded(vacant));
  const owner = explicit(a, guard);
  const human = a.issue('subject', 'session-human');
  assert.equal(explicit(a, human, 'session-human').ok, true);
  assert.equal(explicit(a, guard).ok, false);
  now = 11;
  assert.equal(a.admit({ subject: 'subject', session: 'session-guard',
    admission: { mode: 'resume', generation: owner.generation } }).ok, false);
  assert.equal(a.issue('subject', 'session-newguard', guarded(vacant)).error, 'human-owner-retained');
});

test('same-session explicit human Start creates a new generation and pins human ownership', () => {
  const a = createViewerAdmission();
  const guard = a.issue('subject', 'session-guard', guarded(vacant));
  const old = explicit(a, guard);
  const current = explicit(a, a.issue('subject', 'session-guard'));
  assert.notEqual(current.generation, old.generation);
  assert.equal(explicit(a, guard).ok, false);
  assert.equal(a.issue('subject', 'session-nextguard', guarded(vacant)).error, 'human-owner-retained');
});

test('capacity full of pending guards allows human Start; invalid human request cannot evict them', () => {
  const a = createViewerAdmission({ maxViewerAdmissions: 2 });
  const pendingOnly = createViewerAdmission({ maxViewerAdmissions: 2 });
  const revoked = pendingOnly.issue('subject', 'session-first', guarded(vacant));
  pendingOnly.issue('subject', 'session-second', guarded(vacant));
  const prioritizedHuman = pendingOnly.issue('subject', 'session-human');
  assert.ok(prioritizedHuman.ticket);
  assert.equal(explicit(pendingOnly, revoked, 'session-first').ok, false);
  assert.equal(explicit(pendingOnly, prioritizedHuman, 'session-human').ok, true);
  const first = a.issue('subject', 'session-first', guarded(vacant));
  a.issue('subject', 'session-second', guarded(vacant));
  assert.equal(a.issue('subject', 'session-third', guarded(vacant)).error, 'admission-capacity');
  assert.equal(a.issue('subject', 'bad').error, 'invalid-session');
  assert.equal(explicit(a, first, 'session-first').ok, true);
  // The consumed first record stays live; only the second pending guard yields.
  const human = a.issue('subject', 'session-human');
  assert.ok(human.ticket);
  assert.equal(a.issue('subject', 'session-full').error, 'admission-capacity');
  assert.equal(explicit(a, human, 'session-human').ok, true);
});

test('capacity consumed records denies human without evicting evidence or advancing fence', () => {
  const a = createViewerAdmission({ maxViewerAdmissions: 1 });
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  const owner = explicit(a, ticket);
  assert.equal(a.issue('subject', 'session-human').error, 'admission-capacity');
  assert.deepEqual(explicit(a, ticket), owner);
  assert.equal(a.issue('subject', 'session-nextguard', guarded(vacant)).error, 'admission-capacity');
});

test('guard subject and session confusion cannot consume its ticket', () => {
  const a = createViewerAdmission();
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  assert.equal(explicit(a, ticket, 'session-foreign').ok, false);
  assert.equal(explicit(a, ticket, 'session-guard', 'other').ok, false);
  assert.equal(explicit(a, ticket).ok, true);
});

test('legacy retained owner blocks guard forever without destroying same-session recovery', () => {
  let now = 0;
  const a = createViewerAdmission({ now: () => now });
  assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
  now = 120001;
  assert.equal(a.issue('subject', 'session-guard', guarded(vacant)).error, 'human-owner-retained');
  assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
});

test('proof admission clears pending guards and guarded recovery without reviving legacy compatibility', () => {
  const a = createViewerAdmission();
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  const owner = explicit(a, ticket);
  const pending = a.issue('subject', 'session-pending', guarded(vacant));
  a.noteProofAdmission();
  assert.equal(explicit(a, pending).ok, false);
  assert.equal(explicit(a, ticket).ok, false);
  assert.equal(a.admit({ subject: 'subject', session: 'session-guard',
    admission: { mode: 'resume', generation: owner.generation } }).ok, false);
  assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, false);
});

test('each issue and admission operation captures time exactly once', () => {
  let calls = 0;
  const a = createViewerAdmission({ now: () => { calls += 1; return 0; } });
  const ticket = a.issue('subject', 'session-guard', guarded(vacant));
  assert.equal(calls, 1);
  assert.equal(explicit(a, ticket).ok, true);
  assert.equal(calls, 2);
});


test('legacy acceptance after guard issuance pins owner against guarded first consume', () => {
  const a = createViewerAdmission();
  const pending = a.issue('subject', 'session-guard', guarded(vacant));
  assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
  assert.equal(explicit(a, pending).ok, false);
  assert.equal(a.admit({ subject: 'subject', session: 'session-legacy' }).ok, true);
});
