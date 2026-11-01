import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Terminal talks to Supabase with the PUBLISHABLE key only.
 * The secret key (sb_secret_…) lives exclusively in server environment
 * variables and must never be bundled into the frontend.
 */
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const publishable = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() || '';

export const supabaseUrl = url;
export const supabaseEnabled = Boolean(url && publishable);

let instance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseEnabled) return null;
  if (!instance) {
    instance = createClient(url, publishable, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'terminal' } },
    });
  }
  return instance;
}

/** Minted server-side (Vercel or the Python server) and applied to the client. */
export async function applySupabaseSession(accessToken: string, refreshToken?: string) {
  const client = getSupabase();
  if (!client) return false;
  const { error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken ?? '',
  });
  return !error;
}

export function supabaseErrorText(error: unknown) {
  if (!error) return 'Supabase request failed.';
  if (typeof error === 'string') return error;
  const message = (error as { message?: string })?.message;
  return message || 'Supabase request failed.';
}
