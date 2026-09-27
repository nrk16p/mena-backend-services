# mena-backend-services — Costing: Rate Cards, Shipment Estimates, Truck/Driver Month-to-Date — Design

Status: DRAFT for PO review (2026-09-27). Research basis: `research-rate-engine.md` (Oracle OTM, SAP TM charge calculation sheets, Thai tariff practice, DOPA geography datasets).
Supersedes the "rate engine" sketch in Phase 1 spec §9 and Phase 2 requirements §2 (the three money-line kinds stay the same).

## 1. Goals

1. Every shipment shows an **estimated revenue, cost and margin** as soon as it is planned (DRAFT included), with a line-by-line breakdown.
2. At close the estimate is **re-priced with actual data** (delivered qty, actual stops, waiting, overnight) and **locked** into the Trip Summary. Later rate edits never change closed shipments.
3. **Month-to-date views per truck and per driver**: closed shipments at locked actuals + open shipments at estimates, shown separately and totalled.
4. The rate engine supports every common Thai pricing pattern: per trip (เหมาเที่ยว), per unit (ตัน / คิว / พาเลท / drop), per km and distance bands, zone / province / district matrices, cross-province surcharge (ข้ามจังหวัด), minimum/maximum, accessorials (extra drop, ค่ารอ, ค่าค้างคืน, unloading, after-hours/holiday, เที่ยวเปล่า, backhaul, reefer), and diesel-price escalation.
5. Costs: driver pay (ค่าเที่ยว พจส.), fuel, tolls/other trip costs, maintenance share, depreciation.
6. Planners and admins can review, verify PODs and close (PO 2026-09-27).

Out of scope here: invoicing/AR, payroll payment, accounting postings, month close snapshots (Phase 2 §3.4 — built on top of this).

## 2. Concepts

| Concept | What it is |
|---|---|
| **Rate card** | One versioned, dated pricing rule for a scope (who/what/where). Kind: `revenue` (billed to client), `driverPay` (paid to driver), `tripCost` (company cost standards). |
| **Scope** | Which shipments/DOs the card applies to: client, job group, truck type, service type, material, origin area, destination area. Empty = any. |
| **Charge lines** | Ordered list inside a card (SAP "charge calculation sheet"): base charge, then surcharges, accessorials, fuel adjustment, min/max clamp. |
| **Area** | Location, district (อำเภอ), province (จังหวัด), or a named custom **zone** (set of provinces/districts, e.g. `BKK-METRO`, `EAST`). |
| **Lane** | Origin location → destination location with road km and toll/other costs. The distance source for estimates. |
| **Pricing snapshot** | The computed breakdown stored on the shipment: `estimate` (mutable until close) and `actual` (written once at close). |

## 3. Geography

- New reference collection `geoAdmin`: 77 provinces, ~928 districts, ~7,400 subdistricts with DOPA codes (2/4/6 digits), TH/EN names, centroid lat/lng. Seeded once from `thailand-geography-data/thailand-geography-json` (codes/names) + `spicydog/thailand-province-district-subdistrict-zipcode-latitude-longitude` (centroids). Licences checked at implementation; seed file committed under `seed/geo/`.
- Locations gain `admin { provinceCode, districtCode, subdistrictCode, source: 'auto' | 'manual' }`. On create/update the API resolves it from lat/lng by nearest subdistrict centroid (district ≠ reliable at borders → planner can override; `manual` is never overwritten). Existing locations are backfilled by a one-off script.
- `zones`: named groups `{ code, name, provinceCodes[], districtCodes[] }`, managed by admin/planner. A location can fall in several zones.
- **Cross-province** = origin province ≠ destination province (derived, used as a line condition).

## 4. Distance

Estimates need km before any GPS exists:
1. **Lane table** (`lanes`): `{ originLocationId, destLocationId, km, tollBaht, otherCostBaht, source: 'manual' | 'import' | 'gps' }` — planners enter or import from Excel. Directional; the reverse lane is used if the direct one is missing.
2. **Fallback**: straight-line (haversine) × 1.3 road factor, marked `DISTANCE_ESTIMATED` in the breakdown so planners know to add the lane.
3. **Actual at close**: GPS km from Plan 4 when available; otherwise the lane km.
Each leg (loaded or empty) gets km; DO distance = its pickup→drop loaded km.

## 5. Rate cards

