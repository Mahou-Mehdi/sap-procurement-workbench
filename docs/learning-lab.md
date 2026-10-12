# Learn the project by changing it

This project is an independent SAP development portfolio exercise. Running it
and reproducing its results is the first step; the following changes help build
the experience needed to explain and extend it.

## 1. Trace one complete purchase order

1. Sign in through the local demo persona selector as **buyer**.
2. Create an order below EUR 10,000 for the fictional low-risk supplier Northfield
   Components. Add two lines and check the server-calculated EUR total. Quantities
   accept three decimal places, prices two; each line rounds half-up to cents.
3. Submit it, then switch to **approver** and approve the request.
4. Switch to **integrator**, queue the export, then process the integration queue.
5. Inspect the external reference, integration attempts and audit history.
6. Open the browser's network inspector and identify the OData request for each
   action. Find its declaration in the CDS service and handler in the server.

Explain why the interface is allowed to hide a button, but the server still needs
to reject the same action from an unauthorized caller.

## 2. Make a controlled change to an approval rule

The initial approval policy requires a manager for orders of at least EUR 10,000 or a
high-risk supplier. Write tests at EUR 9,999.99 and EUR 10,000.00 before changing
the threshold. Find every place the interface describes this rule and ensure it
still agrees with the backend. Do not change tests just to make a broken rule pass.

Explain the difference between a business policy and a user role. Consider where
this policy would live in a configurable enterprise implementation.

## 3. Reproduce a conflict

Read the same draft revision in two clients. Save an edit from the first client,
then submit an action with the old revision from the second. Verify that it is
rejected and that no misleading audit event was committed.

Explain why a read followed by an unconditional write would allow lost updates.
Point to the conditional update and its transaction boundary.

## 4. Break the ERP connection and recover

Run the ERP simulator with `ERP_FAIL_FIRST=1` in its environment. Create and
approve a new order, queue it and process its job. Inspect the retry state, then
click **Process next** after the one-second retry delay expires. The worker does
not run in the background. Verify that the successful receipt is recorded and
that replaying the same request returns that receipt.

To exercise terminal failure, stop the simulator and process a different queued
order. Repeat **Process next** after each due time: retry delays are one second
after the first failure and three seconds after the second. The third failure
sets the order to `EXPORT_FAILED`. Restart the simulator, use **Retry failed**,
then **Process next**. The explicit retry resets attempts to zero but retains the
same immutable payload and idempotency key.

Try replaying the exact same request and then reusing its idempotency key with a
different body. Explain why a network timeout does not prove that the remote
system rejected the request.

The simulator is a deliberately small custom API. Its idempotency behavior must
not be assumed to exist in an arbitrary SAP backend.
Use the [transaction guide](architecture.md) to identify where the claim commits,
where HTTP runs, and where the receipt and application audit commit together.

## 5. Extend the model

Add a cost center to a purchase order. Validate it, include it in the interface,
persist it in the CDS model, add it to the integration payload and test it.
Decide what happens to previously queued immutable messages after a model change.

This is a useful first independent contribution because it crosses data
modelling, business logic, UI and integration boundaries.

## 6. Prepare a five-minute technical demonstration

- State the procurement problem and distinguish the application from an ERP.
- Show an order that needs managerial approval and demonstrate a denied action.
- Show a successful export and its audit trail.
- Explain CDS, OData, OpenUI5, optimistic concurrency and the outbox in your own words.
- Identify which parts were tested locally and what remains before a real SAP deployment.

Keep a small changelog of the extensions you personally implement, the errors you
encounter, and how you resolve them. These make concrete interview examples.

## Official learning material

- [Introduction to SAP Cloud Application Programming Model](https://learning.sap.com/courses/introduction-to-sap-cloud-application-programming-model)
- [CAP domain modelling](https://cap.cloud.sap/docs/guides/domain-modeling)
- [CAP access control](https://cap.cloud.sap/docs/guides/security/authorization)
- [CAP consuming services](https://cap.cloud.sap/docs/guides/services/consuming-services)
- [OpenUI5 documentation](https://sdk.openui5.org/)
- [Acquiring core ABAP skills](https://learning.sap.com/learning-journeys/acquiring-core-abap-skills)

CAP and ABAP are different development paths. This repository demonstrates CAP
and UI5; it is not evidence of an ABAP implementation. For jobs that require ABAP,
continue with ABAP fundamentals and RAP on an actual ABAP environment.
