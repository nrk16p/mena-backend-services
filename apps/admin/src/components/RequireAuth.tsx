import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { getSession } from '@shared/api';

const STAFF = ['admin', 'planner', 'viewer'];

export default function RequireAuth({ children }: { children: ReactNode }) {
  const s = getSession();
  if (!s || !s.user.roles.some((r) => STAFF.includes(r))) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export const hasRole = (role: string) => getSession()?.user.roles.includes(role) ?? false;