```ts
rateCards {
  _id, code, name, kind: 'revenue' | 'driverPay' | 'tripCost',
  scope: {
    clientId?, jobGroupId?, truckTypeId?, serviceTypeId?, materialId?,
    origin?: { type: 'location' | 'district' | 'province' | 'zone', ids: string[] },
    dest?:   { type: 'location' | 'district' | 'province' | 'zone', ids: string[] },
  },
  level: 'do' | 'shipment',            // revenue: usually 'do'; driverPay/tripCost: usually 'shipment'
  lines: ChargeLine[],                  // evaluated in order
  min?: number, max?: number,           // clamp on the card total (after all lines except fuel)
  fuelClause?: { series: 'DIESEL_B7', basePrice, stepBaht, mode: 'pctOfBase' | 'bahtPerKm', perStep, capPct? },
  validFrom: Date, validTo: Date | null,
  version: number, supersedesId?, status: 'draft' | 'active' | 'retired',
  note?, createdBy, createdAt, approvedBy?, approvedAt?
}

ChargeLine {
  code: 'BASE' | 'DISTANCE' | 'CROSS_PROVINCE' | 'EXTRA_DROP' | 'WAITING' | 'OVERNIGHT' | 'ALLOWANCE'
      | 'UNLOADING' | 'AFTER_HOURS' | 'HOLIDAY' | 'DRY_RUN' | 'BACKHAUL' | 'REEFER' | 'CUSTOM',
  label: string,                        // shown on breakdown, Thai
  basis: 'perTrip' | 'perUnit' | 'perKm' | 'perDrop' | 'perBlock' | 'perDay' | 'pctOf',
  measure?: 'qty' | 'km' | 'loadedKm' | 'drops' | 'waitMinutes' | 'days',   // what the scale reads
  scale?: { mode: 'step' | 'graduated', bands: { from: number, to: number | null, rate: number }[] },
  rate?: number,                        // when no scale
  free?: number,                        // free allowance before charging (e.g. 60 wait minutes, first drop, first 15 km)
  blockSize?: number,                   // perBlock: e.g. 30 minutes
  pctOf?: string[],                     // pctOf: codes of earlier lines
  when?: { crossProvince?: boolean, overnight?: boolean, holiday?: boolean, afterHours?: boolean, emptyLeg?: boolean, doOutcome?: 'FAILED' },
  perQty?: boolean,                     // multiply the line by the DO qty (e.g. baht per km per คิว)
  min?: number, max?: number,
}
```
- `step` scale: the whole measure is priced at the band it falls in (ton breaks). `graduated`: each band prices its own slice (progressive distance bands).
- `perUnit` uses the DO unit (ตัน/คิว/พาเลท…); the card is only valid for DOs whose unit matches the material's unit (validated on save).
- A **zone/province matrix** is many cards (one per origin × destination cell); the admin UI edits and imports them as a grid from Excel.
- **Versioning**: an active card is never edited. "Edit" creates a new version (draft → active), sets the old one's `validTo`. Drafts can be test-priced but never used for estimates.
- **Approval**: activating a card requires role `admin` (finance authority); planners can create drafts. (PO to confirm — Q3.)

### 5.1 Card selection (precedence)
For each DO (revenue, `level: do`) or shipment (driverPay/tripCost), candidate cards = `active`, valid on the shipment's planned start (Bangkok date), whose every scope field matches (empty = wildcard).
Specificity score: client 64, job group 32, origin/dest area each by type (location 8, district 4, province 3, zone 2), truck type 1, service type 1, material 1. Highest score wins; equal top scores → `RATE_AMBIGUOUS` warning and no price (planner must fix cards) — same principle as job groups.
No candidate → `RATE_NOT_FOUND` warning. A per-DO **manual price** (spot quote with reason, audited) always wins over cards.

### 5.2 Calculation order (per card)
1. Evaluate lines in order → amounts (each clamped by its own min/max).
2. Sum → clamp by card `min`/`max` (e.g. minimum 3 คิว equivalent).
3. Fuel clause: steps = floor(|currentDiesel − basePrice| / stepBaht) with sign; adjust as % of base or baht/km; cap.
4. Result = breakdown `{ cardId, version, lines: [{ code, label, qty, rate, amount }], total }`.
Money stored as integer satang internally; displayed in baht with 2 decimals. Amounts exclude VAT; client `taxTreatment` (default "transport — VAT exempt, WHT 1%") is carried on the breakdown for later invoicing only.

