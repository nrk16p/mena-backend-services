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
