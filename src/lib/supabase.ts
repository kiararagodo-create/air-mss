import { createClient, type SupabaseClient } from "@supabase/supabase-js";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase env vars. Check that VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in your .env file."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function useSupabase(): {
  supabase: SupabaseClient;
  error: string | null;
} {
  return { supabase, error: null };
}