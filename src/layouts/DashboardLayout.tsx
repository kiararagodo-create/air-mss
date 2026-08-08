import { Outlet } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import { useAuth } from "../context/AuthContext";

// Shared shell for every authenticated page: sidebar on the left,
// routed page content on the right via <Outlet />.
export default function DashboardLayout() {
  const { role, logout, profile } = useAuth();

  if (!role) return null; // ProtectedRoute already guards this in practice

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar role={role as any} profile={profile} onSignOut={logout} />
      {/* pt-20 clears Sidebar's fixed mobile hamburger bar; md:pt-7 restores normal spacing on desktop */}
      <main className="flex-1 min-w-0 px-4 pt-20 pb-7 md:px-8 md:pt-7">
        <Outlet />
      </main>
    </div>
  );
}