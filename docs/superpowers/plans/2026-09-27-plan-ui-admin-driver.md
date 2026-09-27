# Plan UI — Admin Panel & Driver App (demo loop) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two React apps on top of the API — an admin panel for planners/admins and a mobile web driver app — that together run the full demo loop: create delivery orders → build and validate a shipment → plan → dispatch → driver accepts → driver taps every stop step with GPS → driver submits PODs with photos and a signature (or a failed-delivery report) → admin verifies PODs → admin closes the shipment and opens the evidence PDF.

**Architecture:** `apps/admin` and `apps/driver` are independent Vite + React + TypeScript + Tailwind + shadcn/ui apps (own `package.json`, own install). Shared browser code (API client with token refresh, types, Bangkok time helpers, stop-step logic) lives in `apps/shared/` (plain TS, no dependencies) and is imported through the `@shared` alias. Both dev servers proxy `/api` to the API on `http://localhost:3000`, so everything is same-origin in development. Data fetching uses TanStack Query; routing uses React Router 6.

**Tech Stack:** Vite 6, React 18, TypeScript 5, Tailwind CSS 4 (`@tailwindcss/vite`), shadcn/ui (Radix), `@tanstack/react-query@^5`, `react-router-dom@^6`, `sonner` (toasts), `@vitejs/plugin-basic-ssl` (driver app, so phones get a secure context for camera, GPS and `crypto.subtle`), Vitest + @testing-library for logic tests, `concurrently` (root) for the demo runner.

**Spec:** `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md` (§5, §6, §8.3). Backend plans 1–3 must be merged into the working branch first.

**Decisions made in this plan (flag to PO at handoff):**
- UI language is Thai with English codes shown where useful (status codes, DO/SH numbers).
- Types are hand-written in `apps/shared/types.ts` (no OpenAPI code generation) — fewer moving parts for the demo; they mirror the API response schemas.
- Master-data management screens (clients, locations, vehicles…) are **not** in this plan; the demo uses `npm run seed -- --demo` data and the existing API/Swagger for edits.
- Offline queueing in the driver app is **not** in this plan: taps and PODs are sent immediately; the API is already idempotent, so a retry after a network error is safe (the UI keeps the same `clientEventId`/`clientPodId` when retrying).
- Pallet movements have no UI in this plan (API exists).
- **The driver app is used on phones (PO 2026-09-27).** It is designed phone-first: single column, thumb-sized buttons (≥ 48 px, primary actions 56 px), 16 px inputs (no iOS zoom), safe-area padding, installable to the home screen (PWA, standalone, no browser bar), screen kept awake while a job is open, and a clear banner when GPS or camera permission is denied. Desktop is only for development.
- Camera, GPS and SHA-256 need a secure context, so the driver dev server runs on HTTPS with a self-signed certificate (basic-ssl) and listens on the LAN (`host: true`); a phone on the same Wi-Fi opens `https://<computer-ip>:5174` and accepts the certificate once. Real field use needs a proper HTTPS deployment (Plan 4).
- Driver accept/decline send the shipment `version` the driver saw (backend ruling P2-R10) → a stale screen gets 409 and the job list reloads.

## Global Constraints

- Node ≥ 22. Each app: `npm run dev`, `npm run build` (`tsc -b && vite build`), `npm test` (Vitest). Admin dev port **5173**, driver dev port **5174**; both proxy `/api` → `http://localhost:3000`.
- Import aliases: `@/` → the app's `src/`, `@shared/` → `apps/shared/`. Relative `.ts` imports inside apps have no extension (Vite/bundler resolution).
- All API calls go through `apiFetch` from `@shared/api` (adds the bearer token, refreshes once on 401, throws `ApiError { status, code, message, details }`).
- Session is kept in `localStorage` key `mena.session.<app>` (`admin` or `driver`), always wrapped in try/catch; the app works (logged out) if storage is unavailable.
- Times: the API speaks UTC ISO; the UI shows and edits Asia/Bangkok time via `@shared/time` helpers.
- Error display: every failed mutation shows a toast with the API `message`; validation issues (`details.errors`/`details.warnings`) are listed, never swallowed.
- shadcn/ui components are generated into `src/components/ui/` by the shadcn CLI (not hand-written).
- Never commit `node_modules`, build output or `.env*` (except `.env.example`). Commit trailer lines as in earlier plans; never `git push`.

## Review Focus

1. **Access token expires during a long session** → the next call refreshes once and retries transparently; if the refresh fails the user lands on the login screen, not a broken page. Test in Task 1.
2. **Planner enters times near midnight** (22:00–02:00) → the `datetime-local` value is interpreted as Bangkok time and sent as `+07:00`, and displays back unchanged. Test in Task 1.
3. **Driver taps a step twice quickly or retries after a timeout** → the same `clientEventId` is reused for the retry, so the API reports `duplicate`, not a second event. Test in Task 7.
4. **POD photo taken in portrait at full phone resolution (e.g. 4032×3024, 5 MB+)** → compressed to ≤ 1600 px JPEG under the 5 MB limit before upload. Test in Task 8.
5. **Planner changes a field and the live validation is still loading** → the “save” button is disabled until the latest validation result for the current form arrives (stale results are ignored). Test in Task 4.

---

## File Structure

```
apps/
  shared/
    api.ts          session store, apiFetch (+refresh), ApiError, login, logout
    types.ts        API response types used by the UI
    time.ts         Bangkok <-> ISO helpers, formatters
    steps.ts        stop step sequence + next step (mirrors backend rules)
    *.test.ts       unit tests (run from apps/admin's vitest)
  admin/            Vite app (port 5173)
    src/main.tsx, App.tsx, lib/query.ts, lib/master.ts
    src/components/ui/*   (shadcn generated)
    src/components/Layout.tsx, IssueList.tsx, StatusBadge.tsx, RequireAuth.tsx
    src/pages/LoginPage.tsx, DeliveryOrdersPage.tsx, CreateDoDialog.tsx,
              ShipmentNewPage.tsx, ShipmentsPage.tsx, ShipmentDetailPage.tsx, PodReviewPage.tsx
  driver/           Vite app (port 5174, https)
    src/main.tsx, App.tsx, lib/gps.ts, lib/image.ts, lib/upload.ts
    src/components/ui/*   (shadcn generated)
    src/components/SignaturePad.tsx, RequireAuth.tsx
    src/pages/LoginPage.tsx, JobsPage.tsx, JobPage.tsx, PodPage.tsx
DEMO.md
package.json (root)  + "demo" script (concurrently)
```

Backend addition (Task 0): `GET /driver/shipments/:id/events` so the driver app knows which steps are done.

---

### Task 0: Backend — driver's own event list

**Files:**
- Modify: `src/modules/execution/events.routes.ts`
- Test: `test/api/driver-events.test.ts`

**Interfaces:**
- Produces: `GET /driver/shipments/:id/events` (role driver; 404 unless the driver is on the shipment) → `{ items: EventItem[] }` ordered by `deviceTime` (same `EventItem` schema as `GET /shipments/:id/events`).

- [ ] **Step 1: Write the failing test** — append inside the `describe` of `test/api/driver-events.test.ts`:
```ts
  it('lets the driver read their own shipment timeline only', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-09' });
    await tap(app, f, shipment, 0, 'ARRIVED');
    const mine = await app.inject({ method: 'GET', url: `/api/v1/driver/shipments/${shipment.id}/events`, headers: f.driver1 });
    expect(mine.json().items.map((e: { code: string }) => e.code)).toEqual(['ARRIVED']);
    expect((await app.inject({ method: 'GET', url: `/api/v1/driver/shipments/${shipment.id}/events`, headers: f.driver2 })).statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/api/driver-events.test.ts` → FAIL (404 route).

- [ ] **Step 3: Implement** — in `eventRoutes` add (import `loadDriverShipment`, `driverIdOf` from `../storage/uploads.routes.js`):
```ts
  app.get(
    '/driver/shipments/:id/events',
    { schema: { tags: ['driver'], params: IdParams, response: { 200: z.object({ items: z.array(EventItem) }) } }, preHandler: app.requireRoles('driver') },
    async (req) => {
      const sh = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverIdOf(req));
      const items = await app.db.collection<EventDoc>(C.events).find({ shipmentId: sh._id }).sort({ deviceTime: 1, receivedAt: 1 }).limit(1000).toArray();
      return { items: items.map(toApi) };
    },
  );
```

- [ ] **Step 4: Verify** — `npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(execution): driver can read their own shipment timeline" -m "<trailers>"`.

---

### Task 1: Shared browser code + admin app scaffold (login, layout, auth guard)

**Files:**
- Create: `apps/shared/api.ts`, `apps/shared/types.ts`, `apps/shared/time.ts`, `apps/shared/api.test.ts`, `apps/shared/time.test.ts`
- Create (scaffold): `apps/admin/**` (Vite + React + TS), `apps/admin/src/{main.tsx,App.tsx,lib/query.ts}`, `apps/admin/src/components/{Layout.tsx,RequireAuth.tsx,StatusBadge.tsx,IssueList.tsx}`, `apps/admin/src/pages/LoginPage.tsx`
- Modify: root `.gitignore` (add `apps/*/node_modules`, `apps/*/dist`)

**Interfaces:**
- Produces (`@shared/api`): `type AppName = 'admin' | 'driver'`; `interface Session { accessToken; refreshToken; user: { id; username; roles: string[]; driverId: string | null } }`; `class ApiError extends Error { status; code; details }`; `configureApi(app: AppName, onLogout: () => void)`; `getSession(): Session | null`; `login(username, password, extra?: { lat?: number; lng?: number }): Promise<Session>`; `logout(): Promise<void>`; `apiFetch<T>(method: 'GET'|'POST'|'PATCH'|'DELETE', path: string, body?: unknown): Promise<T>` (path starts with `/api/v1`).
- Produces (`@shared/time`): `bkkInputValue(iso: string): string` (`YYYY-MM-DDTHH:mm` in Bangkok), `fromBkkInput(value: string): string` (`YYYY-MM-DDTHH:mm:00+07:00`), `fmtBkk(iso: string | null): string` (`d MMM HH:mm` Thai locale, `-` for null).
- Produces (`@shared/types`): `Issue`, `DeliveryOrder`, `Shipment`, `Stop`, `Leg`, `MasterItem`, `Vehicle`, `Driver`, `LocationItem`, `EventItem`, `PodField`, `PodForm`, `DriverDeliveryOrder`, `DriverShipment`, `Pod`, `Page<T>`.
- Admin app: routes `/login`, `/` → redirect `/shipments`; `RequireAuth` redirects to `/login` when there is no session or the user lacks `admin`/`planner`/`viewer`.

- [ ] **Step 1: Scaffold the admin app**

Run (from repo root):
```bash
npm create vite@latest apps/admin -- --template react-ts
cd apps/admin
npm install
npm install tailwindcss @tailwindcss/vite @tanstack/react-query@^5 react-router-dom@^6 sonner
npm install -D @types/node vitest@^3 @testing-library/react @testing-library/jest-dom jsdom
```
Configure Tailwind and aliases:

