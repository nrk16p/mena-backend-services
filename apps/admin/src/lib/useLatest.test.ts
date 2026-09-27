import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@shared/api';
import { useLatestValidation } from './useLatest';

describe('useLatestValidation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps only the result for the latest body and reports pending meanwhile', async () => {
    vi.useFakeTimers();
    const resolvers: ((v: unknown) => void)[] = [];
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise((r) => resolvers.push(r)) as never);
    const { result, rerender } = renderHook(({ body }) => useLatestValidation(body), { initialProps: { body: { v: 1 } as object } });
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    rerender({ body: { v: 2 } });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    await act(async () => {
      resolvers[1]!({ errors: [], warnings: [{ code: 'NEW', message: 'n' }], stops: [], legs: [] });
    });
    await act(async () => {
      resolvers[0]!({ errors: [{ code: 'OLD', message: 'o' }], warnings: [], stops: [], legs: [] });
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.result?.warnings[0]?.code).toBe('NEW');
  });
});
