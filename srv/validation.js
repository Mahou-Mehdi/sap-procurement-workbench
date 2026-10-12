'use strict';

const MAX_AMOUNT_CENTS = 99999999999999n;

function bad(message) {
  const error = new Error(message);
  error.status = error.statusCode = 400;
  error.code = 'INVALID_INPUT';
  throw error;
}

function text(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    bad(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return value.trim();
}

function uuid(value, label = 'supplierID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    bad(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function scaledDecimal(value, scale, precision, label, allowZero = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'number' && !Number.isFinite(value))) bad(`${label} must be a finite decimal.`);
  const source = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(source)) bad(`${label} must be a positive plain decimal.`);
  const [whole, fraction = ''] = source.split('.');
  if (fraction.length > scale) bad(`${label} supports at most ${scale} decimal places.`);
  const integer = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  if ((!allowZero && integer <= 0n) || integer > 10n ** BigInt(precision) - 1n) {
    bad(`${label} is outside the supported positive decimal range.`);
  }
  return integer;
}

function decimalString(integer, scale = 2) {
  const factor = 10n ** BigInt(scale);
  return `${integer / factor}.${String(integer % factor).padStart(scale, '0')}`;
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad('deliveryDate must use YYYY-MM-DD.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) bad('deliveryDate must be a valid calendar date.');
  return value;
}

function validateDraft(data) {
  const title = text(data.title, 'title', 120);
  const supplierID = uuid(data.supplierID);
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 100) bad('Provide between 1 and 100 order items.');
  let total = 0n;
  const items = data.items.map((item, index) => {
    if (!item || typeof item !== 'object') bad('Each item must be an object.');
    const quantity = scaledDecimal(item.quantity, 3, 12, `Item ${index + 1} quantity`);
    const price = scaledDecimal(item.unitPrice, 2, 13, `Item ${index + 1} unitPrice`);
    // Quantity is thousandths; price is cents. Round every line half-up before summing.
    const lineTotal = (quantity * price + 500n) / 1000n;
    if (lineTotal > MAX_AMOUNT_CENTS) bad('An item total exceeds the supported amount range.');
    total += lineTotal;
    if (total > MAX_AMOUNT_CENTS) bad('Order total exceeds the supported amount range.');
    return { lineNumber: index + 1, description: text(item.description, 'Item description', 120),
      quantity: decimalString(quantity, 3), unitPrice: decimalString(price),
      lineTotal: decimalString(lineTotal), deliveryDate: date(item.deliveryDate) };
  });
  if (total === 0n) bad('Order total must be at least EUR 0.01.');
  return { title, supplierID, items, totalAmount: decimalString(total) };
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) bad('expectedRevision must be a positive supported integer.');
  return value;
}

function requiresManager(order) {
  return scaledDecimal(order.totalAmount, 2, 15, 'Order amount', true) >= 1000000n || order.supplier.riskBand === 'HIGH';
}

module.exports = { validateDraft, expectedRevision, requiresManager, text, uuid, scaledDecimal, decimalString };
