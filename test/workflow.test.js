'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startCAP } = require('./helpers/cap-fixture');
const { validateDraft } = require('../srv/validation');

const SUPPLIER = '11111111-1111-4111-8111-111111111111';
const HIGH_RISK = '33333333-3333-4333-8333-333333333333';
const BLOCKED = '44444444-4444-4444-8444-444444444444';
let api;
before(async () => { api = await startCAP({ secondBuyer: true }); });
after(async () => { await api?.close(); });

function draft(overrides = {}) {
  return { supplierID: SUPPLIER, title: 'Fictional workflow test order',
    items: [{ description: 'Test component', quantity: '2.000', unitPrice: '25.00', deliveryDate: '2026-12-01' }], ...overrides };
}
function endpoint(order, action) { return `/PurchaseOrders(${order.ID})/ProcurementService.${action}`; }
async function create(client = api, values = draft()) {
  const response = await client.request('/createOrder', { method: 'POST', body: values });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function act(order, action, user, extra = {}, client = api) {
  return client.request(endpoint(order, action), { method: 'POST', user,
    body: { expectedRevision: order.revision, ...extra } });
}
async function read(order, client = api) {
  const response = await client.request(`/PurchaseOrders(${order.ID})?$expand=supplier,items,events`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

test('all declared personas can read expanded orders; unknown users and anonymous requests cannot', async () => {
  for (const user of ['buyer', 'approver', 'manager', 'integrator', 'auditor']) {
    const result = await api.request('/PurchaseOrders?$expand=supplier,items,events', { user });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.value.length >= 6);
    assert.ok(result.data.value[0].supplier);
    assert.ok(Array.isArray(result.data.value[0].items));
  }
  for (const user of [null, 'unknown-person', 'alice']) {
    assert.equal((await api.request('/PurchaseOrders', { user })).status, 401);
  }
});

test('readonly projections prevent direct CRUD and state/audit bypass', async () => {
  const order = await create();
  for (const [path, method, body] of [
    [`/PurchaseOrders(${order.ID})`, 'PATCH', { status: 'EXPORTED', totalAmount: '0.01' }],
    [`/PurchaseOrders(${order.ID})`, 'DELETE'],
    ['/PurchaseOrders', 'POST', { title: 'Bypass' }],
    ['/PurchaseOrderItems', 'POST', { order_ID: order.ID, lineTotal: '0.01' }],
    ['/AuditEvents', 'POST', { order_ID: order.ID, action: 'APPROVE', actor: 'manager' }],
    ['/ExportJobs', 'POST', { order_ID: order.ID, status: 'SENT' }],
    [`/Suppliers(${SUPPLIER})`, 'PATCH', { blocked: false, riskBand: 'LOW' }]
  ]) {
    const result = await api.request(path, { method, body, user: 'manager' });
    assert.ok([403, 405].includes(result.status), `${method} ${path}: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const unchanged = await read(order);
  assert.equal(unchanged.status, 'DRAFT');
  assert.equal(unchanged.revision, 1);
});

test('server calculates monetary line rounding exactly and derives requester/audit actor', async () => {
  const values = draft({ items: [
    { description: 'Half-cent rounds up', quantity: '0.005', unitPrice: '1.00', deliveryDate: '2026-12-01' },
    { description: 'One-and-half cents rounds up', quantity: '0.005', unitPrice: '3.00', deliveryDate: '2026-12-01' }
  ] });
  const order = await create(api, values);
  const loaded = await read(order);
  assert.equal(Number(loaded.totalAmount), 0.03);
  assert.deepEqual(loaded.items.sort((a, b) => a.lineNumber - b.lineNumber).map(item => Number(item.lineTotal)), [0.01, 0.02]);
  assert.equal(loaded.requestedBy, 'buyer');
  assert.equal(loaded.events[0].actor, 'buyer');
  assert.equal(loaded.currency, 'EUR');
  const spoof = await api.request('/createOrder', { method: 'POST', body: { ...values,
    requestedBy: 'manager', status: 'APPROVED', totalAmount: '999999.00' } });
  if (spoof.status === 200) {
    assert.equal(spoof.data.requestedBy, 'buyer');
    assert.equal(spoof.data.status, 'DRAFT');
    assert.equal(Number(spoof.data.totalAmount), 0.03);
  } else assert.equal(spoof.status, 400);
});

test('invalid inputs are rejected, including impossible dates, excess precision and overflowing totals', async () => {
  const bad = [draft({ items: [] }), draft({ title: ' ' }), draft({ title: 'x'.repeat(121) }),
    draft({ supplierID: '55555555-5555-4555-8555-555555555555' })];
  bad.push(draft({ items: Array.from({ length: 101 }, () => draft().items[0]) }));
  for (const [field, value] of [['quantity', '0'], ['quantity', '-1'], ['quantity', '0.0001'],
    ['unitPrice', '0'], ['unitPrice', '0.001'], ['description', ' '], ['deliveryDate', '2026-02-31']]) {
    const input = draft(); input.items[0][field] = value; bad.push(input);
  }
  const overflow = draft();
  overflow.items[0].quantity = '999999999.999';
  overflow.items[0].unitPrice = '99999999999.99';
  bad.push(overflow);
  for (const input of bad) {
    const result = await api.request('/createOrder', { method: 'POST', body: input });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
});

test('draft updates replace lines and reject stale revisions or submitted edits', async () => {
  const order = await create();
  const edited = await act(order, 'updateDraft', 'buyer', draft({ title: 'Revised fictional order' }));
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.revision, 2);
  assert.equal((await act(order, 'submit', 'buyer')).status, 409);
  const submitted = await act(edited.data, 'submit', 'buyer');
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.revision, 3);
  assert.equal((await act(submitted.data, 'updateDraft', 'buyer', draft())).status, 409);
});

test('blocked supplier cannot submit, and failed action leaves revision and audit unchanged', async () => {
  const order = await create(api, draft({ supplierID: BLOCKED }));
  assert.equal((await act(order, 'submit', 'buyer')).status, 400);
  const loaded = await read(order);
  assert.equal(loaded.status, 'DRAFT');
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.events.length, 1);
});

test('manager boundary includes EUR10000 and high-risk suppliers regardless of lower value', async () => {
  for (const [price, supplierID, managerRequired] of [
    ['9999.99', SUPPLIER, false], ['10000.00', SUPPLIER, true], ['25.00', HIGH_RISK, true]
  ]) {
    const input = draft({ supplierID }); input.items[0].quantity = '1.000'; input.items[0].unitPrice = price;
    const order = await create(api, input);
    const submitted = await act(order, 'submit', 'buyer');
    assert.equal(submitted.status, 200);
    const approval = await act(submitted.data, 'approve', 'approver');
    assert.equal(approval.status, managerRequired ? 403 : 200, JSON.stringify(approval.data));
    if (managerRequired) {
      const managerial = await act(submitted.data, 'approve', 'manager');
      assert.equal(managerial.status, 200, JSON.stringify(managerial.data));
      assert.equal(managerial.data.status, 'APPROVED');
    }
  }
});

test('rejection requires a meaningful reason and records it in the audit', async () => {
  const order = await create();
  const submitted = await act(order, 'submit', 'buyer');
  assert.equal((await act(submitted.data, 'rejectOrder', 'approver', { reason: ' ' })).status, 400);
  const rejected = await act(submitted.data, 'rejectOrder', 'approver', { reason: 'Duplicate fictional request.' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  const loaded = await read(order);
  assert.equal(loaded.status, 'REJECTED');
  assert.ok(loaded.events.some(event => event.action === 'REJECT' && event.details === 'Duplicate fictional request.'));
});

test('server role checks reject unauthorized actions independently of button visibility', async () => {
  assert.equal((await api.request('/createOrder', { method: 'POST', user: 'auditor', body: draft() })).status, 403);
  const order = await create();
  assert.equal((await act(order, 'submit', 'approver')).status, 403);
  assert.equal((await act(order, 'approve', 'integrator')).status, 403);
  assert.equal((await act(order, 'queueExport', 'buyer')).status, 403);
  assert.equal((await api.request('/processNextExport', { method: 'POST', user: 'buyer', body: {} })).status, 403);
});

test('a second buyer cannot update or submit another requester\'s draft', async () => {
  const order = await create();
  const edited = await act(order, 'updateDraft', 'secondbuyer', draft());
  assert.equal(edited.status, 403, JSON.stringify(edited.data));
  assert.equal((await act(order, 'submit', 'secondbuyer')).status, 403);
  const unchanged = await read(order);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.status, 'DRAFT');
});

test('concurrent mutations using one revision have exactly one winner', async () => {
  const order = await create();
  const replies = await Promise.all([act(order, 'submit', 'buyer'), act(order, 'submit', 'buyer')]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const loaded = await read(order);
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.events.filter(event => event.action === 'SUBMIT').length, 1);
});

test('queueing creates one protected outbox job and rejects stale duplicate requests', async () => {
  const order = await create();
  const submitted = await act(order, 'submit', 'buyer');
  const approved = await act(submitted.data, 'approve', 'approver');
  const queued = await act(approved.data, 'queueExport', 'integrator');
  assert.equal(queued.status, 200, JSON.stringify(queued.data));
  assert.equal(queued.data.status, 'EXPORT_QUEUED');
  assert.equal((await act(approved.data, 'queueExport', 'integrator')).status, 409);
  const jobs = await api.request(`/ExportJobs?$filter=order_ID eq ${order.ID}`, { user: 'auditor' });
  assert.equal(jobs.status, 200, JSON.stringify(jobs.data));
  assert.equal(jobs.data.value.length, 1);
  assert.equal(jobs.data.value[0].idempotencyKey, 'po:' + order.ID);
  assert.equal(jobs.data.value[0].status, 'PENDING');
  assert.equal(jobs.data.value[0].payload, undefined);
});

test('requester cannot self-approve even when their test identity also holds Approver', async () => {
  const client = await startCAP({ buyerCanApprove: true });
  try {
    const order = await create(client);
    const submitted = await act(order, 'submit', 'buyer', {}, client);
    assert.equal(submitted.status, 200);
    const result = await act(submitted.data, 'approve', 'buyer', {}, client);
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.match(result.data.error.message, /own purchase orders/);
  } finally { await client.close(); }
});

test('audit storage failure rolls back the status transition and revision atomically', async () => {
  const client = await startCAP({ failAuditAction: 'SUBMIT' });
  try {
    const order = await create(client);
    const submitted = await act(order, 'submit', 'buyer', {}, client);
    assert.equal(submitted.status, 500, JSON.stringify(submitted.data));
    const loaded = await read(order, client);
    assert.equal(loaded.status, 'DRAFT');
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.events.length, 1);
  } finally { await client.close(); }
});

test('integer arithmetic remains exact for values beyond intermediate Number precision', () => {
  const values = draft();
  values.items[0].quantity = '1234567.891';
  values.items[0].unitPrice = '12345.67';
  const result = validateDraft(values);
  const expectedCents = (1234567891n * 1234567n + 500n) / 1000n;
  assert.equal(result.totalAmount, `${expectedCents / 100n}.${String(expectedCents % 100n).padStart(2, '0')}`);
});

test('outbox storage failure rolls back the queued status and its audit event', async () => {
  const client = await startCAP({ failExportJob: true });
  try {
    const order = await create(client);
    const submitted = await act(order, 'submit', 'buyer', {}, client);
    const approved = await act(submitted.data, 'approve', 'approver', {}, client);
    const result = await act(approved.data, 'queueExport', 'integrator', {}, client);
    assert.equal(result.status, 500, JSON.stringify(result.data));
    const loaded = await read(order, client);
    assert.equal(loaded.status, 'APPROVED');
    assert.equal(loaded.revision, approved.data.revision);
    assert.equal(loaded.events.some(event => event.action === 'QUEUE_EXPORT'), false);
    const jobs = await client.request(`/ExportJobs?$filter=order_ID eq ${order.ID}`);
    assert.equal(jobs.data.value.length, 0);
  } finally { await client.close(); }
});
