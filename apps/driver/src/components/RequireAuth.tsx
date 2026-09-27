import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { getSession } from '@shared/api';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const s = getSession();
  if (!s || !s.user.roles.includes('driver') || !s.user.driverId) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
