import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@shared/api';
import type { EventItem } from '@shared/types';

/**
 * The driver's timeline for one shipment (GET .../events). Shared by JobPage, which renders the
 * step buttons from it, and PodPage, which uses it to guard against being opened before the
 * driver has actually reached the required step — same query key and fetch for both, so a tap
 * recorded on JobPage is immediately visible to PodPage's guard via the query cache.
 */
export function useJobEvents(shipmentId: string | undefined) {
  return useQuery({
    queryKey: ['job-events', shipmentId],
    queryFn: async () => (await apiFetch<{ items: EventItem[] }>('GET', `/api/v1/driver/shipments/${shipmentId}/events`)).items,
    enabled: !!shipmentId,
  });
}
