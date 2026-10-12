# Architecture and transaction boundaries

OpenUI5 calls the CAP service at `/odata/v4/procurement`. Its entity projections
are read-only; business changes use the actions declared in
[`procurement-service.cds`](../srv/procurement-service.cds). SQLite stores the
orders, line items, audit history and export outbox.

This edition rejects OData `$batch` with HTTP 501. The UI sends individual
operations, so queueing and worker execution cannot be combined into one outer
batch transaction that would undermine the worker's claim/HTTP/completion split.

## Business changes

`createOrder` derives the requester from the authenticated user and computes
line amounts on the server. Quantities are represented internally as integer
thousandths and prices as integer cents. Each line rounds half-up before totals
are added. An order has 1–100 lines and a total from EUR 0.01 through
EUR 999,999,999,999.99.

Every bound mutation takes `expectedRevision`. The handler checks the current
state and performs a conditional update using the order ID, revision and state.
A competing or stale mutation receives HTTP 409. The revision increment, changed
data and audit event share the request's database transaction. Updating a draft
also replaces its items in that transaction.

| Action | Order transition | Additional rule |
| --- | --- | --- |
| `updateDraft` | `DRAFT` → `DRAFT` | Buyer must be the requester |
| `submit` | `DRAFT` → `SUBMITTED` | Requester only; supplier must not be blocked |
| `approve` | `SUBMITTED` → `APPROVED` | Separate approver; Manager for ≥ EUR 10,000 or HIGH risk |
| `rejectOrder` | `SUBMITTED` → `REJECTED` | Approver or Manager; nonblank reason |
| `queueExport` | `APPROVED` → `EXPORT_QUEUED` | IntegrationOperator |
| `retryExport` | `EXPORT_FAILED` → `EXPORT_QUEUED` | IntegrationOperator; existing failed job |

`queueExport` creates one serialized payload snapshot and the stable key
`po:<order UUID>`. The queued state, audit event and outbox insertion commit
together. Failure to store either the audit or job rolls the whole change back.
The API exposes job status and attempts but omits the raw stored payload.

## Sending a queued order

**Process next** calls `processNextExport`; there is no background scheduler.
One invocation selects at most one due job. The worker uses three distinct phases:

1. **Claim transaction:** select a `PENDING` or due `RETRY` job, conditionally mark
   it `PROCESSING`, increment attempts and record the claim time and audit event.
   Commit before sending anything over the network.
2. **HTTP:** send the original payload and key to the separate local simulator's
   custom `POST /api/purchase-orders` endpoint. The default timeout is five seconds.
3. **Completion transaction:** verify that the same attempt still owns the job.
   Commit the result, order revision/status, external receipt if available, and
   audit event together.

On success the job becomes `SENT` and the order `EXPORTED`. For a retryable failure,
the first and second attempts schedule `RETRY` after one and three seconds,
respectively; the order remains `EXPORT_QUEUED`. The next send happens only when
the integrator invokes **Process next** after that time. A nonretryable response
or the third failed attempt sets the job to `FAILED` and order to `EXPORT_FAILED`.

**Retry failed** resets that job's attempts to zero and clears its error/lease,
starting another cycle of up to three sends. It preserves the original snapshot
and idempotency key. It does not send the request itself or rebuild the payload
from potentially changed data.

## Interrupted workers and repeated requests

A `PROCESSING` job has a 30-second lease. A later **Process next** invocation may
recover an expired claim; it does not recover automatically with elapsed time.
Conditional updates include the attempt count and claim timestamp, so a late
response from an older attempt cannot overwrite the current result. An exhausted
job becomes failed instead of silently acquiring a fourth attempt.

If the simulator accepted the order but the local completion transaction failed,
the durable claim remains `PROCESSING`. Lease recovery sends the same bytes and
key again. The simulator persists receipts and returns the same receipt for an
exact replay; changed content under the same key returns HTTP 409. This is an
implemented property of this simulator, not an assumption about SAP standard APIs
or an exactly-once guarantee for arbitrary remote systems.

The workflow tests inject audit and outbox failures to verify rollback. Integration
tests cover concurrent claims, retry timing, expired leases, stale responses,
receipt replay and recovery after a completion-audit failure. Implementations are
in [`srv/`](../srv/) and [`lib/export-worker.js`](../lib/export-worker.js).
