'use strict';

// This adapter speaks only the fictional simulator's custom JSON contract.
// It is NOT an implementation of an SAP S/4HANA purchasing API.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ErpError extends Error {
  constructor(message, { retryable = false, code = 'INVALID_EXPORT' } = {}) {
    super(message);
    this.name = 'ErpError';
    this.retryable = retryable;
    this.code = code;
  }
}

function decimal(value, scale, field) {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length || 0) > scale || match[1].length > 12) {
    throw new ErpError(`Invalid ${field} in export snapshot`);
  }
  return `${BigInt(match[1])}.${(match[2] || '').padEnd(scale, '0')}`;
}

function integerUnits(value, scale, field) {
  return BigInt(decimal(value, scale, field).replace('.', ''));
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !UUID.test(payload.reference) || payload.currency !== 'EUR'
      || payload.companyCode !== '1000' || payload.purchasingOrganization !== '1000'
      || typeof payload.supplierCode !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(payload.supplierCode)
      || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) {
    throw new ErpError('Export snapshot does not match the fictional ERP contract');
  }
  const lines = new Set();
  let totalCents = 0n;
  for (const item of payload.items) {
    if (!item || !Number.isSafeInteger(item.lineNumber) || item.lineNumber < 1
        || lines.has(item.lineNumber) || typeof item.description !== 'string'
        || !item.description.trim() || item.description.length > 120 || !validDate(item.deliveryDate)) {
      throw new ErpError('Invalid line item in export snapshot');
    }
    lines.add(item.lineNumber);
    const quantity = integerUnits(item.quantity, 3, 'quantity');
    const price = integerUnits(item.unitPrice, 2, 'unit price');
    if (quantity <= 0n || price <= 0n) throw new ErpError('Export quantities and prices must be positive');
    totalCents += (quantity * price + 500n) / 1000n;
  }
  if (totalCents !== integerUnits(payload.totalAmount, 2, 'total amount')) {
    throw new ErpError('Export total does not equal the rounded line totals');
  }
  return payload;
}

function buildPayload(order) {
  if (!order || !order.supplier || !Array.isArray(order.items)) {
    throw new ErpError('Supplier and items must be loaded before queueing an export');
  }
  return validatePayload({
    reference: order.ID,
    supplierCode: order.supplier.code,
    companyCode: '1000',
    purchasingOrganization: '1000',
    currency: order.currency,
    items: [...order.items].sort((a, b) => a.lineNumber - b.lineNumber).map((item) => ({
      lineNumber: item.lineNumber,
      description: item.description,
      quantity: decimal(item.quantity, 3, 'quantity'),
      unitPrice: decimal(item.unitPrice, 2, 'unit price'),
      deliveryDate: item.deliveryDate,
    })),
    totalAmount: decimal(order.totalAmount, 2, 'total amount'),
  });
}

async function readReceipt(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16_384) throw new ErpError('ERP response exceeds the supported size', { retryable: true, code: 'BAD_RESPONSE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ErpError('ERP returned an invalid receipt', { retryable: true, code: 'BAD_RESPONSE' }); }
}

async function sendPurchaseOrder({ payload, idempotencyKey,
  baseUrl = process.env.ERP_BASE_URL || 'http://127.0.0.1:4010', timeoutMs = 5000,
  fetchImpl = globalThis.fetch } = {}) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { throw new ErpError('Stored export snapshot is not valid JSON'); }
  validatePayload(parsed);
  if (idempotencyKey !== `po:${parsed.reference}`) throw new ErpError('Export key does not match the order reference');
  let endpoint;
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    endpoint = new URL('/api/purchase-orders', base);
  } catch { throw new ErpError('ERP_BASE_URL must be an HTTP(S) URL without credentials', { code: 'CONFIGURATION' }); }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 20_000) {
    throw new ErpError('ERP timeout must be between 10 and 20,000 ms', { code: 'CONFIGURATION' });
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (![200, 201].includes(response.status)) {
      // Never propagate arbitrary upstream bodies, credentials, URLs, or stack traces.
      await response.body?.cancel();
      const retryable = response.status >= 500 || [408, 425, 429].includes(response.status);
      const message = response.status === 409 ? 'ERP rejected an idempotency key with changed content'
        : `ERP request failed with HTTP ${response.status}`;
      throw new ErpError(message, { retryable, code: `HTTP_${response.status}` });
    }
    const receipt = await readReceipt(response);
    if (receipt.reference !== parsed.reference || receipt.status !== 'ACCEPTED'
        || typeof receipt.externalOrderID !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(receipt.externalOrderID)) {
      throw new ErpError('ERP receipt does not match the submitted order', { retryable: true, code: 'BAD_RESPONSE' });
    }
    return receipt;
  } catch (error) {
    if (error instanceof ErpError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ErpError('ERP request timed out; receipt may exist and retry will reuse the same key', { retryable: true, code: 'TIMEOUT' });
    }
    throw new ErpError('ERP connection failed; retry will reuse the same key', { retryable: true, code: 'NETWORK' });
  }
}

module.exports = { buildPayload, validatePayload, sendPurchaseOrder, ErpError };
