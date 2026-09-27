import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DeliveryOrdersPage from './pages/DeliveryOrdersPage';
import ShipmentDetailPage from './pages/ShipmentDetailPage';
import ShipmentNewPage from './pages/ShipmentNewPage';
import ShipmentsPage from './pages/ShipmentsPage';

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
      { path: '/shipments', element: <ShipmentsPage /> },
      { path: '/shipments/new', element: <ShipmentNewPage /> },
      { path: '/shipments/:id', element: <ShipmentDetailPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
