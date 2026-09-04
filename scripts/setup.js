#!/usr/bin/env node
'use strict';
// Fetches the Electron runtime the overlay window needs.
//
// This is a separate step because npm 11 blocks package install scripts by
// default, and Electron's postinstall is what downloads its binary. It is also
// where a half-extracted download gets noticed and repaired, rather than showing
// up later as "Electron failed to install correctly".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');

function electronBinary() {
  try {
    const p = require(ELECTRON_DIR);
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function cachedZip() {
  const base =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'electron')
        : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const sub = path.join(base, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    const zip = fs.readdirSync(sub).find((f) => f.endsWith('.zip'));
    if (zip) return path.join(sub, zip);
  }
  return null;
}

// The downloader reports success even when the unpack leaves an empty dist/, so
// unpack the cached archive ourselves as a fallback.
function extract(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const cmd =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dest}" -Force`]]
      : process.platform === 'darwin'
        ? ['ditto', ['-x', '-k', zip, dest]]
        : ['unzip', ['-oq', zip, '-d', dest]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not unpack ${zip}`);

  const exe =
    process.platform === 'win32' ? 'electron.exe'
      : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  if (!fs.existsSync(path.join(dest, exe))) throw new Error('archive unpacked but no Electron binary in it');
  fs.writeFileSync(path.join(ELECTRON_DIR, 'path.txt'), exe);
}

function main() {
  if (!fs.existsSync(ELECTRON_DIR)) {
    console.error('node_modules/electron is missing — run `npm install` first.');
    process.exit(1);
  }

  if (electronBinary()) {
    console.log('Electron is already installed.');
    return;
  }

  console.log('Downloading the Electron runtime (~140 MB, once)…');
  try {
    execFileSync(process.execPath, ['install.js'], { cwd: ELECTRON_DIR, stdio: 'inherit' });
  } catch {
    console.log('The downloader failed; trying the cached archive.');
  }

  if (!electronBinary()) {
    const zip = cachedZip();
    if (zip) {
      console.log(`Unpacking ${path.basename(zip)}…`);
      try { extract(zip, path.join(ELECTRON_DIR, 'dist')); } catch (e) { console.error(e.message); }
    }
  }

  const bin = electronBinary();
  if (bin) {
    console.log(`Electron ready: ${bin}`);
    console.log('Now run:  npm start');
    return;
  }

  console.error(
    [
      '',
      'Could not install Electron.',
      '',
      'Try clearing its download cache and running `npm run setup` again:',
      process.platform === 'win32'
        ? '  rmdir /s /q "%LOCALAPPDATA%\\electron\\Cache"'
        : process.platform === 'darwin'
          ? '  rm -rf ~/Library/Caches/electron'
          : '  rm -rf ~/.cache/electron',
      '',
      'Or skip the desktop window entirely — this works right now:',
      '  node src/cli.js start --browser',
    ].join('\n')
  );
  process.exit(1);
}

main();
