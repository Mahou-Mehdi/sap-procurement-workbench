'use strict';

const cds = require('@sap/cds');
const { sendPurchaseOrder, ErpError } = require('./erp-client');
const { SELECT, UPDATE, INSERT } = cds.ql;

const MAX_ATTEMPTS = 3;
const LEASE_MS = 30_000; // Longer than the adapter's bounded 5-second request timeout.
const RETRY_DELAYS_MS = [1000, 3000];

function entities(db) {
  const resolved = typeof cds.entities === 'function' ? cds.entities('procurement')
    : cds.linked(db.model || cds.model).entities('procurement');
  const result = {};
  for (const name of ['ExportJobs', 'PurchaseOrders', 'AuditEvents']) {
    result[name] = resolved?.[name] || db.model?.definitions?.[`procurement.${name}`];
    if (!result[name]) throw new Error(`Missing procurement entity: ${name}`);
  }
  return result;
}

function fence(job) {
  return { ID: job.ID, status: job.status, attempts: job.attempts, lockedAt: job.lockedAt || null };
}

async function audit(tx, entity, job, order, actor, action, toStatus, details, timestamp) {
  if (!order) return;
  await tx.run(INSERT.into(entity).entries({
    ID: cds.utils.uuid(), order_ID: job.order_ID, timestamp, actor,
    action, fromStatus: order.status, toStatus, details: details.slice(0, 1000),
  }));
}

async function updateOrder(tx, entity, order, status, extra = {}) {
  const changed = await tx.run(UPDATE(entity).set({ status, revision: order.revision + 1, ...extra })
    .where({ ID: order.ID, status: order.status, revision: order.revision }));
  if (changed !== 1) throw new Error('Purchase-order revision changed while finalizing export');
}

async function claimNext(db, named, actor, timestamp) {
  // A plain context object + callback creates a fresh CAP root transaction.
  // Never pass the inbound request transaction to this worker.
  return db.tx({ user: actor }, async (tx) => {
    const jobs = await tx.run(SELECT.from(named.ExportJobs)
      .where({ status: { in: ['PENDING', 'RETRY', 'PROCESSING'] } }).orderBy('createdAt', 'ID'));
    const now = Date.parse(timestamp);
    for (const job of jobs) {
      const abandoned = job.status === 'PROCESSING';
      if (abandoned && job.lockedAt && now - Date.parse(job.lockedAt) < LEASE_MS) continue;
      if (!abandoned && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now) continue;
      const order = await tx.run(SELECT.one.from(named.PurchaseOrders).where({ ID: job.order_ID }));
      if (!order || order.status !== 'EXPORT_QUEUED' || job.attempts >= MAX_ATTEMPTS) {
        const reason = !order || order.status !== 'EXPORT_QUEUED'
          ? 'Order is missing or no longer queued; export was not sent'
          : 'Attempt limit reached after an interrupted export; receipt may exist. Retry uses the same key';
        const changed = await tx.run(UPDATE(named.ExportJobs)
          .set({ status: 'FAILED', lastError: reason, lockedAt: null, nextAttemptAt: null }).where(fence(job)));
        if (!changed) continue;
        const nextStatus = order?.status === 'EXPORT_QUEUED' ? 'EXPORT_FAILED' : order?.status;
        if (order?.status === 'EXPORT_QUEUED') await updateOrder(tx, named.PurchaseOrders, order, nextStatus);
        await audit(tx, named.AuditEvents, job, order, actor, 'EXPORT_FAILED', nextStatus, reason, timestamp);
        return { finished: { processed: true, jobID: job.ID, status: 'FAILED', message: reason } };
      }
      const changed = await tx.run(UPDATE(named.ExportJobs)
        .set({ status: 'PROCESSING', attempts: job.attempts + 1, lockedAt: timestamp,
          nextAttemptAt: null, lastError: null }).where(fence(job)));
      if (!changed) continue; // Another worker won; no outbound call from this worker.
      await audit(tx, named.AuditEvents, job, order, actor, abandoned ? 'EXPORT_LEASE_RECOVERED' : 'EXPORT_ATTEMPT',
        order.status, `Attempt ${job.attempts + 1}; immutable payload and idempotency key retained`, timestamp);
      const claimed = await tx.run(SELECT.one.from(named.ExportJobs).where({ ID: job.ID }));
      return { job: claimed };
    }
    return { finished: { processed: false, jobID: null, status: 'IDLE', message: 'No export is due for processing' } };
  });
}

