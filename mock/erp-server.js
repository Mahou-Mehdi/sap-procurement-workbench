'use strict';

// Fictional JSON simulator. This is deliberately NOT an SAP endpoint emulator.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { validatePayload } = require('../lib/erp-client');

class ReceiptStore {
  constructor(file, { failFirst = false } = {}) {
    this.file = path.resolve(file);
    this.failFirst = failFirst;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { formatVersion: 1, sequence: 0, requests: {} };
    if (this.state.formatVersion !== 1 || !Number.isSafeInteger(this.state.sequence)
        || !this.state.requests || typeof this.state.requests !== 'object' || Array.isArray(this.state.requests)) {
      throw new Error('Invalid simulator receipt ledger; refusing to overwrite it');
    }
  }

  persist(next) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = fs.openSync(temporary, 'wx');
      fs.writeFileSync(handle, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle); handle = undefined;
      fs.renameSync(temporary, this.file);
      this.state = next;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  accept(key, raw, payload) {
    const digest = createHash('sha256').update(raw).digest('hex');
    const previous = this.state.requests[key];
    if (previous && previous.digest !== digest) {
      return { status: 409, body: { error: 'Idempotency key already used with a different serialized payload' } };
    }
    if (previous?.receipt) return { status: 200, body: previous.receipt };
    const next = structuredClone(this.state);
    if (!previous && this.failFirst) {
      next.requests[key] = { digest, injectedFailure: true };
      this.persist(next);
      return { status: 503, body: { error: 'Intentional first-attempt failure in the fictional simulator' } };
    }
    next.sequence += 1;
    const receipt = { externalOrderID: `MOCK-PO-${String(next.sequence).padStart(8, '0')}`,
      reference: payload.reference, status: 'ACCEPTED', receivedAt: new Date().toISOString() };
    next.requests[key] = { digest, receipt };
    // Commit receipt before acknowledging. A lost response can be safely replayed.
    this.persist(next);
    return { status: 201, body: receipt };
  }
}

function send(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(raw);
}

function createMockServer({ storageFile = path.join(__dirname, '../runtime/mock-erp-receipts.json'),
  failFirst = process.env.ERP_FAIL_FIRST === '1' } = {}) {
  const store = new ReceiptStore(storageFile, { failFirst });
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok', service: 'fictional-erp-simulator', isSAP: false,
        receipts: store.state.sequence, failFirst });
    }
    if (req.method !== 'POST' || req.url !== '/api/purchase-orders') return send(res, 404, { error: 'Not found' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin writes are not supported' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Use application/json' });
    if (Number(req.headers['content-length'] || 0) > 65_536) return send(res, 413, { error: 'Payload too large' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65_536) { send(res, 413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload;
      try { payload = JSON.parse(raw); validatePayload(payload); }
      catch { return send(res, 400, { error: 'Invalid fictional purchase-order payload' }); }
      const key = req.headers['idempotency-key'];
      if (key !== `po:${payload.reference}`) return send(res, 400, { error: 'Idempotency-Key must equal po:<reference UUID>' });
      const result = store.accept(key, raw, payload);
      return send(res, result.status, result.body);
    } catch {
      if (!res.headersSent) send(res, 503, { error: 'Simulator could not persist the receipt; retry the identical request' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.receiptStore = store;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.ERP_PORT || 4010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ERP_PORT must be a valid TCP port');
  const server = createMockServer({ storageFile: process.env.ERP_STORE });
  server.listen(port, '127.0.0.1', () => console.log(`Fictional ERP simulator: http://127.0.0.1:${port} (not SAP S/4HANA)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}

module.exports = { createMockServer, ReceiptStore };
