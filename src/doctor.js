'use strict';
// `sig doctor` — checks an install on whatever machine it is run on.
//
// The test suite proves the logic is correct. This proves *this* machine is
// wired up: the right binaries, the right paths in the right config files, a
// reachable server. Those are the things that differ between a Mac and a PC,
// and they are exactly what a user cannot debug from a lamp that just sits there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const client = require('./client');
const install = require('./adapters/install');

const ROOT = path.resolve(__dirname, '..');

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const MARK = {
  pass: paint(32, 'PASS'),
  warn: paint(33, 'WARN'),
  fail: paint(31, 'FAIL'),
};

const results = [];
function check(name, status, detail, fix) {
  results.push({ name, status, detail, fix });
  console.log(`  ${MARK[status]}  ${name}`);
  if (detail) console.log(`        ${paint(2, detail)}`);
  if (fix && status !== 'pass') console.log(`        ${paint(36, '-> ' + fix)}`);
}

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

async function run() {
  console.log(`\nsignalhead doctor — ${process.platform} ${os.release()}, node ${process.version}\n`);

  // ---- runtime
  const major = Number(process.versions.node.split('.')[0]);
  check('Node version', major >= 18 ? 'pass' : 'fail', `node ${process.version}`,
    'install Node 18 or newer');

  // ---- writable state dir
  try {
    config.ensureDir();
    const probe = path.join(config.DIR, '.probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    check('State directory writable', 'pass', config.DIR);
  } catch (e) {
    check('State directory writable', 'fail', `${config.DIR}: ${e.message}`,
      'check permissions on your home directory');
  }

  // ---- server
  const health = await client.health();
  if (health) {
    check('Server running', 'pass', `http://127.0.0.1:${health.port} (pid ${health.pid})`);
    const snap = await client.snapshot();
    check('Live state readable', snap ? 'pass' : 'fail',
      snap ? `overall: ${snap.overall}, ${snap.sessions.length} session(s)` : 'no response');
  } else {
    check('Server running', 'warn', `nothing listening on port ${config.port()}`, 'sig start');
  }

  // ---- overlay runtime
  let electronPath = null;
  try {
    const p = require('electron');
    electronPath = typeof p === 'string' && exists(p) ? p : null;
  } catch { /* not installed */ }
  check('Electron (floating window)', electronPath ? 'pass' : 'warn',
    electronPath || 'not installed — the desktop window is unavailable',
    'npm run setup   (or use: sig start --browser)');

  // ---- universal wrapper
  let pty = false;
  try { require('node-pty'); pty = true; } catch { /* optional */ }
  check('node-pty (sig wrap)', pty ? 'pass' : 'warn',
    pty ? 'available — `sig wrap` works for any CLI agent' : 'not built for this Node version',
    'npm install node-pty   (needs a C++ toolchain)');

  // ---- Claude Code hooks
  for (const scope of ['user', 'project']) {
    const file = install.claudeSettingsPath(scope);
    if (!exists(file)) {
      if (scope === 'user') check('Claude Code hooks (user)', 'warn', `no ${file}`, 'sig connect claude');
      continue;
    }
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      check(`Claude Code settings (${scope})`, 'fail', `${file} is not valid JSON: ${e.message}`,
        'fix or restore the file from its .signalhead-backup-* copy');
      continue;
    }

    const ours = Object.entries(settings.hooks || {})
      .flatMap(([evt, groups]) => (groups || []).flatMap((g) => (g.hooks || []).map((h) => ({ evt, cmd: h.command || '' }))))
      .filter((h) => /hooks[\\/]claude\.js/.test(h.cmd));

    if (!ours.length) {
      if (scope === 'user') check('Claude Code hooks (user)', 'warn', 'not installed', 'sig connect claude');
      continue;
    }

    const events = [...new Set(ours.map((h) => h.evt))];
    check(`Claude Code hooks (${scope})`, events.length >= 8 ? 'pass' : 'warn',
      `${events.length} events in ${file}`,
      events.length >= 8 ? null : 'sig connect claude   (re-run to add the missing events)');

    // The single most common cross-machine failure: the hook points at a node
    // binary or script path that does not exist on this machine (moved checkout,
    // reinstalled node, config synced from another computer).
    const cmd = ours[0].cmd;
    const quoted = cmd.match(/"([^"]+)"/g) || [];
    const [bin, script] = quoted.map((q) => q.slice(1, -1));
    check('  hook interpreter exists', exists(bin) ? 'pass' : 'fail', bin || '(unparsed)',
      'sig connect claude   (rewrites the paths for this machine)');
    check('  hook script exists', exists(script) ? 'pass' : 'fail', script || '(unparsed)',
      'sig connect claude   (rewrites the paths for this machine)');
    if (script && !script.startsWith(ROOT.replace(/\\/g, '/'))) {
      check('  hook points at this checkout', 'warn',
        `points outside ${ROOT}`, 'sig connect claude   (if you moved the project)');
    }

    // Hooks fire on every tool call. If they run a script from a git checkout,
    // that folder is held open for as long as an agent is working — on Windows
    // it cannot then be renamed or deleted, and other applications touching it
    // report "file in use". They also break the day the checkout moves.
    if (script && install.isCheckout() && script.startsWith(ROOT.replace(/\\/g, '/'))) {
      check('  hooks run from a working checkout', 'warn',
        `${ROOT} is held open while any agent runs`,
        'npm install -g signalhead && sig connect claude');
    }
  }

  // ---- Codex
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessions = path.join(codexHome, 'sessions');
  if (exists(sessions)) {
    check('Codex session logs', 'pass', sessions);
    check('  -> full three-lamp support', 'pass', 'run: sig watch codex');
  } else if (exists(codexHome)) {
    check('Codex session logs', 'warn', `${codexHome} exists but no sessions/ yet`,
      'run Codex once, then: sig watch codex');
  } else {
    check('Codex', 'warn', 'not installed on this machine', null);
  }

  // ---- summary
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n  ${results.length} checks — ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail\n`);
  if (fails) {
    console.log(`  ${paint(31, 'Something is broken above.')} Fix the FAIL lines first.\n`);
    process.exitCode = 1;
  } else if (warns) {
    console.log(`  ${paint(33, 'Usable, with optional pieces missing.')}\n`);
  } else {
    console.log(`  ${paint(32, 'Everything checks out.')}\n`);
  }
}

module.exports = { run };
