'use strict';
// Universal adapter: run any CLI agent inside a pseudo-terminal, pass every byte
// through untouched, and infer the lamp from what it prints.
//
//   sig wrap -- gemini
//   sig wrap --agent aider -- aider --model sonnet
//
// This is the fallback for agents with no hook API. Agents that do have one
// (Claude Code, Codex) should use `sig install` instead — it is exact, this is
// a very good guess.

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { profileFor, stripAnsi } = require('./patterns');
const { setState } = require('../client');

// How much recent output to keep, and how far back each kind of rule may look.
// A confirmation prompt is always the last thing on screen, so `waiting` gets a
// short window — otherwise an answered prompt keeps matching and the lamp sticks
// on red for the rest of the session.
const TAIL_MAX = 3000;
const WAITING_WINDOW = 600;
const BUSY_WINDOW = 1500;

function loadPty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

// A pty spawns through CreateProcess/execvp, which — unlike a shell — will not
// search PATH for a bare name, and on Windows cannot execute a .cmd shim at all.
// Most agent CLIs are installed as exactly such a shim.
function which(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return path.resolve(cmd);
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return cmd;
}

function resolveSpawn(command, args) {
  const file = which(command);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return [process.env.COMSPEC || 'cmd.exe', ['/c', file, ...args]];
  }
  return [file, args];
}

function run(argv, opts = {}) {
  const pty = loadPty();
  if (!pty) {
    console.error(
      [
        'sig wrap needs a pseudo-terminal so the agent keeps its full interactive UI.',
        '',
        '  npm install node-pty        (inside ' + path.resolve(__dirname, '..', '..') + ')',
        '',
        'Agents with a hook API do not need this at all:',
        '  sig install claude',
        '  sig install codex',
      ].join('\n')
    );
    process.exit(1);
  }

  const [command, ...args] = argv;
  const profile = profileFor(opts.agent || command);
  const agent = opts.agent || profile.name;
  const session = `wrap:${agent}:${crypto.randomBytes(4).toString('hex')}`;
  const cwd = process.cwd();
  const label = path.basename(cwd);

  let tail = '';
  let current = null;
  let quietTimer = null;

  const push = (state, detail = '') => {
    if (state === current) return;
    current = state;
    setState({ session, agent, state, detail, cwd: label });
  };

  const matches = (rules, window) => {
    const text = tail.slice(-window);
    return rules.some((re) => re.test(text));
  };
  const isWaiting = () => matches(profile.waiting, WAITING_WINDOW);

  const settle = () => {
    // Output stopped. Decide what the silence means.
    if (isWaiting()) push('waiting', 'needs your confirmation');
    else if (matches(profile.busy, BUSY_WINDOW)) push('busy', 'thinking');
    else push('idle');
  };

  const onOutput = (data) => {
    tail = (tail + stripAnsi(data)).slice(-TAIL_MAX);
    if (isWaiting()) push('waiting', 'needs your confirmation');
    else push('busy', 'working');
    clearTimeout(quietTimer);
    quietTimer = setTimeout(settle, profile.idleAfterMs);
  };

  const [file, fileArgs] = resolveSpawn(command, args);
  const child = pty.spawn(file, fileArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd,
    env: { ...process.env, SIGNALHEAD_SESSION: session, SIGNALHEAD_AGENT: agent },
    useConpty: os.platform() === 'win32' ? undefined : false,
  });

  push('busy', 'starting');

  child.onData((d) => {
    process.stdout.write(d);
    onOutput(d);
  });

  // Keystrokes go straight to the agent; typing also means the user is present,
  // so a red light clears the moment they answer.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    child.write(d.toString('utf8'));
    if (current === 'waiting') {
      // The question has been answered, so drop the prompt from the tail before
      // the agent's next output is matched against it.
      tail = '';
      push('busy', 'working');
    }
  });

  const onResize = () => {
    try { child.resize(process.stdout.columns || 120, process.stdout.rows || 30); } catch {}
  };
  process.stdout.on('resize', onResize);

  const finish = (code) => {
    clearTimeout(quietTimer);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();
    setState({ session, agent, state: 'offline' }).finally(() => process.exit(code || 0));
  };

  child.onExit(({ exitCode }) => finish(exitCode));

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(); } catch { finish(0); } });
  }
}

module.exports = { run };
