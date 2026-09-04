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
  constructor({ ttlMs = 6 * 60 * 60 * 1000, staleBusyMs = 60_000, idleTtlMs = 30 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.staleBusyMs = staleBusyMs;
    this.idleTtlMs = idleTtlMs;
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

      // An agent that crashed or was force-quit never sends SessionEnd, so its
      // pill would sit there for hours claiming to be "ready" when nothing is
      // running. A green session nobody has touched in half an hour is almost
      // certainly gone; if it is not, its next event brings it straight back.
      if (s.state === 'idle' && now - s.updatedAt > this.idleTtlMs) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }

      // A working agent reports constantly, so a `busy` session that has gone
      // quiet for a minute has almost certainly finished without saying so —
      // some agents have no reliable "turn ended" event at all. Without this the
      // lamp stays yellow forever and the tool is worse than useless: it lies.
      // If the agent is genuinely still working, its next event corrects this.
      if (s.state === 'busy' && now - s.updatedAt > this.staleBusyMs) {
        this.sessions.set(id, { ...s, state: 'idle', detail: '', since: now, updatedAt: now, stale: true });
        changed = true;
      }
    }

    if (changed) this.emit('change', this.snapshot());
  }

  // Overall light: the most attention-hungry session wins.
  // Overall fuel: the emptiest tank wins, for the same reason — one gauge should
  // show the thing that is going to run out first.
  snapshot() {
    const sessions = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    let overall = 'offline';
    for (const s of sessions) if (PRIORITY[s.state] > PRIORITY[overall]) overall = s.state;

    let fuel = null;
    for (const s of sessions) {
      if (!s.fuel) continue;
      if (!fuel || s.fuel.remaining < fuel.remaining) fuel = { ...s.fuel, agent: s.agent };
    }

    return { overall, fuel, sessions, at: Date.now() };
  }
}

module.exports = { Store, STATES, PRIORITY, normaliseFuel };
