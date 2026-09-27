import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { checkActiveRefs } from '../../lib/active-refs.js';
import type { Issue } from '../../lib/issues.js';
import { bangkokDate, bangkokDatesBetween, bangkokWeekday } from '../../lib/time.js';
import { type ResourceType, findActiveBlocks } from '../availability/blocks.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { jobGroupWarnings } from '../orders/orders.service.js';
import { type LegPlan, type StopPlan, buildStopsFromDos, deriveLegs, structuralIssues } from './shipment.domain.js';
import { findShipmentsUsing } from './shipment.queries.js';
import type { ShipmentInputT } from './shipment.schemas.js';

export interface DraftSlot {
  vehicleId: string;
  driverId: string | null;
}

export interface DraftStop extends StopPlan {
  plannedArrival: Date | null;
}

export interface ShipmentDraft {
  plannedStart: Date;
  plannedEnd: Date;
  head: DraftSlot | null;
  tail: DraftSlot | null;
  stops: DraftStop[];
  note: string | null;
}

export interface VehicleLite {
  _id: ObjectId;
  plate: string;
  part: string;
  truckTypeId: ObjectId;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
  dos: DeliveryOrderDoc[];
  headVehicle: VehicleLite | null;
  legs: LegPlan[];
}

export async function toDraft(db: Db, input: ShipmentInputT): Promise<ShipmentDraft> {
  let stops: DraftStop[] = [];
  if (input.stops) {
    stops = input.stops.map((s) => ({
      locationId: s.locationId,
      plannedArrival: s.plannedArrival ? new Date(s.plannedArrival) : null,
      pickupDoIds: s.pickupDoIds,
      dropDoIds: s.dropDoIds,
    }));
  } else if (input.doIds && input.doIds.length > 0) {
    const dos = await db
      .collection<DeliveryOrderDoc>(C.deliveryOrders)
      .find({ _id: { $in: input.doIds.map((i) => new ObjectId(i)) } }, { projection: { originLocationId: 1, destLocationId: 1 } })
      .toArray();
    const byId = new Map(dos.map((d) => [d._id.toHexString(), d]));
    const routes = input.doIds
      .filter((id) => byId.has(id))
      .map((id) => ({ id, originLocationId: byId.get(id)!.originLocationId.toHexString(), destLocationId: byId.get(id)!.destLocationId.toHexString() }));
    const missing = input.doIds.filter((id) => !byId.has(id));
    stops = buildStopsFromDos(routes).map((s) => ({ ...s, plannedArrival: null }));
    // Unknown ids are kept on the first stop so validation reports them.
    if (missing.length > 0 && stops[0]) stops[0].pickupDoIds.push(...missing);
    else if (missing.length > 0) stops = [{ locationId: '000000000000000000000000', pickupDoIds: missing, dropDoIds: [], plannedArrival: null }];
  }
  return {
    plannedStart: new Date(input.plannedStart),
    plannedEnd: new Date(input.plannedEnd),
    head: input.head,
    tail: input.tail,
    stops,
    note: input.note,
  };
}

const oid = (h: string) => new ObjectId(h);

