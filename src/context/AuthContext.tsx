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
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: UserRole | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ error: string | null }>;
  logout: () => Promise<void>;
  sendPasswordResetCode: (email: string) => Promise<{ error: string | null }>;
  verifyPasswordResetCode: (email: string, code: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

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

    const row = data as Profile | null;
    const isActive = row?.is_active ?? false;
    setProfile(isActive ? row : null);
    return { profile: row, isActive };
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
      const { isActive } = await fetchProfile(data.user.id);
      if (!isActive) {
        await supabase.auth.signOut();
        return { error: "This account has been deactivated. Contact your administrator." };
      }
    }

    return { error: null };
  }

  async function logout() {
    await supabase.auth.signOut();
  }

  // Sends a 6-digit recovery code to the user's email. Requires the
  // Supabase "Reset Password" email template to include {{ .Token }}
  // (see project setup notes) so the message shows a code, not a link.
  async function sendPasswordResetCode(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email);

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  }

  // Verifies the code the user typed in. On success Supabase establishes
  // a short-lived "recovery" session, which is what allows updatePassword
  // to work immediately after, all without leaving this page.
  async function verifyPasswordResetCode(email: string, code: string) {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "recovery",
    });

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  }

  // Sets the new password on the recovery session created by
  // verifyPasswordResetCode, then signs out so the user logs back in
  // fresh with their new credentials.
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
    sendPasswordResetCode,
    verifyPasswordResetCode,
    updatePassword,
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