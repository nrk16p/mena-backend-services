export interface Issue { code: string; message: string; details?: unknown }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface MasterItem { id: string; code: string; name: string; active: boolean }
export interface Vehicle { id: string; plate: string; part: 'head' | 'tail' | 'rigid'; truckTypeId: string; active: boolean }
export interface Driver { id: string; code: string; name: string; phone: string | null; active: boolean }
export interface LocationItem { id: string; code: string; name: string; lat: number; lng: number; geofenceRadiusM: number; isSite: boolean; active: boolean }

export type DoStatus = 'UNASSIGNED' | 'PLANNED' | 'PICKED_UP' | 'DELIVERED' | 'POD_VERIFIED' | 'POD_REJECTED' | 'FAILED' | 'CANCELLED';
export interface DeliveryOrder {
  id: string; doNo: string; clientRef: string | null; clientId: string; jobGroupId: string | null;
  jobGroupMatch: { status: 'auto' | 'manual' | 'ambiguous' | 'none'; candidates: string[] };
  serviceTypeId: string; materialId: string; qty: number; unit: string;
  originLocationId: string; destLocationId: string; shipmentId: string | null; status: DoStatus; note: string | null;
  warnings?: Issue[];
}

export type ShipmentStatus = 'DRAFT' | 'PLANNED' | 'DISPATCHED' | 'ACCEPTED' | 'IN_TRANSIT' | 'COMPLETED' | 'CLOSED' | 'CANCELLED';
export interface Stop { stopId: string; seq: number; locationId: string; pickupDoIds: string[]; dropDoIds: string[]; plannedArrival: string | null; status: 'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE' }
export interface Leg { fromStopId: string; toStopId: string; loaded: boolean; doIds: string[]; mapKm: number | null; gpsKm: number | null }
export interface Shipment {
  id: string; shipmentNo: string; status: ShipmentStatus; version: number; plannedStart: string; plannedEnd: string;
  head: { vehicleId: string; driverId: string | null } | null; tail: { vehicleId: string; driverId: string | null } | null;
  stops: Stop[]; legs: Leg[]; warnings: Issue[]; note: string | null;
  dispatch: { at: string; by: string; version: number } | null;
  driverResponse: { status: 'ACCEPTED' | 'DECLINED'; reason: string | null; at: string; by: string } | null;
  closedAt: string | null; closedBy: string | null; summaryId: string | null;
  deliveryOrders?: DeliveryOrder[];
}
export interface ValidateResult { errors: Issue[]; warnings: Issue[]; stops: { locationId: string; pickupDoIds: string[]; dropDoIds: string[] }[]; legs: { doIds: string[]; loaded: boolean }[] }
export interface EventItem { id: string; clientEventId: string; stopId: string | null; code: string; reasonCode: string | null; deviceTime: string; flags: string[]; geofenceDistanceM: number | null; by: string }

export interface PodField { key: string; label: string; type: 'photo' | 'signature' | 'text' | 'number' | 'select' | 'checkbox' | 'qtyLines' | 'palletLines'; required: boolean; min?: number; max?: number; unit?: string; options?: string[] }
export interface PodForm { templateId: string | null; version: number; fields: PodField[]; extraSteps: string[] }
export interface DriverDeliveryOrder extends DeliveryOrder { podForm: PodForm }
export interface DriverShipment extends Shipment {
  deliveryOrders: DriverDeliveryOrder[];
  locations: { id: string; code: string; name: string; lat: number; lng: number; geofenceRadiusM: number }[];
}

export interface PodFile { fieldKey: string; key: string; sha256: string; mime: string; bytes: number }
export interface Pod {
  id: string; clientPodId: string; doId: string; shipmentId: string; stopId: string;
  templateId: string | null; templateVersion: number; outcome: 'DELIVERED' | 'FAILED'; reasonCode: string | null; note: string | null;
  answers: Record<string, unknown>; files: PodFile[];
  evidence: {
    deviceTime: string; receivedAt: string; lat: number | null; lng: number | null; accuracyM: number | null;
    noGpsReason: string | null; geofenceDistanceM: number | null; device: string | null; appVersion: string | null; offline: boolean;
  };
  hash: string; flags: string[]; status: 'submitted' | 'verified' | 'rejected'; review: { by: string; at: string; reason: string | null } | null;
  supersedesPodId: string | null; by: string; fileUrls?: { key: string; url: string }[];
}
