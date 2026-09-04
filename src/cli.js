#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const client = require('./client');
const install = require('./adapters/install');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- arg parsing

function parse(argv) {
  const flags = {};
  const positional = [];
  const rest = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDoubleDash) { rest.push(a); continue; }
    if (a === '--') { afterDoubleDash = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional, rest };
}

// -------------------------------------------------------------------- output

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`, grn: (s) => `\x1b[32m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, red: (s) => s, yel: (s) => s, grn: (s) => s };

const DOT = { waiting: () => c.red('●'), busy: () => c.yel('●'), idle: () => c.grn('●'), offline: () => c.dim('○') };

function usage() {
  console.log(`
${c.b('signalhead')} — a red/yellow/green lamp that floats over everything and
tells you what your AI coding agents are doing.

  ${c.red('●')} red     an agent stopped and needs you (permission, question, choice)
  ${c.yel('●')} yellow  an agent is working
  ${c.grn('●')} green   an agent finished and is ready for the next task

${c.b('USAGE')}
  sig start                    start the server and the floating overlay
  sig server                   state server only (no window)
  sig overlay                  overlay only (server must already run)
  sig stop                     shut everything down

  sig install claude           wire into Claude Code hooks   ${c.dim('(exact)')}
  sig install codex            wire into Codex notify        ${c.dim('(red + green)')}
  sig install generic          print snippets for any other tool
  sig uninstall claude|codex   remove those again

  sig wrap -- <command>        run any agent in a watched terminal
                                ${c.dim('e.g. sig wrap -- gemini')}

  sig watch codex              read Codex's own session logs  ${c.dim('(all 3 lamps)')}

  sig set <busy|waiting|idle|offline> [--agent name] [--session id] [--detail text]
  sig fuel <percent> [--used] [--agent name] [--label text]
                                drive the fuel gauge from anything
  sig status                   print current lights
  sig clear [--session id]     forget sessions left behind by a crashed agent
  sig setup                    download the Electron runtime for the window
  sig doctor                   check this machine is wired up correctly
  sig demo                     cycle the lamps to check the overlay works

${c.b('OPTIONS')}
  --port <n>       server port (default ${config.DEFAULTS.port})
  --scope project  install hooks into ./.claude instead of ~/.claude
  --agent <name>   label shown next to the lamp
  --no-overlay     for \`start\`: server only
  --browser        for \`start\`: open the light in a browser tab instead of a window
`);
}

// ------------------------------------------------------------------ commands

async function cmdServer(flags, { detached = false } = {}) {
  const { start } = require('./server');
  const port = Number(flags.port) || config.port();
  const { port: bound } = await start({ port });
  if (!detached) console.log(`${c.grn('●')} server listening on http://127.0.0.1:${bound}`);
  return bound;
}

function spawnOverlay(port) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    return null;
  }
  const child = spawn(String(electron), [path.join(ROOT, 'src', 'overlay', 'main.js')], {
    cwd: ROOT,
    env: { ...process.env, SIGNALHEAD_PORT: String(port), ELECTRON_NO_ATTACH_CONSOLE: '1' },
    stdio: 'ignore',
    detached: false,
  });
  child.on('error', () => {});
  return child;
}

async function cmdStart(flags) {
  const port = Number(flags.port) || config.port();

  const running = await client.health();
  if (running) {
    console.log(`${c.dim('server already running on port ' + running.port)}`);
  } else {
    await cmdServer({ port });
  }

  // Nothing else to wait on, but the server lives in this process — stay up.
  const hold = () => new Promise(() => {});
  if (flags['no-overlay']) return hold();

  if (flags.browser) {
    const url = `http://127.0.0.1:${port}/`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { shell: process.platform === 'win32', stdio: 'ignore' }).on('error', () => {});
    console.log(`overlay in browser: ${url}`);
    return hold();
  }

  const child = spawnOverlay(port);
  if (!child) {
    console.log(`${c.yel('!')} Electron is not installed, so there is no floating window.`);
    console.log(`  ${c.dim('npm install')}  inside ${ROOT}`);
    console.log(`  ${c.dim('or use')} sig start --browser  ${c.dim('for a browser overlay')}`);
    return hold();
  }

  console.log(`${c.grn('●')} traffic light up. Drag it anywhere; hover for controls.`);
  console.log(c.dim(`  server  http://127.0.0.1:${port}`));
  console.log(c.dim('  stop    sig stop'));
  child.on('exit', () => process.exit(0));
}

async function cmdOverlay(flags) {
  const port = Number(flags.port) || config.port();
  const running = await client.health();
  if (!running) {
    console.error(`${c.red('●')} no server on port ${port}. Run: sig start`);
    process.exit(1);
  }
  const child = spawnOverlay(port);
  if (!child) {
    console.error('Electron is not installed. Run `npm install` here, or `sig start --browser`.');
    process.exit(1);
  }
  child.on('exit', (code) => process.exit(code || 0));
}

async function cmdStop() {
  const running = await client.health();
  if (!running) return console.log(c.dim('nothing running'));
  await client.quitServer();
  console.log('stopped');
}

async function cmdSet(positional, flags) {
  const state = positional[0];
  if (!state) { console.error('usage: sig set <busy|waiting|idle|offline>'); process.exit(1); }
  const res = await client.setState({
    state,
    agent: flags.agent || 'agent',
    session: flags.session || `${flags.agent || 'agent'}:manual`,
    detail: flags.detail || '',
    cwd: flags.cwd || '',
  });
  if (!res) console.error(c.dim('(no server listening — start it with `sig start`)'));
}

