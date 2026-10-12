# Fictional ERP integration simulator

This independent localhost process accepts a custom JSON purchase-order payload. It is **not SAP S/4HANA**, an OData service, or a reproduction of an SAP purchasing API.

Start from the repository root with `node mock/erp-server.js`. The default address is `http://127.0.0.1:4010`.

- `GET /health` identifies the simulator and reports the receipt count.
- `POST /api/purchase-orders` requires JSON and `Idempotency-Key: po:<reference UUID>`.
- Accepted requests return a fictional `MOCK-PO-...` identifier and receipt.
- An exact replay returns the identical persisted receipt. Changed serialized content under the same key returns HTTP 409.
- Receipt persistence precedes the HTTP acknowledgement, so retrying a lost acknowledgement cannot create a second receipt.

The adapter maps the immutable approved snapshot to `reference`, `supplierCode`, fixed fictional company/purchasing organization `1000`, `currency: EUR`, line items and `totalAmount`. Quantities have three decimal places; prices and totals have two. Integer arithmetic validates each rounded line and the order total. This mapping is a **custom test contract**, not a claim that real SAP APIs provide these fields or idempotency semantics.

Optional environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `ERP_PORT` | `4010` | Simulator listening port, on loopback only |
| `ERP_STORE` | `runtime/mock-erp-receipts.json` | Persistent receipt ledger |
| `ERP_FAIL_FIRST` | unset | Set to `1` to return one HTTP 503 per previously unseen key |
| `ERP_BASE_URL` | `http://127.0.0.1:4010` | CAP adapter's configured destination |

First-failure markers survive restart, as do successful receipts. Existing accepted keys continue to replay successfully when fail-first mode is enabled. The receipt ledger contains fictional records only and is ignored by Git.

The simulator is single-process: run only one process against a ledger file. It writes a new file, flushes it, then renames it before acknowledging. This covers process interruption/restart and lost HTTP responses; it is not a replicated production database or a guarantee against every filesystem/power-loss scenario. Keep it on localhost. There is no production authentication, ERP posting, BTP destination service, or SAP integration here.

## Durable outbox behavior in the CAP application

Queueing an approved order creates its immutable serialized snapshot and stable `po:<UUID>` key in the same database transaction as the order transition and audit event. The client never rebuilds a queued payload from subsequently changed order data.

The integration operator's **Process next export** action executes one due job:

1. A fresh, short database transaction conditionally claims the job, increments its attempt count and writes an attempt audit event.
2. After that transaction commits, an HTTP request runs with a 5-second timeout. No database transaction is held open over the network.
3. Another fresh transaction records the job result, order revision/status, external receipt and audit event together.

Transient network/server failures become eligible for retry after 1 second, then 3 seconds. There are at most three attempts per processing cycle. Permanent failures or exhausted attempts set `EXPORT_FAILED`. Explicit **Retry export** starts another cycle using the original snapshot and key. This local edition has no continuously running scheduler: press **Process next export** again after the due time, or invoke the same authorized action from a future scheduler.

A `PROCESSING` claim has a 30-second lease. The next processing call after an expired lease can reclaim it, using the same payload/key. The completion update is fenced by job status, attempt and lease timestamp, so a late response cannot overwrite a later worker's result. An expired lease after the third attempt is marked failed with an explicit uncertain-receipt message; manual retry still reuses the key.

The important failure case is **ERP accepted, local completion failed**: the local job stays `PROCESSING`, recovery asks the simulator again with the original key, and the persisted receipt is returned without a second fictional posting. A real ERP adapter would need its own documented reconciliation/idempotency design; this simulator's guarantee must not be attributed to SAP APIs.
