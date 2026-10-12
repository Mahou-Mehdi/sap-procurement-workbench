sap.ui.define([
  "sap/ui/core/mvc/Controller", "sap/ui/core/Fragment", "sap/m/MessageToast",
  "sap/m/MessageBox", "sap/m/Dialog", "sap/m/TextArea", "sap/m/Button", "sap/m/VBox", "sap/m/Label"
], function (Controller, Fragment, MessageToast, MessageBox, Dialog, TextArea, Button, VBox, Label) {
  "use strict";

  const BASE = "/odata/v4/procurement";
  const MONEY = new Intl.NumberFormat("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const STATUS = {
    DRAFT: ["Draft", "None"], SUBMITTED: ["Awaiting approval", "Warning"],
    APPROVED: ["Approved", "Success"], REJECTED: ["Rejected", "Error"],
    EXPORT_QUEUED: ["Export queued", "Information"], EXPORTED: ["Exported", "Success"],
    EXPORT_FAILED: ["Export failed", "Error"]
  };
  const PERSONAS = { buyer: "Buyer", approver: "Approver", manager: "Manager", integrator: "Integration operator", auditor: "Auditor" };
  const amount = (value) => MONEY.format(Number(value || 0));
  const titleCase = (value) => String(value || "").toLowerCase().replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  const time = (value) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const dateInTwoWeeks = () => {
    const date = new Date(); date.setDate(date.getDate() + 14);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const blankLine = () => ({ description: "", quantity: "1", unitPrice: "", deliveryDate: dateInTwoWeeks() });

  return Controller.extend("mehdi.procurement.controller.App", {
    onInit: function () {
      this.vm = this.getOwnerComponent().getModel("vm");
      this.vm.setProperty("/connectionLabel", "Connecting to local service");
      this.vm.setProperty("/connectionState", "Information");
      this.vm.setProperty("/hasSelection", false);
      this.onRefresh();
    },

    _api: async function (path, body) {
      const persona = this.vm.getProperty("/persona");
      const headers = { Accept: "application/json", Authorization: `Basic ${btoa(`${persona}:demo`)}` };
      const options = { method: body === undefined ? "GET" : "POST", headers, cache: "no-store", signal: AbortSignal.timeout(20000) };
      if (body !== undefined) { headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
      const response = await fetch(BASE + path, options);
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; }
      catch (_) { throw new Error(`The service returned an unreadable response (${response.status}).`); }
      if (!response.ok) {
        const detail = data.error?.message;
        const error = new Error(typeof detail === "string" ? detail : detail?.value || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return data;
    },

    _run: async function (work) {
      if (this.vm.getProperty("/busy")) return;
      this.vm.setProperty("/busy", true);
      this.vm.setProperty("/error", "");
      try { await work(); return true; }
      catch (error) {
        let message = error.message || "The request could not be completed.";
        if (error.status === 409) {
          if (this._orderDialog?.isOpen()) this._orderDialog.close();
          try { await this._reloadData(); message += " Current records have been refreshed. Review the latest revision before trying again."; }
          catch (_) { message += " Refresh the worklist to load the latest revision."; }
        }
        this.vm.setProperty("/error", message);
        MessageBox.error(message, { title: error.status === 409 ? "Order changed" : "Request could not be completed" });
        return false;
      } finally {
        this.vm.setProperty("/busy", false);
        this.vm.setProperty("/saving", false);
      }
    },

    _enrichOrder: function (order) {
      const persona = this.vm.getProperty("/persona");
      const supplier = order.supplier || {};
      const managerRequired = Number(order.totalAmount) >= 10000 || supplier.riskBand === "HIGH";
      const isApprover = persona === "approver" || persona === "manager";
      const ownRequest = order.requestedBy === persona;
      const status = STATUS[order.status] || [order.status, "None"];
      return {
        ...order,
        supplierName: supplier.name || "Unknown supplier",
        supplier_ID: order.supplier_ID || supplier.ID,
        statusText: status[0], statusState: status[1], amountText: amount(order.totalAmount),
        riskText: supplier.blocked ? "Blocked supplier" : `${titleCase(supplier.riskBand)} supplier risk`,
        riskState: supplier.blocked || supplier.riskBand === "HIGH" ? "Error" : supplier.riskBand === "MEDIUM" ? "Warning" : "Success",
        approvalLabel: managerRequired ? "Manager required" : "Standard approval",
        approvalDescription: supplier.blocked
          ? "This supplier is blocked. Submission is prevented by the service."
          : managerRequired
            ? "Approval policy: manager review for orders of at least €10,000 or with a high-risk supplier. Requesters cannot approve their own orders."
            : "Approval policy: an approver or manager reviews this order. Requesters cannot approve their own orders.",
        approvalMessageType: supplier.blocked ? "Error" : managerRequired ? "Warning" : "Information",
        revisionText: `Revision ${order.revision}`,
        requesterText: `Requested by ${order.requestedBy} · Last updated ${time(order.modifiedAt)}`,
        externalText: `ERP receipt: ${order.externalOrderID || ""}`, hasExternal: Boolean(order.externalOrderID),
        canEdit: persona === "buyer" && ownRequest && order.status === "DRAFT",
        canSubmit: persona === "buyer" && ownRequest && order.status === "DRAFT",
        canApprove: isApprover && !ownRequest && order.status === "SUBMITTED" && (!managerRequired || persona === "manager"),
        canReject: isApprover && order.status === "SUBMITTED",
        canQueue: persona === "integrator" && order.status === "APPROVED",
        canRetry: persona === "integrator" && order.status === "EXPORT_FAILED",
        items: (order.items || []).slice().sort((a, b) => a.lineNumber - b.lineNumber).map((line) => ({
          ...line, priceText: amount(line.unitPrice), lineText: amount(line.lineTotal)
        })),
        events: (order.events || []).slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).map((event) => ({
          ...event, actionText: titleCase(event.action), timeText: time(event.timestamp),
          transitionText: event.fromStatus ? `${titleCase(event.fromStatus)} → ${titleCase(event.toStatus)}` : titleCase(event.toStatus)
        }))
      };
    },

    _reloadData: async function () {
      const selectedID = this.vm.getProperty("/selected/ID");
      const [supplierData, orderData, jobData] = await Promise.all([
        this._api("/Suppliers?$orderby=name"),
        this._api("/PurchaseOrders?$expand=supplier,items,events&$orderby=modifiedAt%20desc"),
        this._api("/ExportJobs?$orderby=createdAt%20desc")
      ]);
      const suppliers = (supplierData.value || []).map((supplier) => ({
        ...supplier, label: `${supplier.name} · ${supplier.riskBand}${supplier.blocked ? " · BLOCKED" : ""}`
      }));
      const orders = (orderData.value || []).map(this._enrichOrder.bind(this));
      const byID = new Map(orders.map((order) => [order.ID, order]));
      const jobs = (jobData.value || []).map((job) => ({
        ...job, orderNumber: byID.get(job.order_ID)?.orderNumber || job.order_ID,
        jobShortID: `Job ${String(job.ID).slice(0, 8)}`,
        state: job.status === "SENT" ? "Success" : job.status === "FAILED" ? "Error" : job.status === "RETRY" ? "Warning" : "Information",
        nextOrReceipt: job.externalOrderID || (job.nextAttemptAt ? time(job.nextAttemptAt) : "—"),
        lastError: job.lastError || (job.status === "SENT" ? "Accepted by mock ERP" : "—")
      }));
      this.vm.setProperty("/suppliers", suppliers);
      this.vm.setProperty("/orders", orders);
      this.vm.setProperty("/jobs", jobs);
      this.vm.setProperty("/jobCount", jobs.length);
      // Summaries describe the records loaded into this local workbench.
      this.vm.setProperty("/metrics", {
        count: orders.length, total: `€${amount(orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0))}`,
        pending: orders.filter((order) => order.status === "SUBMITTED").length,
        approved: orders.filter((order) => order.status === "APPROVED").length,
        exportAttention: jobs.filter((job) => job.status === "RETRY" || job.status === "FAILED").length
      });
      this.vm.setProperty("/connected", true);
      this.vm.setProperty("/connectionLabel", "Local service connected");
      this.vm.setProperty("/connectionState", "Success");
      this.vm.setProperty("/lastRefresh", `Refreshed ${new Date().toLocaleTimeString("en-GB")}`);
      this._applyFilters();
      const persona = this.vm.getProperty("/persona");
      const initialOrder = orders.find((order) => order.status === "DRAFT" && order.requestedBy === persona && !order.supplier?.blocked)
        || orders.find((order) => !order.supplier?.blocked)
        || orders[0] || null;
      this._selectOrder(byID.get(selectedID) || initialOrder);
    },

    _applyFilters: function () {
      const query = (this.vm.getProperty("/query") || "").trim().toLowerCase();
      const filter = this.vm.getProperty("/filter");
      const orders = this.vm.getProperty("/orders") || [];
      const filtered = orders.filter((order) => (filter === "ALL" || order.status === filter)
        && (!query || `${order.orderNumber} ${order.title} ${order.supplierName}`.toLowerCase().includes(query)));
      this.vm.setProperty("/filteredOrders", filtered);
      this.vm.setProperty("/visibleCount", filtered.length);
      this.vm.setProperty("/visibleLabel", `${filtered.length} of ${orders.length} loaded orders · Select a row to review lines, actions and audit history.`);
    },

    _selectOrder: function (order) {
      this.vm.setProperty("/selected", order || null);
      this.vm.setProperty("/hasSelection", Boolean(order));
      const table = this.byId("ordersTable");
      if (table) {
        table.removeSelections(true);
        const item = table.getItems().find((row) => row.getBindingContext("vm")?.getProperty("ID") === order?.ID);
        if (item) table.setSelectedItem(item, true);
      }
    },

    onRefresh: function () { return this._run(this._reloadData.bind(this)); },
    onDismissError: function () { this.vm.setProperty("/error", ""); },
    onSearch: function (event) {
      this.vm.setProperty("/query", event.getParameter("newValue") ?? event.getParameter("query") ?? event.getSource().getValue());
      this._applyFilters();
    },
    onFilter: function () { this._applyFilters(); },
    onOrderSelect: function (event) { this._selectOrder(event.getParameter("listItem").getBindingContext("vm").getObject()); },
    onPersonaChange: function (event) {
      const persona = event.getSource().getSelectedKey();
      this.vm.setProperty("/persona", persona);
      this.vm.setProperty("/personaLabel", PERSONAS[persona]);
      this.vm.setProperty("/isBuyer", persona === "buyer");
      this.vm.setProperty("/isIntegrator", persona === "integrator");
      return this.onRefresh();
    },

    _openEditor: async function (order) {
      if (!this._orderDialog) {
        this._orderDialog = await Fragment.load({ id: this.getView().getId(), name: "mehdi.procurement.view.OrderDialog", controller: this });
        this.getView().addDependent(this._orderDialog);
      }
      this.vm.setProperty("/editorHeading", order ? `Edit ${order.orderNumber}` : "Create purchase order draft");
      this.vm.setProperty("/editor", {
        ID: order?.ID || null, expectedRevision: order?.revision,
        title: order?.title || "", supplierID: order?.supplier_ID || this.vm.getProperty("/suppliers").find((supplier) => !supplier.blocked)?.ID || "",
        items: order ? order.items.map((line) => ({ description: line.description, quantity: String(line.quantity), unitPrice: String(line.unitPrice), deliveryDate: line.deliveryDate })) : [blankLine()]
      });
      this._orderDialog.open();
    },
    onCreate: function () { this._openEditor(null).catch((error) => MessageBox.error(error.message)); },
    onEdit: function () { this._openEditor(this.vm.getProperty("/selected")).catch((error) => MessageBox.error(error.message)); },
    onCancelDraft: function () { this._orderDialog.close(); },
    onAddLine: function () {
      const items = this.vm.getProperty("/editor/items").slice();
      if (items.length >= 100) { MessageBox.information("A purchase order supports up to 100 lines."); return; }
      items.push(blankLine()); this.vm.setProperty("/editor/items", items);
    },
    onRemoveLine: function (event) {
      const path = event.getSource().getBindingContext("vm").getPath();
      const index = Number(path.split("/").pop());
      const items = this.vm.getProperty("/editor/items").slice();
      items.splice(index, 1); this.vm.setProperty("/editor/items", items);
    },
    onSaveDraft: function () {
      const editor = this.vm.getProperty("/editor");
      const payload = {
        supplierID: editor.supplierID, title: editor.title.trim(),
        items: editor.items.map((line) => ({ description: String(line.description).trim(), quantity: String(line.quantity), unitPrice: String(line.unitPrice), deliveryDate: line.deliveryDate }))
      };
      if (!payload.title || !payload.supplierID || !payload.items.length) { MessageBox.warning("Enter a request title, select a supplier, and add at least one line."); return; }
      const invalid = payload.items.find((line) => !line.description || !/^\d+(\.\d{1,3})?$/.test(line.quantity) || Number(line.quantity) <= 0 || !/^\d+(\.\d{1,2})?$/.test(line.unitPrice) || Number(line.unitPrice) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(line.deliveryDate));
      if (invalid) { MessageBox.warning("Each line needs a description, a positive quantity (up to 3 decimals), a positive price (up to 2 decimals), and a valid delivery date."); return; }
      this._run(async () => {
        this.vm.setProperty("/saving", true);
        let result;
        if (editor.ID) result = await this._api(`/PurchaseOrders(${editor.ID})/ProcurementService.updateDraft`, { ...payload, expectedRevision: editor.expectedRevision });
        else result = await this._api("/createOrder", payload);
        this._orderDialog.close();
        await this._reloadData();
        if (result.ID) this._selectOrder(this.vm.getProperty("/orders").find((order) => order.ID === result.ID));
        MessageToast.show("Draft saved. Amounts and approval route were calculated by the service.");
      });
    },

    _act: function (name, extra, message) {
      const order = this.vm.getProperty("/selected");
      if (!order) return;
      return this._run(async () => {
        await this._api(`/PurchaseOrders(${order.ID})/ProcurementService.${name}`, { expectedRevision: order.revision, ...extra });
        await this._reloadData(); MessageToast.show(message);
      });
    },
    onSubmit: function () { return this._act("submit", {}, "Order submitted for approval."); },
    onApprove: function () { return this._act("approve", {}, "Order approved."); },
    onQueue: function () { return this._act("queueExport", {}, "Immutable export snapshot queued."); },
    onRetry: function () { return this._act("retryExport", {}, "The same export snapshot and idempotency key are queued for retry."); },
    onReject: function () {
      const reason = new TextArea({ width: "100%", rows: 4, maxLength: 500, placeholder: "Explain why this order is being rejected" });
      const label = new Label({ text: "Rejection reason", required: true, labelFor: reason });
      const dialog = new Dialog({
        title: "Reject purchase order", contentWidth: "30rem", content: [new VBox({ items: [label, reason] }).addStyleClass("sapUiSmallMargin")],
        beginButton: new Button({ text: "Reject order", type: "Reject", press: async () => {
          const value = reason.getValue().trim();
          if (!value) { reason.setValueState("Error"); reason.setValueStateText("A rejection reason is required."); return; }
          dialog.setBusy(true);
          const succeeded = await this._act("rejectOrder", { reason: value }, "Order rejected; the reason is recorded in its audit history.");
          dialog.setBusy(false);
          if (succeeded) dialog.close();
        } }),
        endButton: new Button({ text: "Cancel", press: () => dialog.close() }), afterClose: () => dialog.destroy()
      });
      this.getView().addDependent(dialog); dialog.open();
    },
    onProcess: function () {
      return this._run(async () => {
        const result = await this._api("/processNextExport", {});
        await this._reloadData();
        MessageToast.show(result.message || (result.processed ? `Export processing result: ${result.status}` : "No eligible export job is ready."), { duration: 6000 });
      });
    },
    onOpenJobOrder: function (event) {
      const job = event.getSource().getBindingContext("vm").getObject();
      const order = this.vm.getProperty("/orders").find((item) => item.ID === job.order_ID);
      if (!order) { MessageBox.information("This order is not in the loaded worklist. Refresh and try again."); return; }
      this.vm.setProperty("/query", ""); this.vm.setProperty("/filter", "ALL"); this._applyFilters();
      this.byId("mainTabs").setSelectedKey("orders"); this._selectOrder(order);
    },
    onExit: function () { if (this._orderDialog) this._orderDialog.destroy(); }
  });
});
