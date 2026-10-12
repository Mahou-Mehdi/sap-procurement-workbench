# What is actually SAP here?

| Component | Implemented in this repository | Boundary |
| --- | --- | --- |
| Application services | SAP CAP Node.js runtime | Runs locally; no BTP tenant deployed |
| Domain model | SAP CDS entities, associations and compositions | Simplified independent procurement model |
| API | CAP OData V4 services and actions | Not an S/4HANA standard purchase-order API |
| Interface | Actual OpenUI5 controls with a Fiori-style worklist | Custom UI5 application, not Fiori elements or SAP Fiori Launchpad |
| Persistence | CAP SQLite adapter | No SAP HANA instance tested |
| Authorization | CAP roles with named local demo users | Not XSUAA, IAS, SSO or a production identity setup |
| Integration | Durable outbox, manually triggered worker and local ERP simulator | Custom JSON contract; no live S/4HANA or SAP Integration Suite connection |
| History | Application audit records committed with state transitions | Not SAP Audit Log service or an immutable compliance archive |

## Business scope

The application manages purchase-order proposals and their approval/export
lifecycle. It is not a full procure-to-pay implementation. It does not implement
inventory, goods receipts, invoice verification, tax determination, accounting
postings, supplier onboarding or payment. The EUR-only examples deliberately
avoid implying that mixed-currency totals are meaningful.

The supplier risk band is a fictional manually assigned policy input. It is not
an AI model, a credit score, or a claim about a real business.

Orders contain 1–100 lines and use EUR throughout. The server accepts positive
quantities with up to three decimal places and unit prices with up to two;
it rounds each line half-up and caps the total at EUR 999,999,999,999.99. These are
this application's limits, not a claim about the limits of SAP purchasing APIs.

The simulator accepts `POST /api/purchase-orders` with this project's JSON
payload and `Idempotency-Key` header. It is a separate local HTTP process; neither
its endpoint nor its receipt format represents an SAP standard service. See the
[architecture guide](architecture.md) for the implemented delivery semantics.

## Connecting a real SAP system later

1. Obtain an authorized development system and identify the exact supported
   purchase-order API, its version and permitted operations for that system.
2. Import or model its published contract; map organizational units, supplier
   identifiers, line items, units of measure, currency and date semantics.
3. Configure the appropriate BTP destination/connectivity and authentication.
   Keep credentials out of this repository.
4. Validate CSRF handling, authorization, error responses, retry semantics and
   external duplicate detection against that real API. The simulator's
   `Idempotency-Key` contract does not establish SAP API support for that header.
5. Test a complete lifecycle in the target system and retain evidence of the
   verified result before describing it as live SAP integration experience.

## Before cloud deployment

The bootstrap deliberately refuses `NODE_ENV=production`: its public demo
passwords and persona switcher are for local learning only. A real deployment
requires appropriate identity, role collections, secret management, database
deployment/migration, service bindings, TLS, operational monitoring, retention
policies, robust worker hosting and integration-specific verification. This
repository does not supply or claim a verified production deployment descriptor.

Useful starting points are the official [CAP deployment guide](https://cap.cloud.sap/docs/guides/deployment/)
and [CAP service consumption guide](https://cap.cloud.sap/docs/guides/services/consuming-services).
