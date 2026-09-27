import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import JobPage from './pages/JobPage';
import JobsPage from './pages/JobsPage';
import LoginPage from './pages/LoginPage';
import PodPage from './pages/PodPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RequireAuth><JobsPage /></RequireAuth> },
  { path: '/jobs/:id', element: <RequireAuth><JobPage /></RequireAuth> },
  { path: '/jobs/:id/pod/:doId', element: <RequireAuth><PodPage /></RequireAuth> },
]);

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] bg-neutral-50">
      <RouterProvider router={router} />
    </div>
  );
}
