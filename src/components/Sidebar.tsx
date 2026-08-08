import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Wind, LayoutDashboard, Cpu, FileBarChart2, Settings, LogOut, Users, Menu, X } from "lucide-react";
import type { UserRole } from "../types";
import type { Profile } from "../context/AuthContext";
import { getPermissions } from "../lib/permissions";

interface SidebarProps {
  role: UserRole;
  profile: Profile | null;
  onSignOut: () => void;
}

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, requires: null as "reports" | "settings" | "admin" | null },
  { to: "/devices", label: "Devices", icon: Cpu, requires: null as "reports" | "settings" | "admin" | null },
  { to: "/reports", label: "Reports", icon: FileBarChart2, requires: "reports" as const },
  { to: "/personnel", label: "Personnel", icon: Users, requires: "admin" as const },
  { to: "/settings", label: "Settings", icon: Settings, requires: "settings" as const },
];

export default function Sidebar({ role, profile, onSignOut }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const permissions = getPermissions(role);
  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.requires === "reports") return permissions.canAccessReports;
    if (item.requires === "settings") return permissions.canAccessSettings;
    if (item.requires === "admin") return role === "admin";
    return true;
  });

  // Falls back to a generic label only while the profile is still loading,
  // rather than ever showing fabricated name/email data.
  const displayName = profile?.name ?? "Loading…";
  const displayEmail = profile?.email ?? "";
  const displayTag = profile?.role_label ?? "";
  const initial = profile?.name ? profile.name.charAt(0).toUpperCase() : "?";

  return (
    <>
      {/* Mobile top bar with hamburger toggle */}
      <div className="md:hidden fixed top-0 left-0 right-0 w-full z-30 flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-teal-600 flex items-center justify-center">
            <Wind className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-semibold text-slate-900 text-sm">A.I.R.</span>
        </div>
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Backdrop, mobile only, shown while drawer is open */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="md:hidden fixed inset-0 bg-slate-900/40 z-40"
        />
      )}

      <aside
        className={`
          w-60 shrink-0 h-screen border-r border-slate-200 bg-white flex flex-col
          fixed top-0 left-0 z-50 transition-transform duration-200 ease-out
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 md:sticky md:top-0
        `}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <Wind className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-slate-900">A.I.R.</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="md:hidden text-slate-400 hover:text-slate-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mx-4 mb-5 p-3 rounded-xl bg-slate-50 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-medium">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{displayName}</p>
            <p className="text-[11px] text-slate-400 truncate">{displayEmail}</p>
            {displayTag && (
              <span className="inline-block mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">
                {displayTag}
              </span>
            )}
          </div>
        </div>

        <p className="px-5 text-[11px] font-medium tracking-wide text-slate-400 mb-2">MAIN MENU</p>
        <nav className="flex-1 px-3 space-y-1">
          {visibleNavItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-teal-50 text-teal-700 font-medium"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-100">
          <button
            onClick={onSignOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}