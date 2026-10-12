'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startCAP } = require('./helpers/cap-fixture');
let app;
before(async () => { app = await startCAP(); });
after(async () => { await app?.close(); });

test('batch operations cannot combine independent integration commits with a request transaction', async () => {
  for (const endpoint of ['/$batch', '/%24batch', '/%2524batch']) {
    const result = await app.request(endpoint, { user: 'integrator', method: 'POST', body: { requests: [] } });
    assert.equal(result.status, 501, endpoint);
    assert.match(result.data.error.message, /individual operations/);
  }
  assert.equal((await app.request('/Suppliers')).status, 200);
});

test('cross-origin writes are rejected while same-origin actions remain available', async () => {
  const blocked = await app.request('/processNextExport', { user: 'integrator', method: 'POST', body: {},
    headers: { Origin: 'https://unrelated.example' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error.message, /Cross-origin writes/);
  const allowed = await app.request('/processNextExport', { user: 'integrator', method: 'POST', body: {},
    headers: { Origin: new URL(app.url).origin } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.processed, false);
});

test('production startup refuses the public demo identity setup', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_ENV: 'production' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot run in production with demo authentication/);
});