### 5.3 Worked examples (acceptance tests)
1. **Mixer per คิว, minimum 3 คิว, distance surcharge beyond 15 km**: BASE perUnit 850 with line `min` 2,550 (= 3 คิว); DISTANCE perUnit-km (basis perKm, measure km, free 15, rate 10.70, multiplied by qty). 2.5 คิว at 20 km → BASE max(2,125, 2,550) = 2,550; DISTANCE 5 km × 10.70 × 2.5 = 133.75 → 2,683.75.
2. **Feedmill per ton by destination district + ข้ามจังหวัด**: step scale 0–10 t @ 450, 10+ @ 400; CROSS_PROVINCE perTrip 500 when crossProvince. 15 t cross-province → 15 × 400 + 500 = 6,500.
3. **Trailer flat per lane + diesel escalation**: BASE perTrip 8,000; fuel clause base 32.50, step 1.00, +1.5 %/step; diesel 33.80 → +120 → 8,120.
4. **Cold-chain per trip + extra drops + waiting + reefer**: BASE 3,500; REEFER perDay 500; EXTRA_DROP perDrop free 1 rate 300; WAITING perBlock 30 min free 60 rate 100. 3 drops, 90 min wait, 1 day → 3,500 + 500 + 600 + 100 = 4,700.
5. **Driver pay by distance band + overnight**: BASE perTrip, measure km, step bands 0–100 @ 600, 100–300 @ 900, 300+ @ 1,400; OVERNIGHT 300 when overnight. 250 km with overnight → 1,200.

## 6. Trip cost

`tripCost` cards hold company standards per truck type (or per client/job group where different):
- **Fuel** = Σ legs km × consumption (litres/100 km by truck type, separate loaded / empty values, optional mixer drum-running litres per drop) × diesel price on the planned date.
- **Tolls / other** = from lanes (+ CUSTOM lines, e.g. ค่าผ่านท่าเรือ, ค่าลงสินค้า paid by us).
- **Driver pay** = the `driverPay` card result (it is both driver income and company cost).
- **Maintenance share** = km × maintenance baht/km. Per-vehicle rate if set (later auto-computed monthly from ATMS repair/PM/tyre cost ÷ GPS km, rolling 6 months), else the truck-type standard.
- **Depreciation** (optional per vehicle): `vehicleCostProfile { purchasePrice, residualValue, startDate, lifeMonths | lifeKm, method: 'perKm' | 'perMonth' }`. `perKm` → allocated per trip by km; `perMonth` → not on trips, added to the truck month view as a fixed line.
- Head + tail: maintenance/depreciation computed for each vehicle (tail uses its own profile).
- **Allocation to DOs** (for client / job-group margin): shipment costs split across DOs by loaded km share; empty legs split by the same shares.

Diesel price: `dieselPrices { date, series, baht }` entered by admin (weekly or when it changes) or imported; the estimate uses the latest price on/before the planned date.

## 7. Pricing lifecycle on a shipment

```
shipment.pricing = {
  estimate: { revenue, driverPay, cost: { fuel, tolls, other, maintenance, depreciation, driverPay, total }, margin,
              perDo: [{ doId, revenue, costShare }], warnings: [...], pricedAt, inputs: { km, dieselPrice, ... } } | null,
  actual:   same shape | null,          // written once at close, then immutable
}
```
- **Estimate** recomputed (in the same transaction) on shipment create/update/plan/dispatch, DO qty changes, and when a planner presses "คำนวณใหม่" (e.g. after adding a lane or rate card). Estimates of open shipments are **not** silently recomputed when rate cards change; the shipment shows "เรทมีการเปลี่ยนแปลง — คำนวณใหม่" instead (bounded work; no mass recompute).
- **Actual** at close: same cards (the versions valid on the planned start date), actual inputs: delivered qty (POD qtyLines), actual drops, failed DOs (`when.doOutcome = FAILED` lines, e.g. dry run), waiting minutes (ARRIVED→DEPARTED minus loading/unloading, from events), overnight (trip crosses 00:00 Bangkok with the driver away from base), GPS km if available else lane km.
- **Close rule**: a shipment can close only when every DO has a revenue price (card or manual). Missing driver-pay/cost cards → warning only.
- Variance (actual − estimate) shown on the shipment and on the month views.

## 8. Month-to-date views

- Month = Bangkok calendar month of the shipment's `plannedStart` (trip date).
- **Per truck** (head and rigid vehicles; tails in their own list): trips, km (loaded / empty), revenue, driver pay, fuel, tolls/other, maintenance, depreciation (per km + per month fixed), margin, margin/km — columns split **Closed (actual)** | **Open (estimate)** | **Total**. Drill-down to the shipment list.
- **Per driver**: trips, DOs, km, days worked, revenue generated, ค่าเที่ยว (closed actual + open estimate), extras breakdown; minimum daily guarantee (if configured) shown as a top-up line.
- Also filterable by client and job group (same numbers from the per-DO allocation).
- **Performance** (1,000 trucks): a rollup collection `monthStats { month, dim: 'vehicle' | 'driver' | 'client' | 'jobGroup', key, closed: {...sums}, open: {...sums} }` is updated with `$inc` deltas inside the same transaction whenever a shipment's pricing or status changes (delta = new − old snapshot). Views read ≤ 1 doc per resource → O(1000) docs per month screen, no aggregation over shipments at read time. A nightly job re-derives the current month from shipments and reports any drift.
- Excel export of each view.

