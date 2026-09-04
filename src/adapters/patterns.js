'use strict';
// Output signatures used by `sig wrap` to read any CLI agent's state.
//
// The wrapper watches a rolling tail of the agent's terminal output:
//   * output is flowing            -> busy
//   * output went quiet, and the   -> waiting   (a prompt is on screen)
//     tail matches a `waiting` rule
//   * output went quiet, and the   -> busy      (thinking silently)
//     tail matches a `busy` rule
//   * output went quiet otherwise  -> idle
//
// To support a new agent, add a profile here — nothing else needs to change.

// Prompts that mean "a human has to answer this before anything else happens".
const COMMON_WAITING = [
  /\(y(?:es)?\s*\/\s*n(?:o)?\)/i,
  /\[y\/n\]/i,
  /\by\/n\b\s*[:?]/i,
  /do you want to (proceed|continue|allow|apply|run|make)/i,
  /\b(allow|approve|permit)\b[^\n]{0,60}\?/i,
  /waiting for (your )?(input|confirmation|approval|response)/i,
  /press\s+(enter|return)\s+to\s+(continue|confirm)/i,
  /(^|\n)\s*[❯>]\s*\d+\.\s/,          // numbered choice menu with a cursor
  /\b(confirm|confirmation) required\b/i,
  /continue\?\s*$/i,
];

// Signals that the agent is still thinking even though nothing is printing.
const COMMON_BUSY = [
  /esc(ape)?\s+to\s+(interrupt|cancel|stop)/i,
  /ctrl\+c\s+to\s+(interrupt|cancel|stop)/i,
  /\b(thinking|working|generating|running|executing|analyzing|searching)[.…]{1,3}/i,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/,        // braille spinners
];

const PROFILES = {
  default: {
    idleAfterMs: 1400,
    waiting: COMMON_WAITING,
    busy: COMMON_BUSY,
  },

  claude: {
    idleAfterMs: 1200,
    waiting: [
      ...COMMON_WAITING,
      /do you want to (make this edit|create|run this command)/i,
      /\byes,?\s+and\s+don'?t\s+ask\s+again\b/i,
    ],
    busy: [...COMMON_BUSY, /\(esc to interrupt\)/i, /tokens?\s*·\s*esc/i],
  },

  codex: {
    idleAfterMs: 1400,
    waiting: [...COMMON_WAITING, /allow command\?/i, /requires approval/i],
    busy: [...COMMON_BUSY, /working\b/i],
  },

  gemini: {
    idleAfterMs: 1400,
    waiting: [...COMMON_WAITING, /apply this change\?/i, /allow execution\?/i],
    busy: COMMON_BUSY,
  },

  aider: {
    idleAfterMs: 1200,
    waiting: [
      ...COMMON_WAITING,
      /^\s*(add|edit|create|run|commit)[^\n]{0,80}\?\s*$/im,
      /\(Y\)es\/\(N\)o/i,
    ],
    busy: COMMON_BUSY,
  },

  cursor: { idleAfterMs: 1400, waiting: COMMON_WAITING, busy: COMMON_BUSY },
  opencode: { idleAfterMs: 1400, waiting: COMMON_WAITING, busy: COMMON_BUSY },
  copilot: { idleAfterMs: 1400, waiting: COMMON_WAITING, busy: COMMON_BUSY },
};

// Map an executable name onto a profile: `cursor-agent` -> cursor, `gemini` -> gemini.
function profileFor(command = '') {
  const name = String(command).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  for (const key of Object.keys(PROFILES)) {
    if (key !== 'default' && name.includes(key)) return { name: key, ...PROFILES[key] };
  }
  return { name: name || 'agent', ...PROFILES.default };
}

// A regex literal on purpose. Built from a string every backslash needs doubling,
// and an earlier version silently lost them: \d became a literal "d", so the
// pattern matched almost nothing and ANSI codes reached the matchers untouched.
//   CSI  ESC [ params intermediates final
//   OSC  ESC ] ... BEL   or   ESC ] ... ESC backslash
//   plus the single-character escapes
const ANSI = /[\u001B\u009B](?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');

module.exports = { PROFILES, profileFor, stripAnsi, COMMON_WAITING, COMMON_BUSY };
