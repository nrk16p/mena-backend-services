# Rate Engine Research — TMS Backend for Thai Trucking Fleet (Mixers, Trailers, Feedmill, Cold-Chain, Side-Curtain)

Scope: revenue pricing patterns, driver pay patterns, trip cost estimation, how commercial TMS products model rates, Thai geography data for zone pricing, and a recommended MongoDB data model with worked examples.

---

## 1. Client revenue pricing patterns in Thai road freight

**Flat per trip/lane (เหมาเที่ยว)** — single fixed price per lane (origin→destination), regardless of load detail, common for dedicated/contract lanes (e.g., factory→DC daily runs). Simple to bill but blind to actual weight/volume, so many contracts add a load-factor floor ("ต้องบรรทุกไม่ต่ำกว่า X ตัน จึงจะได้ราคานี้").

**Per unit (ตัน / ลูกบาศก์เมตร / pallet / carton / drop)**
- Ready-mix concrete (คอนกรีตผสมเสร็จ) is priced **per m³ (คิว)** with a **minimum order quantity per trip** — a common real-world schedule: minimum 4 m³/trip with no extra charge; below 4 m³ a shortfall surcharge of ~375 THB/m³ applies; distance beyond a free radius (e.g. 15 km) adds ~10.70 THB/m³/km ([builk.com survey](https://www.builk.com/th/%E0%B8%A3%E0%B8%B2%E0%B8%84%E0%B8%B2-%E0%B8%84%E0%B8%AD%E0%B8%99%E0%B8%81%E0%B8%A3%E0%B8%B5%E0%B8%95%E0%B8%9C%E0%B8%AA%E0%B8%A1%E0%B9%80%E0%B8%AA%E0%B8%A3%E0%B9%87%E0%B8%88-1-2560/), [yotathai — ราคากลางค่าขนส่งคอนกรีต](https://www.yotathai.com/passadu/concrete-transportation-cost)). This is the canonical **minimum charge + distance-band surcharge** pattern.
- Feedmill / bulk agri (ข้าวโพด, กากถั่วเหลือง, อาหารสัตว์) — priced per ton, often **tiered/weight-break scales**: rate per ton decreases as tonnage increases (analogous to LTL "weight breaks" — see §4), or increases beyond truck capacity utilization thresholds.
- Parcel/LTL carriers illustrate the general **weight-break** mechanic clearly: rate is quoted per 100 kg (CWT-equivalent) and steps down at breakpoints (e.g., 500/1,000/2,000/5,000/10,000 lb bands in the US model) with an **absolute minimum charge** per shipment regardless of computed rate ([Redwood Logistics](https://www.redwoodlogistics.com/insights/how-to-get-better-ltl-freight-rates), [PLS Logistics](https://www.plslogistics.com/blog/ltl-freight-pricing-factors/), [FreightSimple](https://www.freightsimple.com/blog/how-ltl-freight-pricing-works)). The same structure maps directly onto ton/m³ scales for Thai bulk freight.

**Per km and distance bands** — rate = base + (rate/km × distance), or a stepped table of distance bands (0–50 km, 51–100 km, 101–200 km, >200 km) each with its own flat or per-km rate. Used heavily for both client billing and driver pay (see §2). Also seen as a **radius-free-then-surcharge** model (first N km included, then THB/km beyond).

**Zone-to-zone matrices** — an NxN (or zone×zone) rate table where zone = a province/cluster of provinces or a courier "region." Thai parcel carriers publish literal zone tables (e.g., Flash Express rate table) with **cross-zone / cross-region surcharges** stacked per kg or per shipment ([Flash Express check-price](https://www.flashexpress.co.th/fle/check-price/), sample zone surcharge table showing +30 THB/kg for Bangkok↔ต่างจังหวัด and inter-region moves, +100 THB for far provinces (ยะลา ปัตตานี นราธิวาส แม่ฮ่องสอน) requiring boat, [eaglegood transtable](https://courier-v2.eaglegood.co.th/backend/transtable.php)). For FTL/dedicated trucking the same idea appears as a province-pair rate card rather than parcel zones.

**Thai admin-geography-based pricing (zone / จังหวัด / อำเภอ) + cross-province surcharge (ข้ามจังหวัด)** — because Thailand's official addressing and much operational data (delivery points, ATMS/WMS records, driving-distance datasets in this org) is keyed by province (จังหวัด) → district (อำเภอ) → subdistrict (ตำบล), the natural rate dimension is **destination district**, with a rate table keyed by (origin zone, destination province/district) and a flat "cross-province" adder when origin and destination provinces differ (mirrors the parcel-carrier practice above). This is exactly the feedmill "per ton by destination district + cross-province surcharge" pattern requested by the product owner.

**Minimum charge** — floor applied after all other calculations (per-trip, per-unit, or per-km) so a small/short shipment never bills below a break-even amount. Universal in LTL: e.g. US carriers enforce shipment minimums of $159–$254 regardless of computed weight rate ([redstagfulfillment.com](https://redstagfulfillment.com/what-is-average-cost-per-pound-ltl-shipping/)); same concept applies to the concrete "4 m³ minimum" example above.

**Maximum cap** — less common but used in some government/institutional contracts and in "not-to-exceed" accessorial clauses; also used to cap fuel-escalation charges (see below) so a surcharge cannot exceed X% of base rate.

**Accessorial charges** (แยกเรียกเก็บนอกราคาหลัก) — industry-standard set, directly transferable to Thai trucking:
- Extra drop / multi-stop charge (ค่าจุดส่งเพิ่ม) — flat fee per additional delivery point beyond the first.
- Waiting/detention (ค่ารอ/ดีเทนชั่น) — free time window (30 min–2 hr typical), then per-15/30-min or per-hour rate after; can escalate ([C.H. Robinson Detention & Demurrage Guide](https://www.chrobinson.com/en-us/resources/resource-center/guides/detention-and-demurrage-guide/), [datadocks.com](https://datadocks.com/posts/truck-detention-accessorial-fees)).
- Overnight (ค่าค้างคืน) — flat allowance when a trip requires the truck/driver to stay overnight away from base, common for long-haul trailer lanes.
- Unloading labour (ค่าแรงงานขนถ่าย) — when driver/helper physically unloads instead of client's dock crew.
- After-hours / holiday surcharge — premium for deliveries outside normal hours or on public holidays.
- Dry run / cancellation / เที่ยวเปล่า (empty/dead-head run) — compensation when a scheduled trip is cancelled after truck dispatch, or a paid empty leg.
- Return/backhaul (ขากลับ) — either discounted (if client controls both legs) or a separate paid leg if a return load must be arranged.
- Temperature control (ควบคุมอุณหภูมิ, cold-chain) — reefer surcharge, often flat per trip or per day for chiller/freezer operation, sometimes with a fuel-for-reefer-unit component separate from tractor fuel.

**Fuel surcharge / diesel-price escalation clauses** — Thai commercial and institutional contracts typically peg an adjustment to a published diesel benchmark rather than negotiating rate changes ad hoc: the reference is the retail diesel price published by the Department of Energy Business (DOEB, กรมธุรกิจพลังงาน) or the PTT posted price, tracked against a **base price fixed at contract signing**, with a banded escalation table (e.g., "for every ±1 THB/litre movement of the diesel reference price beyond a ± band, adjust the transport rate by X%"), reviewed monthly or quarterly. This mirrors the international FSC mechanic: `FSC = f(current reference diesel price vs. base) × distance` or `× base rate` ([oilpriceapi.com FSC calculator](https://www.oilpriceapi.com/tools/fuel-surcharge-calculator), [OTR Solutions — What Is a Fuel Surcharge](https://otrsolutions.com/blog/what-is-a-fuel-surcharge), [orderplus.me — Fuel Surcharge](https://orderplus.me/news/Fuel%20Surcharge%20%E0%B8%84%E0%B8%B7%E0%B8%AD%E0%B8%AD%E0%B8%B0%E0%B9%84%E0%B8%A3%20%E0%B8%97%E0%B8%B3%E0%B9%84%E0%B8%A1%E0%B8%84%E0%B9%88%E0%B8%B2%E0%B8%AA%E0%B9%88%E0%B8%87%E0%B8%96%E0%B8%B6%E0%B8%87%E0%B9%81%E0%B8%9E%E0%B8%87%E0%B8%82%E0%B8%B6%E0%B9%89%E0%B8%99%20%E0%B9%81%E0%B8%A5%E0%B9%89%E0%B8%A7%E0%B8%88%E0%B8%B0%E0%B8%A5%E0%B8%94%E0%B8%A5%E0%B8%87%E0%B9%80%E0%B8%A1%E0%B8%B7%E0%B9%88%E0%B8%AD%E0%B9%84%E0%B8%AB%E0%B8%A3%E0%B9%88)). SAP TM implements the same idea as a native charge type ("Fuel Surcharge") calculated off a reference-vs-actual fuel index table ([SAP TM Fuel Surcharge blog](https://www.linkedin.com/pulse/fuel-surcharge-sap-tm-12-sheethal-potdar)). Design implication: the rate engine needs a **diesel reference price time series** and a **surcharge formula per client contract** (band table or linear %/THB per litre-delta), applied either as % of base rate, THB/km, or THB/trip.

**VAT 7% and withholding tax (ภาษีหัก ณ ที่จ่าย 1%)** — Thai domestic transport services (การให้บริการขนส่งในราชอาณาจักร) by a properly licensed carrier are **VAT-exempt**; the payer instead withholds **1% WHT** on the transport-service portion of the invoice. If the invoice bundles transport with other taxable services (e.g., installation, handling that changes the legal character to "ค่าจ้างทำของ"), the whole amount can become subject to VAT 7% and 3% WHT instead of 1% ([inflowaccount.co.th](https://inflowaccount.co.th/taxable-transportation-business/), [PNK Accounting](https://pnkaccount.co.th/%E0%B8%82%E0%B8%B2%E0%B8%A2%E0%B8%AA%E0%B8%B4%E0%B8%99%E0%B8%84%E0%B9%89%E0%B8%B2%E0%B8%A1%E0%B8%B5-%E0%B8%84%E0%B9%88%E0%B8%B2%E0%B8%82%E0%B8%99%E0%B8%AA%E0%B9%88%E0%B8%87/), [BMU](https://bmu.co.th/shipping-cost/), [beeaccountant.com](https://www.beeaccountant.com/delivery-service-tax-wh/)). Design implication: revenue amount on a shipment must carry a **tax classification code** (transport-exempt-VAT/1%WHT vs. bundled-service-VAT7%/3%WHT) resolved per client/contract line item, not hardcoded — and the "estimated vs. actual" revenue snapshot should store both gross, net-of-WHT, and VAT treatment so downstream AR/AP and the P&L views reconcile.

---

## 2. Driver pay (ค่าเที่ยว) patterns

Common structures observed across Thai trucking job postings and payroll practice:
- **Per trip by distance band/zone** — e.g., a flat ค่าเที่ยว for Bangkok–ปริมณฑล short runs (observed market reference: ~600 THB/trip for a 10-wheeler, ~700 THB/trip for a trailer/head-trailer combo), stepping up for longer distance bands or specific province pairs ([fairfast.co.th](https://www.fairfast.co.th/cars/)).
- **Per drop** — additional flat amount per extra delivery stop, separate from the base trip fee (mirrors the client-side extra-drop accessorial, but paid to the driver rather than billed to the client — the two are related but not identical amounts).
- **Per m³/ton** — mixer drivers are frequently paid per m³ delivered (ties naturally to the client-side per-m³ revenue and lets the system compute driver margin directly from the same volume field), sometimes blended with a per-trip floor.
- **Allowance (เบี้ยเลี้ยง)** — daily subsistence allowance for multi-day long-haul trips, paid per day away from base regardless of load, separate from the trip fee itself ([flowaccount.com](https://flowaccount.com/blog/employee-travel-expenses/)).
- **Overnight (ค่าค้างคืน)** — flat add-on when the trip requires staying out overnight (common on long-haul trailer/cold-chain lanes; rare for local mixer runs which return same-day).
- **Waiting pay (ค่ารอ)** — compensation to the driver when queued/loading delays exceed a threshold, funded by (and often directly passed through from) the client's waiting/detention accessorial.
- **Holiday/OT multipliers** — Thai Labour Protection Act baseline: overtime pay at 1.5× normal rate on ordinary working days and 2×–3× on holidays/holiday-OT ([drthawip.com summary of Labour Protection Act Chapter 5](https://www.drthawip.com/laborlaw/009), [sanook.com OT explainer](https://www.sanook.com/campus/1417455/)). Trip-based (เหมาจ่าย) driver pay is a legally distinct concept from wage/OT and Thai labor courts have held that per-trip incentive pay (ค่าเที่ยว) conditioned on completing a trip is **not** automatically counted as base wage for OT/severance calculations if structured correctly as a discretionary incentive — a legal nuance worth flagging to HR/legal, not something to hardcode into the rate engine without counsel input ([paiboonniti.com](https://paiboonniti.com/%E0%B8%84%E0%B9%88%E0%B8%B2%E0%B9%80%E0%B8%97%E0%B8%B5%E0%B9%88%E0%B8%A2%E0%B8%A7-%E0%B8%97%E0%B8%B5%E0%B9%88%E0%B8%99%E0%B8%B2%E0%B8%A2%E0%B8%88%E0%B9%89%E0%B8%B2%E0%B8%87%E0%B9%83%E0%B8%AB%E0%B9%89/)).
- **Minimum daily guarantee** — a floor (เงินประกันรายวัน) ensuring the driver earns at least X THB/day even on light-volume days, topped up if trip-based pay falls short — same "minimum charge" abstraction as client pricing, just applied to driver pay.

**Mixer vs. long-haul trailer differences:** mixer drivers are typically same-day, multiple short trips/day, paid per m³ or per trip with a per-drop add-on and no overnight component; long-haul trailer drivers are typically one (or few) trip/day or multi-day, paid per trip/distance-band with overnight and waiting pay as standard components, and per-ton less common than flat-per-lane.

---

## 3. Trip cost estimation (สำหรับต้นทุนประมาณการ)

A practical bottom-up trip-cost model, consistent with what a Thai trucking cost calculator lays out ([rod-truck.com — 5 ขั้นตอนคิดต้นทุนเที่ยวรถบรรทุก](https://rod-truck.com/how-to-calulate-truck-budget/)):

1. **Fuel** = distance (km) × fuel consumption rate (litre/km, by truck type & load state) × diesel price (THB/litre). Consumption benchmarks vary sharply by truck class and load state — 4-wheel ~8–12 km/l, 6-wheel ~6–8 km/l, 10-wheel/dump ~3–5 km/l, tractor-trailer (หัวลาก) ~3–4.5 km/l, and **loaded vs. empty legs should use different consumption rates** (empty legs consume noticeably less, though not linearly) ([orsgo.com fuel consumption rate](https://orsgo.com/fuel-consumption-rate/), [kitsadagoodcar.com fuel calculator](https://www.kitsadagoodcar.com/fuel/)). Best practice: maintain a per-truck-type × load-state consumption table (loaded/empty, and ideally a mixer-specific "drum running" adjustment) rather than one flat km/l figure.
2. **Tolls** — per-route lookup (fixed set of toll plazas for a given expressway/motorway route); store as a route-level fixed cost or computed from a toll-segment table if routes vary.
3. **Other trip costs** — parking/entry fees, ferry (for island/river-crossing routes), ad hoc permits.
4. **Maintenance allocation** — typically allocated **per km** (tires, PM service, repairs averaged over recent history — this org already tracks MR × WD repair severity data that could feed a rolling per-km maintenance rate per truck or truck class) or **per month** as a fixed overhead if maintenance is contracted flat-fee.
5. **Depreciation** — either **straight-line per month** (purchase price − residual ÷ useful-life months, a fixed monthly cost independent of usage) or **units-of-activity per km** (depreciable base ÷ estimated lifetime km, e.g., a flat X THB/km) ([MyDepreciation fleet calculator](https://www.mydepreciation.org/calculators/fleet), [oer.pressbooks.pub units-of-activity method](https://oer.pressbooks.pub/utsaccounting2/chapter/explain-and-apply-depreciation-methods-to-allocate-capitalized-costs/)). For trip-level cost allocation, **per-km depreciation is more decision-useful** (it varies the estimated cost with actual trip distance) while per-month is simpler for monthly P&L roll-ups; a sound design computes both — a per-km rate for trip-level estimated cost, and a per-month fixed rate for truck-level monthly P&L reconciliation — and reconciles the difference at month-end.

A concrete worked micro-example from the source above: fixed cost 42,083 THB/month + variable cost 3.5 THB/km (fuel+maintenance+tolls+OT ÷ 10,000 km/month) → total cost/km = 42,083/10,000 + 3.5 = **7.71 THB/km**; a 300 km trip costs **≈2,313 THB**. This is a reasonable default shape for the engine's cost-estimation formula: `estimated_cost = (monthly_fixed_cost_alloc_per_km + variable_cost_per_km) × trip_distance_km + tolls + accessorial_costs`.

---

## 4. How established TMS products model rates

**Oracle Transportation Management (OTM/OTMoL) Rate Manager** ([Rate Offering](https://docs.oracle.com/en/cloud/saas/transportation/21a/otmol/planning/rate_manager/create_rate_offering.htm), [Rate Record](https://docs.oracle.com/en/cloud/saas/transportation/26b/otmol/planning/rate_manager/create_rate_record.htm), [Accessorial Costs](https://docs.oracle.com/en/cloud/saas/transportation/23a/otmol/planning/power_data/rates_and_codes/accessorial_costs.htm), [Rate Offering Type](https://docs.oracle.com/en/cloud/saas/transportation/20c/otmol/planning/power_data/rates_and_codes/rate_offer_type_def.htm), [Using Arbitraries](https://docs.oracle.com/en/cloud/saas/transportation/26c/otmol/planning/rate_manager/using_arbitraries.htm)):
- **Rate Offering** = the contract-level container (carrier/customer agreement, validity dates, rate offering type e.g. FTL/LTL/parcel).
- **Rate Record** = one lane/service definition inside an offering (cost between origin and destination for given equipment/service).
- **Rate Geography / Arbitraries** = geography-driven rate modifiers layered onto a base lane rate for specific zones (e.g., accessorial pickup/delivery zones), independent of the base itinerary.
- **Accessorial Costs** = attached to offering or record; contingency rates for special circumstances (COD, signature, packing, storage-in-transit, etc.), only invoiced if triggered.

**SAP TM Charge Calculation Sheet** ([Calculation Bases](https://community.sap.com/t5/supply-chain-management-blog-posts-by-members/sap-tm-calculation-bases-to-decide-which-value-gets-charged/ba-p/14485746), [Maintaining Rate Tables](https://learning.sap.com/courses/charges-and-settlement-in-sap-s-4hana-transportation-management/maintaining-rate-tables), [Maintaining Scale and Calculation Bases](https://learning.sap.com/courses/charges-and-settlement-in-sap-s-4hana-transportation-management/maintaining-scale-and-calculation-bases), [Determining Agreements and Charge Calculation Rules](https://learning.sap.com/courses/charges-and-settlement-in-sap-s-4hana-transportation-management/determining-agreements-and-charge-calculation-rules), [Fuel Surcharge in SAP TM](https://www.linkedin.com/pulse/fuel-surcharge-sap-tm-12-sheethal-potdar)):
- **Calculation Base** = links the transport document to a numeric input the engine can evaluate (distance, weight, volume, count of stops, etc.) — conceptually the "dimension" a scale is defined over.
- **Scale** = the tier/step table mapping a calculation-base value → rate (per-unit or absolute); up to 14 dimensions can combine in one rate table (e.g., weight AND distance simultaneously = a true matrix).
- **Calculation Type** = absolute vs. relative (percentage) charge.
- **Rate Table** = the concrete set of scale rows with validity dates.
- **Charge Calculation Sheet** = the ordered list of charge line items (base freight + each accessorial + fuel surcharge + tax) evaluated in sequence per shipment, each pulling its own calculation base/rate table — this **sequenced, composable line-item model is the single most reusable idea** for our engine.
- **Agreement determination** = system finds the applicable agreement/contract first (customer + service + validity date + geography), *then* resolves calculation rules — i.e., **precedence resolves at the contract level before the line-item level**.

**Other systems, briefly:**
- **MercuryGate** — single rate-management engine spanning FTL spot/contract, LTL class rates, and accessorial/fuel-surcharge tables with automated update workflows; integrates 3rd-party rate feeds (e.g., SMC³) as an alternate rate source for LTL class rates ([MercuryGate blog](https://mercurygate.com/blog-posts/spot-freight-market-and-contract-freight-market-insight-inside-your-tms/), [SMC3/MercuryGate integration](https://www.smc3.com/press-releases-20171011.htm)).
- **Descartes (3G TMS)** — competing enterprise TMS with comparable rate/contract/accessorial management; no unique public abstraction beyond the OTM/SAP pattern was found in this pass.
- **Odoo / ERPNext** — much lighter-weight: Odoo's "Delivery Costs" module defines a delivery pricelist (essentially a rate table by weight/value/carrier), and freight/transport community modules add transporter + route + basic transport-charge fields; ERPNext's shipping/landed-cost tooling fetches shipping charges by item value or weight and folds them into landed cost, but neither product has a first-class "rate engine" with scales/precedence/geography — they are better references for *what to avoid* (too flat a model) than for architecture to copy ([ERPNext freight docs](https://docs.erpnext.com/docs/user/manual/en/calculatin-freight-in-taxes-in-erpnext), [Odoo transport_module](https://apps.odoo.com/apps/modules/17.0/transport_module)).

**Common abstractions to carry forward** (synthesized across all of the above):
`Agreement/Contract (client or driver-pay policy) → Rate Card/Table (a named, versioned rate definition) → Dimension(s)/Calculation Base (distance, weight/volume, zone-pair, stop count, time) → Scale/Tier rows (band → rate, absolute or %) → Min/Max clamps → Accessorial line items (each its own small rate card) → Validity dates (effective_from/to) → Versioning (supersede, never mutate in place) → Precedence (most specific applicable match wins: client+lane+date beats client+zone+date beats client-default beats company-default)`.

---

## 5. Thai geography data for zone/district pricing

Thailand's official administrative hierarchy is maintained by the **Department of Provincial Administration (DOPA, กรมการปกครอง)**: province (จังหวัด, 77) → district (อำเภอ, ~928) → subdistrict (ตำบล, ~7,400+), each with standard numeric codes (2-digit province, 4-digit district, 6-digit subdistrict) ([Wikipedia — Department of Provincial Administration](https://en.wikipedia.org/wiki/Department_of_Provincial_Administration)). Usable open datasets for seeding, all with TH/EN names:
- **thailand-geography-data/thailand-geography-json** — clean, well-structured `provinces.json` / `districts.json` / `subdistricts.json` / `geography.json`, includes postal codes, TH+EN names and parent codes; actively maintained, good primary seed source ([GitHub](https://github.com/thailand-geography-data/thailand-geography-json)).
- **kongvut/thai-province-data** — same coverage, exported in CSV/JSON/SQL/XLSX/XML plus a hosted JSON API, convenient if you want a ready endpoint rather than a static import ([GitHub](https://github.com/kongvut/thai-province-data)).
- **spicydog/thailand-province-district-subdistrict-zipcode-latitude-longitude** — adds **centroid lat/lng per subdistrict/district/province** alongside zip code, which is exactly the join needed to go from a GPS point or free-text address to an administrative code ([GitHub](https://github.com/spicydog/thailand-province-district-subdistrict-zipcode-latitude-longitude)).
- **GeoThai/data** — multiple export shapes (flat, nested-with-postal-codes, indexed lookup, "ultra-fast" lookup) if you want to pick a shape matched to your query pattern ([GitHub](https://github.com/GeoThai/data)).
- **Cerberus/Thailand-Address** — another maintained TH address dataset (provinces/districts/subdistricts/zipcodes/geographies) as a cross-check/fallback source ([GitHub](https://github.com/Cerberus/Thailand-Address)).
- **thailocate (Go package)** — a reverse-geocoder that resolves a WGS84 lat/lng directly to province/district/subdistrict without a third-party API call, covering all 77/928/7,425 units; useful as a reference algorithm (point-in-polygon against subdistrict boundaries) even if you reimplement in Node ([pkg.go.dev](https://pkg.go.dev/github.com/siwakorne/thailocate)).
- **data.go.th** hosts an official dataset of province/district/subdistrict centroids as a government-source cross-check ([2015.index.okfn.org Thailand listing](http://2015.index.okfn.org/place/thailand/postcodes/)).

**Recommended approach for this TMS:** seed a `geo_admin` collection from `thailand-geography-json` (authoritative names/codes/hierarchy) joined with `spicydog`'s centroid lat/lng for point-based lookups; for **mapping a delivery lat/lng → district**, either (a) do a nearest-centroid match against subdistrict/district centroids for cheap approximate zoning (adequate for surcharge tiers, not for legal boundaries), or (b) load actual subdistrict polygon boundaries (Thailand has open subdistrict GeoJSON boundary sets from the same open-data ecosystem) and do true point-in-polygon if precision matters — start with (a), it is far cheaper to build and sufficient for rate-zone purposes; upgrade to (b) only if disputes arise over zone edge cases.

---

## 6. Recommended MongoDB data model

Core idea, following the OTM/SAP synthesis: separate **rate cards** (versioned, dated, scoped) from **calculation execution** (a small interpreter that walks scales/tiers/accessorials in a fixed order), and always **snapshot the resolved calculation onto the shipment** at both planning time (estimate) and close time (actual/locked), so historical shipments are never affected by later rate-card edits.

```js
// ---- rate_cards ---------------------------------------------------------
{
  _id: ObjectId,
  cardType: "CLIENT_REVENUE" | "DRIVER_PAY" | "TRIP_COST_STD",
  scope: {
    clientId: ObjectId | null,        // null = company-wide default
    truckType: "MIXER" | "TRAILER" | "FEEDMILL" | "COLDCHAIN" | "SIDECURTAIN" | null,
    contractId: ObjectId | null,
    lane: { originProvinceCode: "10", destProvinceCode: "20" } | null,  // most specific
    zonePair: { originZone: "BKK-METRO", destZone: "EAST" } | null,     // less specific
  },
  basis: "PER_TRIP" | "PER_KM" | "PER_UNIT_M3" | "PER_UNIT_TON" | "PER_ZONE_MATRIX",
  unitDimension: "m3" | "ton" | "km" | "drop" | null,
  tiers: [                              // scale/tier rows; empty = flat rate
    { minQty: 0,   maxQty: 4,   rate: 0,      note: "included in min charge" },
    { minQty: 4,   maxQty: null, rate: 0,     note: "base already covers >=4 m3" },
  ],
  distanceBands: [                      // optional second dimension (SAP-style multi-scale)
    { minKm: 0,  maxKm: 15,  surchargePerUnit: 0 },
    { minKm: 15, maxKm: null, surchargePerUnit: 10.70, per: "km_per_m3" },
  ],
  minCharge: 0,
  maxCharge: null,
  crossProvinceSurcharge: { flat: 0, perUnit: 0 },
  fuelEscalation: {
    referenceSeries: "DOEB_DIESEL_B7",
    baseRefPrice: 32.50,               // THB/litre, locked at contract signing
    bandStep: 1.00,                    // THB/litre per adjustment step
    adjustmentPct: 1.5,                // % of base rate per step
    capPct: 15                          // max total escalation
  },
  accessorials: [ObjectId, ...],        // refs into accessorial_rate_defs
  taxTreatment: "TRANSPORT_EXEMPT_VAT_WHT1" | "BUNDLED_VAT7_WHT3",
  effectiveFrom: ISODate,
  effectiveTo: ISODate | null,
  version: 3,
  supersedes: ObjectId | null,
  status: "ACTIVE" | "SUPERSEDED" | "DRAFT",
  createdAt, createdBy
}

// ---- accessorial_rate_defs ----------------------------------------------
{
  _id, code: "WAITING", scope: {...}, freeMinutes: 60,
  rate: 100, per: "30min", capAmount: 1500, effectiveFrom, effectiveTo
}

// ---- geo_admin (seeded reference) ---------------------------------------
{ _id, level: "district", code: "1001", nameTh, nameEn,
  provinceCode: "10", centroid: { lat, lng }, zoneTags: ["BKK-METRO"] }

// ---- diesel_price_index ---------------------------------------------------
{ _id, series: "DOEB_DIESEL_B7", date: ISODate, pricePerLitre: 33.80 }

// ---- shipments (excerpt: rate resolution + snapshot) ---------------------
{
  _id, clientId, truckId, driverId, contractId,
  origin: { districtCode, provinceCode, lat, lng },
  destination: { districtCode, provinceCode, lat, lng },
  plannedQty: { m3: 6 }, plannedDistanceKm: 42,
  pricing: {
    status: "ESTIMATED" | "LOCKED",
    resolvedRateCardId: ObjectId, resolvedRateCardVersion: 3,
    revenue: { base: 2400, distanceSurcharge: 0, crossProvince: 0,
               fuelEscalation: 45, accessorials: [{code:"WAITING", amount:100}],
               vatTreatment: "TRANSPORT_EXEMPT_VAT_WHT1",
               gross: 2545, wht: 25.45, net: 2519.55 },
    driverPay: { base: 700, perDropExtra: 0, overnight: 0, total: 700 },
    tripCost:  { fuel: 588, tolls: 120, maintenanceAlloc: 147, depreciationAlloc: 210, total: 1065 },
    snapshotAt: ISODate,          // set once, at CLOSE — never edited after
  }
}
```

**Precedence rule (resolution order, most-specific wins):**
`contractId + exact lane (origin district ↔ dest district) + truckType`
→ `contractId + zonePair + truckType`
→ `clientId + truckType (client default, no lane)`
→ `truckType company-wide default`
→ error/manual-quote-required if nothing matches.
Within a matched card: evaluate tiers (unit scale) → apply distance-band surcharge → apply cross-province surcharge → apply min/max clamp → apply fuel escalation → add matched accessorials → apply tax treatment. This mirrors SAP's ordered "charge calculation sheet" concept directly.

**Versioning & snapshot rule:** rate cards are **never mutated** — an edit creates a new version with a new `effectiveFrom` and marks the prior version `SUPERSEDED` with `effectiveTo` set. At planning time, a shipment resolves and stores `resolvedRateCardId + version` plus the fully computed numbers as an **estimate** (`status: ESTIMATED`, mutable if the shipment itself changes before dispatch). At close, the same resolution is **re-run once more** (in case quantities/distance changed during execution) and the result is written to `pricing` with `status: LOCKED` and `snapshotAt` set — from that point the shipment's financials are immutable regardless of later rate-card edits, which is what makes month-to-date truck/driver revenue-cost views stable and auditable.

### Worked examples

1. **Mixer, per m³ with minimum 3 m³ + distance-band surcharge.** Card: `basis: PER_UNIT_M3`, tiers `[{0–3: rate 850/m3 flat-equivalent minimum charge = 2550}]`, distanceBands `[{0–15km: 0}, {15+: 10.70/km/m3}]`. A 2.5 m³ pour at 20 km: billed as if 3 m³ (min) × 850 = 2,550, plus (20−15) × 10.70 × 3 = 160.50 → revenue ≈ 2,710.50 THB.
2. **Feedmill, per ton by destination district + cross-province surcharge.** Card keyed by `scope.lane` per district pair, `basis: PER_UNIT_TON`, tiers stepping down per ton (e.g., 1–10t @ 450/t, 10–20t @ 400/t), `crossProvinceSurcharge.flat: 500` applied when `origin.provinceCode != destination.provinceCode`. 15 tons crossing a province line: (10×450)+(5×400) + 500 = 4,500+2,000+500 = 7,000 THB.
3. **Trailer, flat per lane + fuel escalation.** Card `basis: PER_TRIP`, flat 8,000 THB Bangkok–Chiang Mai, `fuelEscalation` referencing DOEB diesel index: base ref 32.50, current 33.80 → 1.3 THB/litre step over bandStep 1.00 → 1 step → +1.5% of base = 120 THB → revenue 8,120 THB.
4. **Cold-chain, per trip + extra drops + waiting.** Card `basis: PER_TRIP` flat 3,500 THB + reefer accessorial 500 THB/day; shipment has 2 extra drops (accessorial `EXTRA_DROP` 300 THB each) and 90 min waiting against a 60-min free allowance (accessorial `WAITING` 100 THB/30min → 1 chargeable block = 100 THB): revenue = 3,500+500+600+100 = 4,700 THB.
5. **Driver pay, per trip by distance band + overnight.** Driver-pay card `basis: PER_TRIP`, distanceBands `[{0–100km: 600},{100–300km: 900},{300+: 1400}]`, `overnight` accessorial flat 300 THB if trip requires overnight stay. A 250 km trip with overnight: driver pay = 900 + 300 = 1,200 THB.

---

## Open questions for the product owner

1. **Fuel escalation reference & cadence** — which exact index (DOEB retail diesel, PTT posted price, or an internally-negotiated blended benchmark) does each client contract reference, and how often is it re-based (monthly/quarterly) and re-locked?
2. **Tax treatment ownership** — should tax classification (transport-exempt-VAT/1%WHT vs. bundled-service/VAT7%/3%WHT) live on the rate card, the contract, or be decided per invoice line by finance? Who is authoritative if they conflict?
3. **Zone granularity** — for cross-province surcharges, is the unit of "zone" strictly province, or does the company want custom zone clusters (e.g., grouping several provinces into a named region) that don't map 1:1 to DOPA codes?
4. **Estimate-to-actual variance policy** — when actual quantity/distance/waiting time differs from the plan at close, does the system re-resolve the rate card fresh, or apply a variance adjustment on top of the original estimate? Is there a tolerance threshold requiring approval before re-pricing?
5. **Driver-pay vs. wage-law boundary** — should ค่าเที่ยว be structured (per counsel) as a non-wage incentive to stay outside OT/severance base calculations, and does HR need a separate "compliant wage floor" check independent of the trip-pay rate engine?
6. **Rate card negotiation granularity** — do sales/ops need a UI to define brand-new lane-specific exceptions ad hoc (spot quotes) that fall outside the standard tier/zone model, and if so how do those interact with precedence (do spot quotes always win over standing contracts)?
7. **Empty-leg/backhaul economics** — should เที่ยวเปล่า and backhaul legs automatically generate a (negative-margin) shipment record for cost tracking even when there's no client to bill, so truck/driver MTD views stay complete?
8. **Multi-truck-type contracts** — does a single client contract need different rate cards per truck type simultaneously active (e.g., mixer + trailer under one master agreement), and if so is there a combined min/max cap at the contract level across shipment lines?
9. **Historical rate-card audit** — is a full change-log/diff view of rate card versions required for client disputes, or is version+effective dates sufficient?
10. **Geo precision requirement** — is nearest-centroid zone assignment acceptable long-term, or do specific high-value lanes need true polygon-boundary district matching from day one?
