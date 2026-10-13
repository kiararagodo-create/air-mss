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

/**
 * Least privilege. Applied to any role string that is not one of the three
 * roles above.
 *
 * profiles.role is a free-text column, so a value like a legacy "staff" or a
 * typo reaches this function. Returning undefined instead made Sidebar.tsx
 * throw on `permissions.canAccessReports`, which white-screened the entire app
 * for that user with no error boundary. Failing closed - read-only, no reports,
 * no settings - is both correct and survivable.
 */
const UNKNOWN_ROLE_PERMISSIONS: RolePermissions = {
  canAddDevice: false,
  canRemoveDevice: false,
  canToggleDevice: false,
  canAccessReports: false,
  canAccessSettings: false,
};

export function getPermissions(role: UserRole): RolePermissions {
  return PERMISSIONS[role] ?? UNKNOWN_ROLE_PERMISSIONS;
}

/** Where to send a role after login, or after being denied an admin-only page. */
export const DEFAULT_ROUTE = "/devices";
