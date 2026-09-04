'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const DIR = process.env.SIGNALHEAD_HOME || path.join(HOME, '.signalhead');
const CONFIG_FILE = path.join(DIR, 'config.json');
const PORT_FILE = path.join(DIR, 'port');
const LOG_FILE = path.join(DIR, 'server.log');

const DEFAULTS = {
  port: 4747,
  // Window position is remembered between runs. null => bottom-right of the display.
  window: { x: null, y: null },
  theme: 'classic',        // classic | slim
  scale: 1,
  clickThrough: true,      // let clicks pass through everywhere except the light itself
  showLabels: true,        // show per-agent pills when more than one agent is active
  sessionTtlMs: 6 * 60 * 60 * 1000,
  // A green session nobody has touched in this long is treated as gone.
  idleTtlMs: 30 * 60 * 1000,
  // A session that has not reported in this long is shown as quiet, not fresh.
  quietAfterMs: 90 * 1000,
  // A session that announced itself and then never did anything is forgotten
  // this quickly, rather than waiting out the full idle timeout.
  unusedTtlMs: 2 * 60 * 1000,
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw, window: { ...DEFAULTS.window, ...(raw.window || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  ensureDir();
  const next = { ...load(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function port() {
  if (process.env.SIGNALHEAD_PORT) return Number(process.env.SIGNALHEAD_PORT);
  return load().port;
}

module.exports = { DIR, CONFIG_FILE, PORT_FILE, LOG_FILE, DEFAULTS, ensureDir, load, save, port };
