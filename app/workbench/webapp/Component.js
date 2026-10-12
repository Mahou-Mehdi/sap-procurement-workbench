sap.ui.define(["sap/ui/core/UIComponent", "sap/ui/model/json/JSONModel"], function (UIComponent, JSONModel) {
  "use strict";
  return UIComponent.extend("mehdi.procurement.Component", {
    metadata: { manifest: "json" },
    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      const model = new JSONModel({
        persona: "buyer", personaLabel: "Buyer", isBuyer: true, isIntegrator: false,
        busy: false, error: "", connected: false, lastRefresh: "Not loaded",
        orders: [], filteredOrders: [], suppliers: [], jobs: [], selected: null,
        query: "", filter: "ALL", visibleCount: 0,
        metrics: { count: 0, pending: 0, approved: 0, exportAttention: 0, total: "€0.00" },
        editor: { title: "", supplierID: "", items: [] }
      });
      model.setSizeLimit(2000);
      this.setModel(model, "vm");
    }
  });
});
