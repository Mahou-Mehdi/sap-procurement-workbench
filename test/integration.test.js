'use strict';

const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const cds = require('@sap/cds');
const { buildPayload, sendPurchaseOrder, ErpError } = require('../lib/erp-client');
const { processNextExport, LEASE_MS } = require('../lib/export-worker');
const { createMockServer } = require('../mock/erp-server');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const runtimeRoot = path.resolve(__dirname, '../runtime');
const testDirectory = path.join(runtimeRoot, `integration-${randomUUID()}`);
let db, named, servers = [], tick, failCompletionAudit = false;
const clock = () => new Date(tick);

before(async () => {
  fs.mkdirSync(testDirectory, { recursive: true });
  const model = await cds.load(path.resolve(__dirname, '../db/schema.cds'));
  db = await cds.deploy(model).to('sqlite::memory:');
  cds.model = db.model;
  named = cds.entities('procurement');
  db.before('CREATE', named.AuditEvents, (request) => {
    const entries = request.query?.INSERT?.entries || [request.data];
    if (failCompletionAudit && entries.some((entry) => entry.action === 'EXPORT_SUCCEEDED')) {
      throw new Error('Injected completion audit failure');
    }
  });
});

beforeEach(async () => {
  tick = Date.parse('2026-10-12T12:00:00.000Z');
  failCompletionAudit = false;
  for (const name of ['AuditEvents', 'ExportJobs', 'PurchaseOrderItems', 'PurchaseOrders', 'Suppliers']) {
    await db.run(DELETE.from(named[name]));
  }
});

