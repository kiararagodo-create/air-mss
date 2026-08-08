import type { UserRole } from "../types";

export interface RolePermissions {
  /** Register a brand-new IoT device */
  canAddDevice: boolean;
  /** Remove a device from the registry */
  canRemoveDevice: boolean;
  /** Flip a device Online/Offline */
  canToggleDevice: boolean;
  /** Reports page in the sidebar */
  canAccessReports: boolean;
  /** Settings page in the sidebar */
  canAccessSettings: boolean;
}

// Admin: full control. Maintenance: can toggle devices but not add/remove,
// no reports/settings. Security: read-only monitoring, no reports/settings.
// Maintenance and security intentionally share identical permissions except
// for canToggleDevice, since their pages are meant to look/behave the same.
export const PERMISSIONS: Record<UserRole, RolePermissions> = {
  admin: {
    canAddDevice: true,
    canRemoveDevice: true,
    canToggleDevice: true,
    canAccessReports: true,
    canAccessSettings: true,
  },
  maintenance: {
    canAddDevice: false,
    canRemoveDevice: false,
    canToggleDevice: true,
    canAccessReports: false,
    canAccessSettings: false,
  },
  security: {
    canAddDevice: false,
    canRemoveDevice: false,
    canToggleDevice: false,
    canAccessReports: false,
    canAccessSettings: false,
  },
};

export function getPermissions(role: UserRole): RolePermissions {
  return PERMISSIONS[role];
}

/** Where to send a role after login, or after being denied an admin-only page. */
export const DEFAULT_ROUTE = "/devices";
