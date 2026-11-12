import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { RoomsProvider, useRooms } from "./context/RoomsContext";
import { NotificationsProvider } from "./context/NotificationContext";
import { AlarmProvider } from "./context/AlarmContext";
import ProtectedRoute from "./routes/ProtectedRoute";
import RoleRoute from "./routes/RoleRoute";
import DashboardLayout from "./layouts/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import DashboardPage from "./pages/DashboardPage";
import DevicesPage from "./pages/DevicesPage";
import ReportsPage from "./pages/admin/ReportsPage";
import SettingsPage from "./pages/admin/SettingsPage";
import PersonnelManagementPage from "./pages/admin/PersonnelManagementPage";
import ResetPasswordPage from "./pages/Resetpasswordpage";
import NotificationsPage from "./pages/NotificationsPage";
import ActionPage from "./pages/ActionPage";

// Thin wrappers so the page components keep receiving props (unchanged),
// while the real values come from RoomsContext/AuthContext instead of the
// old {} as any / [] as any placeholders.
function DashboardRoute() {
  const { rooms, selectedId, setSelectedId } = useRooms();
  return <DashboardPage rooms={rooms} selectedId={selectedId} setSelectedId={setSelectedId} />;
}

function DevicesRoute() {
  const { rooms, removeRoom, addRoom, thresholds, toggleSiren, muteAll } = useRooms();
  const { user: authUser, role } = useAuth();
  const user = { id: authUser?.id ?? "", role: role ?? "", email: authUser?.email };
  return (
    <DevicesPage
      rooms={rooms}
      removeRoom={removeRoom}
      addRoom={addRoom}
      user={user}
      thresholds={thresholds}
      toggleSiren={toggleSiren}
      muteAll={muteAll}
    />
  );
}

function ReportsRoute() {
  const { rooms, thresholds } = useRooms();
  return <ReportsPage rooms={rooms} thresholds={thresholds} />;
}

// Personnel display info per role - matches what the Settings page's
// "Logged-in Personnel Details" panel expects (name/roleLabel/department/accessScope).
const ROLE_INFO: Record<string, { name: string; roleLabel: string; department: string; accessScope: string }> = {
  admin: {
    name: "Admin",
    roleLabel: "PPF Office Personnel",
    department: "Physical Plant & Facilities Office",
    accessScope: "Admin Level",
  },
  maintenance: {
    name: "Maintenance",
    roleLabel: "Maintenance Personnel",
    department: "Physical Plant & Facilities Office",
    accessScope: "Toggle & View",
  },
  security: {
    name: "Security",
    roleLabel: "Security Personnel",
    department: "Campus Security Office",
    accessScope: "Monitoring Only",
  },
};

function SettingsRoute() {
  const { thresholds, setThresholds, setSettings } = useRooms();
  const { user: authUser, role } = useAuth();
  const info = ROLE_INFO[role ?? ""] ?? {
    name: role ?? "User",
    roleLabel: role ?? "",
    department: "",
    accessScope: "",
  };
  const user = {
    role: role ?? "",
    name: info.name,
    email: authUser?.email ?? "",
    roleLabel: info.roleLabel,
    department: info.department,
    accessScope: info.accessScope,
  };
  return (
    <SettingsPage
      setSettings={setSettings}
      thresholds={thresholds}
      setThresholds={setThresholds}
      user={user}
    />
  );
}

// Route map:
//   /login          -> public, sign-in screen (also handles "forgot password"
//                      inline via its mode state)
//   /register       -> public, self-service registration
//   /reset-password -> public, sets a new password from the emailed recovery
//                      link. Must stay OUTSIDE ProtectedRoute: the recovery
//                      session's profile may not be loaded/approved yet, so
//                      gating on `role` would bounce a legitimate user away.
//   /dashboard      -> protected, every role, content differs by role
//   /devices        -> protected, every role, content + permissions differ by role
//   /reports        -> protected, ADMIN ONLY (RoleRoute redirects others to /dashboard)
//   /settings       -> protected, ADMIN ONLY (RoleRoute redirects others to /dashboard)
//   /personnel      -> protected, ADMIN ONLY (RoleRoute redirects others to /dashboard)
//   anything else (including "/") -> redirect to /dashboard (which itself
//                    redirects to /login if not signed in)
export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          {/* RoomsProvider must be OUTER: NotificationsProvider derives its
              live bell alerts from the live rooms + thresholds. */}
          <RoomsProvider>
            <NotificationsProvider>
              <AlarmProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                {/* Public SMS action link: token identifies the personnel, no login. */}
                <Route path="/action/:token" element={<ActionPage />} />

                <Route element={<ProtectedRoute />}>
                  <Route element={<DashboardLayout />}>
                    <Route path="/dashboard" element={<DashboardRoute />} />
                    <Route path="/devices" element={<DevicesRoute />} />
                    {/* Sensor alerts: every role, row-level scoped by RLS. */}
                    <Route path="/notifications" element={<NotificationsPage />} />

                    <Route element={<RoleRoute allow={["admin"]} />}>
                      <Route path="/reports" element={<ReportsRoute />} />
                      <Route path="/settings" element={<SettingsRoute />} />
                      <Route path="/personnel" element={<PersonnelManagementPage />} />
                    </Route>
                  </Route>
                </Route>

                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
              </AlarmProvider>
            </NotificationsProvider>
          </RoomsProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}