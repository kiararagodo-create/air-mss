import { Navigate, Outlet } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";

// Guards every /dashboard, /devices, /reports, /settings route.
// Not signed in -> bounce to /login. Signed in -> render the nested route.
// Ensures loading never sticks: falls back to /login after 15s.
export default function ProtectedRoute() {
  const { role, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => navigate("/login", { replace: true }), 15000);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Wait for the auth session + profile to finish loading before
  // deciding whether to redirect. Without this guard, `role` is null
  // during the initial async fetch, so every page load would bounce
  // the user back to /login even when they're already signed in.
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontSize: 14, color: "#64748b" }}>
        Loading...
      </div>
    );
  }

  if (!role) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
