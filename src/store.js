'use strict';
const { EventEmitter } = require('events');

// The four states every adapter maps onto.
//   waiting -> RED     the agent has stopped and needs a human (permission, question, choice)
//   busy    -> YELLOW  the agent is thinking or running tools
//   idle    -> GREEN   the agent finished its turn and is ready for a new task
//   offline -> DARK    session ended / nothing connected
const STATES = ['waiting', 'busy', 'idle', 'offline'];
const PRIORITY = { waiting: 3, busy: 2, idle: 1, offline: 0 };

// Fuel is always "how much is left", 0–100. Reporters that think in "used"
// convert before sending, so the gauge only ever has one meaning.
function normaliseFuel(fuel) {
  if (fuel === null) return null;
  const remaining = Number(typeof fuel === 'object' ? fuel.remaining : fuel);
  if (!Number.isFinite(remaining)) return null;
  return {
    remaining: Math.max(0, Math.min(100, remaining)),
    label: (typeof fuel === 'object' && fuel.label) || 'remaining',
    ...(typeof fuel === 'object' && fuel.resetsAt ? { resetsAt: fuel.resetsAt } : {}),
  };
}

class Store extends EventEmitter {
  constructor({
    ttlMs = 6 * 60 * 60 * 1000,
    idleTtlMs = 30 * 60 * 1000,
    quietAfterMs = 90_000,
    unusedTtlMs = 2 * 60 * 1000,
  } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.idleTtlMs = idleTtlMs;
    this.quietAfterMs = quietAfterMs;
    this.unusedTtlMs = unusedTtlMs;
    this.sessions = new Map();
    this._sweeper = setInterval(() => this.sweep(), 5_000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  set({ session = 'default', agent = 'agent', state, detail = '', cwd = '', fuel } = {}) {
    const prev = this.sessions.get(session);

    // A fuel-only update must not disturb the lamp: quota reports and state
    // changes arrive on completely different schedules.
    if (state === undefined && fuel !== undefined && prev) {
      this.sessions.set(session, { ...prev, fuel: normaliseFuel(fuel), updatedAt: Date.now() });
      this.emit('change', this.snapshot());
      return this.snapshot();
    }

    const next = state === undefined ? 'idle' : state;
    if (!STATES.includes(next)) throw new Error(`unknown state "${next}" (use: ${STATES.join(', ')})`);

    const now = Date.now();
    if (next === 'offline') {
      this.sessions.delete(session);
    } else {
      this.sessions.set(session, {
        session,
        agent: agent || prev?.agent || 'agent',
        state: next,
        detail,
        cwd: cwd || prev?.cwd || '',
        fuel: fuel !== undefined ? normaliseFuel(fuel) : (prev?.fuel ?? null),
        // A session that has only ever announced itself is not the same as one
        // that has done work. Agents sometimes open a session and abandon it
        // without ever reporting an end, and those must not linger as if real.
        everBusy: prev?.everBusy || next === 'busy' || next === 'waiting',
        since: prev && prev.state === next ? prev.since : now,
        updatedAt: now,
      });
    }
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  sweep() {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    let changed = false;

    for (const [id, s] of this.sessions) {
      if (s.updatedAt < cutoff) { this.sessions.delete(id); changed = true; continue; }

      // Announced itself and then did nothing at all. An agent that opens a
      // session and abandons it never sends SessionEnd, so without this the
      // phantom sits on screen claiming to be a ready agent until the much
      // longer idle timeout. A real session that has done work is untouched.
      if (!s.everBusy && s.state === 'idle' && now - s.updatedAt > this.unusedTtlMs) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }

      // An agent that crashed or was force-quit never sends SessionEnd, so its
      // pill would sit there for hours claiming to be "ready" when nothing is
      // running. A green session nobody has touched in half an hour is almost
      // certainly gone; if it is not, its next event brings it straight back.
      if (s.state === 'idle' && now - s.updatedAt > this.idleTtlMs) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }

      // A busy session that has gone quiet is NOT promoted to idle.
      //
      // It used to be: the theory was that a working agent reports constantly,
      // so silence meant it had finished without saying so. That is often true
      // and occasionally very wrong — an agent thinking hard with no tool calls
      // reports nothing for minutes, and flipping it to green told the user
      // "finished, come and look" while it was still working. Silence is not
      // evidence of completion, and green is a claim, not a shrug.
      //
      // Silence is now shown as silence: the session stays busy and the quiet
      // flag dims it, which says "last I heard it was working, a while ago".
      // A busy session that has been silent past the idle window is dropped
      // outright, because by then the agent is gone rather than thinking.
      if (s.state === 'busy' && now - s.updatedAt > this.idleTtlMs) {
        this.sessions.delete(id);
        changed = true;
      }
    }

    if (changed) this.emit('change', this.snapshot());
  }

  // Overall light: the most attention-hungry session wins.
  // Overall fuel: the emptiest tank wins, for the same reason — one gauge should
  // show the thing that is going to run out first.
  snapshot() {
    const now = Date.now();
    // An agent that reported once and then went quiet is not the same as one
    // that just told us it finished, but they look identical on a lamp. Mark
    // the difference so the display can show it, rather than presenting a
    // stale claim with full confidence.
    const sessions = [...this.sessions.values()]
      .map((s) => (now - s.updatedAt > this.quietAfterMs ? { ...s, quiet: true, quietFor: now - s.updatedAt } : s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    let overall = 'offline';
    for (const s of sessions) if (PRIORITY[s.state] > PRIORITY[overall]) overall = s.state;

    let fuel = null;
    for (const s of sessions) {
      if (!s.fuel) continue;
      if (!fuel || s.fuel.remaining < fuel.remaining) fuel = { ...s.fuel, agent: s.agent };
    }

    return { overall, fuel, sessions, at: now };
  }
}

module.exports = { Store, STATES, PRIORITY, normaliseFuel };
