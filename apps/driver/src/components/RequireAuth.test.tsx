import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureApi } from '@shared/api';
import RequireAuth from './RequireAuth';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>login-page</div>} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <div>jobs-page</div>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    localStorage.clear();
    configureApi('driver', () => {});
  });
  afterEach(() => cleanup());

  it('redirects to /login when there is no driver session', () => {
    renderAt('/');
    expect(screen.getByText('login-page')).toBeTruthy();
    expect(screen.queryByText('jobs-page')).toBeNull();
  });

  it('redirects to /login when the session has no driver role', () => {
    localStorage.setItem(
      'mena.session.driver',
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'u', username: 'p', roles: ['planner'], driverId: null } }),
    );
    renderAt('/');
    expect(screen.getByText('login-page')).toBeTruthy();
  });

  it('renders the protected content for a valid driver session', () => {
    localStorage.setItem(
      'mena.session.driver',
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'u', username: 'demo-driver1', roles: ['driver'], driverId: 'd1' } }),
    );
    renderAt('/');
    expect(screen.getByText('jobs-page')).toBeTruthy();
  });
});
