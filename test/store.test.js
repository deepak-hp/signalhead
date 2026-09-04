'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');

test('the most attention-hungry session wins the lamp', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'idle' });
  assert.equal(s.snapshot().overall, 'idle');

  s.set({ session: 'b', state: 'busy' });
  assert.equal(s.snapshot().overall, 'busy', 'busy outranks idle');

  s.set({ session: 'c', state: 'waiting' });
  assert.equal(s.snapshot().overall, 'waiting', 'waiting outranks everything');

  s.set({ session: 'c', state: 'idle' });
  assert.equal(s.snapshot().overall, 'busy', 'drops back once nobody is waiting');
});

test('offline removes a session rather than storing a state', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'busy' });
  s.set({ session: 'a', state: 'offline' });
  assert.equal(s.snapshot().sessions.length, 0);
  assert.equal(s.snapshot().overall, 'offline');
});

test('since only resets when the state actually changes', async () => {
  const s = new Store();
  s.set({ session: 'a', state: 'busy' });
  const first = s.snapshot().sessions[0].since;
  await new Promise((r) => setTimeout(r, 20));
  s.set({ session: 'a', state: 'busy', detail: 'still going' });
  assert.equal(s.snapshot().sessions[0].since, first, 'repeat of same state keeps since');
  s.set({ session: 'a', state: 'idle' });
  assert.notEqual(s.snapshot().sessions[0].since, first, 'a real change moves since');
});

test('rejects an unknown state instead of guessing', () => {
  const s = new Store();
  assert.throws(() => s.set({ session: 'a', state: 'purple' }), /unknown state/);
});

// The bug this guards against: an agent with no reliable "finished" event leaves
// the lamp yellow forever, which is worse than no lamp at all.
test('a busy session gone quiet falls back to idle; a reporting one does not', async () => {
  const s = new Store({ staleBusyMs: 120 });
  s.set({ session: 'silent', agent: 'quiet', state: 'busy' });
  s.set({ session: 'chatty', agent: 'loud', state: 'busy' });

  const keepAlive = setInterval(() => s.set({ session: 'chatty', agent: 'loud', state: 'busy' }), 40);
  await new Promise((r) => setTimeout(r, 260));
  clearInterval(keepAlive);
  s.sweep();

  const byId = Object.fromEntries(s.snapshot().sessions.map((x) => [x.session, x]));
  assert.equal(byId.silent.state, 'idle', 'silent agent decayed to idle');
  assert.equal(byId.silent.stale, true, 'and is marked as assumed rather than reported');
  assert.equal(byId.chatty.state, 'busy', 'agent that kept reporting was left alone');
});

test('a waiting session never decays — red must not disappear on its own', async () => {
  const s = new Store({ staleBusyMs: 60 });
  s.set({ session: 'a', state: 'waiting' });
  await new Promise((r) => setTimeout(r, 150));
  s.sweep();
  assert.equal(s.snapshot().overall, 'waiting');
});

// An agent that crashes or is force-quit never sends SessionEnd, so its pill
// would sit there for hours claiming "ready" when nothing is running. This is
// the same failure as the stuck-yellow lamp: the light must not report a session
// that no longer exists.
test('a green session nobody touches is forgotten, not left claiming "ready"', async () => {
  const s = new Store({ idleTtlMs: 120, staleBusyMs: 10_000 });
  s.set({ session: 'ghost', agent: 'claude', state: 'idle' });
  s.set({ session: 'live', agent: 'claude', state: 'idle' });

  const keepAlive = setInterval(() => s.set({ session: 'live', agent: 'claude', state: 'idle' }), 40);
  await new Promise((r) => setTimeout(r, 260));
  clearInterval(keepAlive);
  s.sweep();

  const ids = s.snapshot().sessions.map((x) => x.session);
  assert.ok(!ids.includes('ghost'), 'the abandoned session is gone');
  assert.ok(ids.includes('live'), 'one still reporting stays');
});

test('a waiting session is never forgotten, however long it waits', async () => {
  const s = new Store({ idleTtlMs: 60, staleBusyMs: 60 });
  s.set({ session: 'a', state: 'waiting' });
  await new Promise((r) => setTimeout(r, 200));
  s.sweep();
  assert.equal(s.snapshot().overall, 'waiting', 'red must survive any amount of waiting');
});

// A window that reported once and then went silent looked identical to one that
// had just said "ready" — the light presented a stale claim with full
// confidence, and there was no way to tell the difference.
test('a session that has gone silent is marked quiet, not fresh', async () => {
  const s = new Store({ quietAfterMs: 100, idleTtlMs: 600_000, staleBusyMs: 600_000 });
  s.set({ session: 'silent', agent: 'claude', state: 'idle' });
  s.set({ session: 'chatty', agent: 'claude', state: 'idle' });

  const keepAlive = setInterval(() => s.set({ session: 'chatty', agent: 'claude', state: 'idle' }), 30);
  await new Promise((r) => setTimeout(r, 220));
  clearInterval(keepAlive);

  const by = Object.fromEntries(s.snapshot().sessions.map((x) => [x.session, x]));
  assert.equal(by.silent.quiet, true, 'the silent one is flagged');
  assert.ok(by.silent.quietFor >= 100, 'and says how long it has been silent');
  assert.equal(by.chatty.quiet, undefined, 'one still reporting is not flagged');
  assert.equal(by.silent.state, 'idle', 'the state itself is unchanged — only our confidence in it');
});

test('sessions expire after the TTL', async () => {
  const s = new Store({ ttlMs: 80, staleBusyMs: 10_000 });
  s.set({ session: 'a', state: 'idle' });
  await new Promise((r) => setTimeout(r, 140));
  s.sweep();
  assert.equal(s.snapshot().sessions.length, 0);
});
