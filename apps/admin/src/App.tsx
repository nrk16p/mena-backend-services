import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DeliveryOrdersPage from './pages/DeliveryOrdersPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <Navigate to="/shipments" replace /> },
      { path: '/delivery-orders', element: <DeliveryOrdersPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
