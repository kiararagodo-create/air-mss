import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// Guards every /dashboard, /devices, /reports, /settings route.
// Not signed in -> bounce to /login. Signed in -> render the nested route.
export default function ProtectedRoute() {
  const { role } = useAuth();

  if (!role) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