`apps/admin/src/index.css` (replace content):
```css
@import "tailwindcss";
```

`apps/admin/vite.config.ts`:
```ts
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}', '../shared/**/*.test.ts'] },
});
```
(Add `/// <reference types="vitest/config" />` at the top so `test` type-checks.)

In both `apps/admin/tsconfig.json` and `apps/admin/tsconfig.app.json` add under `compilerOptions`:
```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"], "@shared/*": ["../shared/*"] }
```
and in `tsconfig.app.json` add `"../shared"` to `include`. Add `"test": "vitest run"` to `apps/admin/package.json` scripts.

Initialise shadcn and add the components used by this plan:
```bash
npx shadcn@latest init            # accept defaults: base color Neutral, CSS variables yes
npx shadcn@latest add button input label card table dialog select badge textarea checkbox separator sonner
```
If the CLI asks questions it cannot answer non-interactively, rerun with `--defaults`/`-y` as supported by the installed CLI version.

- [ ] **Step 2: Write the failing shared tests**

`apps/shared/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { bkkInputValue, fmtBkk, fromBkkInput } from './time';

describe('Bangkok time helpers', () => {
  it('round-trips datetime-local values as Bangkok time, including around midnight', () => {
    expect(fromBkkInput('2026-10-05T22:30')).toBe('2026-10-05T22:30:00+07:00');
    expect(bkkInputValue('2026-10-05T15:30:00.000Z')).toBe('2026-10-05T22:30');
    expect(bkkInputValue('2026-10-05T17:30:00.000Z')).toBe('2026-10-06T00:30');
    expect(bkkInputValue(new Date(fromBkkInput('2026-10-06T01:15')).toISOString())).toBe('2026-10-06T01:15');
  });

  it('formats nulls as a dash', () => {
    expect(fmtBkk(null)).toBe('-');
    expect(fmtBkk('2026-10-05T01:00:00.000Z')).toContain('08:00');
  });
});
```

`apps/shared/api.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, configureApi, getSession, login } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, tokenType: 'Bearer', expiresIn: 3600, user: { id: 'u', username: 'p', roles: ['planner'], driverId: null } });

describe('apiFetch', () => {
  const onLogout = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    configureApi('admin', onLogout);
    onLogout.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('logs in, sends the bearer token and refreshes once on 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, session(1)))
      .mockResolvedValueOnce(json(401, { code: 'INVALID_TOKEN', message: 'expired' }))
      .mockResolvedValueOnce(json(200, session(2)))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await login('p', 'pw');
    expect(getSession()?.accessToken).toBe('a1');
    expect(await apiFetch('GET', '/api/v1/me')).toEqual({ ok: true });
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe('Bearer a1');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/v1/auth/refresh');
    expect(fetchMock.mock.calls[3]![1].headers.authorization).toBe('Bearer a2');
    expect(getSession()?.refreshToken).toBe('r2');
  });

  it('logs out when the refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(200, session(1))).mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(401, { code: 'REFRESH_TOKEN_REUSED', message: 'x' })));
    await login('p', 'pw');
    await expect(apiFetch('GET', '/api/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
    expect(onLogout).toHaveBeenCalled();
  });

  it('throws ApiError with the API error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(422, { code: 'SHIPMENT_INVALID', message: 'bad', details: { errors: [] } })));
    await expect(apiFetch('POST', '/api/v1/shipments', {})).rejects.toMatchObject({ status: 422, code: 'SHIPMENT_INVALID', details: { errors: [] } });
  });
});
```

Run: `cd apps/admin && npm test` → FAIL (modules missing).

- [ ] **Step 3: Implement shared code**

`apps/shared/api.ts`:
```ts
export type AppName = 'admin' | 'driver';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; roles: string[]; driverId: string | null };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
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
}
```

`apps/shared/time.ts`:
```ts
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function bkkInputValue(iso: string): string {
  const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function fromBkkInput(value: string): string {
  return `${value}:00+07:00`;
}

const display = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function fmtBkk(iso: string | null | undefined): string {
  return iso ? display.format(new Date(iso)) : '-';
}
```

`apps/shared/types.ts`:
```ts
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
  id: string; doId: string; shipmentId: string; outcome: 'DELIVERED' | 'FAILED'; reasonCode: string | null; note: string | null;
  answers: Record<string, unknown>; files: PodFile[];
  evidence: { deviceTime: string; receivedAt: string; lat: number | null; lng: number | null; accuracyM: number | null; geofenceDistanceM: number | null; offline: boolean };
  hash: string; flags: string[]; status: 'submitted' | 'verified' | 'rejected'; review: { by: string; at: string; reason: string | null } | null;
  supersedesPodId: string | null; fileUrls?: { key: string; url: string }[];
}
```

Run `cd apps/admin && npm test` → the shared tests PASS.

- [ ] **Step 4: Implement the admin shell**

`apps/admin/src/lib/query.ts`:
```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });
```

`apps/admin/src/main.tsx`:
```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { configureApi } from '@shared/api';
import App from './App';
import { queryClient } from './lib/query';
import './index.css';

configureApi('admin', () => {
  queryClient.clear();
  window.location.assign('/login');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/admin/src/App.tsx`:
```tsx
import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [{ path: '/', element: <Navigate to="/shipments" replace /> }],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
```
(Later tasks add child routes to this `children` array.)

`apps/admin/src/components/RequireAuth.tsx`:
```tsx
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
```

`apps/admin/src/components/Layout.tsx`:
```tsx
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { getSession, logout } from '@shared/api';

const links = [
  { to: '/shipments', label: 'งานขนส่ง' },
  { to: '/delivery-orders', label: 'ใบสั่งส่ง (DO)' },
  { to: '/pods', label: 'ตรวจ POD' },
];

export default function Layout() {
  const user = getSession()?.user;
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b bg-white px-4 py-2">
        <div className="flex items-center gap-6">
          <span className="font-semibold">Mena TMS</span>
          <nav className="flex gap-4 text-sm">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'font-semibold text-blue-700' : 'text-neutral-600 hover:text-neutral-900')}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-500">
            {user?.username} ({user?.roles.join(', ')})
          </span>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            ออกจากระบบ
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
```

`apps/admin/src/components/StatusBadge.tsx`:
```tsx
import { Badge } from '@/components/ui/badge';

const TH: Record<string, string> = {
  DRAFT: 'ร่าง', PLANNED: 'วางแผนแล้ว', DISPATCHED: 'ส่งงานแล้ว', ACCEPTED: 'คนขับรับงาน', IN_TRANSIT: 'กำลังขนส่ง',
  COMPLETED: 'ส่งครบ รอปิด', CLOSED: 'ปิดงาน', CANCELLED: 'ยกเลิก', UNASSIGNED: 'รอจัดรถ', PICKED_UP: 'รับของแล้ว',
  DELIVERED: 'ส่งแล้ว', POD_VERIFIED: 'POD ผ่าน', POD_REJECTED: 'POD ไม่ผ่าน', FAILED: 'ส่งไม่สำเร็จ',
  submitted: 'รอตรวจ', verified: 'ผ่าน', rejected: 'ไม่ผ่าน',
};

export default function StatusBadge({ status }: { status: string }) {
  const variant = ['CANCELLED', 'FAILED', 'POD_REJECTED', 'rejected'].includes(status)
    ? 'destructive'
    : ['CLOSED', 'POD_VERIFIED', 'verified'].includes(status)
      ? 'default'
      : 'secondary';
  return <Badge variant={variant}>{TH[status] ?? status}</Badge>;
}
```

`apps/admin/src/components/IssueList.tsx`:
```tsx
import type { Issue } from '@shared/types';

export default function IssueList({ errors = [], warnings = [] }: { errors?: Issue[]; warnings?: Issue[] }) {
  if (errors.length === 0 && warnings.length === 0) return <p className="text-sm text-green-700">ผ่านทุกกฎการวางแผน</p>;
  return (
    <ul className="space-y-1 text-sm">
      {errors.map((e, i) => (
        <li key={`e${i}`} className="rounded bg-red-50 px-2 py-1 text-red-800">
          <span className="font-mono text-xs">{e.code}</span> {e.message}
        </li>
      ))}
      {warnings.map((w, i) => (
        <li key={`w${i}`} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
          <span className="font-mono text-xs">{w.code}</span> {w.message}
        </li>
      ))}
    </ul>
  );
}
```

`apps/admin/src/pages/LoginPage.tsx`:
```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, login } from '@shared/api';

export default function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
      nav('/shipments');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Mena TMS — ผู้วางแผน</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="u">ชื่อผู้ใช้</Label>
              <Input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p">รหัสผ่าน</Label>
              <Input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !username || !password}>
              เข้าสู่ระบบ
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Verify**

Run: `cd apps/admin && npm test && npm run build`
Expected: tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A apps .gitignore
git commit -m "feat(ui): shared API client, time helpers and admin app shell with login" -m "<trailers>"
```

---

### Task 2: Admin — delivery-order pool and create dialog

**Files:**
- Create: `apps/admin/src/lib/master.ts`, `apps/admin/src/pages/DeliveryOrdersPage.tsx`, `apps/admin/src/pages/CreateDoDialog.tsx`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: `useMaster<T>(path: string)` (TanStack query of `GET {path}?limit=200` returning `T[]`), `useMasterMap(path)` → `Map<id, name/plate>`; route `/delivery-orders`: table of DOs filtered by status (default `UNASSIGNED`) with row checkboxes; “สร้างเที่ยวจาก DO ที่เลือก” navigates to `/shipments/new?doIds=a,b`; “สร้าง DO” dialog posting `POST /api/v1/delivery-orders` and toasting job-group warnings.

- [ ] **Step 1: Implement**

`apps/admin/src/lib/master.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@shared/api';
import type { Page } from '@shared/types';

export function useMaster<T>(path: string) {
  return useQuery({ queryKey: ['master', path], queryFn: async () => (await apiFetch<Page<T>>('GET', `/api/v1${path}${path.includes('?') ? '&' : '?'}limit=200`)).items, staleTime: 60_000 });
}

export function useNameMap(path: string, field: 'name' | 'plate' | 'code' = 'name') {
  const q = useMaster<Record<string, string>>(path);
  const map = new Map<string, string>();
  for (const item of q.data ?? []) map.set(item.id, item[field] ?? item.id);
  return map;
}
```

