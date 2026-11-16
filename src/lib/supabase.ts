import { createClient, type SupabaseClient } from "@supabase/supabase-js";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabaseLegacyAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Use publishable key first (new Supabase default), fall back to legacy anon key
const supabaseAnonKey = supabasePublishableKey || supabaseLegacyAnonKey;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase env vars. Check that VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) are set in your .env file."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function useSupabase(): {
  supabase: SupabaseClient;
  error: string | null;
} {
  return { supabase, error: null };
}