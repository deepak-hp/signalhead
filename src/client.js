'use strict';
const http = require('http');
const config = require('./config');

// Everything here is best-effort. A hook that throws would break the agent it is
// reporting on, so failures are swallowed and the caller still exits 0.
function post(pathname, payload, { timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.port(),
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try { resolve(JSON.parse(out)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function get(pathname, { timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: config.port(), path: pathname, timeout },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try { resolve(JSON.parse(out)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const setState = (payload) => post('/state', payload);
const health = () => get('/health');
const snapshot = () => get('/state');
const quitServer = () => post('/quit', {});

module.exports = { post, get, setState, health, snapshot, quitServer };
