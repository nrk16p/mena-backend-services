# mena-backend-services — Phase 2 Requirements: Availability, Costing & Monthly Reports

- **Date:** 2026-09-27
- **Owner (PO):** Plug
- **Status:** Requirements agreed in conversation — to be turned into a design spec before Plan 2 / Phase 2 plans are written
- **Builds on:** `2026-09-27-phase1-planning-epod-design.md` (§9 Trip Summary & Phase 2 hooks)

## 1. Driver & truck availability (goes into Plan 2 — planning)

### 1.1 Unavailability blocks

Availability is modelled as **time-bounded blocks**, not a single status field, so planners can see future PM, repairs and leave while planning.

```
resourceBlocks {
  resourceType: driver | vehicle
  resourceId
  reason:
    driver  → LEAVE (ลา) | HOLIDAY (วันหยุด) | SICK (ลาป่วย) | TRAINING | OTHER
    vehicle → PM | REPAIR (ซ่อม) | TIRE (เปลี่ยนยาง) | INSPECTION (ตรวจสภาพ/ต่อภาษี) | OTHER
  from, to            // whole-day or exact time range
  note
  source: manual | atms | hr
  createdBy, createdAt, cancelledAt?
}
```

### 1.2 Working calendar

- **Company holidays** (วันหยุดบริษัท): one shared list.
- **Regular weekly days off per driver** (e.g. every Sunday), so recurring days off are not entered by hand each week.

### 1.3 Rules

| Situation | Behaviour |
|---|---|
| Assign/validate a shipment whose window overlaps a block of its head, tail or driver | **Blocking error** for LEAVE, HOLIDAY, SICK, TRAINING, PM, REPAIR, TIRE, INSPECTION; **warning** (override with reason) for OTHER |
| Driver's regular day off / company holiday overlaps the window | Warning (planner may schedule overtime) |
| Create or extend a block that overlaps an already-planned shipment | Saved, returns a warning listing the affected shipments |
| `GET /availability` | Excludes blocked resources and returns the reason and end time ("PM until 29 Sep") |
| Current status of a truck/driver | **Derived**, not stored: available / on shipment / PM / repair / leave … |

### 1.4 Sources (decided)

- Truck blocks: **entered manually** in Phase 2. A scheduled **ATMS repair-status sync** (statuses other than วA/วร/ว → REPAIR block) is a later add-on.
- Driver leave: **entered manually** by planners/HR.

## 2. Costing (Phase 2 — per trip, at shipment close)

As in Phase 1 spec §9: rate engine by client → job group → lane/truck type/service, producing three kinds of money lines on the locked trip summary — company revenue (per DO), driver pay ค่าเที่ยว พจส. (per DO + shipment extras), trip cost (per shipment, allocated to DOs by distance). Distance-source priority still to be decided.

## 3. Monthly reports (Phase 2)

### 3.1 Truck costs included — decided: option 2

Trip costs (driver pay, fuel, tolls, unloading) **plus maintenance costs per plate from ATMS** (repair, PM, tires). Fixed costs (depreciation/lease, insurance, tax) are **out of scope** for now.

### 3.2 Driver monthly report

- Work: days worked, leave/holiday days, trips, DOs, km
- Pay: ค่าเที่ยว total, extras (extra drops, waiting, overnight), deductions, net
- Quality: on-time %, POD rejections, exceptions

### 3.3 Truck monthly report

- Usage: days available / working / blocked (PM, repair, tire) → utilisation %; km loaded vs empty
- Money: revenue; trip costs; maintenance costs (ATMS); cost per km; profit per truck

### 3.4 Month close (ปิดงวด)

- When all shipments in the month are closed, finance/admin closes the period.
- Closing stores a **snapshot** of both reports; later corrections are adjustments, never silent edits.
- Outputs: Excel export, PDF per driver (can attach to pay slip), month-over-month dashboard view.

## 4. Open questions (for the Phase 2 design spec)

- Distance-source priority for billing vs driver pay.
- ATMS maintenance-cost mapping: which ATMS fields/purposes count as PM vs repair vs tire (ATMS renamed purposes in Aug 2026 — both naming sets must be matched).
- Plate matching between ATMS and this system (use `plateKey`).
- Who may close a month (finance vs admin) and whether a closed month can be reopened.
