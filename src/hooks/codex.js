#!/usr/bin/env node
'use strict';
// Codex CLI adapter.
//
// Codex calls the program in `notify` with a single JSON argument describing the
// event. It only fires on notable moments (turn finished, approval needed), so
// this adapter drives red and green. For a yellow "working" lamp as well, run
// Codex through `sig wrap -- codex` instead.

const { setState } = require('../client');

function classify(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('approval') || t.includes('request') || t.includes('input')) return 'waiting';
  if (t.includes('complete') || t.includes('finish') || t.includes('done')) return 'idle';
  return 'idle';
}

async function main() {
  let evt = {};
  const arg = process.argv.slice(2).join(' ').trim();
  if (arg) { try { evt = JSON.parse(arg); } catch { /* keep defaults */ } }

  const state = classify(evt.type);
  await setState({
    session: evt['thread-id'] || evt.thread_id || evt.session_id
      ? `codex:${evt['thread-id'] || evt.thread_id || evt.session_id}`
      : 'codex:default',
    agent: 'codex',
    state,
    detail: state === 'waiting' ? 'needs approval' : '',
    cwd: evt.cwd || '',
  });
}

const bail = setTimeout(() => process.exit(0), 1500);
bail.unref?.();

main().then(() => process.exit(0)).catch(() => process.exit(0));
