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
