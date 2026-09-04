'use strict';
// Wires the traffic light into an agent's own hook system, so state comes from
// the agent itself rather than from guessing at its output.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = os.homedir();
// Our own entries are recognised by the hook script they point at, so uninstall
// still works if the checkout gets renamed or moved.
const isOurs = (cmd) => /signalhead|src[\\/]+hooks[\\/]+(?:claude|codex)\.js/.test(String(cmd || ''));

const hookScript = (name) => path.join(ROOT, 'src', 'hooks', `${name}.js`).replace(/\\/g, '/');
const nodeBin = process.execPath.replace(/\\/g, '/');
const cmdFor = (name) => `"${nodeBin}" "${hookScript(name)}"`;

// Hook commands carry an absolute path to a script in this install. If that
// install is a working checkout, every hook invocation — and they fire on every
// tool call — executes a file inside it, which on Windows holds the folder open
// and makes it unrenameable. Worse, the hooks break silently the day the
// checkout moves. A global install lives somewhere stable and outside any
// project, which is where hook paths belong.
const isCheckout = () => fs.existsSync(path.join(ROOT, '.git'));

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.signalhead-backup-${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------- Claude Code

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
];
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse', 'PreCompact']);

function claudeSettingsPath(scope) {
  return scope === 'project'
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(HOME, '.claude', 'settings.json');
}

function stripOurs(groups = []) {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
    .filter((g) => (g.hooks || []).length > 0);
}

function installClaude({ scope = 'user' } = {}) {
  const file = claudeSettingsPath(scope);
  const bak = backup(file);
  const settings = readJson(file);
  settings.hooks = settings.hooks || {};

  for (const event of CLAUDE_EVENTS) {
    const existing = stripOurs(settings.hooks[event] || []);
    const entry = { hooks: [{ type: 'command', command: cmdFor('claude'), timeout: 5 }] };
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*';
    settings.hooks[event] = [...existing, entry];
  }

  writeJson(file, settings);
  return { file, backup: bak, events: CLAUDE_EVENTS.length, fromCheckout: isCheckout(), root: ROOT };
}

function uninstallClaude({ scope = 'user' } = {}) {
  const file = claudeSettingsPath(scope);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const bak = backup(file);
  const settings = readJson(file);
  let removed = 0;

  for (const event of Object.keys(settings.hooks || {})) {
    const before = JSON.stringify(settings.hooks[event]);
    const after = stripOurs(settings.hooks[event]);
    if (JSON.stringify(after) !== before) removed++;
    if (after.length) settings.hooks[event] = after;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeJson(file, settings);
  return { file, backup: bak, removed };
}

// --------------------------------------------------------------------- Codex

function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
}

function installCodex() {
  const file = codexConfigPath();
  const bak = backup(file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  // `notify` is a top-level key, so it has to sit above the first [table] header.
  const lines = existing.split(/\r?\n/).filter((l) => !/^\s*notify\s*=/.test(l));
  const notify = `notify = ["${nodeBin}", "${hookScript('codex')}"]`;
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable === -1) lines.push(notify);
  else lines.splice(firstTable, 0, notify, '');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n').trimStart() + '\n');
  return { file, backup: bak, fromCheckout: isCheckout(), root: ROOT };
}

function uninstallCodex() {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const bak = backup(file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = lines.filter((l) => !(/^\s*notify\s*=/.test(l) && isOurs(l)));
  fs.writeFileSync(file, kept.join('\n'));
  return { file, backup: bak, removed: lines.length - kept.length };
}

// ------------------------------------------------------------------- Generic

// For agents with no hook system and no need for a full wrapper: print the two
// commands to drop into whatever start/finish hook the tool does offer.
function genericSnippet(agent = 'my-agent') {
  const set = (state) => `"${nodeBin}" "${path.join(ROOT, 'src', 'cli.js').replace(/\\/g, '/')}" set ${state} --agent ${agent}`;
  return [
    '# when the agent starts working',
    set('busy'),
    '',
    '# when it needs a human',
    set('waiting'),
    '',
    '# when it finishes a turn',
    set('idle'),
    '',
    '# or straight over HTTP, from anything at all:',
    `curl -s "http://127.0.0.1:4747/set/busy?agent=${agent}&session=$$"`,
  ].join('\n');
}

module.exports = {
  isCheckout,
  installClaude,
  uninstallClaude,
  installCodex,
  uninstallCodex,
  genericSnippet,
  claudeSettingsPath,
  codexConfigPath,
};
