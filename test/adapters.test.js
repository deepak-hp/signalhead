'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { profileFor, stripAnsi, PROFILES } = require('../src/adapters/patterns');
const { classify } = require('../src/adapters/codex-watch');

// ---------------------------------------------------------------- patterns

test('agent profiles resolve from however the binary is named', () => {
  assert.equal(profileFor('gemini').name, 'gemini');
  assert.equal(profileFor('/usr/local/bin/claude').name, 'claude');
  assert.equal(profileFor('C:\\Users\\x\\AppData\\npm\\cursor-agent.cmd').name, 'cursor');
  assert.equal(profileFor('totally-unknown-agent').name, 'totally-unknown-agent');
  assert.deepEqual(profileFor('totally-unknown-agent').waiting, PROFILES.default.waiting);
});

test('ANSI is stripped so patterns match what the user actually sees', () => {
  assert.equal(stripAnsi('\u001b[1;32mDone\u001b[0m'), 'Done');
  assert.equal(stripAnsi('\u001b]0;window title\u0007text'), 'text');
  assert.equal(stripAnsi('plain'), 'plain');
});

const hits = (rules, s) => rules.some((re) => re.test(s));

test('real confirmation prompts are recognised as waiting', () => {
  const p = profileFor('default');
  for (const prompt of [
    'Do you want to proceed? (y/n)',
    'Apply this change? [y/N]',
    'Allow Bash to run this command?',
    '  1. Yes\n  2. No\n❯ 1. Yes',
    'Press Enter to continue',
    'Waiting for your confirmation',
  ]) {
    assert.ok(hits(p.waiting, prompt), `should be waiting: ${JSON.stringify(prompt)}`);
  }
});

test('ordinary output is not mistaken for a prompt', () => {
  const p = profileFor('default');
  for (const line of [
    'Reading src/server.js',
    'Wrote 42 lines to disk.',
    'All tests passed.',
    'Committed as a1b2c3d',
  ]) {
    assert.ok(!hits(p.waiting, line), `should NOT be waiting: ${JSON.stringify(line)}`);
  }
});

test('silent thinking still reads as busy', () => {
  const p = profileFor('claude');
  assert.ok(hits(p.busy, '⠹ Thinking…'));
  assert.ok(hits(p.busy, '(esc to interrupt)'));
});

// ------------------------------------------------------------------ codex

test('codex events map to the three lamps', () => {
  assert.equal(classify('task_started'), 'busy');
  assert.equal(classify('task_complete'), 'idle');
  assert.equal(classify('task_aborted'), 'idle');
  assert.equal(classify('exec_approval_request'), 'waiting');
  assert.equal(classify('apply_patch_approval_request'), 'waiting');
});

// Same class of bug as Claude's SubagentStop: an event arriving after the turn
// ended must not be able to change the lamp.
test('ambient codex events are inert and cannot revive a finished session', () => {
  for (const t of ['token_count', 'agent_message', 'agent_reasoning', 'web_search_end', 'mcp_tool_call_end']) {
    assert.equal(classify(t), null, `${t} must not decide state`);
  }
});

// ------------------------------------------------------- claude hook mapping

const HOOK = path.join(__dirname, '..', 'src', 'hooks', 'claude.js');

// Runs the hook with no server listening: it must still exit 0 and stay silent,
// because a hook that fails or hangs stalls the agent it is supposed to watch.
function runHook(event) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    env: { ...process.env, AITL_PORT: '4999', AITL_LOG: '0' },
    encoding: 'utf8',
    timeout: 5000,
  });
  return out;
}

test('hook never breaks the agent when the light is not running', () => {
  for (const name of ['Stop', 'PreToolUse', 'Notification', 'SubagentStop', 'WhoKnows']) {
    assert.doesNotThrow(() => runHook({ session_id: 't', hook_event_name: name }), name);
  }
});

test('hook survives malformed input', () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [HOOK], {
      input: 'not json at all',
      env: { ...process.env, AITL_PORT: '4999', AITL_LOG: '0' },
      encoding: 'utf8',
      timeout: 5000,
    })
  );
});
