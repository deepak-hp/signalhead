#!/usr/bin/env node
'use strict';
// Claude Code hook adapter.
//
// Claude Code pipes a JSON event on stdin for every lifecycle hook. One script
// handles them all and maps each to a lamp. Registered by `aitl install claude`.
//
// Never fail loudly: a hook that errors or hangs stalls the agent it watches.

const fs = require('fs');
const path = require('path');
const { setState } = require('../client');
const { DIR, ensureDir } = require('../config');

// Every event that arrives, appended to ~/.ai-traffic-light/hook-events.log.
// Cheap, and the only way to see what an agent actually sends versus what its
// docs claim. Set AITL_LOG=0 to turn it off.
function log(line) {
  if (process.env.AITL_LOG === '0') return;
  try {
    ensureDir();
    const file = path.join(DIR, 'hook-events.log');
    try { if (fs.statSync(file).size > 256 * 1024) fs.truncateSync(file, 0); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break the agent */ }
}

const EVENT_STATE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  PreCompact: 'busy',
  Notification: 'waiting',   // permission prompt / "Claude is waiting for your input"
  Stop: 'idle',              // turn finished, ready for a new task
  SessionEnd: 'offline',
};

// Events that say nothing reliable about the main agent's state.
//
// SubagentStop looks like it means "a subagent finished, so the parent is still
// working" — but it lands a few seconds *after* Stop at the end of a turn. Mapping
// it to busy turned the lamp yellow again the instant it went green, and left it
// there. The main agent's own Pre/PostToolUse and Stop already track it exactly,
// so this adds nothing but a race.
const IGNORED = new Set(['SubagentStop']);

function detailFor(evt) {
  switch (evt.hook_event_name) {
    case 'PreToolUse':
      return evt.tool_name ? `running ${evt.tool_name}` : 'running a tool';
    case 'PostToolUse':
      return 'thinking';
    case 'UserPromptSubmit':
      return 'thinking';
    case 'Notification':
      return String(evt.message || 'needs your confirmation').slice(0, 80);
    case 'PreCompact':
      return 'compacting context';
    case 'Stop':
      return '';
    default:
      return '';
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let evt = {};
  let parsed = true;
  try { evt = JSON.parse(raw || '{}'); } catch { parsed = false; }

  const name = evt.hook_event_name;
  const sid = String(evt.session_id || 'default').slice(0, 8);

  if (IGNORED.has(name)) {
    log(`${name} ignored [${sid}]`);
    return;
  }

  // An unrecognised event used to fall back to "busy", which pinned the lamp
  // yellow forever whenever anything unexpected arrived. Ignoring it instead
  // leaves the last known-good state alone.
  if (!Object.prototype.hasOwnProperty.call(EVENT_STATE, name)) {
    log(`UNKNOWN event=${JSON.stringify(name)} parsed=${parsed} keys=${Object.keys(evt).join(',')} raw=${raw.slice(0, 200)}`);
    return;
  }

  const state = EVENT_STATE[name];
  const cwd = evt.cwd || process.cwd();
  log(`${name} -> ${state}${evt.tool_name ? ' (' + evt.tool_name + ')' : ''} [${sid}]`);

  await setState({
    session: evt.session_id ? `claude:${evt.session_id}` : 'claude:default',
    agent: 'claude',
    state,
    detail: detailFor(evt),
    cwd: path.basename(cwd) || cwd,
  });
}

// Hard stop so a wedged socket can never hold the agent hostage.
const bail = setTimeout(() => process.exit(0), 1500);
bail.unref?.();

main().then(() => process.exit(0)).catch(() => process.exit(0));
