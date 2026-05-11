import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  if (cached) return cached;
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

// Test-only: reset the singleton between tests.
export function _resetSupabaseSingleton(): void {
  cached = null;
}