async function complete(db, named, actor, claimed, outcome, timestamp) {
  return db.tx({ user: actor }, async (tx) => {
    const job = await tx.run(SELECT.one.from(named.ExportJobs).where(fence(claimed)));
    if (!job) return { processed: true, jobID: claimed.ID, status: 'STALE',
      message: 'A later worker owns this export; the stale response was ignored' };
    const order = await tx.run(SELECT.one.from(named.PurchaseOrders).where({ ID: job.order_ID }));
    if (!order || order.status !== 'EXPORT_QUEUED') {
      const reason = 'Order changed while export was running; receipt requires reconciliation';
      await tx.run(UPDATE(named.ExportJobs).set({ status: 'FAILED', lastError: reason,
        lockedAt: null, nextAttemptAt: null }).where(fence(job)));
      await audit(tx, named.AuditEvents, job, order, actor, 'EXPORT_FAILED', order?.status, reason, timestamp);
      return { processed: true, jobID: job.ID, status: 'FAILED', message: reason };
    }
    if (outcome.receipt) {
      await tx.run(UPDATE(named.ExportJobs).set({ status: 'SENT', lastError: null,
        nextAttemptAt: null, lockedAt: null, externalOrderID: outcome.receipt.externalOrderID }).where(fence(job)));
      await updateOrder(tx, named.PurchaseOrders, order, 'EXPORTED', { externalOrderID: outcome.receipt.externalOrderID });
      await audit(tx, named.AuditEvents, job, order, actor, 'EXPORT_SUCCEEDED', 'EXPORTED',
        `Fictional ERP receipt ${outcome.receipt.externalOrderID}; attempt ${job.attempts}`, timestamp);
      return { processed: true, jobID: job.ID, status: 'SENT', message: `Receipt ${outcome.receipt.externalOrderID} recorded` };
    }
    const retry = outcome.retryable && job.attempts < MAX_ATTEMPTS;
    const nextStatus = retry ? 'EXPORT_QUEUED' : 'EXPORT_FAILED';
    const nextAttemptAt = retry
      ? new Date(Date.parse(timestamp) + RETRY_DELAYS_MS[job.attempts - 1]).toISOString() : null;
    await tx.run(UPDATE(named.ExportJobs).set({ status: retry ? 'RETRY' : 'FAILED', lockedAt: null,
      nextAttemptAt, lastError: outcome.message }).where(fence(job)));
    await updateOrder(tx, named.PurchaseOrders, order, nextStatus);
    await audit(tx, named.AuditEvents, job, order, actor, retry ? 'EXPORT_RETRY_SCHEDULED' : 'EXPORT_FAILED',
      nextStatus, `${outcome.code}: ${outcome.message}; attempt ${job.attempts}`, timestamp);
    return { processed: true, jobID: job.ID, status: retry ? 'RETRY' : 'FAILED', message: outcome.message };
  });
}

async function processNextExport({ db = cds.db, user = 'system', transport = sendPurchaseOrder,
  clock = () => new Date() } = {}) {
  if (!db || db.context) throw new Error('Pass the root database service, not an active transaction');
  const actor = typeof user === 'string' && user.length <= 80 ? user : 'system';
  const named = entities(db);
  const claim = await claimNext(db, named, actor, clock().toISOString());
  if (claim.finished) return claim.finished;
  let outcome;
  try {
    // The claim transaction has COMMITTED before any network I/O starts.
    const receipt = await transport({ payload: claim.job.payload, idempotencyKey: claim.job.idempotencyKey });
    outcome = { receipt };
  } catch (error) {
    outcome = error instanceof ErpError
      ? { retryable: error.retryable, code: error.code, message: error.message.slice(0, 500) }
      : { retryable: true, code: 'TRANSPORT_FAILURE', message: 'Unexpected integration transport failure; retry uses the same key' };
  }
  // A failed database commit intentionally leaves PROCESSING durable. Recovery
  // waits for the lease, then replays the same request to recover the receipt.
  return complete(db, named, actor, claim.job, outcome, clock().toISOString());
}

module.exports = { processNextExport, MAX_ATTEMPTS, LEASE_MS, RETRY_DELAYS_MS };