## 9. Daily / weekly review board (approved)

Admin panel page "ตรวจงานประจำวัน / สัปดาห์" (admin + planner), day or week (Mon–Sun, Bangkok) selector:
- **Summary**: shipments by status and by client; DOs delivered / failed; on-time % (arrival vs plannedArrival).
- **Needs attention** (worst first): PODs waiting review; rejected PODs not yet resubmitted; failed DOs with reasons; shipments past plannedEnd still open; DISPATCHED not accepted; evidence flags (outside geofence, no GPS, late/offline submission, device clock skew); unpriced shipments.
- **Bulk actions**: verify all PODs with no flags (one audit entry per POD); close all shipments that are ready (each closed in its own transaction, results listed). Flagged items always need one-by-one review.
- **Excel export** of the period.
- API: `GET /reviews/summary?from&to` (range ≤ 31 days, indexed on plannedStart/status), `POST /pods/verify-bulk { podIds[] }` (≤ 200), `POST /shipments/close-bulk { items: [{ id, version }] }` (≤ 100).
- Driver app: after the last POD/failed report, an **end-of-job summary** screen lists each DO ✓ delivered / ✗ failed (+ POD review state) and the estimated ค่าเที่ยว for the job.

With pricing, the board also shows the day's/week's estimated vs actual revenue, cost and margin, and "not priced" shipments (RATE_NOT_FOUND / RATE_AMBIGUOUS / DISTANCE_ESTIMATED) as a needs-attention group.

## 10. Roles

| Action | admin | planner | viewer | driver |
|---|---|---|---|---|
| See estimates / month views | ✓ | ✓ | ✓ | own ค่าเที่ยว only |
| Create/edit draft rate cards, lanes, zones, diesel prices | ✓ | ✓ | – | – |
| Activate rate cards, vehicle cost profiles | ✓ | – | – | – |
| Manual DO price (spot quote) | ✓ | ✓ (reason required) | – | – |
| Verify POD / close shipment | ✓ | ✓ | – | – |

Every rate card, lane, zone, diesel price, cost profile and manual price change writes an audit entry (who, before/after).

## 11. API (summary)

- `GET/POST /rate-cards`, `GET /rate-cards/:id`, `POST /rate-cards/:id/new-version`, `/activate`, `/retire`, `POST /rate-cards/import` (Excel grid), `POST /rate-cards/test` (price a hypothetical DO/shipment — "ทดลองคำนวณ").
- `GET/POST/PATCH /lanes`, `/lanes/import`; `GET/POST/PATCH /zones`; `GET/POST /diesel-prices`; `GET/PUT /vehicles/:id/cost-profile`; `GET /geo/provinces`, `/geo/districts?provinceCode=`.
- `GET /shipments/:id/pricing`, `POST /shipments/:id/pricing/recalculate`, `PUT /delivery-orders/:id/manual-price`.
- `GET /reports/month/vehicles?month=2026-10`, `/reports/month/drivers`, `/reports/month/clients`, `/reports/month/job-groups` (+ `?format=xlsx`).

## 12. Admin UI additions (frontend plan)

Rate cards (list, editor with line builder, grid editor for zone/province matrices, Excel import, test calculator), lanes, zones, diesel prices, vehicle cost profiles; pricing panel on shipment builder + detail (estimate / actual / variance, warnings with "add lane"/"add rate" shortcuts); month views per truck / driver / client / job group with export.

## 13. Decisions (PO 2026-09-27)

1. **Distance**: the PO's own map/routing API (free, built in-house) is the primary source. A `DistanceProvider` adapter calls it (`MAP_API_URL`, `MAP_API_KEY` in `.env`, never in chat) and caches each origin→destination result in `lanes` (`source: 'map'`), so each pair is fetched once; planners can still override km/tolls manually (`manual` wins). Fallback when the API is down: straight-line × 1.3 flagged `DISTANCE_ESTIMATED`. Calls are bounded (timeout 3 s, cache first, no calls inside Mongo transactions — resolved before the transaction starts).
2. **Driver visibility**: yes — the driver app shows estimated ค่าเที่ยว per job and a month-to-date total (actual for closed jobs, estimate for open). Drivers never see revenue or cost.
3. **Rate card activation**: admin only; planners create drafts and use the test calculator.
4. **Review board + driver end-of-job summary**: yes (§9 is in scope).
5. Defaults taken (PO may change): one company-wide diesel series entered weekly (each card's fuel clause keeps its own base price); maintenance and depreciation start from per-truck-type standards, per-vehicle values optional via Excel; close requires a revenue price on every DO.

Pending from PO: the map API's base URL and one example request/response (route distance between two lat/lng points; toll if available).
