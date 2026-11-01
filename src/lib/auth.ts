import { defaultServer } from '../chat/types';

export interface AuthSessionUser {
  id: string;
  name: string;
  handle: string;
  email?: string;
  hue?: string;
  initials?: string;
}

export interface AuthSessionData {
  user: AuthSessionUser;
  token: string;
}

export interface SignInOptions {
  callbackUrl?: string;
  serverUrl?: string;
}

/** Vercel deployment that hosts NextAuth. Empty when running fully local. */
export const gatewayUrl = ((import.meta.env.VITE_TERMINAL_API as string | undefined) || '').trim().replace(/\/+$/, '');

export const gatewayEnabled = Boolean(gatewayUrl);

/**
 * Starts the sign-in flow. With a Vercel gateway configured the browser goes
 * to the NextAuth sign-in page there; otherwise it uses the Python server's
 * Google OAuth route. The client secret stays server-side either way.
 */
export function signIn(provider: 'google' = 'google', options?: SignInOptions): void {
  if (provider !== 'google') {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  const callback = options?.callbackUrl || window.location.origin;
  if (gatewayEnabled) {
    window.location.assign(
      `${gatewayUrl}/api/auth/signin/google?callbackUrl=${encodeURIComponent(callback)}`,
    );
    return;
  }
  const server = (options?.serverUrl || defaultServer()).replace(/\/+$/, '');
  const origin = new URL(callback, window.location.origin).toString().replace(/\/+$/, '');
  window.location.assign(`${server}/api/oauth/google/start?origin=${encodeURIComponent(origin)}`);
}

export interface GatewaySession {
  accessToken: string;
  refreshToken: string;
  email: string;
  handle: string;
  displayName: string;
}

/** Reads the NextAuth session on Vercel and exchanges it for a Supabase session. */
export async function bootstrapGatewaySession(): Promise<GatewaySession | null> {
  if (!gatewayEnabled) return null;
  try {
    const sessionRes = await fetch(`${gatewayUrl}/api/auth/session`, { credentials: 'include' });
    if (!sessionRes.ok) return null;
    const session = await sessionRes.json();
    if (!session?.user?.email) return null;
    const tokenRes = await fetch(`${gatewayUrl}/api/terminal/supabase-token`, { credentials: 'include' });
    if (!tokenRes.ok) return null;
    const token = await tokenRes.json();
    if (!token?.access_token) return null;
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      email: token.email || session.user.email,
      handle: token.handle || session.user.email.split('@')[0],
      displayName: token.display_name || session.user.name || session.user.email,
    };
  } catch {
    return null;
  }
}
