'use strict';

const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const { validateDraft, expectedRevision, requiresManager, text, uuid } = require('./validation');

module.exports = class ProcurementService extends cds.ApplicationService {
  async init() {
    const entities = cds.entities('procurement');
    const { PurchaseOrders, PurchaseOrderItems, Suppliers, AuditEvents, ExportJobs } = entities;

    const authorize = (req, ...roles) => {
      if (!roles.some(role => req.user.is(role))) req.reject(403, 'Your role cannot perform this operation.');
    };
    const transaction = req => cds.db.tx(req);
    const actor = req => text(req.user.id, 'Authenticated user ID', 80);

    async function loadOrder(tx, ID, req) {
      const order = await tx.run(SELECT.one.from(PurchaseOrders).where({ ID }));
      if (!order) req.reject(404, 'Purchase order was not found.');
      order.supplier = await tx.run(SELECT.one.from(Suppliers).where({ ID: order.supplier_ID }));
      order.items = await tx.run(SELECT.from(PurchaseOrderItems).where({ order_ID: ID }).orderBy('lineNumber'));
      return order;
    }

    async function current(req, allowedStatus) {
      const revision = expectedRevision(req.data.expectedRevision);
      const ID = uuid(req.params?.[0]?.ID, 'Purchase order ID');
      const tx = transaction(req);
      const order = await loadOrder(tx, ID, req);
      if (order.revision !== revision) req.reject(409, 'This order changed. Refresh it and retry using its current revision.');
      if (order.status !== allowedStatus) req.reject(409, `This operation requires status ${allowedStatus}.`);
      return { tx, order, revision };
    }

    async function audit(tx, req, order, action, toStatus, details) {
      await tx.run(INSERT.into(AuditEvents).entries({ ID: cds.utils.uuid(), order_ID: order.ID,
        timestamp: new Date().toISOString(), actor: actor(req), action,
        fromStatus: order.status, toStatus, details }));
    }

    async function change(tx, req, order, revision, values, action, details) {
      const count = await tx.run(UPDATE(PurchaseOrders).set({ ...values, revision: revision + 1 })
        .where({ ID: order.ID, revision, status: order.status }));
      if (count !== 1) req.reject(409, 'Another request changed this order. Refresh and retry.');
      await audit(tx, req, order, action, values.status ?? order.status, details);
    }

    async function requireSupplier(tx, ID, req) {
      const supplier = await tx.run(SELECT.one.from(Suppliers).where({ ID }));
      if (!supplier) req.reject(400, 'Choose an existing supplier.');
      return supplier;
    }

    this.on('createOrder', async req => {
      authorize(req, 'Buyer');
      const draft = validateDraft(req.data);
      const tx = transaction(req);
      await requireSupplier(tx, draft.supplierID, req);
      const ID = cds.utils.uuid();
      const order = { ID, orderNumber: 'PO-' + ID.replace(/-/g, '').slice(0, 16).toUpperCase(),
        title: draft.title, supplier_ID: draft.supplierID, totalAmount: draft.totalAmount,
        currency: 'EUR', status: 'DRAFT', requestedBy: actor(req), revision: 1 };
      await tx.run(INSERT.into(PurchaseOrders).entries(order));
      await tx.run(INSERT.into(PurchaseOrderItems).entries(draft.items.map(item => ({ ...item, ID: cds.utils.uuid(), order_ID: ID }))));
      await audit(tx, req, { ...order, status: null }, 'CREATE', 'DRAFT', 'Draft created with server-calculated line amounts.');
      return loadOrder(tx, ID, req);
    });

    this.on('updateDraft', 'PurchaseOrders', async req => {
      authorize(req, 'Buyer');
      const draft = validateDraft(req.data);
      const { tx, order, revision } = await current(req, 'DRAFT');
      if (order.requestedBy !== req.user.id) req.reject(403, 'Only the requester can update this draft.');
      await requireSupplier(tx, draft.supplierID, req);
      await change(tx, req, order, revision, { title: draft.title, supplier_ID: draft.supplierID, totalAmount: draft.totalAmount },
        'UPDATE_DRAFT', 'Draft lines and supplier updated; monetary totals recalculated.');
      await tx.run(DELETE.from(PurchaseOrderItems).where({ order_ID: order.ID }));
      await tx.run(INSERT.into(PurchaseOrderItems).entries(draft.items.map(item => ({ ...item, ID: cds.utils.uuid(), order_ID: order.ID }))));
      return loadOrder(tx, order.ID, req);
    });

    this.on('submit', 'PurchaseOrders', async req => {
      authorize(req, 'Buyer');
      const { tx, order, revision } = await current(req, 'DRAFT');
      if (order.requestedBy !== req.user.id) req.reject(403, 'Only the requester can submit this draft.');
      if (!order.supplier || order.supplier.blocked) req.reject(400, 'Blocked suppliers cannot receive submitted orders.');
      if (!order.items.length) req.reject(400, 'An order must contain at least one item.');
      await change(tx, req, order, revision, { status: 'SUBMITTED' }, 'SUBMIT',
        requiresManager(order) ? 'Submitted for manager approval.' : 'Submitted for approver review.');
      return loadOrder(tx, order.ID, req);
    });

    this.on('approve', 'PurchaseOrders', async req => {
      authorize(req, 'Approver', 'Manager');
      const { tx, order, revision } = await current(req, 'SUBMITTED');
      if (order.requestedBy === req.user.id) req.reject(403, 'Requesters cannot approve their own purchase orders.');
      if (requiresManager(order) && !req.user.is('Manager')) req.reject(403, 'A manager must approve orders of EUR 10,000 or more and high-risk suppliers.');
      await change(tx, req, order, revision, { status: 'APPROVED' }, 'APPROVE', 'Approved after role, value, and segregation-of-duties checks.');
      return loadOrder(tx, order.ID, req);
    });

    this.on('rejectOrder', 'PurchaseOrders', async req => {
      authorize(req, 'Approver', 'Manager');
      const reason = text(req.data.reason, 'Rejection reason', 500);
      const { tx, order, revision } = await current(req, 'SUBMITTED');
      await change(tx, req, order, revision, { status: 'REJECTED' }, 'REJECT', reason);
      return loadOrder(tx, order.ID, req);
    });

    this.on('queueExport', 'PurchaseOrders', async req => {
      authorize(req, 'IntegrationOperator');
      const { tx, order, revision } = await current(req, 'APPROVED');
      const { buildPayload } = require('../lib/erp-client');
      const payload = JSON.stringify(buildPayload(order));
      await change(tx, req, order, revision, { status: 'EXPORT_QUEUED' }, 'QUEUE_EXPORT', 'Immutable purchase-order snapshot queued for ERP delivery.');
      await tx.run(INSERT.into(ExportJobs).entries({ ID: cds.utils.uuid(), order_ID: order.ID, status: 'PENDING',
        attempts: 0, idempotencyKey: 'po:' + order.ID, payload }));
      return loadOrder(tx, order.ID, req);
    });

    this.on('retryExport', 'PurchaseOrders', async req => {
      authorize(req, 'IntegrationOperator');
      const { tx, order, revision } = await current(req, 'EXPORT_FAILED');
      const job = await tx.run(SELECT.one.from(ExportJobs).where({ order_ID: order.ID, status: 'FAILED' }));
      if (!job) req.reject(409, 'No failed export job exists for this order.');
      await change(tx, req, order, revision, { status: 'EXPORT_QUEUED' }, 'RETRY_EXPORT', 'Retry requested using the original snapshot and idempotency key.');
      const changed = await tx.run(UPDATE(ExportJobs).set({ status: 'PENDING', attempts: 0,
        nextAttemptAt: null, lockedAt: null, lastError: null }).where({ ID: job.ID, status: 'FAILED' }));
      if (changed !== 1) req.reject(409, 'This export job changed. Refresh and retry.');
      return loadOrder(tx, order.ID, req);
    });

    this.on('processNextExport', async req => {
      authorize(req, 'IntegrationOperator');
      // No request DB operations here. The worker opens separate claim/completion
      // transactions, with the remote HTTP request strictly between them.
      const { processNextExport } = require('../lib/export-worker');
      return processNextExport({ db: cds.db, user: req.user.id });
    });

    return super.init();
  }
};
