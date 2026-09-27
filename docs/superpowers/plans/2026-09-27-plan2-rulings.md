# Plan 2 — execution rulings (from SDD ledger, 2026-09-27)

## Rulings
- Ruling P2-R1: Implementation on branch feat/plan2-planning stacked on feat/plan1-foundation (PO asked to keep Plan 1 branch for review and continue) — cost if wrong: rebase if Plan 1 changes after review.
- Ruling P2-R2 (PO decision 2026-09-27): frontends = Vite+React+TS+Tailwind in apps/admin + apps/driver (same repo); POD files on DigitalOcean Spaces from the start (PO provides bucket/keys via .env); sequence: finish Plan 2 → Plan 3 backend → frontends + demo seed → Plan 4 later — cost if wrong: n/a (PO choice).
- Ruling P2-R3 (PO 2026-09-27): frontends use shadcn/ui (on Tailwind) for components.
Task 2: minor (deferred): weeklyDaysOff accepts duplicates; status code max(20) vs Code max(40)
- Ruling P2-R4: Task 3 plan-mandated gaps accepted — DO PATCH update filter re-asserts status+shipmentId (409 DO_CHANGED), unit follows a changed material unless given; cancel audit carries before/after — cost if wrong: none.
Task 3: minor (deferred): create-time job-group warning message says "this delivery order" (details carry doNo)
Task 3: minor (deferred): manual job group not re-checked for active on unrelated PATCH
Task 3: minor (deferred): DO_CHANGED 409 proven at service layer, no HTTP-level test
Task 4: minor (deferred): DO numbers consumed before transaction are skipped if it fails (accepted: numbers never reused)
Task 5: minor (deferred): DO_DUPLICATED details lack side/stop indices; auto-built stops depend on DO order supplied by caller (documented)
- Ruling P2-R5 (PO 2026-09-27 "skip driver and truck status and continue"): Task 11 (/availability) dropped from scope; Task 6 task-review skipped (reviewer failed on SSL/API error) — its code stays and is covered by the final whole-branch review; Task 7 keeps block/day-off/holiday checks since the code exists — cost if wrong: unreviewed T6 until final review; no availability endpoint for the planning board.
Task 6: parked — task review not run (API SSL error; PO asked to move on) — Ruling: covered by final review
Task 7: minor (deferred): unknown-DO-id path in toDraft untested
Task 7: minor (deferred → Plan 3): validation flags own DOs in PICKED_UP+ as DO_NOT_AVAILABLE (only matters if a post-pickup shipment is ever re-validated)
- Ruling P2-R6: Task 8 concurrent vehicle/driver double booking (write skew under snapshot isolation) — fix with reserveResources: $inc bookingLock on vehicle/driver docs inside the txn + session re-check → 409 RESOURCE_TAKEN; must also be used by updateShipment in Task 9 (carry to T9 dispatch). Job-group master-data reads outside the session accepted — cost if wrong: one extra write per resource per booking.
Task 8: minor (deferred): truckTypeId list filter matches head only; SH number burned if txn aborts (accepted)
Task 8: minor (deferred): bookingLock appears in audit before/after of vehicle/driver PATCH (no audit read API yet)
- Ruling P2-R7: Tasks 12 and 13 are small and independent — dispatched together to one implementer and reviewed as one unit; README must omit the /availability line (Task 11 skipped) — cost if wrong: coarser review granularity.
- Ruling P2-R8: Task 13 deviation accepted — client-level timeoutMS (CSOT) + session.withTransaction breaks bulkWrite/insertMany in mongodb 6.21; those two call sites now write sequentially inside the transaction. Carry to Plan 3 global constraints: never use bulkWrite/insertMany inside withTransaction — cost if wrong: slower large imports (≤500 rows, acceptable).
Task 13: parked — sequential writes inside one transaction share the client timeoutMS (5 s) budget, so very large bulk DO/import batches may time out — Ruling: accepted for now; revisit in Plan 4 load test (raise MONGO_TIMEOUT_MS for batch routes or cap batch size)
Task 12: minor (deferred): README heading still says "Availability"; applyOp default branch throws plain Error
- Ruling P2-R9: ONE fix wave covers Important 1–3 plus cheap minors (decline reason + set fields in transition audit, plan/dispatch return+store fresh warnings, block cancel audit before/after, block source enum + 'hr', README heading, missing tests DO_LOCKED_BY_SHIPMENT / SHIPMENT_NOT_CANCELLABLE / NOT_A_DRIVER). Everything else parked to Plan 3/4 — cost if wrong: minor items resurface later.
- Ruling P2-R10: accept/decline body = { version } compared with shipment.version (the version the driver saw in the job list) → 409 VERSION_CONFLICT; UI plan must send it — cost if wrong: one more field on the driver app.
- Ruling P2-R11: re-review APPROVED; linkDos/releaseDos per-DO rematch (2 queries/DO, ≤50 DOs) parked to Plan 4 perf pass — cost if wrong: slower edits of very large shipments.
