'use strict';
// Codex adapter that reads Codex's own session log instead of its `notify` hook.
//
// `notify` only fires on notable moments, so it can never show "working". Codex
// also appends a JSONL rollout file per session under ~/.codex/sessions/YYYY/MM/DD/,
// and that stream carries task_started / task_complete / approval events — enough
// to drive all three lamps. This tails those files.
//
//   sig watch codex
//
// Works for the CLI and the editor extension alike, since both write rollouts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setState } = require('../client');

const SESSIONS_DIR = () =>
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

// Only three kinds of event actually decide the lamp. Everything else is ambient
// chatter (token counts, reasoning, tool output) that means "still alive" but must
// never *change* state — an ambient event arriving after task_complete would flip
// a finished session back to yellow and pin it there.
function classify(payloadType) {
  const t = String(payloadType || '');
  if (/approval[_-]?request|request[_-]?approval/i.test(t)) return 'waiting';
  if (t === 'task_started' || t === 'turn_started') return 'busy';
  if (t === 'task_complete' || t === 'turn_complete' || t === 'task_aborted') return 'idle';
  return null; // ambient
}

// Turn a Codex token_count payload into "how much is left".
//
//   quota   -> the plan allowance, which is what actually stops you working
//   context -> how full this conversation's context window is
//
// Quota is the default because running out of it blocks the next turn entirely,
// whereas a full context window merely triggers a compaction.
function readFuel(payload, mode = 'quota') {
  const used = payload?.rate_limits?.primary?.used_percent;
  if (mode !== 'context' && Number.isFinite(used)) {
    return {
      remaining: 100 - used,
      label: 'plan quota',
      ...(payload.rate_limits.primary.resets_at ? { resetsAt: payload.rate_limits.primary.resets_at } : {}),
    };
  }

  const total = payload?.info?.total_token_usage?.total_tokens;
  const window = payload?.info?.model_context_window;
  if (Number.isFinite(total) && Number.isFinite(window) && window > 0) {
    return { remaining: 100 - (total / window) * 100, label: 'context' };
  }
  return null;
}

function newestFiles(dir, sinceMs) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* file vanished mid-scan */ }
      }
    }
  };
  walk(dir);
  return out;
}

function run(opts = {}) {
  const dir = opts.dir || SESSIONS_DIR();
  const pollMs = Number(opts.interval) || 1000;
  // Files older than this are history, not live sessions.
  const lookbackMs = Number(opts.lookback) || 10 * 60 * 1000;
  const quiet = !!opts.quiet;

  if (!fs.existsSync(dir)) {
    console.error(`No Codex sessions directory at ${dir}`);
    console.error('Is Codex installed? Set CODEX_HOME if it lives somewhere else.');
    process.exit(1);
  }

  const tracked = new Map(); // path -> { offset, sessionId, cwd, state, buffer }
  if (!quiet) console.log(`watching ${dir}`);

  const handleLine = (file, line) => {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const t = tracked.get(file);
    if (!t) return;

    if (rec.type === 'session_meta') {
      t.sessionId = rec.payload?.session_id || rec.payload?.id || t.sessionId;
      t.cwd = rec.payload?.cwd || t.cwd;
      return;
    }

    const next = rec.type === 'event_msg' ? classify(rec.payload?.type) : null;
    const session = `codex:${t.sessionId || path.basename(file)}`;

    // Codex reports both how much of the plan's quota is gone and how full the
    // context window is. Fuel goes on its own channel so it never moves the lamp.
    if (rec.type === 'event_msg' && rec.payload?.type === 'token_count') {
      const f = readFuel(rec.payload, opts.fuel);
      if (f) setState({ session, fuel: f });
      return;
    }

    if (next) {
      if (next === t.state) return;
      t.state = next;
      setState({
        session,
        agent: 'codex',
        state: next,
        detail: next === 'waiting' ? 'needs approval' : next === 'busy' ? 'working' : '',
        cwd: t.cwd ? path.basename(t.cwd) : '',
      });
      if (!quiet) console.log(`  ${new Date().toISOString().slice(11, 19)}  ${rec.payload?.type} -> ${next}`);
      return;
    }

    // Ambient event: keep a busy session from being swept as stale, nothing more.
    if (t.state === 'busy') {
      setState({ session, agent: 'codex', state: 'busy', detail: 'working', cwd: t.cwd ? path.basename(t.cwd) : '' });
    }
  };

  const tick = () => {
    for (const f of newestFiles(dir, Date.now() - lookbackMs)) {
      let t = tracked.get(f.path);
      if (!t) {
        // Start from the end of a file that already existed, so old sessions do
        // not replay on startup — but read a brand-new file from the beginning.
        const fresh = Date.now() - f.mtimeMs < pollMs * 3;
        t = { offset: fresh ? 0 : f.size, state: null, buffer: '' };
        tracked.set(f.path, t);
        if (!fresh) continue;
      }
      if (f.size <= t.offset) continue;

      let chunk = '';
      try {
        const fd = fs.openSync(f.path, 'r');
        const buf = Buffer.alloc(f.size - t.offset);
        fs.readSync(fd, buf, 0, buf.length, t.offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch { continue; }

      t.offset = f.size;
      t.buffer += chunk;
      const lines = t.buffer.split(/\r?\n/);
      t.buffer = lines.pop() || '';           // keep any partial trailing line
      for (const line of lines) if (line.trim()) handleLine(f.path, line);
    }
  };

  tick();
  const timer = setInterval(tick, pollMs);

  const stop = () => {
    clearInterval(timer);
    for (const t of tracked.values()) {
      if (t.state && t.state !== 'idle') {
        setState({ session: `codex:${t.sessionId}`, agent: 'codex', state: 'offline' });
      }
    }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);

  return { stop, tracked };
}

module.exports = { run, classify, readFuel, newestFiles };
