'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { start } = require('../src/server');
const install = require('../src/adapters/install');

const HOOK = path.join(__dirname, '..', 'src', 'hooks', 'claude.js');

// Port 0 lets the OS pick a free one. A fixed port collides with the user's own
// running traffic light, which is exactly the kind of failure that only shows up
// on someone else's machine.
let server;
let PORT;
before(async () => {
  ({ server } = await start({ port: 0, staleBusyMs: 500 }));
  PORT = server.address().port;
});
after(() => server && server.close());

const api = async (p, init) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
  return r.json();
};

// Deliberately async. execFileSync blocks this process's event loop, so the
// server running in it cannot answer the hook's request — every hook then times
// out and the lamp never moves. The real agent does not block our server, so a
// synchronous helper tests a situation that never happens.
const fire = (event) =>
  new Promise((resolve, reject) => {
    const cp = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, SIGNALHEAD_PORT: String(PORT), SIGNALHEAD_LOG: '0' }, timeout: 5000 },
      (err) => (err ? reject(err) : resolve())
    );
    cp.stdin.end(JSON.stringify(event));
  });

const stateOf = async (sid) =>
  (await api('/state')).sessions.find((s) => s.session === `claude:${sid}`)?.state ?? null;

test('server reports health and starts empty', async () => {
  assert.equal((await api('/health')).ok, true);
  assert.equal((await api('/state')).overall, 'offline');
});

test('a full Claude turn drives the lamp end to end', async () => {
  const sid = 'turn-1';
  await fire({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy', 'prompt submitted -> working');

  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy');

  await fire({ session_id: sid, hook_event_name: 'Notification', message: 'needs permission', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'waiting', 'permission prompt -> needs you');

  await fire({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy', 'answered -> working again');

  await fire({ session_id: sid, hook_event_name: 'Stop', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'idle', 'turn finished -> ready');
});

// Regression: SubagentStop lands a few seconds AFTER Stop at the end of a turn.
// Mapping it to busy turned the lamp green then immediately back to yellow, where
// it stuck. This is the single worst bug this project has had.
test('SubagentStop after Stop must not revive a finished session', async () => {
  const sid = 'turn-2';
  await fire({ session_id: sid, hook_event_name: 'Stop' });
  assert.equal(await stateOf(sid), 'idle');

  await fire({ session_id: sid, hook_event_name: 'SubagentStop' });
  assert.equal(await stateOf(sid), 'idle', 'still green three seconds later');
});

// Regression: unknown events used to fall back to busy, so one unexpected payload
// pinned the lamp yellow with no way to tell why.
test('an unrecognised event leaves the last good state alone', async () => {
  const sid = 'turn-3';
  await fire({ session_id: sid, hook_event_name: 'Stop' });
  assert.equal(await stateOf(sid), 'idle');

  await fire({ session_id: sid, hook_event_name: 'SomeFutureHook' });
  assert.equal(await stateOf(sid), 'idle');
});

test('SessionEnd clears the session', async () => {
  const sid = 'turn-4';
  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(await stateOf(sid), 'busy');
  await fire({ session_id: sid, hook_event_name: 'SessionEnd' });
  assert.equal(await stateOf(sid), null);
});

test('the shell one-liner API works for any tool', async () => {
  await api('/set/busy?agent=ci&session=pipeline&detail=building');
  const s = (await api('/state')).sessions.find((x) => x.session === 'pipeline');
  assert.equal(s.state, 'busy');
  assert.equal(s.agent, 'ci');
  assert.equal(s.detail, 'building');

  await api('/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'pipeline', state: 'offline' }),
  });
  assert.equal((await api('/state')).sessions.find((x) => x.session === 'pipeline'), undefined);
});

test('a bad state is rejected, not silently accepted', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'z', state: 'chartreuse' }),
  });
  assert.equal(r.status, 400);
});

test('the overlay page is served for browser mode', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /AI Traffic Light/);
});

// The CLI is a scripting surface: people wire it into their own tooling. A
// rejected value that prints nothing and exits 0 is the worst possible
// behaviour there — the script "works" and the lamp never moves.
test('the CLI reports a rejected state instead of failing silently', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args],
        { env: { ...process.env, SIGNALHEAD_PORT: String(PORT) } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });

  const bad = await run(['set', 'chartreuse', '--agent', 'x']);
  assert.equal(bad.code, 1, 'a rejected state must exit non-zero');
  assert.match(bad.stderr, /unknown state/, 'and must say why');

  const good = await run(['set', 'busy', '--agent', 'x']);
  assert.equal(good.code, 0);
  assert.equal(good.stderr.trim(), '');
});

// -------------------------------------------------------------- installer

// Hook commands carry an absolute path into this install. When that install is
// a git checkout, every hook invocation executes a file inside it — which holds
// the folder open on Windows and breaks the day the checkout moves. The
// installer has to say so rather than let people find out.
test('installing from a checkout reports that it did', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-checkout-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('.claude');
    fs.writeFileSync(path.join('.claude', 'settings.json'), '{}');
    const r = install.installClaude({ scope: 'project' });
    // This repo is itself a checkout, so the flag must be set and must name the
    // directory the user would need to stop using.
    assert.equal(r.fromCheckout, install.isCheckout(), 'flag reflects reality');
    assert.ok(r.root, 'and says which directory it means');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installing hooks preserves existing config and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-inst-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('.claude');
    fs.writeFileSync(
      path.join('.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      })
    );

    install.installClaude({ scope: 'project' });
    install.installClaude({ scope: 'project' });
    install.installClaude({ scope: 'project' });

    const after = JSON.parse(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf8'));
    const ours = Object.values(after.hooks).flat().flatMap((g) => g.hooks)
      .filter((h) => /hooks[\\/]claude\.js/.test(h.command));
    assert.equal(ours.length, 9, 'nine events, no duplicates after three installs');
    assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings untouched');
    assert.ok(
      Object.values(after.hooks).flat().flatMap((g) => g.hooks).some((h) => h.command === 'echo mine'),
      'the user\'s own hook survived'
    );

    install.uninstallClaude({ scope: 'project' });
    const restored = JSON.parse(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(restored.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    assert.deepEqual(restored.permissions, { allow: ['Bash(ls:*)'] });
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