export async function validateShipment(
  db: Db,
  draft: ShipmentDraft,
  opts: { shipmentId?: ObjectId; mode: 'draft' | 'planned' },
): Promise<ValidationResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const completeness = (i: Issue) => (opts.mode === 'planned' ? errors : warnings).push(i);
  const selfId = opts.shipmentId?.toHexString() ?? null;
  const rangeOk = draft.plannedEnd.getTime() > draft.plannedStart.getTime();
  if (!rangeOk) errors.push({ code: 'INVALID_RANGE', message: 'plannedEnd must be after plannedStart' });

  const vehicleIds = [draft.head?.vehicleId, draft.tail?.vehicleId].filter((v): v is string => !!v);
  const driverIds = [...new Set([draft.head?.driverId, draft.tail?.driverId].filter((v): v is string => !!v))];
  const locationIds = [...new Set(draft.stops.map((s) => s.locationId))];
  errors.push(
    ...(await checkActiveRefs(db, [
      { field: 'vehicles', collection: C.vehicles, ids: vehicleIds.map(oid) },
      { field: 'drivers', collection: C.drivers, ids: driverIds.map(oid) },
      { field: 'stops.locationId', collection: C.locations, ids: locationIds.map(oid) },
    ])),
  );

  const vehicles = await db.collection<VehicleLite>(C.vehicles).find({ _id: { $in: vehicleIds.map(oid) } }).toArray();
  const vmap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const headV = draft.head ? (vmap.get(draft.head.vehicleId) ?? null) : null;
  const tailV = draft.tail ? (vmap.get(draft.tail.vehicleId) ?? null) : null;

  if (!draft.head) completeness({ code: 'HEAD_REQUIRED', message: 'A head (or rigid) vehicle is required' });
  else {
    if (headV && headV.part !== 'head' && headV.part !== 'rigid') {
      errors.push({ code: 'VEHICLE_WRONG_SLOT', message: `${headV.plate} cannot be used as the head`, details: { slot: 'head', plate: headV.plate } });
    }
    if (!draft.head.driverId) completeness({ code: 'HEAD_DRIVER_REQUIRED', message: 'The head vehicle needs a driver' });
  }
  if (draft.tail) {
    if (!draft.head) errors.push({ code: 'TAIL_WITHOUT_HEAD', message: 'A tail needs a head vehicle' });
    if (tailV && tailV.part !== 'tail') {
      errors.push({ code: 'VEHICLE_WRONG_SLOT', message: `${tailV.plate} cannot be used as the tail`, details: { slot: 'tail', plate: tailV.plate } });
    }
    if (headV?.part === 'rigid') errors.push({ code: 'RIGID_WITH_TAIL', message: 'A rigid truck cannot pull a tail' });
    if (!draft.tail.driverId) completeness({ code: 'TAIL_DRIVER_REQUIRED', message: 'The tail needs a driver' });
  } else if (headV?.part === 'head') {
    completeness({ code: 'TAIL_REQUIRED', message: 'A tractor head needs a tail' });
  }
  if (draft.head?.driverId && draft.tail?.driverId && draft.head.driverId !== draft.tail.driverId) {
    warnings.push({ code: 'DRIVER_MISMATCH', message: 'Head and tail have different drivers' });
  }

  const doIds = [...new Set(draft.stops.flatMap((s) => [...s.pickupDoIds, ...s.dropDoIds]))];
  const dos = await db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIds.map(oid) } }).toArray();
  const doMap = new Map(dos.map((d) => [d._id.toHexString(), d]));
  const unknownDos = doIds.filter((id) => !doMap.has(id));
  if (unknownDos.length > 0) {
    errors.push({ code: 'INVALID_REFERENCE', message: 'Unknown delivery orders', details: { field: 'deliveryOrders', ids: unknownDos } });
  }
  for (const d of dos) {
    const inOther = d.shipmentId && d.shipmentId.toHexString() !== selfId;
    if (inOther) {
      errors.push({ code: 'DO_IN_OTHER_SHIPMENT', message: `${d.doNo} is already in another shipment`, details: { doNo: d.doNo } });
    } else if (!(d.status === 'UNASSIGNED' || (d.status === 'PLANNED' && d.shipmentId?.toHexString() === selfId))) {
      errors.push({ code: 'DO_NOT_AVAILABLE', message: `${d.doNo} is ${d.status}`, details: { doNo: d.doNo, status: d.status } });
    }
    warnings.push(...jobGroupWarnings(d.doNo, d.jobGroupMatch.status));
  }
  if (doIds.length === 0) completeness({ code: 'DOS_REQUIRED', message: 'Add at least one delivery order' });
  if (draft.stops.length < 2) completeness({ code: 'STOPS_REQUIRED', message: 'A shipment needs at least two stops' });

  const structural = structuralIssues(
    draft.stops,
    dos.map((d) => ({ id: d._id.toHexString(), originLocationId: d.originLocationId.toHexString(), destLocationId: d.destLocationId.toHexString() })),
  );
  errors.push(...structural.errors);
  warnings.push(...structural.warnings);

  draft.stops.forEach((s, i) => {
    if (!s.plannedArrival) return;
    const check = (ids: string[], kind: 'pickup' | 'drop') => {
      for (const id of ids) {
        const w = kind === 'pickup' ? doMap.get(id)?.pickupWindow : doMap.get(id)?.dropWindow;
        if (w && (s.plannedArrival! < w.from || s.plannedArrival! > w.to)) {
          warnings.push({ code: 'DO_WINDOW', message: `Stop ${i + 1} is outside the ${kind} window of ${doMap.get(id)!.doNo}`, details: { doNo: doMap.get(id)!.doNo, kind, stop: i } });
        }
      }
    };
    check(s.pickupDoIds, 'pickup');
    check(s.dropDoIds, 'drop');
  });

  if (rangeOk) {
    const { plannedStart: from, plannedEnd: to } = draft;
    for (const v of vehicles) {
      const using = await findShipmentsUsing(db, 'vehicle', v._id, from, to, opts.shipmentId);
      if (using.length > 0) {
        errors.push({ code: 'VEHICLE_DOUBLE_BOOKED', message: `${v.plate} is already booked`, details: { plate: v.plate, shipmentNos: using.map((s) => s.shipmentNo) } });
      }
    }
    for (const id of driverIds) {
      const using = await findShipmentsUsing(db, 'driver', oid(id), from, to, opts.shipmentId);
      if (using.length > 0) {
        errors.push({ code: 'DRIVER_DOUBLE_BOOKED', message: 'The driver is already booked', details: { driverId: id, shipmentNos: using.map((s) => s.shipmentNo) } });
      }
    }
    const resources: { type: ResourceType; id: ObjectId }[] = [
      ...vehicles.map((v) => ({ type: 'vehicle' as const, id: v._id })),
      ...driverIds.map((id) => ({ type: 'driver' as const, id: oid(id) })),
    ];
    for (const b of await findActiveBlocks(db, resources, from, to)) {
      const details = { resourceType: b.resourceType, resourceId: b.resourceId.toHexString(), statusCode: b.statusCode, from: b.from.toISOString(), to: b.to.toISOString() };
      if (b.blocksAssignment) errors.push({ code: 'RESOURCE_BLOCKED', message: `The ${b.resourceType} is unavailable (${b.statusCode})`, details });
      else warnings.push({ code: 'RESOURCE_BLOCK_OTHER', message: `The ${b.resourceType} has a ${b.statusCode} note in this period`, details });
    }
    const dates = bangkokDatesBetween(from, to);
    const drivers = await db.collection(C.drivers).find({ _id: { $in: driverIds.map(oid) } }).toArray();
    const endDate = bangkokDate(to);
    for (const d of drivers) {
      if (typeof d.licenseExpiry === 'string' && d.licenseExpiry < endDate) {
        warnings.push({ code: 'LICENSE_EXPIRES', message: `Driver ${d.code}'s licence expires before the shipment ends`, details: { driverCode: d.code, licenseExpiry: d.licenseExpiry } });
      }
      const off = (d.weeklyDaysOff as number[] | undefined) ?? [];
      const offDates = dates.filter((date) => off.includes(bangkokWeekday(date)));
      if (offDates.length > 0) {
        warnings.push({ code: 'DRIVER_DAY_OFF', message: `Driver ${d.code} is normally off on ${offDates.join(', ')}`, details: { driverCode: d.code, dates: offDates } });
      }
    }
    const holidays = await db.collection(C.holidays).find({ date: { $in: dates }, active: true }).toArray();
    for (const h of holidays) warnings.push({ code: 'COMPANY_HOLIDAY', message: `${h.date} is a company holiday (${h.name})`, details: { date: h.date, name: h.name } });
  }

  return { errors, warnings, dos, headVehicle: headV, legs: deriveLegs(draft.stops) };
}
