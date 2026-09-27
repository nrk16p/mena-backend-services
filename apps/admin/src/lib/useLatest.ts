import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@shared/api';
import type { ValidateResult } from '@shared/types';

export function useLatestValidation(body: object | null) {
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const key = body ? JSON.stringify(body) : '';
  useEffect(() => {
    if (!body) {
      setResult(null);
      setPending(false);
      return;
    }
    const mine = ++seq.current;
    setPending(true);
    const timer = setTimeout(() => {
      apiFetch<ValidateResult>('POST', '/api/v1/shipments/validate', body)
        .then((r) => {
          if (mine === seq.current) setResult(r);
        })
        .catch(() => {
          if (mine === seq.current) setResult(null);
        })
        .finally(() => {
          if (mine === seq.current) setPending(false);
        });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { result, pending };
}
