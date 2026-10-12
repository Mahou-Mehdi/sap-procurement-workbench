using { procurement as db } from '../db/schema';

@path: '/odata/v4/procurement'
@requires: ['Buyer', 'Approver', 'Manager', 'IntegrationOperator', 'Auditor']
service ProcurementService {
  type ItemInput {
    description  : String(120);
    quantity     : Decimal(12,3);
    unitPrice    : Decimal(13,2);
    deliveryDate : Date;
  }

  @readonly entity Suppliers as projection on db.Suppliers;
  @readonly entity PurchaseOrderItems as projection on db.PurchaseOrderItems;
  @readonly entity AuditEvents as projection on db.AuditEvents;
  @readonly entity ExportJobs as projection on db.ExportJobs excluding { payload };

  @readonly entity PurchaseOrders as projection on db.PurchaseOrders actions {
    @requires: 'Buyer'
    action updateDraft(expectedRevision: Integer, supplierID: UUID, title: String(120), items: many ItemInput) returns PurchaseOrders;
    @requires: 'Buyer'
    action submit(expectedRevision: Integer) returns PurchaseOrders;
    @requires: ['Approver', 'Manager']
    action approve(expectedRevision: Integer) returns PurchaseOrders;
    @requires: ['Approver', 'Manager']
    action rejectOrder(expectedRevision: Integer, reason: String(500)) returns PurchaseOrders;
    @requires: 'IntegrationOperator'
    action queueExport(expectedRevision: Integer) returns PurchaseOrders;
    @requires: 'IntegrationOperator'
    action retryExport(expectedRevision: Integer) returns PurchaseOrders;
  };

  @requires: 'Buyer'
  action createOrder(supplierID: UUID, title: String(120), items: many ItemInput) returns PurchaseOrders;
  @requires: 'IntegrationOperator'
  action processNextExport() returns {
    processed: Boolean;
    jobID: UUID;
    status: String(30);
    message: String(500);
  };
}
