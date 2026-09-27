export interface TapInput {
  shipmentId: string;
  stopId: string | null;
  code: string;
  reasonCode?: string | null;
  note?: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  noGpsReason: 'NO_GPS' | null;
  deviceTime: string;
}

export interface EventResult {
  clientEventId: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  eventId: string | null;
  flags: string[];
  code?: string;
  message?: string;
}

export function createTapSender(send: (body: { events: (TapInput & { clientEventId: string })[] }) => Promise<{ results: EventResult[] }>) {
  const pending = new Map<string, { clientEventId: string; deviceTime: string }>();
  return async function tap(input: TapInput): Promise<EventResult> {
    const key = `${input.shipmentId}|${input.stopId ?? '-'}|${input.code}`;
    const prior = pending.get(key);
    const clientEventId = prior?.clientEventId ?? crypto.randomUUID();
    const deviceTime = prior?.deviceTime ?? input.deviceTime;
    pending.set(key, { clientEventId, deviceTime });
    const res = await send({ events: [{ ...input, deviceTime, clientEventId }] });
    pending.delete(key);
    return res.results[0]!;
  };
}
