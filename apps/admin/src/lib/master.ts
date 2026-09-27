import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@shared/api';
import type { Page } from '@shared/types';

export function useMaster<T>(path: string) {
  return useQuery({
    queryKey: ['master', path],
    queryFn: async () => (await apiFetch<Page<T>>('GET', `/api/v1${path}${path.includes('?') ? '&' : '?'}limit=200`)).items,
    staleTime: 60_000,
  });
}

/** Builds an id → display-name lookup from a list of master records. Pure, so it's unit-testable without React Query. */
export function buildNameMap(items: Record<string, unknown>[], field: 'name' | 'plate' | 'code' = 'name'): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const id = item.id;
    if (typeof id !== 'string') continue;
    const value = item[field];
    map.set(id, typeof value === 'string' ? value : id);
  }
  return map;
}

export function useNameMap(path: string, field: 'name' | 'plate' | 'code' = 'name') {
  const q = useMaster<Record<string, unknown>>(path);
  return buildNameMap(q.data ?? [], field);
}
