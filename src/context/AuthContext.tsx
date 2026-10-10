import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export type UserRole = "admin" | "staff" | "rider" | string;

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  role_label: string;
  department: string | null;
  contact_number: string | null;
  access_scope: string | null;
  is_active: boolean;
  account_status: "pending" | "approved" | "rejected" | "disabled";
  approved_at: string | null;
  approved_by: string | null;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: UserRole | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ error: string | null }>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  refreshProfile: () => Promise<Profile | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Admins are provisioned only through the bootstrap_admins allowlist or direct
// SQL, never through the approval queue, so they are exempt from it. An
// explicit deactivation by an admin always wins, including for an admin.
// Every other role must be 'approved' to get in.
function isLoginAllowed(row: Profile): boolean {
  if (!row.is_active) return false;
  if (row.role === "admin") return row.account_status !== "disabled";
  return row.account_status === "approved";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchProfile(userId: string): Promise<{ profile: Profile | null; isActive: boolean }> {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Failed to fetch user profile:", error.message);
      setProfile(null);
      return { profile: null, isActive: false };
    }

    const row = (data ?? null) as Profile | null;
    const allowed = row ? isLoginAllowed(row) : false;
    setProfile(allowed ? row : null);
    return { profile: row, isActive: allowed };
  }

  async function refreshProfile(): Promise<Profile | null> {
    const userId = session?.user?.id ?? profile?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) {
      console.error("Failed to refresh profile:", error.message);
      return null;
    }
    const row = (data ?? null) as Profile | null;
    setProfile(row && isLoginAllowed(row) ? row : null);
    return row;
  }

  useEffect(() => {
    // Load existing session on first mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        fetchProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // Keep session in sync on login/logout/token refresh
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        fetchProfile(session.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return { error: error.message };
    }

    if (data.user) {
      // Fetch the full profile so we can check account_status and is_active
      // separately, and give each blocked state its own message.
      const { data: profileRow, error: profileError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", data.user.id)
        .single();

      if (profileError) {
        console.error("Failed to load profile during login:", profileError.message);
        await supabase.auth.signOut();
        return { error: "We couldn't verify your account right now. Please try again in a moment." };
      }

      if (!profileRow) {
        // A profile row is created for every auth signup by the
        // on_auth_user_created trigger, so this only happens for accounts
        // that predate it. Say so plainly instead of implying a network fault.
        await supabase.auth.signOut();
        return { error: "No account profile was found for this login. Please contact your administrator." };
      }

      const row = profileRow as Profile;
      const status = row.account_status ?? "pending";
      const isAdmin = row.role === "admin";

      // Deactivation is checked first and applies to admins too: an admin who
      // has been deactivated by another admin must not slip in via the bypass.
      if (!row.is_active) {
        await supabase.auth.signOut();
        return { error: "Your account has been deactivated by an administrator. Contact your administrator." };
      }
      if (status === "disabled") {
        await supabase.auth.signOut();
        return { error: "Your account has been disabled by an administrator. Contact your administrator." };
      }

      // Admins bypass the approval queue; everyone else must be approved.
      if (!isAdmin) {
        if (status === "rejected") {
          await supabase.auth.signOut();
          return { error: "Your account request was rejected. Contact your administrator." };
        }
        if (status === "pending") {
          await supabase.auth.signOut();
          return { error: "Your account is still waiting for Admin approval." };
        }
        if (status !== "approved") {
          await supabase.auth.signOut();
          return { error: "Your account is not approved. Contact your administrator." };
        }
      }

      setProfile(row);
      return { error: null };
    }

    return { error: null };
  }

  async function logout() {
    await supabase.auth.signOut();
  }

  // Emails a recovery link that lands on /reset-password. The redirectTo is
  // built from the current origin so the same build works on Netlify preview
  // URLs and on localhost; the host must still be allow-listed under
  // Supabase -> Authentication -> URL Configuration, otherwise the link is
  // rejected.
  //
  // The caller is responsible for showing one uniform message regardless of
  // the outcome. Supabase returns success for unknown addresses to avoid
  // leaking which emails are registered, but a misconfigured redirect can
  // still surface an error worth showing.
  async function requestPasswordReset(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  }

  // Sets the new password on the recovery session that the emailed link
  // established, then signs out so the user logs back in fresh with their new
  // credentials.
  async function updatePassword(newPassword: string) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      return { error: error.message };
    }

    await supabase.auth.signOut();
    return { error: null };
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    loading,
    login,
    logout,
    requestPasswordReset,
    updatePassword,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
