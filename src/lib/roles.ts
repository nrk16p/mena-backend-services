export const ROLES = ['admin', 'planner', 'driver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['admin', 'planner', 'viewer'];