`apps/admin/src/pages/CreateDoDialog.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, apiFetch } from '@shared/api';
import type { DeliveryOrder, LocationItem, MasterItem } from '@shared/types';
import { useMaster } from '../lib/master';

function Pick({ label, items, value, onChange }: { label: string; items: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="เลือก…" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function CreateDoDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const clients = useMaster<MasterItem>('/clients').data ?? [];
  const services = useMaster<MasterItem>('/service-types').data ?? [];
  const materials = useMaster<MasterItem>('/materials').data ?? [];
  const locations = useMaster<LocationItem>('/locations').data ?? [];
  const [form, setForm] = useState({ clientId: '', serviceTypeId: '', materialId: '', originLocationId: '', destLocationId: '', qty: '1', clientRef: '' });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => apiFetch<DeliveryOrder>('POST', '/api/v1/delivery-orders', { ...form, qty: Number(form.qty), clientRef: form.clientRef || null }),
    onSuccess: (d) => {
      toast.success(`สร้าง ${d.doNo} แล้ว`);
      for (const w of d.warnings ?? []) toast.warning(w.message);
      void qc.invalidateQueries({ queryKey: ['delivery-orders'] });
      setOpen(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'สร้าง DO ไม่สำเร็จ'),
  });
  const ready = form.clientId && form.serviceTypeId && form.materialId && form.originLocationId && form.destLocationId && Number(form.qty) > 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>สร้าง DO</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>สร้างใบสั่งส่ง</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Pick label="ลูกค้า" items={clients} value={form.clientId} onChange={set('clientId')} />
          <Pick label="บริการ" items={services} value={form.serviceTypeId} onChange={set('serviceTypeId')} />
          <Pick label="สินค้า" items={materials} value={form.materialId} onChange={set('materialId')} />
          <Pick label="ต้นทาง" items={locations} value={form.originLocationId} onChange={set('originLocationId')} />
          <Pick label="ปลายทาง" items={locations} value={form.destLocationId} onChange={set('destLocationId')} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>จำนวน</Label>
              <Input type="number" min={0} value={form.qty} onChange={(e) => set('qty')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>เลขที่อ้างอิงลูกค้า</Label>
              <Input value={form.clientRef} onChange={(e) => set('clientRef')(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/admin/src/pages/DeliveryOrdersPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetch } from '@shared/api';
import type { DeliveryOrder, Page } from '@shared/types';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';
import CreateDoDialog from './CreateDoDialog';

const STATUSES = ['UNASSIGNED', 'PLANNED', 'PICKED_UP', 'DELIVERED', 'POD_VERIFIED', 'FAILED', 'CANCELLED'];

export default function DeliveryOrdersPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('UNASSIGNED');
  const [selected, setSelected] = useState<string[]>([]);
  const clients = useNameMap('/clients');
  const locations = useNameMap('/locations');
  const materials = useNameMap('/materials');
  const q = useQuery({ queryKey: ['delivery-orders', status], queryFn: () => apiFetch<Page<DeliveryOrder>>('GET', `/api/v1/delivery-orders?status=${status}&limit=200`) });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">ใบสั่งส่ง (DO)</h1>
        <div className="flex gap-2">
          <Select value={status} onValueChange={(v) => { setStatus(v); setSelected([]); }}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CreateDoDialog />
          <Button variant="secondary" disabled={selected.length === 0} onClick={() => nav(`/shipments/new?doIds=${selected.join(',')}`)}>
            สร้างเที่ยวจาก DO ที่เลือก ({selected.length})
          </Button>
        </div>
      </div>
      <Table className="bg-white">
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead>เลขที่</TableHead>
            <TableHead>ลูกค้า</TableHead>
            <TableHead>สินค้า</TableHead>
            <TableHead>ต้นทาง → ปลายทาง</TableHead>
            <TableHead>กลุ่มงาน</TableHead>
            <TableHead>สถานะ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(q.data?.items ?? []).map((d) => (
            <TableRow key={d.id}>
              <TableCell>{d.status === 'UNASSIGNED' && <Checkbox checked={selected.includes(d.id)} onCheckedChange={() => toggle(d.id)} />}</TableCell>
              <TableCell className="font-mono text-xs">{d.doNo}</TableCell>
              <TableCell>{clients.get(d.clientId)}</TableCell>
              <TableCell>
                {materials.get(d.materialId)} {d.qty} {d.unit}
              </TableCell>
              <TableCell>
                {locations.get(d.originLocationId)} → {locations.get(d.destLocationId)}
              </TableCell>
              <TableCell className="text-xs">{d.jobGroupMatch.status === 'none' ? <span className="text-amber-700">ไม่พบกลุ่มงาน</span> : d.jobGroupMatch.status}</TableCell>
              <TableCell>
                <StatusBadge status={d.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.isLoading && <p className="text-sm text-neutral-500">กำลังโหลด…</p>}
    </div>
  );
}
```

Add to the `children` of the layout route in `App.tsx`: `{ path: '/delivery-orders', element: <DeliveryOrdersPage /> }`.

- [ ] **Step 2: Verify**

Run: `cd apps/admin && npm run build`. Then manual check: start the API (`npm run dev` at repo root with demo seed) and `npm run dev` in `apps/admin`; log in as `demo-planner`; the DO page lists the three demo DOs; creating a DO shows a toast with its number.

- [ ] **Step 3: Commit**

```bash
git add -A apps
git commit -m "feat(ui/admin): delivery-order pool with selection and create dialog" -m "<trailers>"
```

---

### Task 3: Admin — shipment builder with live validation

**Files:**
- Create: `apps/admin/src/pages/ShipmentNewPage.tsx`, `apps/admin/src/lib/useLatest.ts`, `apps/admin/src/lib/useLatest.test.ts`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: `useLatestValidation(body: object | null)` → `{ result: ValidateResult | null; pending: boolean }` — debounces 400 ms, calls `POST /api/v1/shipments/validate`, and ignores responses for anything but the latest body (request sequence number). Route `/shipments/new?doIds=`: pickers for start/end (Bangkok `datetime-local`), head vehicle (head/rigid), head driver, tail (only when the head is a tractor head) and tail driver (defaults to the head driver), selected DO list, auto-built stop preview, live errors/warnings; “บันทึกเป็นร่าง” (`POST /api/v1/shipments`) disabled while `pending` or errors exist; navigates to `/shipments/:id`.

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/useLatest.test.ts`:
```ts
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
    await act(async () => { vi.advanceTimersByTime(450); });
    rerender({ body: { v: 2 } });
    expect(result.current.pending).toBe(true);
    await act(async () => { vi.advanceTimersByTime(450); });
    await act(async () => { resolvers[1]!({ errors: [], warnings: [{ code: 'NEW', message: 'n' }], stops: [], legs: [] }); });
    await act(async () => { resolvers[0]!({ errors: [{ code: 'OLD', message: 'o' }], warnings: [], stops: [], legs: [] }); });
    expect(result.current.pending).toBe(false);
    expect(result.current.result?.warnings[0]?.code).toBe('NEW');
  });
});
```

Run: `cd apps/admin && npm test` → FAIL.

- [ ] **Step 2: Implement the hook**

`apps/admin/src/lib/useLatest.ts`:
```ts
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
```

Run: `npm test` → PASS.

- [ ] **Step 3: Implement the page**

`apps/admin/src/pages/ShipmentNewPage.tsx`:
```tsx
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, apiFetch } from '@shared/api';
import { fromBkkInput } from '@shared/time';
import type { DeliveryOrder, Driver, Shipment, Vehicle } from '@shared/types';
import IssueList from '../components/IssueList';
import { useMaster, useNameMap } from '../lib/master';
import { useLatestValidation } from '../lib/useLatest';

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

