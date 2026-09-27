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
