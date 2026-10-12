namespace procurement;

using { cuid, managed } from '@sap/cds/common';

type RiskBand : String(10) enum { LOW; MEDIUM; HIGH; }
type OrderStatus : String(30) enum {
  DRAFT; SUBMITTED; APPROVED; REJECTED; EXPORT_QUEUED; EXPORTED; EXPORT_FAILED;
}
type ExportStatus : String(20) enum { PENDING; PROCESSING; RETRY; SENT; FAILED; }

@assert.unique: { code: [code] }
entity Suppliers : cuid {
  code     : String(20) not null;
  name     : String(120) not null;
  country  : String(2) not null;
  riskBand : RiskBand default 'LOW';
  blocked  : Boolean default false;
}

@assert.unique: { orderNumber: [orderNumber] }
entity PurchaseOrders : cuid, managed {
  orderNumber    : String(20) not null;
  title          : String(120) not null;
  supplier       : Association to Suppliers not null;
  currency       : String(3) default 'EUR';
  totalAmount    : Decimal(15,2) not null;
  status         : OrderStatus default 'DRAFT';
  requestedBy    : String(80) not null;
  revision       : Integer default 1;
  externalOrderID: String(40);
  items          : Composition of many PurchaseOrderItems on items.order = $self;
  events         : Association to many AuditEvents on events.order = $self;
}

@assert.unique: { orderLine: [order, lineNumber] }
entity PurchaseOrderItems : cuid {
  order        : Association to PurchaseOrders not null;
  lineNumber   : Integer not null;
  description  : String(120) not null;
  quantity     : Decimal(12,3) not null;
  unitPrice    : Decimal(13,2) not null;
  lineTotal    : Decimal(15,2) not null;
  deliveryDate : Date not null;
}

entity AuditEvents : cuid {
  order      : Association to PurchaseOrders not null;
  timestamp  : Timestamp @cds.on.insert: $now;
  actor      : String(80) not null;
  action     : String(40) not null;
  fromStatus : String(30);
  toStatus   : String(30);
  details    : String(1000);
}

@assert.unique: { idempotencyKey: [idempotencyKey] }
entity ExportJobs : cuid, managed {
  order           : Association to PurchaseOrders not null;
  status          : ExportStatus default 'PENDING';
  attempts        : Integer default 0;
  idempotencyKey  : String(80) not null;
  payload         : LargeString not null;
  lastError       : String(500);
  nextAttemptAt   : Timestamp;
  lockedAt        : Timestamp;
  externalOrderID : String(40);
}
