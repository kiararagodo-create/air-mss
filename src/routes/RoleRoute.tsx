import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { DEFAULT_ROUTE } from "../lib/permissions";
import type { UserRole } from "../types";

interface RoleRouteProps {
  allow: UserRole[];
}

// Sits inside ProtectedRoute (so `role` is guaranteed non-null here).
// If the signed-in role isn't in the allow list - e.g. security hitting
// /settings - bounce them to their default page instead of showing a 404.
export default function RoleRoute({ allow }: RoleRouteProps) {
  const { role } = useAuth();

  if (!role || !allow.includes(role as UserRole)) {
    return <Navigate to={DEFAULT_ROUTE} replace />;
  }

  return <Outlet />;
}
