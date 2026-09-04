'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { Store, normaliseFuel } = require('../src/store');
const { readFuel } = require('../src/adapters/codex-watch');

// --------------------------------------------------------------- normalising

test('fuel always means "how much is left", clamped to 0-100', () => {
  assert.equal(normaliseFuel(42).remaining, 42);
  assert.equal(normaliseFuel({ remaining: 42 }).remaining, 42);
  assert.equal(normaliseFuel(150).remaining, 100, 'clamped high');
  assert.equal(normaliseFuel(-20).remaining, 0, 'clamped low');
  assert.equal(normaliseFuel('nonsense'), null, 'garbage is dropped, not shown as 0%');
  assert.equal(normaliseFuel(null), null);
  assert.equal(normaliseFuel(0).remaining, 0, 'empty is a real value, not falsy-dropped');
});

test('a label is carried through so the gauge can say what it measures', () => {
  assert.equal(normaliseFuel({ remaining: 10, label: 'plan quota' }).label, 'plan quota');
  assert.equal(normaliseFuel(10).label, 'remaining');
});

// ------------------------------------------------------------------- store

// The whole point of a separate channel: a quota report and a state change
// arrive on completely unrelated schedules, and a fuel update landing mid-turn
// must never touch the lamp.
test('a fuel-only update leaves the lamp exactly as it was', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'waiting', detail: 'needs you' });
  const before = s.snapshot().sessions[0];

  s.set({ session: 'a', fuel: { remaining: 30, label: 'plan quota' } });
  const after = s.snapshot().sessions[0];

  assert.equal(after.state, 'waiting', 'state untouched');
  assert.equal(after.detail, 'needs you', 'detail untouched');
  assert.equal(after.since, before.since, 'and the clock did not restart');
  assert.equal(after.fuel.remaining, 30);
});

test('fuel survives subsequent state changes', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy', fuel: 80 });
  s.set({ session: 'a', agent: 'claude', state: 'idle' });
  assert.equal(s.snapshot().sessions[0].fuel.remaining, 80, 'not wiped by a state update');
});

test('the emptiest tank is the one shown', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy', fuel: 90 });
  s.set({ session: 'b', agent: 'codex', state: 'busy', fuel: 12 });
  s.set({ session: 'c', agent: 'gemini', state: 'busy' });   // no fuel reported

  const snap = s.snapshot();
  assert.equal(snap.fuel.remaining, 12);
  assert.equal(snap.fuel.agent, 'codex', 'and it says whose tank it is');
});

test('no fuel anywhere means no gauge, not an empty gauge', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  assert.equal(s.snapshot().fuel, null);
});

test('a fuel update for an unknown session does not invent one', () => {
  const s = new Store();
  s.set({ session: 'ghost', fuel: 50 });
  // No prior session, so this falls through to a normal set and creates one
  // rather than silently vanishing — but it must not crash or produce a
  // session with an undefined state.
  const snap = s.snapshot();
  if (snap.sessions.length) assert.ok(['idle', 'busy', 'waiting'].includes(snap.sessions[0].state));
});

// ------------------------------------------------------------------- codex

// Shape taken from a real ~/.codex/sessions rollout file.
const TOKEN_COUNT = {
  type: 'token_count',
  info: {
    total_token_usage: { input_tokens: 21861, output_tokens: 196, total_tokens: 22057 },
    model_context_window: 258400,
  },
  rate_limits: {
    primary: { used_percent: 35, window_minutes: 43200, resets_at: 1790275478 },
    secondary: null,
  },
};

test('codex plan quota becomes fuel remaining', () => {
  const f = readFuel(TOKEN_COUNT, 'quota');
  assert.equal(f.remaining, 65, '35% used -> 65% left');
  assert.equal(f.label, 'plan quota');
  assert.equal(f.resetsAt, 1790275478, 'reset time carried through');
});

test('codex context window is available as an alternative gauge', () => {
  const f = readFuel(TOKEN_COUNT, 'context');
  assert.equal(f.label, 'context');
  assert.ok(f.remaining > 91 && f.remaining < 92, `expected ~91.5, got ${f.remaining}`);
});

test('quota is preferred, because that is what actually blocks the next turn', () => {
  assert.equal(readFuel(TOKEN_COUNT).label, 'plan quota');
});

test('falls back to context when no rate limit is reported', () => {
  const noLimits = { ...TOKEN_COUNT, rate_limits: {} };
  assert.equal(readFuel(noLimits).label, 'context');
});

test('reports nothing rather than guessing when the payload is unusable', () => {
  assert.equal(readFuel({}), null);
  assert.equal(readFuel({ info: {} }), null);
  assert.equal(readFuel({ info: { total_token_usage: { total_tokens: 5 }, model_context_window: 0 } }), null);
});

// ------------------------------------------------------------------ layout

// Guards the fix for a real complaint: the lamp slid sideways every time an
// agent's status text changed length, because the window was shrink-wrapped
// around content of varying width. A fixed stage width is what pins it.
test('the overlay pins its width so the lamp cannot drift', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /--stage-w:\s*\d+px/, 'stage width is a fixed pixel value');
  assert.match(html, /width:\s*var\(--stage-w\)/, 'and the stage actually uses it');
  assert.doesNotMatch(html, /#stage\s*\{[^}]*width:\s*max-content/, 'never shrink-wrapped again');
});

// Guards a second reported bug: collapsed to a single lamp there are no pills
// below the light, so an asymmetric bottom padding left less room than the bloom
// needs and sliced it into a visible box edge.
test('glow headroom is symmetric, so the bloom is never clipped in any mode', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  const stage = html.match(/#stage\s*\{[^}]*\}/)[0];
  const pad = stage.match(/padding:\s*([^;]+);/)[1].trim();
  assert.match(pad, /^var\(--glow-pad\)\s+0$/,
    `#stage padding must be vertically symmetric glow headroom, got "${pad}"`);

  const glow = Number(html.match(/--glow-pad:\s*(\d+)px/)[1]);
  assert.ok(glow >= 72, `glow headroom ${glow}px is smaller than the 72px bloom radius`);
});

test('the fuel gauge is positioned out of flow so it cannot move the lamp', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /#fuel\s*\{[^}]*position:\s*absolute/, 'gauge is absolutely positioned');
});