async function stop(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(async () => {
  for (const server of servers) await stop(server);
  servers = [];
});

after(async () => {
  if (db) await db.disconnect();
  // Only remove this test's UUID directory, verified inside the runtime directory.
  assert.equal(path.dirname(path.resolve(testDirectory)), runtimeRoot);
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function simulator(options = {}) {
  const file = options.storageFile || path.join(testDirectory, `${randomUUID()}.json`);
  const server = createMockServer({ ...options, storageFile: file });
  return { server, file, baseUrl: await listen(server) };
}

async function queuedJob(overrides = {}) {
  const orderID = randomUUID(), supplierID = randomUUID(), jobID = randomUUID();
  const supplier = { ID: supplierID, code: `SUP-${supplierID.slice(0, 8)}`, name: 'Fictional Test Supplier', country: 'FR', riskBand: 'LOW', blocked: false };
  const item = { ID: randomUUID(), order_ID: orderID, lineNumber: 1, description: 'Fictional replacement bearing',
    quantity: '2.500', unitPrice: '12.34', lineTotal: '30.85', deliveryDate: '2026-11-01' };
  const order = { ID: orderID, orderNumber: `PO-${orderID.slice(0, 8)}`, title: 'Integration test', supplier_ID: supplierID,
    currency: 'EUR', totalAmount: '30.85', status: 'EXPORT_QUEUED', requestedBy: 'buyer', revision: 1 };
  const payload = JSON.stringify(buildPayload({ ...order, supplier, items: [item] }));
  const job = { ID: jobID, order_ID: orderID, status: 'PENDING', attempts: 0,
    idempotencyKey: `po:${orderID}`, payload, ...overrides };
  await db.tx(async (tx) => {
    await tx.run(INSERT.into(named.Suppliers).entries(supplier));
    await tx.run(INSERT.into(named.PurchaseOrders).entries(order));
    await tx.run(INSERT.into(named.PurchaseOrderItems).entries(item));
    await tx.run(INSERT.into(named.ExportJobs).entries(job));
  });
  return { job, order, supplier, item, payload };
}

const jobRow = (ID) => db.run(SELECT.one.from(named.ExportJobs).where({ ID }));
const orderRow = (ID) => db.run(SELECT.one.from(named.PurchaseOrders).where({ ID }));
const receiptFor = (payload, externalOrderID = 'MOCK-PO-00000001') => ({
  reference: JSON.parse(payload).reference, status: 'ACCEPTED', externalOrderID,
});

test('payload mapping is detached, decimal-safe, and rejects inconsistent totals', () => {
  const original = { ID: randomUUID(), currency: 'EUR', supplier: { code: 'SUP-DEMO' }, totalAmount: '0.01',
    items: [{ lineNumber: 1, description: 'Half-cent rounding test', quantity: '0.005', unitPrice: '1.00', deliveryDate: '2026-11-01' }] };
  const before = structuredClone(original);
  const payload = buildPayload(original);
  assert.deepEqual(original, before);
  assert.equal(payload.items[0].quantity, '0.005');
  assert.equal(payload.totalAmount, '0.01');
  assert.throws(() => buildPayload({ ...original, totalAmount: '0.00' }), /rounded line totals/);
});

test('simulator persists receipts across restart and rejects changed payload under the same key', async () => {
  const fixture = await queuedJob();
  const first = await simulator();
  const parameters = { payload: fixture.payload, idempotencyKey: fixture.job.idempotencyKey };
  const receipt = await sendPurchaseOrder({ ...parameters, baseUrl: first.baseUrl });
  await stop(first.server);
  const restarted = await simulator({ storageFile: first.file });
  assert.deepEqual(await sendPurchaseOrder({ ...parameters, baseUrl: restarted.baseUrl }), receipt);
  const changed = JSON.parse(fixture.payload);
  changed.items[0].description = 'Changed serialized snapshot';
  await assert.rejects(sendPurchaseOrder({ ...parameters, payload: JSON.stringify(changed), baseUrl: restarted.baseUrl }),
    (error) => error instanceof ErpError && error.code === 'HTTP_409' && !error.retryable);
  assert.equal(restarted.server.receiptStore.state.sequence, 1);
});

test('simultaneous identical HTTP requests create one persistent receipt', async () => {
  const fixture = await queuedJob();
  const { server, baseUrl } = await simulator();
  const input = { payload: fixture.payload, idempotencyKey: fixture.job.idempotencyKey, baseUrl };
  const receipts = await Promise.all([sendPurchaseOrder(input), sendPurchaseOrder(input)]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(server.receiptStore.state.sequence, 1);
});

test('real HTTP failure retries the identical immutable snapshot and audits success', async () => {
  const fixture = await queuedJob();
  const { server, baseUrl } = await simulator({ failFirst: true });
  const sent = [];
  const transport = async (input) => { sent.push(input); return sendPurchaseOrder({ ...input, baseUrl }); };
  const first = await processNextExport({ db, user: 'integrator', clock, transport });
  assert.equal(first.status, 'RETRY');
  assert.equal((await jobRow(fixture.job.ID)).attempts, 1);
  assert.equal((await orderRow(fixture.order.ID)).status, 'EXPORT_QUEUED');
  assert.equal((await processNextExport({ db, clock, transport })).status, 'IDLE');
  // Changing source data after queueing cannot change the already-approved snapshot.
  await db.run(UPDATE(named.PurchaseOrders).set({ title: 'Changed after queue', totalAmount: '99.99' }).where({ ID: fixture.order.ID }));
  tick += 1001;
  const second = await processNextExport({ db, user: 'integrator', clock, transport });
  assert.equal(second.status, 'SENT');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[1].payload, fixture.payload);
  assert.equal(server.receiptStore.state.sequence, 1);
  const order = await orderRow(fixture.order.ID);
  assert.equal(order.status, 'EXPORTED');
  assert.equal(order.revision, 3);
  const actions = (await db.run(SELECT.from(named.AuditEvents).where({ order_ID: order.ID }))).map((row) => row.action);
  assert.ok(actions.includes('EXPORT_RETRY_SCHEDULED'));
  assert.ok(actions.includes('EXPORT_SUCCEEDED'));
});

test('two workers cannot double-claim; database remains available during HTTP work', { timeout: 5000 }, async () => {
  const fixture = await queuedJob();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const first = processNextExport({ db, clock, transport: async ({ payload }) => {
    calls += 1;
    assert.equal((await jobRow(fixture.job.ID)).status, 'PROCESSING');
    started();
    await gate;
    return receiptFor(payload);
  } });
  await entered;
  try {
    const competing = await processNextExport({ db, clock, transport: () => { throw new Error('Must not call ERP twice'); } });
    assert.equal(competing.processed, false);
  } finally { release(); }
  assert.equal((await first).status, 'SENT');
  assert.equal(calls, 1);
  assert.equal((await jobRow(fixture.job.ID)).attempts, 1);
});

test('lease recovery replays an already accepted request after an interrupted local completion', async () => {
  const fixture = await queuedJob({ status: 'PROCESSING', attempts: 1, lockedAt: new Date(tick - LEASE_MS - 1).toISOString() });
  const { server, baseUrl } = await simulator();
  const knownReceipt = await sendPurchaseOrder({ payload: fixture.payload, idempotencyKey: fixture.job.idempotencyKey, baseUrl });
  const result = await processNextExport({ db, clock, transport: (input) => sendPurchaseOrder({ ...input, baseUrl }) });
  assert.equal(result.status, 'SENT');
  assert.equal((await orderRow(fixture.order.ID)).externalOrderID, knownReceipt.externalOrderID);
  assert.equal((await jobRow(fixture.job.ID)).attempts, 2);
  assert.equal(server.receiptStore.state.sequence, 1);
  assert.ok(await db.run(SELECT.one.from(named.AuditEvents).where({ order_ID: fixture.order.ID, action: 'EXPORT_LEASE_RECOVERED' })));
});

test('completion audit failure rolls back receipt/state changes and recovery does not repost', async () => {
  const fixture = await queuedJob();
  const { server, baseUrl } = await simulator();
  const transport = (input) => sendPurchaseOrder({ ...input, baseUrl });
  failCompletionAudit = true;
  await assert.rejects(processNextExport({ db, clock, transport }), /Injected completion audit failure/);
  assert.equal(server.receiptStore.state.sequence, 1);
  const waiting = await jobRow(fixture.job.ID);
  assert.equal(waiting.status, 'PROCESSING');
  assert.equal(waiting.externalOrderID, null);
  assert.equal((await orderRow(fixture.order.ID)).status, 'EXPORT_QUEUED');
  assert.equal((await orderRow(fixture.order.ID)).revision, 1);
  failCompletionAudit = false;
  tick += LEASE_MS + 1;
  assert.equal((await processNextExport({ db, clock, transport })).status, 'SENT');
  assert.equal(server.receiptStore.state.sequence, 1);
  assert.equal((await jobRow(fixture.job.ID)).attempts, 2);
});

test('a stale response cannot overwrite a recovered worker result', { timeout: 5000 }, async () => {
  const fixture = await queuedJob();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const old = processNextExport({ db, clock, transport: async ({ payload }) => {
    started(); await gate; return receiptFor(payload, 'MOCK-OLD');
  } });
  await entered;
  tick += LEASE_MS + 1;
  let recovered;
  try { recovered = await processNextExport({ db, clock, transport: async ({ payload }) => receiptFor(payload, 'MOCK-RECOVERED') }); }
  finally { release(); }
  assert.equal(recovered.status, 'SENT');
  assert.equal((await old).status, 'STALE');
  assert.equal((await orderRow(fixture.order.ID)).externalOrderID, 'MOCK-RECOVERED');
});

test('transient retries stop after three attempts and retain the original payload/key', async () => {
  const fixture = await queuedJob();
  const transport = async () => { throw new ErpError('ERP temporarily unavailable', { retryable: true, code: 'HTTP_503' }); };
  assert.equal((await processNextExport({ db, clock, transport })).status, 'RETRY');
  tick += 1001;
  assert.equal((await processNextExport({ db, clock, transport })).status, 'RETRY');
  tick += 3001;
  assert.equal((await processNextExport({ db, clock, transport })).status, 'FAILED');
  const job = await jobRow(fixture.job.ID);
  assert.equal(job.attempts, 3);
  assert.equal(job.payload, fixture.payload);
  assert.equal(job.idempotencyKey, fixture.job.idempotencyKey);
  assert.equal((await orderRow(fixture.order.ID)).status, 'EXPORT_FAILED');
  assert.equal((await processNextExport({ db, clock, transport })).status, 'IDLE');
});

test('an expired final-attempt lease fails explicitly without a fourth automatic request', async () => {
  const fixture = await queuedJob({ status: 'PROCESSING', attempts: 3, lockedAt: new Date(tick - LEASE_MS - 1).toISOString() });
  const result = await processNextExport({ db, clock, transport: async () => assert.fail('Unexpected fourth automatic request') });
  assert.equal(result.status, 'FAILED');
  assert.match(result.message, /receipt may exist/);
  assert.equal((await orderRow(fixture.order.ID)).status, 'EXPORT_FAILED');
});

test('permanent errors fail immediately and unexpected transport details are sanitized', async () => {
  const fixture = await queuedJob();
  const failed = await processNextExport({ db, clock, transport: async () => {
    throw new ErpError('ERP rejected an idempotency key with changed content', { code: 'HTTP_409' });
  } });
  assert.equal(failed.status, 'FAILED');
  assert.equal((await jobRow(fixture.job.ID)).attempts, 1);
  const second = await queuedJob();
  await processNextExport({ db, clock, transport: async () => { throw new Error('secret-token-in-upstream-error'); } });
  assert.doesNotMatch((await jobRow(second.job.ID)).lastError, /secret-token/);
});

test('HTTP timeout is bounded and classified as safely retryable', async () => {
  const fixture = await queuedJob();
  const slow = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 200).unref();
  });
  const baseUrl = await listen(slow);
  await assert.rejects(sendPurchaseOrder({ payload: fixture.payload, idempotencyKey: fixture.job.idempotencyKey,
    baseUrl, timeoutMs: 20 }), (error) => error.code === 'TIMEOUT' && error.retryable);
});