export default function ShipmentNewPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const doIds = (params.get('doIds') ?? '').split(',').filter(Boolean);
  const vehicles = useMaster<Vehicle>('/vehicles').data ?? [];
  const drivers = useMaster<Driver>('/drivers').data ?? [];
  const locations = useNameMap('/locations');
  const dos = useQuery({
    queryKey: ['dos-by-id', doIds],
    queryFn: () => Promise.all(doIds.map((id) => apiFetch<DeliveryOrder>('GET', `/api/v1/delivery-orders/${id}`))),
    enabled: doIds.length > 0,
  });
  const [start, setStart] = useState(`${today}T08:00`);
  const [end, setEnd] = useState(`${today}T17:00`);
  const [headId, setHeadId] = useState('');
  const [tailId, setTailId] = useState('');
  const [driverId, setDriverId] = useState('');
  const head = vehicles.find((v) => v.id === headId);
  const body = useMemo(() => {
    if (!start || !end) return null;
    return {
      plannedStart: fromBkkInput(start),
      plannedEnd: fromBkkInput(end),
      head: headId ? { vehicleId: headId, driverId: driverId || null } : null,
      tail: head?.part === 'head' && tailId ? { vehicleId: tailId, driverId: driverId || null } : null,
      doIds,
    };
  }, [start, end, headId, tailId, driverId, head?.part, doIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const { result, pending } = useLatestValidation(body);
  const save = useMutation({
    mutationFn: () => apiFetch<Shipment>('POST', '/api/v1/shipments', body),
    onSuccess: (sh) => {
      toast.success(`สร้าง ${sh.shipmentNo} แล้ว`);
      nav(`/shipments/${sh.id}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'บันทึกไม่สำเร็จ'),
  });
  const draftErrors = (result?.errors ?? []).filter((e) => !['TAIL_REQUIRED', 'HEAD_REQUIRED', 'HEAD_DRIVER_REQUIRED', 'TAIL_DRIVER_REQUIRED', 'STOPS_REQUIRED', 'DOS_REQUIRED'].includes(e.code));
  const VehicleSelect = ({ value, onChange, parts }: { value: string; onChange: (v: string) => void; parts: string[] }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="เลือกรถ" />
      </SelectTrigger>
      <SelectContent>
        {vehicles.filter((v) => parts.includes(v.part)).map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.plate} ({v.part})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>สร้างเที่ยวขนส่ง</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>เริ่ม (เวลาไทย)</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>สิ้นสุด (เวลาไทย)</Label>
              <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>หัวลาก / รถบรรทุก</Label>
            <VehicleSelect value={headId} onChange={setHeadId} parts={['head', 'rigid']} />
          </div>
          {head?.part === 'head' && (
            <div className="space-y-1">
              <Label>หาง</Label>
              <VehicleSelect value={tailId} onChange={setTailId} parts={['tail']} />
            </div>
          )}
          <div className="space-y-1">
            <Label>พนักงานขับรถ</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger>
                <SelectValue placeholder="เลือกคนขับ" />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">DO ในเที่ยวนี้</p>
            <ul className="space-y-1 text-sm">
              {(dos.data ?? []).map((d) => (
                <li key={d.id} className="font-mono text-xs">
                  {d.doNo} · {locations.get(d.originLocationId)} → {locations.get(d.destLocationId)}
                </li>
              ))}
            </ul>
          </div>
          <Button className="w-full" disabled={pending || !result || draftErrors.length > 0 || save.isPending} onClick={() => save.mutate()}>
            {pending ? 'กำลังตรวจกฎ…' : 'บันทึกเป็นร่าง'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>ตรวจกฎการวางแผน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <IssueList errors={result?.errors} warnings={result?.warnings} />
          <div>
            <p className="mb-1 text-sm font-medium">จุดจอด (สร้างอัตโนมัติ)</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {(result?.stops ?? []).map((s, i) => (
                <li key={i}>
                  {locations.get(s.locationId)} — รับ {s.pickupDoIds.length} / ส่ง {s.dropDoIds.length}
                </li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```
(Completeness issues are errors in `planned` mode; a DRAFT may still be saved with them, so the save button only blocks on conflict errors — `draftErrors`.)

Register `{ path: '/shipments/new', element: <ShipmentNewPage /> }` in `App.tsx`.

- [ ] **Step 4: Verify**

`cd apps/admin && npm test && npm run build`; manual: from the DO page select a demo DO → builder shows auto stops, choosing `80-3001` and `DRV-001` clears errors; save opens the detail route (404 page until Task 4 — acceptable).

- [ ] **Step 5: Commit**

```bash
git add -A apps
git commit -m "feat(ui/admin): shipment builder with debounced live validation" -m "<trailers>"
```

---

### Task 4: Admin — shipments list and detail with actions, timeline and PDF

**Files:**
- Create: `apps/admin/src/pages/ShipmentsPage.tsx`, `apps/admin/src/pages/ShipmentDetailPage.tsx`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: route `/shipments` (list with status filter, links); route `/shipments/:id` showing header (number, status, version, vehicles, drivers, planned times, driver response), stops table (location, status, pickup/drop DO numbers), events timeline (`GET /api/v1/shipments/:id/events`, auto-refresh every 10 s while ACCEPTED/IN_TRANSIT), DO list with statuses; actions by status: DRAFT → “วางแผน” (`/plan`), PLANNED → “ส่งงานให้คนขับ” (`/dispatch`), DRAFT/PLANNED/DISPATCHED/ACCEPTED → “ยกเลิก” (reason prompt), COMPLETED → “ปิดงาน” (admin only, `/close`), CLOSED → “เปิด PDF หลักฐาน” (`openAuthedFile('/api/v1/shipments/:id/summary.pdf')`). Each action sends the current `version`; 409 shows “มีคนแก้ไขพร้อมกัน — โหลดใหม่” and refetches; 422 `SHIPMENT_INVALID` lists `details.errors`.

- [ ] **Step 1: Implement**

`apps/admin/src/pages/ShipmentsPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetch } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { Page, Shipment } from '@shared/types';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';

const STATUSES = ['ALL', 'DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED', 'CLOSED', 'CANCELLED'];

export default function ShipmentsPage() {
  const [status, setStatus] = useState('ALL');
  const plates = useNameMap('/vehicles', 'plate');
  const drivers = useNameMap('/drivers');
  const q = useQuery({
    queryKey: ['shipments', status],
    queryFn: () => apiFetch<Page<Shipment>>('GET', `/api/v1/shipments?limit=200${status === 'ALL' ? '' : `&status=${status}`}`),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">งานขนส่ง</h1>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Table className="bg-white">
        <TableHeader>
          <TableRow>
            <TableHead>เลขที่</TableHead>
            <TableHead>เวลา</TableHead>
            <TableHead>รถ</TableHead>
            <TableHead>คนขับ</TableHead>
            <TableHead>จุดจอด</TableHead>
            <TableHead>สถานะ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...(q.data?.items ?? [])].reverse().map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link className="font-mono text-xs text-blue-700 hover:underline" to={`/shipments/${s.id}`}>
                  {s.shipmentNo}
                </Link>
              </TableCell>
              <TableCell className="text-xs">
                {fmtBkk(s.plannedStart)} – {fmtBkk(s.plannedEnd)}
              </TableCell>
              <TableCell>{[s.head?.vehicleId, s.tail?.vehicleId].filter(Boolean).map((id) => plates.get(id!)).join(' + ')}</TableCell>
              <TableCell>{s.head?.driverId ? drivers.get(s.head.driverId) : '-'}</TableCell>
              <TableCell>{s.stops.length}</TableCell>
              <TableCell>
                <StatusBadge status={s.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

`apps/admin/src/pages/ShipmentDetailPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch, openAuthedFile } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { EventItem, Issue, Shipment } from '@shared/types';
import IssueList from '../components/IssueList';
import { hasRole } from '../components/RequireAuth';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';

export default function ShipmentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const plates = useNameMap('/vehicles', 'plate');
  const drivers = useNameMap('/drivers');
  const locations = useNameMap('/locations');
  const sh = useQuery({ queryKey: ['shipment', id], queryFn: () => apiFetch<Shipment>('GET', `/api/v1/shipments/${id}`), refetchInterval: 10_000 });
  const live = sh.data && ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'].includes(sh.data.status);
  const events = useQuery({
    queryKey: ['events', id],
    queryFn: async () => (await apiFetch<{ items: EventItem[] }>('GET', `/api/v1/shipments/${id}/events`)).items,
    refetchInterval: live ? 10_000 : false,
  });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => apiFetch<Shipment>('POST', `/api/v1/shipments/${id}/${path}`, body),
    onSuccess: () => {
      toast.success('บันทึกแล้ว');
      void qc.invalidateQueries({ queryKey: ['shipment', id] });
      void qc.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) toast.error('มีคนแก้ไขพร้อมกัน — โหลดข้อมูลใหม่แล้ว');
      else if (e instanceof ApiError && e.code === 'SHIPMENT_INVALID') toast.error(((e.details as { errors: Issue[] }).errors ?? []).map((x) => x.message).join('\n'));
      else toast.error(e instanceof ApiError ? e.message : 'ทำรายการไม่สำเร็จ');
      void qc.invalidateQueries({ queryKey: ['shipment', id] });
    },
  });
  if (!sh.data) return <p>กำลังโหลด…</p>;
  const s = sh.data;
  const doNo = new Map((s.deliveryOrders ?? []).map((d) => [d.id, d.doNo]));
  const v = { version: s.version };
  const cancel = () => {
    const reason = window.prompt('เหตุผลที่ยกเลิก');
    if (reason && reason.trim().length >= 3) act.mutate({ path: 'cancel', body: { ...v, reason } });
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{s.shipmentNo}</h1>
          <StatusBadge status={s.status} />
          <span className="text-xs text-neutral-500">v{s.version}</span>
        </div>
        <div className="flex gap-2">
          {s.status === 'DRAFT' && <Button onClick={() => act.mutate({ path: 'plan', body: v })}>วางแผน</Button>}
          {s.status === 'PLANNED' && <Button onClick={() => act.mutate({ path: 'dispatch', body: v })}>ส่งงานให้คนขับ</Button>}
          {['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'].includes(s.status) && (
            <Button variant="outline" onClick={cancel}>
              ยกเลิก
            </Button>
          )}
          {s.status === 'COMPLETED' && (hasRole('admin') || hasRole('planner')) && <Button onClick={() => act.mutate({ path: 'close', body: v })}>ปิดงาน</Button>}
          {s.status === 'CLOSED' && (
            <Button variant="secondary" onClick={() => openAuthedFile(`/api/v1/shipments/${id}/summary.pdf`).catch((e) => toast.error(e.message))}>
              เปิด PDF หลักฐาน
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ข้อมูลเที่ยว</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>เวลา: {fmtBkk(s.plannedStart)} – {fmtBkk(s.plannedEnd)}</p>
            <p>รถ: {[s.head?.vehicleId, s.tail?.vehicleId].filter(Boolean).map((x) => plates.get(x!)).join(' + ') || '-'}</p>
            <p>คนขับ: {s.head?.driverId ? drivers.get(s.head.driverId) : '-'}</p>
            {s.driverResponse && (
              <p>
                คนขับ{s.driverResponse.status === 'ACCEPTED' ? 'รับงาน' : `ปฏิเสธ: ${s.driverResponse.reason}`} ({fmtBkk(s.driverResponse.at)})
              </p>
            )}
            <IssueList warnings={s.warnings} />
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">จุดจอด</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {s.stops.map((st) => (
                <li key={st.stopId} className="flex items-center justify-between rounded border bg-white px-3 py-2">
                  <span>
                    {st.seq}. {locations.get(st.locationId)}
                    <span className="ml-2 text-xs text-neutral-500">
                      {st.pickupDoIds.length > 0 && `รับ ${st.pickupDoIds.map((d) => doNo.get(d)).join(', ')} `}
                      {st.dropDoIds.length > 0 && `ส่ง ${st.dropDoIds.map((d) => doNo.get(d)).join(', ')}`}
                    </span>
                  </span>
                  <span className="text-xs">{st.status}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ใบสั่งส่ง</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(s.deliveryOrders ?? []).map((d) => (
              <div key={d.id} className="flex items-center justify-between">
                <span className="font-mono text-xs">{d.doNo}</span>
                <StatusBadge status={d.status} />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ไทม์ไลน์คนขับ</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {(events.data ?? []).map((e) => (
                <li key={e.id} className="flex justify-between">
                  <span>
                    {e.code}
                    {e.reasonCode ? ` (${e.reasonCode})` : ''}
                    {e.flags.length > 0 && <span className="ml-2 text-xs text-amber-700">{e.flags.join(', ')}</span>}
                  </span>
                  <span className="text-xs text-neutral-500">{fmtBkk(e.deviceTime)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

Register `{ path: '/shipments', element: <ShipmentsPage /> }` and `{ path: '/shipments/:id', element: <ShipmentDetailPage /> }` in `App.tsx` (keep `/shipments/new` before `/shipments/:id`).

- [ ] **Step 2: Verify**

`cd apps/admin && npm run build`; manual: open the saved draft → “วางแผน” → “ส่งงานให้คนขับ”; the status badge follows; a second tab with a stale version shows the conflict toast.

- [ ] **Step 3: Commit**

```bash
git add -A apps
git commit -m "feat(ui/admin): shipments list and detail with plan/dispatch/cancel/close, timeline and PDF" -m "<trailers>"
```

---

### Task 5: Admin — POD review

**Files:**
- Create: `apps/admin/src/pages/PodReviewPage.tsx`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: route `/pods`: left list of `GET /api/v1/pods?status=submitted` (oldest first, flagged ones marked), right panel with `GET /api/v1/pods/:id` detail — outcome, reason, answers (label-less key/value list), photos from `fileUrls` (`<img>`; opens full size), evidence (device time, distance to site, accuracy, flags), hash; buttons “ผ่าน” (`/verify`) and “ไม่ผ่าน” (`/reject` with a reason prompt) for admins.

- [ ] **Step 1: Implement**

`apps/admin/src/pages/PodReviewPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { Page, Pod } from '@shared/types';
import { hasRole } from '../components/RequireAuth';
import StatusBadge from '../components/StatusBadge';

export default function PodReviewPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['pods', 'submitted'], queryFn: () => apiFetch<Page<Pod>>('GET', '/api/v1/pods?status=submitted&limit=100'), refetchInterval: 10_000 });
  const detail = useQuery({ queryKey: ['pod', selected], queryFn: () => apiFetch<Pod>('GET', `/api/v1/pods/${selected}`), enabled: !!selected });
  const review = useMutation({
    mutationFn: ({ action, reason }: { action: 'verify' | 'reject'; reason?: string }) => apiFetch<Pod>('POST', `/api/v1/pods/${selected}/${action}`, action === 'reject' ? { reason } : {}),
    onSuccess: (p) => {
      toast.success(p.status === 'verified' ? 'ผ่านแล้ว' : 'ตีกลับแล้ว');
      setSelected(null);
      void qc.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'ทำรายการไม่สำเร็จ'),
  });
  const p = detail.data;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">POD รอตรวจ ({list.data?.items.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {(list.data?.items ?? []).map((x) => (
            <button key={x.id} onClick={() => setSelected(x.id)} className={`w-full rounded border px-2 py-1 text-left text-sm ${selected === x.id ? 'border-blue-600 bg-blue-50' : 'bg-white'}`}>
              <span className="font-mono text-xs">{x.id.slice(-6)}</span> · {x.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ไม่สำเร็จ (${x.reasonCode})`}
              {x.flags.length > 0 && <span className="ml-1 text-xs text-amber-700">⚑ {x.flags.join(', ')}</span>}
              <div className="text-xs text-neutral-500">{fmtBkk(x.evidence.deviceTime)}</div>
            </button>
          ))}
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">รายละเอียด</CardTitle>
        </CardHeader>
        <CardContent>
          {!p ? (
            <p className="text-sm text-neutral-500">เลือก POD ทางซ้าย</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={p.status} />
                <span>{p.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ส่งไม่สำเร็จ — ${p.reasonCode}${p.note ? `: ${p.note}` : ''}`}</span>
              </div>
              <dl className="grid grid-cols-2 gap-1">
                {Object.entries(p.answers).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-500">{k}</dt>
                    <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-2">
                {(p.fileUrls ?? []).map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer">
                    <img src={f.url} alt={f.key} className="h-32 rounded border object-cover" />
                  </a>
                ))}
              </div>
              <div className="rounded bg-neutral-50 p-2 text-xs">
                <p>เวลาที่เครื่อง: {fmtBkk(p.evidence.deviceTime)} · รับที่เซิร์ฟเวอร์: {fmtBkk(p.evidence.receivedAt)}</p>
                <p>
                  ระยะจากจุดส่ง: {p.evidence.geofenceDistanceM ?? '-'} ม. · ความแม่นยำ GPS: {p.evidence.accuracyM ?? '-'} ม. · ออฟไลน์: {p.evidence.offline ? 'ใช่' : 'ไม่'}
                </p>
                {p.flags.length > 0 && <p className="text-amber-700">ข้อสังเกต: {p.flags.join(', ')}</p>}
                <p className="break-all font-mono">hash: {p.hash}</p>
              </div>
              {(hasRole('admin') || hasRole('planner')) && p.status === 'submitted' && (
                <div className="flex gap-2">
                  <Button onClick={() => review.mutate({ action: 'verify' })}>ผ่าน</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      const reason = window.prompt('เหตุผลที่ไม่ผ่าน');
                      if (reason && reason.trim().length >= 3) review.mutate({ action: 'reject', reason });
                    }}
                  >
                    ไม่ผ่าน
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```
Register `{ path: '/pods', element: <PodReviewPage /> }`.

- [ ] **Step 2: Verify** — `cd apps/admin && npm run build`.

- [ ] **Step 3: Commit**

```bash
git add -A apps
git commit -m "feat(ui/admin): POD review queue with photos, evidence and verify/reject" -m "<trailers>"
```

---

### Task 6: Driver app scaffold — login, job list, accept/decline

**Files:**
- Create (scaffold): `apps/driver/**` (same steps as Task 1 Step 1 with port 5174 and the basic-ssl plugin)
- Create: `apps/driver/src/{main.tsx,App.tsx}`, `apps/driver/src/components/RequireAuth.tsx`, `apps/driver/src/pages/{LoginPage.tsx,JobsPage.tsx}`

**Interfaces:**
- Produces: driver app (mobile-first, max width 480 px) with routes `/login`, `/` (job list from `GET /api/v1/driver/shipments`, refresh every 20 s, pull-to-refresh button), `/jobs/:id` (Task 7). Job cards show shipment number, status, planned times, stop count; DISPATCHED jobs show “รับงาน” (`POST /driver/shipments/:id/accept`) and “ปฏิเสธ” (reason prompt, `/decline`). `RequireAuth` requires role `driver`. Login sends the phone position when available.

- [ ] **Step 1: Scaffold**

Run from repo root:
```bash
npm create vite@latest apps/driver -- --template react-ts
cd apps/driver
npm install
npm install tailwindcss @tailwindcss/vite @tanstack/react-query@^5 react-router-dom@^6 sonner
npm install -D @types/node @vitejs/plugin-basic-ssl vitest@^3 @testing-library/react @testing-library/jest-dom jsdom
```
Apply the same `index.css`, tsconfig `paths`/`include` edits and shadcn init as in Task 1 Step 1, adding components `button input label card badge textarea select checkbox dialog sonner`. `apps/driver/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: { alias: { '@': path.resolve(__dirname, './src'), '@shared': path.resolve(__dirname, '../shared') } },
  server: { port: 5174, host: true, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
```
Add `"test": "vitest run"` to scripts.

- [ ] **Step 2: Implement**

`apps/driver/src/main.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { configureApi } from '@shared/api';
import App from './App';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
configureApi('driver', () => {
  queryClient.clear();
  window.location.assign('/login');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/driver/src/App.tsx`:
```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import JobsPage from './pages/JobsPage';
import LoginPage from './pages/LoginPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RequireAuth><JobsPage /></RequireAuth> },
]);

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] bg-neutral-50">
      <RouterProvider router={router} />
    </div>
  );
}
```

`apps/driver/src/components/RequireAuth.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { getSession } from '@shared/api';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const s = getSession();
  if (!s || !s.user.roles.includes('driver') || !s.user.driverId) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

`apps/driver/src/pages/LoginPage.tsx`: same as the admin login page but titled “Mena TMS — พนักงานขับรถ”, navigating to `/`, and calling `login(username, password, pos)` where `pos` comes from `getPosition()` (Task 7's `lib/gps.ts`; until then pass `{}`) — write it as:
```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, login } from '@shared/api';

export default function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
      nav('/');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex min-h-screen flex-col justify-center gap-4 p-6">
      <h1 className="text-center text-2xl font-semibold">Mena TMS — พนักงานขับรถ</h1>
      <div className="space-y-1">
        <Label htmlFor="u">ชื่อผู้ใช้</Label>
        <Input id="u" className="h-12 text-lg" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="p">รหัสผ่าน</Label>
        <Input id="p" type="password" className="h-12 text-lg" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <Button type="submit" className="h-12 text-lg" disabled={busy || !username || !password}>
        เข้าสู่ระบบ
      </Button>
    </form>
  );
}
```

`apps/driver/src/pages/JobsPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, logout } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { DriverShipment } from '@shared/types';

const TH: Record<string, string> = { DISPATCHED: 'งานใหม่', ACCEPTED: 'รับงานแล้ว', IN_TRANSIT: 'กำลังวิ่ง' };

export default function JobsPage() {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items, refetchInterval: 20_000 });
  const respond = useMutation({
    mutationFn: ({ id, version, action, reason }: { id: string; version: number; action: 'accept' | 'decline'; reason?: string }) =>
      apiFetch('POST', `/api/v1/driver/shipments/${id}/${action}`, action === 'decline' ? { version, reason } : { version }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => {
      toast.error(e instanceof ApiError && e.status === 409 ? 'งานถูกแก้ไขแล้ว — โหลดงานใหม่ให้แล้ว กรุณาตรวจสอบอีกครั้ง' : e instanceof ApiError ? e.message : 'ทำรายการไม่สำเร็จ');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">งานของฉัน</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
            รีเฟรช
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            ออก
          </Button>
        </div>
      </div>
      {(jobs.data ?? []).length === 0 && !jobs.isLoading && <p className="text-center text-neutral-500">ยังไม่มีงาน</p>}
      {(jobs.data ?? []).map((j) => (
        <div key={j.id} className="space-y-2 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono">{j.shipmentNo}</span>
            <Badge>{TH[j.status] ?? j.status}</Badge>
          </div>
          <p className="text-sm text-neutral-600">
            {fmtBkk(j.plannedStart)} – {fmtBkk(j.plannedEnd)} · {j.stops.length} จุด
          </p>
          <p className="text-sm">{j.locations.map((l) => l.name).join(' → ')}</p>
          {j.status === 'DISPATCHED' ? (
            <div className="grid grid-cols-2 gap-2">
              <Button className="h-12" onClick={() => respond.mutate({ id: j.id, version: j.version, action: 'accept' })}>
                รับงาน
              </Button>
              <Button
                className="h-12"
                variant="outline"
                onClick={() => {
                  const reason = window.prompt('เหตุผลที่ปฏิเสธ');
                  if (reason && reason.trim().length >= 3) respond.mutate({ id: j.id, version: j.version, action: 'decline', reason });
                }}
              >
                ปฏิเสธ
              </Button>
            </div>
          ) : (
            <Button asChild className="h-12 w-full">
              <Link to={`/jobs/${j.id}`}>เปิดงาน</Link>
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify** — `cd apps/driver && npm run build`; manual: log in as `demo-driver1` at `https://localhost:5174`, the dispatched job appears, “รับงาน” flips it to “รับงานแล้ว”.

- [ ] **Step 4: Commit**

```bash
git add -A apps
git commit -m "feat(ui/driver): driver app shell with login, job list and accept/decline" -m "<trailers>"
```

---

### Task 7: Driver app — run the job (steps with GPS, exceptions)

**Files:**
- Create: `apps/shared/steps.ts`, `apps/driver/src/lib/gps.ts`, `apps/driver/src/lib/events.ts`, `apps/driver/src/lib/events.test.ts`, `apps/driver/src/pages/JobPage.tsx`
- Modify: `apps/driver/src/App.tsx`, `apps/driver/vite.config.ts` (test include `../shared/**/*.test.ts`)

**Interfaces:**
- Produces:
  - `@shared/steps`: `stopSequence(hasDrops, hasPickups): string[]` and `nextStep(stop: { pickupDoIds; dropDoIds }, done: Set<string>): string | null` (mirror of the backend rule, drops before pickups; returns `null` when `DEPARTED` is done).
  - `lib/gps.ts`: `getPosition(timeoutMs = 10000): Promise<{ lat: number | null; lng: number | null; accuracyM: number | null; noGpsReason: 'NO_GPS' | null }>` (never rejects).
  - `lib/events.ts`: `createTapSender(send: (body) => Promise<{ results: EventResult[] }>)` → `tap(input)`; a tap that fails with a network error is retried with the **same** `clientEventId` on the next call for the same (stop, code) pair until it gets a definitive result (`accepted` / `duplicate` / `rejected`).
  - Route `/jobs/:id`: stops list; the current stop (first not `DONE`) shows a big button for `nextStep`; at a drop stop after `UNLOAD_END` each drop DO shows “ส่งหลักฐาน (POD)” → `/jobs/:id/pod/:doId`; after `ARRIVED` it also shows “ส่งไม่สำเร็จ” → same POD page with `?failed=1`; extra steps from the DO forms (`podForm.extraSteps`) appear as secondary buttons while at the stop; “แจ้งปัญหา” opens a dialog for `DELAYED` / `BREAKDOWN` / `EXCEPTION` + reason. Done steps come from `GET /api/v1/driver/shipments/:id/events`.

- [ ] **Step 1: Write the failing tests**

`apps/driver/src/lib/events.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { nextStep } from '@shared/steps';
import { createTapSender } from './events';

describe('nextStep', () => {
  it('walks drops before pickups and ends after departure', () => {
    const stop = { pickupDoIds: ['p'], dropDoIds: ['d'] };
    expect(nextStep(stop, new Set())).toBe('ARRIVED');
    expect(nextStep(stop, new Set(['ARRIVED']))).toBe('UNLOAD_START');
    expect(nextStep(stop, new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']))).toBe('LOAD_START');
    expect(nextStep({ pickupDoIds: [], dropDoIds: ['d'] }, new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'DEPARTED']))).toBeNull();
  });
});

describe('createTapSender', () => {
  const base = { shipmentId: 's', stopId: 'st', code: 'ARRIVED', lat: 1, lng: 2, accuracyM: 5, noGpsReason: null, deviceTime: '2026-10-05T08:00:00+07:00' };

  it('reuses the clientEventId after a network failure', async () => {
    const send = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ results: [{ clientEventId: 'x', status: 'accepted', eventId: 'e', flags: [] }] });
    const tap = createTapSender(send);
    await expect(tap(base)).rejects.toThrow('offline');
    await tap(base);
    const id1 = send.mock.calls[0]![0].events[0].clientEventId;
    const id2 = send.mock.calls[1]![0].events[0].clientEventId;
    expect(id1).toBe(id2);
  });

  it('uses a fresh id once the previous tap got an answer', async () => {
    const send = vi.fn().mockResolvedValue({ results: [{ clientEventId: 'x', status: 'rejected', eventId: null, flags: [], code: 'EVENT_OUT_OF_ORDER' }] });
    const tap = createTapSender(send);
    await tap(base);
    await tap(base);
    expect(send.mock.calls[0]![0].events[0].clientEventId).not.toBe(send.mock.calls[1]![0].events[0].clientEventId);
  });
});
```

Run: `cd apps/driver && npm test` → FAIL.

- [ ] **Step 2: Implement helpers**

`apps/shared/steps.ts`:
```ts
export function stopSequence(hasDrops: boolean, hasPickups: boolean): string[] {
  return ['ARRIVED', ...(hasDrops ? ['UNLOAD_START', 'UNLOAD_END'] : []), ...(hasPickups ? ['LOAD_START', 'LOAD_END'] : []), 'DEPARTED'];
}

export function nextStep(stop: { pickupDoIds: string[]; dropDoIds: string[] }, done: Set<string>): string | null {
  return stopSequence(stop.dropDoIds.length > 0, stop.pickupDoIds.length > 0).find((c) => !done.has(c)) ?? null;
}

export const STEP_TH: Record<string, string> = {
  ARRIVED: 'ถึงจุดแล้ว', UNLOAD_START: 'เริ่มลงสินค้า', UNLOAD_END: 'ลงสินค้าเสร็จ', LOAD_START: 'เริ่มขึ้นสินค้า',
  LOAD_END: 'ขึ้นสินค้าเสร็จ', DEPARTED: 'ออกจากจุด', DOCS_SUBMITTED: 'ยื่นเอกสาร', DOCS_RETURNED: 'รับเอกสารคืน',
  SEAL_CHECKED: 'ตรวจซีล', TEMP_CHECKED: 'ตรวจอุณหภูมิ',
};
```

`apps/driver/src/lib/gps.ts`:
```ts
export interface Position {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  noGpsReason: 'NO_GPS' | null;
}

export function getPosition(timeoutMs = 10_000): Promise<Position> {
  const none: Position = { lat: null, lng: null, accuracyM: null, noGpsReason: 'NO_GPS' };
  if (!('geolocation' in navigator)) return Promise.resolve(none);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), noGpsReason: null }),
      () => resolve(none),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
    );
  });
}
```

`apps/driver/src/lib/events.ts`:
```ts
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
```

Add `'../shared/**/*.test.ts'` to the driver `test.include`. Run `npm test` → PASS.

- [ ] **Step 3: Implement the job page**

`apps/driver/src/pages/JobPage.tsx`:
```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@shared/api';
import { STEP_TH, nextStep } from '@shared/steps';
import type { DriverShipment, EventItem } from '@shared/types';
import { createTapSender, type EventResult } from '../lib/events';
import { getPosition } from '../lib/gps';

const REASONS = ['TRAFFIC', 'BREAKDOWN', 'WEATHER', 'CHECKPOINT', 'CONSIGNEE_CLOSED', 'NO_RECEIVER', 'WRONG_ADDRESS', 'OTHER'];
const tap = createTapSender((body) => apiFetch<{ results: EventResult[] }>('POST', '/api/v1/driver/events', body));

export default function JobPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; reason: string; note: string } | null>(null);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items });
  const events = useQuery({ queryKey: ['job-events', id], queryFn: async () => (await apiFetch<{ items: EventItem[] }>('GET', `/api/v1/driver/shipments/${id}/events`)).items });
  const job = jobs.data?.find((j) => j.id === id);
  const done = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of events.data ?? []) if (e.stopId) m.set(e.stopId, new Set([...(m.get(e.stopId) ?? []), e.code]));
    return m;
  }, [events.data]);
  if (!job) return <p className="p-4">กำลังโหลด… {jobs.isFetched && <Link to="/" className="text-blue-700">กลับ</Link>}</p>;
  const locName = new Map(job.locations.map((l) => [l.id, l.name]));
  const dos = new Map(job.deliveryOrders.map((d) => [d.id, d]));
  const current = job.stops.find((s) => !(done.get(s.stopId)?.has('DEPARTED')));

  const send = async (stopId: string | null, code: string, extra: { reasonCode?: string; note?: string } = {}) => {
    setBusy(true);
    try {
      const pos = await getPosition();
      const r = await tap({ shipmentId: job.id, stopId, code, ...pos, deviceTime: new Date().toISOString(), reasonCode: extra.reasonCode ?? null, note: extra.note ?? null });
      if (r.status === 'rejected') toast.error(r.message ?? r.code ?? 'ไม่สำเร็จ');
      else toast.success(`${STEP_TH[code] ?? code}${r.flags.length ? ` (${r.flags.join(', ')})` : ''}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'ส่งไม่สำเร็จ — ลองกดอีกครั้ง');
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['job-events', id] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <button onClick={() => nav('/')} className="text-blue-700">
          ← งานของฉัน
        </button>
        <span className="font-mono text-sm">{job.shipmentNo}</span>
      </div>
      {job.stops.map((s) => {
        const d = done.get(s.stopId) ?? new Set<string>();
        const isCurrent = current?.stopId === s.stopId;
        const next = nextStep(s, d);
        const extras = [...new Set([...s.dropDoIds, ...s.pickupDoIds].flatMap((x) => dos.get(x)?.podForm.extraSteps ?? []))].filter((c) => !d.has(c));
        return (
          <div key={s.stopId} className={`space-y-2 rounded-lg border p-4 ${isCurrent ? 'border-blue-600 bg-white shadow' : 'bg-neutral-100'}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {s.seq}. {locName.get(s.locationId)}
              </span>
              <span className="text-xs text-neutral-500">{[...d].map((c) => STEP_TH[c] ?? c).join(' · ')}</span>
            </div>
            <p className="text-sm text-neutral-600">
              {s.pickupDoIds.length > 0 && `รับ: ${s.pickupDoIds.map((x) => dos.get(x)?.doNo).join(', ')} `}
              {s.dropDoIds.length > 0 && `ส่ง: ${s.dropDoIds.map((x) => dos.get(x)?.doNo).join(', ')}`}
            </p>
            {isCurrent && next && (
              <Button className="h-14 w-full text-lg" disabled={busy} onClick={() => void send(s.stopId, next)}>
                {STEP_TH[next] ?? next}
              </Button>
            )}
            {isCurrent &&
              s.dropDoIds.map((doId) => {
                const o = dos.get(doId);
                if (!o) return null;
                const needsPod = ['PICKED_UP', 'POD_REJECTED', 'PLANNED'].includes(o.status);
                if (!needsPod || !d.has('ARRIVED')) return null;
                return (
                  <div key={doId} className="grid grid-cols-2 gap-2">
                    <Button asChild className="h-12" disabled={!d.has('UNLOAD_END')}>
                      <Link to={`/jobs/${job.id}/pod/${doId}`}>POD {o.doNo}</Link>
                    </Button>
                    <Button asChild variant="outline" className="h-12">
                      <Link to={`/jobs/${job.id}/pod/${doId}?failed=1`}>ส่งไม่สำเร็จ</Link>
                    </Button>
                  </div>
                );
              })}
            {isCurrent && d.has('ARRIVED') && !d.has('DEPARTED') && extras.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extras.map((c) => (
                  <Button key={c} variant="secondary" disabled={busy} onClick={() => void send(s.stopId, c)}>
                    {STEP_TH[c] ?? c}
                  </Button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <Button variant="outline" className="h-12 w-full" onClick={() => setProblem({ code: 'DELAYED', reason: 'TRAFFIC', note: '' })}>
        แจ้งปัญหา / ล่าช้า
      </Button>
      <Dialog open={!!problem} onOpenChange={(o) => !o && setProblem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>แจ้งปัญหา</DialogTitle>
          </DialogHeader>
          {problem && (
            <div className="space-y-3">
              <Select value={problem.code} onValueChange={(v) => setProblem({ ...problem, code: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELAYED">ล่าช้า</SelectItem>
                  <SelectItem value="BREAKDOWN">รถเสีย</SelectItem>
                  <SelectItem value="EXCEPTION">เหตุอื่น</SelectItem>
                </SelectContent>
              </Select>
              <Select value={problem.reason} onValueChange={(v) => setProblem({ ...problem, reason: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea placeholder="รายละเอียด" value={problem.note} onChange={(e) => setProblem({ ...problem, note: e.target.value })} />
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => {
                if (!problem) return;
                void send(null, problem.code, { reasonCode: problem.reason, note: problem.note || undefined });
                setProblem(null);
              }}
            >
              ส่ง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```
Register `{ path: '/jobs/:id', element: <RequireAuth><JobPage /></RequireAuth> }` in the driver router.

- [ ] **Step 4: Verify** — `cd apps/driver && npm test && npm run build`; manual: on an accepted job, tapping walks the pickup stop (ARRIVED → LOAD_START → LOAD_END → DEPARTED) and then arrives at the drop stop.

- [ ] **Step 5: Commit**

```bash
git add -A apps
git commit -m "feat(ui/driver): run a job step by step with GPS, extra steps and problem reports" -m "<trailers>"
```

---

### Task 8: Driver app — POD form (photos, signature, fields, failed delivery)

**Files:**
- Create: `apps/driver/src/lib/image.ts`, `apps/driver/src/lib/image.test.ts`, `apps/driver/src/lib/upload.ts`, `apps/driver/src/components/SignaturePad.tsx`, `apps/driver/src/pages/PodPage.tsx`
- Modify: `apps/driver/src/App.tsx`

**Interfaces:**
- Produces:
  - `lib/image.ts`: `fitWithin(w: number, h: number, max = 1600): { width: number; height: number }`; `compressImage(file: Blob, max = 1600, quality = 0.8): Promise<Blob>` (canvas → `image/jpeg`); `sha256Hex(blob: Blob): Promise<string>` (`crypto.subtle`).
  - `lib/upload.ts`: `uploadFile(shipmentId, doId, fieldKey, blob): Promise<PodFile>` (presign → `PUT` to the returned URL with the returned headers → returns `{ fieldKey, key, sha256, mime: 'image/jpeg', bytes }`; throws on non-2xx).
  - `SignaturePad` component (`onChange(blob | null)`), pointer events, “ล้าง” button, exports a PNG blob that is then passed through `compressImage` like photos.
  - Route `/jobs/:id/pod/:doId[?failed=1]`: renders every field of the DO's `podForm` — `photo` (camera input `accept="image/*" capture="environment" multiple`, thumbnails, remove), `signature` (pad), `text`, `number`, `select`, `checkbox`, `qtyLines` (one line prefilled with the DO qty/unit), `palletLines` (add rows) — or, in failed mode, reason select + note + optional photos. Submit: uploads all files, then `POST /api/v1/driver/pods` with a `clientPodId` created once when the page opens (reused on retry), current position and `deviceTime`; on success toast and go back to the job; on `POD_INVALID` show each issue message.

- [ ] **Step 1: Write the failing test**

`apps/driver/src/lib/image.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fitWithin, sha256Hex } from './image';

describe('image helpers', () => {
  it('scales a 4032×3024 portrait photo to fit 1600 px, keeping the ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('hashes blobs with SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```
Run: `cd apps/driver && npm test` → FAIL.

- [ ] **Step 2: Implement helpers**

`apps/driver/src/lib/image.ts`:
```ts
export function fitWithin(w: number, h: number, max = 1600): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export async function compressImage(file: Blob, max = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', quality));
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

`apps/driver/src/lib/upload.ts`:
```ts
import { apiFetch } from '@shared/api';
import type { PodFile } from '@shared/types';
import { sha256Hex } from './image';

export async function uploadFile(shipmentId: string, doId: string, fieldKey: string, blob: Blob): Promise<PodFile> {
  const p = await apiFetch<{ key: string; url: string; headers: Record<string, string>; maxBytes: number }>('POST', '/api/v1/uploads/presign', {
    shipmentId, doId, contentType: 'image/jpeg',
  });
  if (blob.size > p.maxBytes) throw new Error('ไฟล์ใหญ่เกินกำหนด');
  const res = await fetch(p.url, { method: 'PUT', headers: p.headers, body: blob });
  if (!res.ok) throw new Error(`อัปโหลดไม่สำเร็จ (${res.status})`);
  return { fieldKey, key: p.key, sha256: await sha256Hex(blob), mime: 'image/jpeg', bytes: blob.size };
}
```

`apps/driver/src/components/SignaturePad.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

export default function SignaturePad({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    c.width = c.clientWidth * 2;
    c.height = c.clientHeight * 2;
    const ctx = c.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) ref.current!.toBlob((b) => onChange(b), 'image/png');
  };
  const clear = () => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange(null);
  };
  return (
    <div className="space-y-1">
      <canvas
        ref={ref}
        className="h-40 w-full touch-none rounded border bg-white"
        onPointerDown={(e) => {
          drawing.current = true;
          const { x, y } = point(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const { x, y } = point(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.lineTo(x, y);
          ctx.stroke();
          dirty.current = true;
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      <Button type="button" variant="ghost" size="sm" onClick={clear}>
        ล้างลายเซ็น
      </Button>
    </div>
  );
}
```

Run `npm test` → PASS.

- [ ] **Step 3: Implement the POD page**

`apps/driver/src/pages/PodPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@shared/api';
import type { DriverShipment, Issue, PodField, PodFile } from '@shared/types';
import SignaturePad from '../components/SignaturePad';
import { getPosition } from '../lib/gps';
import { compressImage } from '../lib/image';
import { uploadFile } from '../lib/upload';

const FAIL_REASONS = ['CONSIGNEE_CLOSED', 'NO_RECEIVER', 'REFUSED_FULL', 'REFUSED_PARTIAL', 'DAMAGED', 'SHORTAGE', 'WRONG_ADDRESS', 'DOCS_MISSING', 'TEMP_OUT_OF_RANGE', 'OTHER'];

export default function PodPage() {
  const { id, doId } = useParams();
  const [params] = useSearchParams();
  const failed = params.get('failed') === '1';
  const nav = useNavigate();
  const clientPodId = useMemo(() => crypto.randomUUID(), []);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items });
  const job = jobs.data?.find((j) => j.id === id);
  const d = job?.deliveryOrders.find((x) => x.id === doId);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [blobs, setBlobs] = useState<Record<string, Blob[]>>({});
  const [reason, setReason] = useState('CONSIGNEE_CLOSED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  if (!job || !d) return <p className="p-4">กำลังโหลด…</p>;
  const fields = failed ? d.podForm.fields.filter((f) => f.type === 'photo') : d.podForm.fields;
  const set = (k: string, v: unknown) => setAnswers((a) => ({ ...a, [k]: v }));

  const addPhotos = async (f: PodField, files: FileList | null) => {
    if (!files) return;
    const out: Blob[] = [];
    for (const file of Array.from(files)) out.push(await compressImage(file));
    setBlobs((b) => ({ ...b, [f.key]: [...(b[f.key] ?? []), ...out].slice(0, f.max ?? 10) }));
  };

  const submit = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const files: PodFile[] = [];
      for (const [fieldKey, list] of Object.entries(blobs)) {
        for (const blob of list) files.push(await uploadFile(job.id, d.id, fieldKey, fieldKey && d.podForm.fields.find((f) => f.key === fieldKey)?.type === 'signature' ? await compressImage(blob) : blob));
      }
      const pos = await getPosition();
      await apiFetch('POST', '/api/v1/driver/pods', {
        clientPodId, doId: d.id, outcome: failed ? 'FAILED' : 'DELIVERED',
        reasonCode: failed ? reason : null, note: note || null,
        answers: failed ? {} : answers, files, ...pos, deviceTime: new Date().toISOString(),
        device: navigator.userAgent.slice(0, 100), appVersion: '0.1.0', offline: !navigator.onLine,
      });
      toast.success('ส่ง POD แล้ว');
      nav(`/jobs/${job.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POD_INVALID') setIssues(((e.details as { issues: Issue[] }).issues ?? []));
      toast.error(e instanceof Error ? e.message : 'ส่งไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const renderField = (f: PodField) => {
    switch (f.type) {
      case 'photo':
        return (
          <div className="space-y-2">
            <Input type="file" accept="image/*" capture="environment" multiple onChange={(e) => void addPhotos(f, e.target.files)} />
            <div className="flex flex-wrap gap-2">
              {(blobs[f.key] ?? []).map((b, i) => (
                <button key={i} type="button" onClick={() => setBlobs((x) => ({ ...x, [f.key]: (x[f.key] ?? []).filter((_, j) => j !== i) }))}>
                  <img src={URL.createObjectURL(b)} alt="" className="h-20 w-20 rounded object-cover" />
                </button>
              ))}
            </div>
          </div>
        );
      case 'signature':
        return <SignaturePad onChange={(b) => setBlobs((x) => ({ ...x, [f.key]: b ? [b] : [] }))} />;
      case 'text':
        return <Input value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
      case 'number':
        return <Input type="number" inputMode="decimal" value={(answers[f.key] as number | undefined) ?? ''} onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />;
      case 'select':
        return (
          <Select value={(answers[f.key] as string) ?? ''} onValueChange={(v) => set(f.key, v)}>
            <SelectTrigger>
              <SelectValue placeholder="เลือก" />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'checkbox':
        return <Checkbox checked={answers[f.key] === true} onCheckedChange={(v) => set(f.key, v === true)} />;
      case 'qtyLines': {
        const line = ((answers[f.key] as { planned: number; delivered: number; unit: string }[] | undefined) ?? [{ planned: d.qty, delivered: d.qty, unit: d.unit }])[0]!;
        return (
          <div className="flex items-center gap-2 text-sm">
            <span>ตามแผน {line.planned} {line.unit} · ส่งจริง</span>
            <Input type="number" className="w-28" value={line.delivered} onChange={(e) => set(f.key, [{ ...line, delivered: Number(e.target.value) }])} />
          </div>
        );
      }
      case 'palletLines': {
        const rows = (answers[f.key] as { type: string; qty: number }[] | undefined) ?? [];
        return (
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input placeholder="ประเภท" value={r.type} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} />
                <Input type="number" className="w-24" value={r.qty} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => set(f.key, [...rows, { type: '', qty: 0 }])}>
              + เพิ่มแถว
            </Button>
          </div>
        );
      }
    }
  };

  return (
    <div className="space-y-4 p-4">
      <button onClick={() => nav(`/jobs/${job.id}`)} className="text-blue-700">
        ← กลับ
      </button>
      <h1 className="text-lg font-semibold">
        {failed ? 'ส่งไม่สำเร็จ' : 'หลักฐานการส่ง (POD)'} · <span className="font-mono">{d.doNo}</span>
      </h1>
      {failed && (
        <div className="space-y-2">
          <Label>เหตุผล</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FAIL_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea placeholder="รายละเอียด (จำเป็นถ้าเลือก OTHER)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label>
            {f.label}
            {!failed && f.required && <span className="text-red-600"> *</span>}
            {f.unit && <span className="text-neutral-500"> ({f.unit})</span>}
          </Label>
          {renderField(f)}
        </div>
      ))}
      {issues.length > 0 && (
        <ul className="rounded bg-red-50 p-2 text-sm text-red-800">
          {issues.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      )}
      <Button className="h-14 w-full text-lg" disabled={busy} onClick={() => void submit()}>
        {busy ? 'กำลังส่ง…' : 'ส่ง POD'}
      </Button>
    </div>
  );
}
```
Simplify the signature branch in `submit` to: signature blobs are compressed when captured (call `compressImage` in the `SignaturePad` `onChange` handler before storing) so every stored blob is already a JPEG; then upload each blob as-is. Register `{ path: '/jobs/:id/pod/:doId', element: <RequireAuth><PodPage /></RequireAuth> }`.

- [ ] **Step 4: Verify** — `cd apps/driver && npm test && npm run build`; manual on a phone or desktop: at the drop stop after “ลงสินค้าเสร็จ”, open POD, take a photo, sign, enter receiver name, submit → returns to the job; the admin POD queue shows it with the photos.

- [ ] **Step 5: Commit**

```bash
git add -A apps
git commit -m "feat(ui/driver): POD form with compressed photos, signature, template fields and failed delivery" -m "<trailers>"
```

---

### Task 9: Driver app on the phone — installable PWA, wake lock, permission banners

**Files:**
- Modify: `apps/driver/index.html`, `apps/driver/vite.config.ts`, `apps/driver/src/index.css`, `apps/driver/src/pages/JobPage.tsx`, `apps/driver/src/pages/JobsPage.tsx`
- Create: `apps/driver/public/icon-192.png`, `apps/driver/public/icon-512.png`, `apps/driver/public/apple-touch-icon.png`, `apps/driver/src/lib/useWakeLock.ts`, `apps/driver/src/components/PermissionBanner.tsx`, `apps/driver/src/lib/permissions.ts`, `apps/driver/src/lib/permissions.test.ts`

**Interfaces:**
- Produces: installable PWA (manifest name “Mena Driver”, `display: standalone`, `start_url: /`, theme `#1d4ed8`, portrait); service worker caches the app shell only (never `/api/*`); `useWakeLock(active: boolean)` keeps the screen on while the job page is open (silently no-op where unsupported); `gpsState(): Promise<'granted' | 'prompt' | 'denied' | 'unsupported'>`; `<PermissionBanner />` shows a red sticky banner with Thai instructions when GPS is denied/unsupported and an amber one while offline (`navigator.onLine`).

- [ ] **Step 1: Write the failing test**

`apps/driver/src/lib/permissions.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gpsState } from './permissions';

describe('gpsState', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports unsupported when the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', {});
    expect(await gpsState()).toBe('unsupported');
  });

  it('reads the permission state when the Permissions API exists', async () => {
    vi.stubGlobal('navigator', { geolocation: {}, permissions: { query: vi.fn().mockResolvedValue({ state: 'denied' }) } });
    expect(await gpsState()).toBe('denied');
  });

  it('falls back to prompt when the Permissions API is missing (older iOS Safari)', async () => {
    vi.stubGlobal('navigator', { geolocation: {} });
    expect(await gpsState()).toBe('prompt');
  });
});
```
Run: `cd apps/driver && npm test` → FAIL.

- [ ] **Step 2: Implement helpers**

`apps/driver/src/lib/permissions.ts`:
```ts
export type GpsState = 'granted' | 'prompt' | 'denied' | 'unsupported';

export async function gpsState(): Promise<GpsState> {
  if (!('geolocation' in navigator)) return 'unsupported';
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return (status?.state as GpsState | undefined) ?? 'prompt';
  } catch {
    return 'prompt';
  }
}
```

`apps/driver/src/lib/useWakeLock.ts`:
```ts
import { useEffect } from 'react';

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* battery saver or unsupported: ignore */
      }
    };
    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
```

`apps/driver/src/components/PermissionBanner.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { gpsState, type GpsState } from '../lib/permissions';

export default function PermissionBanner() {
  const [gps, setGps] = useState<GpsState>('prompt');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    void gpsState().then(setGps);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const t = setInterval(() => void gpsState().then(setGps), 15_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(t);
    };
  }, []);
  return (
    <div className="sticky top-0 z-10">
      {(gps === 'denied' || gps === 'unsupported') && (
        <div className="bg-red-600 px-4 py-2 text-sm text-white">
          ปิดตำแหน่ง (GPS) อยู่ — เปิดที่ ตั้งค่า › เบราว์เซอร์ › ตำแหน่ง แล้วเปิดแอปใหม่ (ยังกดงานได้ แต่จะถูกบันทึกว่าไม่มี GPS)
        </div>
      )}
      {!online && <div className="bg-amber-500 px-4 py-2 text-sm text-white">ไม่มีสัญญาณอินเทอร์เน็ต — กดซ้ำได้เมื่อสัญญาณกลับมา</div>}
    </div>
  );
}
```
Run `npm test` → PASS.

- [ ] **Step 3: PWA manifest, icons and phone layout**

Run: `cd apps/driver && npm install -D vite-plugin-pwa@^1`.

In `apps/driver/vite.config.ts` add the plugin (keep the others):
```ts
import { VitePWA } from 'vite-plugin-pwa';
// plugins: [react(), tailwindcss(), basicSsl(), VitePWA({ ... })]
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['apple-touch-icon.png'],
  manifest: {
    name: 'Mena Driver',
    short_name: 'Mena Driver',
    lang: 'th',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5f5f5',
    theme_color: '#1d4ed8',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  workbox: { navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//], runtimeCaching: [] },
}),
```

Icons: generate the three PNGs once with Python Pillow (`python3 -m pip install --user pillow` if missing; the script is not committed):
```bash
cd apps/driver && python3 - <<'EOF'
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (512, 512), '#1d4ed8')
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 300)
except OSError:
    font = ImageFont.load_default()
d.text((256, 256), 'M', fill='white', font=font, anchor='mm')
img.save('public/icon-512.png')
img.resize((192, 192)).save('public/icon-192.png')
img.resize((180, 180)).save('public/apple-touch-icon.png')
EOF
```

`apps/driver/index.html` — set in `<head>`:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#1d4ed8" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Mena Driver" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<title>Mena Driver</title>
```
and `<html lang="th">`.

`apps/driver/src/index.css` — append:
```css
html { -webkit-tap-highlight-color: transparent; overscroll-behavior-y: contain; }
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); background: #f5f5f5; }
input, select, textarea { font-size: 16px; }
```

Wire it in: render `<PermissionBanner />` at the top of `JobsPage` and `JobPage`; call `useWakeLock(true)` in `JobPage` (and in `PodPage` so the screen stays on while the driver signs). In `JobPage`, move the current stop's big step button into a bottom bar that stays reachable with a thumb: wrap it in `<div className="sticky bottom-0 -mx-4 border-t bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">…</div>` (only the primary step button; POD/failed buttons stay in the stop card).

- [ ] **Step 4: Verify**

`cd apps/driver && npm test && npm run build` (build output must contain `manifest.webmanifest` and `sw.js`). Manual on a real phone on the same Wi-Fi: open `https://<computer-ip>:5174`, accept the certificate, “Add to Home Screen” (iOS Share › เพิ่มไปยังหน้าจอโฮม / Android menu › Install app), launch from the icon → opens full-screen; deny location → red banner; open a job → screen does not dim.

- [ ] **Step 5: Commit**

```bash
git add -A apps
git commit -m "feat(ui/driver): installable phone PWA with wake lock, permission and offline banners" -m "<trailers>"
```

---

### Task 10: Demo runner and walkthrough

**Files:**
- Create: `DEMO.md`
- Modify: root `package.json` (script `demo`), `README.md` (link to DEMO.md)

**Interfaces:**
- Produces: `npm run demo` (root) starts the API (`npm run dev`), the admin app and the driver app together with `concurrently`, colour-prefixed logs; `DEMO.md` with the exact walkthrough.

- [ ] **Step 1: Implement**

Run at repo root: `npm i -D concurrently@^9`. Add to root `package.json` scripts:
```json
"demo": "concurrently -n api,admin,driver -c blue,green,magenta \"npm run dev\" \"npm --prefix apps/admin run dev\" \"npm --prefix apps/driver run dev\""
```

`DEMO.md`:
````markdown
# Demo: plan → dispatch → drive → POD → verify → close

## One-time setup
1. MongoDB replica set: `docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0 && docker exec mongo mongosh --quiet --eval "rs.initiate()"`
2. `cp .env.example .env`, set `JWT_SECRET`, `API_KEY_PEPPER`, `DEMO_PASSWORD`.
   - Photos in memory (no Spaces): keep `STORAGE_DRIVER=memory` and set `PUBLIC_BASE_URL=https://<computer-ip>:5174` (the address the phone uses; uploads then go through the driver app's proxy). Memory photos disappear when the API restarts.
   - Photos in DigitalOcean Spaces: `STORAGE_DRIVER=s3` and the `SPACES_*` keys; add a CORS rule on the bucket allowing `PUT` and `GET` from `https://localhost:5174`, `http://localhost:5173` (and your phone URL).
3. `npm install && npm --prefix apps/admin install && npm --prefix apps/driver install`
4. `npm run seed -- --demo`

## Run
`npm run demo` → API http://localhost:3000 (docs /docs), admin http://localhost:5173 on the computer.

Driver on the phone (same Wi-Fi as the computer):
1. Find the computer's IP: `ipconfig getifaddr en0` (macOS).
2. On the phone open `https://<computer-ip>:5174`, accept the certificate warning (iOS: Show Details › visit this website; Android Chrome: Advanced › Proceed).
3. Add to the home screen (iOS Safari: Share › เพิ่มไปยังหน้าจอโฮม; Android Chrome: ⋮ › Install app) and open it from the icon.
4. Allow location and camera when asked.
If the phone cannot connect, allow incoming connections for Node in macOS Firewall settings.

## Walkthrough
1. Admin (`demo-planner`): ใบสั่งส่ง → tick two DOs → “สร้างเที่ยวจาก DO ที่เลือก” → choose `80-3001` and `DRV-001 สมชาย` → watch the rule panel → “บันทึกเป็นร่าง” → “วางแผน” → “ส่งงานให้คนขับ”.
2. Driver (`demo-driver1`): “รับงาน” → “เปิดงาน” → tap the steps at the plant → drive → tap “ถึงจุดแล้ว”, “เริ่มลงสินค้า”, “ลงสินค้าเสร็จ” → “POD …” → photo + name + signature → send. For the second DO try “ส่งไม่สำเร็จ” with a reason.
3. Admin (`demo-admin`): ตรวจ POD → open each → “ผ่าน” (or “ไม่ผ่าน” and let the driver resubmit) → งานขนส่ง → the shipment is “ส่งครบ รอปิด” → “ปิดงาน” → “เปิด PDF หลักฐาน”.
````
README: add a line under Setup: “Full demo with the admin panel and driver app: see DEMO.md”.

- [ ] **Step 2: Verify**

Run `npm run demo` with a seeded local database and walk through `DEMO.md` end to end (controller will also drive this with a browser automation check). Stop with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add -A package.json package-lock.json DEMO.md README.md
git commit -m "chore(demo): one-command demo runner and walkthrough" -m "<trailers>"
```

---

## Self-review notes (plan author)

- **Loop coverage:** DO create/select (Task 2) → build + validate + save (Task 3) → plan/dispatch (Task 4) → accept (Task 6) → steps with GPS (Task 7) → POD/failed (Task 8) → verify/reject (Task 5) → close + PDF (Task 4) → phone PWA (Task 9) → demo runner (Task 10). Backend support for the driver timeline (Task 0).
- **Trailers:** `<trailers>` in commit steps means the two trailer lines from Global Constraints of Plan 1.
