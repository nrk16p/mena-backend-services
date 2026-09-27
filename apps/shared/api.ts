export type AppName = 'admin' | 'driver';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; roles: string[]; driverId: string | null };
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let appName: AppName = 'admin';
let onLogoutCb: () => void = () => {};
const storageKey = () => `mena.session.${appName}`;

export function configureApi(app: AppName, onLogout: () => void) {
  appName = app;
  onLogoutCb = onLogout;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(storageKey(), JSON.stringify(s));
    else localStorage.removeItem(storageKey());
  } catch {
    /* storage unavailable: session lives for this page only */
  }
}

async function readError(res: Response): Promise<ApiError> {
  let body: { code?: string; message?: string; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }
  return new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.message ?? res.statusText, body.details);
}

function toSession(body: Session & Record<string, unknown>): Session {
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user };
}

export async function login(username: string, password: string, extra: { lat?: number; lng?: number } = {}): Promise<Session> {
  const res = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...extra }) });
  if (!res.ok) throw await readError(res);
  const s = toSession(await res.json());
  setSession(s);
  return s;
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = getSession();
  if (!s) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
      if (!res.ok) return false;
      setSession(toSession(await res.json()));
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function logout(): Promise<void> {
  const s = getSession();
  setSession(null);
  if (s) await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) }).catch(() => undefined);
  onLogoutCb();
}

export async function apiFetch<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = {};
    const s = getSession();
    if (s) headers.authorization = `Bearer ${s.accessToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res = await send();
  if (res.status === 401 && getSession()) {
    if (await refresh()) res = await send();
    else {
      setSession(null);
      onLogoutCb();
    }
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Downloads an authenticated binary (e.g. the evidence PDF) and opens it in a new tab. */
export async function openAuthedFile(path: string): Promise<void> {
  const s = getSession();
  const res = await fetch(path, { headers: s ? { authorization: `Bearer ${s.accessToken}` } : {} });
  if (!res.ok) throw await readError(res);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  // The new tab has loaded the blob by then; free the memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