async function cmdFuel(positional, flags) {
  const raw = Number(positional[0]);
  if (!Number.isFinite(raw)) {
    console.error('usage: sig fuel <percent-remaining> [--used] [--agent name] [--label text]');
    process.exit(1);
  }
  // --used lets a reporter that counts consumption skip the arithmetic.
  const remaining = flags.used ? 100 - raw : raw;
  const agent = flags.agent || 'agent';
  const res = await client.setState({
    session: flags.session || `${agent}:manual`,
    agent,
    fuel: { remaining, label: flags.label || 'remaining' },
    ...(flags.state ? { state: flags.state } : {}),
  });
  if (!res) console.error(c.dim('(no server listening — start it with `sig start`)'));
}

async function cmdClear(flags) {
  if (flags.session) {
    await client.setState({ session: flags.session, state: 'offline' });
    console.log(`cleared ${flags.session}`);
    return;
  }
  const res = await client.post('/clear', {});
  if (!res) return console.error(c.dim('(no server listening)'));
  console.log('cleared all sessions');
}

async function cmdStatus() {
  const snap = await client.snapshot();
  if (!snap) { console.log(`${c.dim('○')} server not running`); return; }
  console.log(`${DOT[snap.overall]()} ${c.b(snap.overall)}`);
  if (!snap.sessions.length) return console.log(c.dim('  no active agents'));
  for (const s of snap.sessions) {
    const age = Math.round((Date.now() - s.since) / 1000);
    const note = s.stale ? 'no finish signal — assumed done'
      : s.quiet ? `${s.detail || ''} (silent ${Math.round(s.quietFor / 60000)}m)`.trim()
      : s.detail || '';
    console.log(`  ${DOT[s.state]()} ${s.agent.padEnd(10)} ${String(s.state).padEnd(8)} ${c.dim(`${age}s  ${note}`)}`);
  }
}

async function cmdDemo() {
  const seq = [
    ['busy', 'reading files'],
    ['busy', 'editing src/server.js'],
    ['waiting', 'wants to run a command'],
    ['idle', ''],
  ];
  for (const [state, detail] of seq) {
    process.stdout.write(`${DOT[state]()} ${state}${detail ? ' — ' + detail : ''}\n`);
    await client.setState({ state, detail, agent: 'demo', session: 'demo:1' });
    await new Promise((r) => setTimeout(r, 2200));
  }
  await client.setState({ state: 'offline', session: 'demo:1' });
  console.log(c.dim('demo done'));
}

function cmdInstall(positional, flags) {
  const target = (positional[0] || '').toLowerCase();
  const scope = flags.scope === 'project' ? 'project' : 'user';

  if (target === 'claude') {
    const r = install.installClaude({ scope });
    console.log(`${c.grn('●')} Claude Code hooks installed (${r.events} events)`);
    console.log(c.dim(`  ${r.file}`));
    if (r.backup) console.log(c.dim(`  backup: ${r.backup}`));
    console.log(c.dim('  Restart Claude Code, or run /hooks there, to pick them up.'));
    return;
  }
  if (target === 'codex') {
    const r = install.installCodex();
    console.log(`${c.grn('●')} Codex notify hook installed`);
    console.log(c.dim(`  ${r.file}`));
    if (r.backup) console.log(c.dim(`  backup: ${r.backup}`));
    console.log(c.dim('  Codex only notifies on turn end / approval, so you get red and green.'));
    console.log(c.dim('  For a yellow "working" lamp too: sig wrap -- codex'));
    return;
  }
  if (target === 'generic') {
    console.log(install.genericSnippet(flags.agent || 'my-agent'));
    return;
  }
  console.error('usage: sig install <claude|codex|generic>');
  process.exit(1);
}

function cmdUninstall(positional, flags) {
  const target = (positional[0] || '').toLowerCase();
  const scope = flags.scope === 'project' ? 'project' : 'user';
  if (target === 'claude') {
    const r = install.uninstallClaude({ scope });
    console.log(`removed traffic-light hooks from ${r.file}`);
    return;
  }
  if (target === 'codex') {
    const r = install.uninstallCodex();
    console.log(`removed traffic-light notify from ${r.file}`);
    return;
  }
  console.error('usage: sig uninstall <claude|codex>');
  process.exit(1);
}

// ---------------------------------------------------------------------- main

async function main() {
  const { flags, positional, rest } = parse(process.argv.slice(2));
  const cmd = positional.shift();

  if (flags.port) process.env.SIGNALHEAD_PORT = String(Number(flags.port));

  switch (cmd) {
    case 'start':      return cmdStart(flags);
    case 'server':     return cmdServer(flags).then(() => new Promise(() => {}));
    case 'overlay':    return cmdOverlay(flags);
    case 'stop':       return cmdStop();
    case 'set':        return cmdSet(positional, flags);
    case 'status':     return cmdStatus();
    case 'clear':      return cmdClear(flags);
    case 'doctor':     return require('./doctor').run();
    case 'setup':      return require('child_process')
                         .spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
    case 'fuel':       return cmdFuel(positional, flags);
    case 'demo':       return cmdDemo();
    case 'install':    return cmdInstall(positional, flags);
    case 'uninstall':  return cmdUninstall(positional, flags);
    case 'watch': {
      const target = (positional[0] || '').toLowerCase();
      if (target !== 'codex') {
        console.error('usage: sig watch codex');
        process.exit(1);
      }
      require('./adapters/codex-watch').run(flags);
      return new Promise(() => {});
    }
    case 'wrap': {
      const argv = rest.length ? rest : positional;
      if (!argv.length) { console.error('usage: sig wrap -- <command> [args...]'); process.exit(1); }
      return require('./adapters/wrap').run(argv, flags);
    }
    case 'help':
    case undefined:    return usage();
    default:
      console.error(`unknown command "${cmd}"`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
