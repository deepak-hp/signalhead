'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const config = require('./config');

const OVERLAY_DIR = path.join(__dirname, 'overlay');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function start({ port = config.port(), ttlMs, idleTtlMs, quietAfterMs, unusedTtlMs } = {}) {
  const cfg = config.load();
  const store = new Store({
    ttlMs: ttlMs ?? cfg.sessionTtlMs,
    idleTtlMs: idleTtlMs ?? cfg.idleTtlMs,
    quietAfterMs: quietAfterMs ?? cfg.quietAfterMs,
    unusedTtlMs: unusedTtlMs ?? cfg.unusedTtlMs,
  });
  const clients = new Set();

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Local-only tool: allow the overlay page (and OBS/browser sources) to read it.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      if (p === '/health') return send(res, 200, { ok: true, pid: process.pid, port });

      if (p === '/state' && req.method === 'GET') return send(res, 200, store.snapshot());

      if (p === '/state' && req.method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        return send(res, 200, store.set(payload));
      }

      // Convenience for shell one-liners and hooks:  curl -s localhost:4747/set/busy?agent=claude
      if (p.startsWith('/set/')) {
        const state = p.slice('/set/'.length);
        return send(res, 200, store.set({
          state,
          agent: url.searchParams.get('agent') || 'agent',
          session: url.searchParams.get('session') || 'default',
          detail: url.searchParams.get('detail') || '',
          cwd: url.searchParams.get('cwd') || '',
        }));
      }

      if (p === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      // Wipe every session. Useful after testing, or when a crashed agent has
      // left a pill behind and you do not want to wait for it to age out.
      if (p === '/clear' && req.method === 'POST') {
        for (const id of [...store.sessions.keys()]) store.set({ session: id, state: 'offline' });
        return send(res, 200, store.snapshot());
      }

      if (p === '/quit' && req.method === 'POST') {
        send(res, 200, { ok: true });
        return setTimeout(() => process.exit(0), 50);
      }

      // Static: the same overlay UI Electron loads, so a plain browser tab works too.
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const abs = path.join(OVERLAY_DIR, file);
      if (abs.startsWith(OVERLAY_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        return fs.createReadStream(abs).pipe(res);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 400, { error: String(err.message || err) });
    }
  });

  store.on('change', (snap) => {
    const frame = `data: ${JSON.stringify(snap)}\n\n`;
    for (const c of clients) { try { c.write(frame); } catch { clients.delete(c); } }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      config.ensureDir();
      try { fs.writeFileSync(config.PORT_FILE, String(port)); } catch {}
      resolve({ server, store, port });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`signalhead server on http://127.0.0.1:${port}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
