import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getSupabaseTokenForEmail } from '@/lib/supabaseToken';

export const dynamic = 'force-dynamic';

// This route only ever runs on the Vercel origin itself (same-origin as the
// NextAuth cookie), right after Google sign-in. Its only job is to turn that
// cookie session into a one-shot deep link the native app can actually
// receive — the app's own origin (https://localhost inside Capacitor) can
// never read this cookie directly because it's cross-origin.
export async function GET() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();

  if (!email) {
    // No session yet (e.g. opened directly) — send through normal sign-in,
    // which will loop back here once Google auth completes.
    const signinUrl = new URL('/api/auth/signin/google', process.env.NEXTAUTH_URL);
    signinUrl.searchParams.set('callbackUrl', '/api/terminal/mobile-callback');
    return NextResponse.redirect(signinUrl);
  }

  try {
    const token = await getSupabaseTokenForEmail(email);
    const params = new URLSearchParams({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      email: token.email,
      handle: token.handle,
      name: token.display_name,
    });
    return NextResponse.redirect(`terminal://auth#${params.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign-in failed.';
    return NextResponse.redirect(`terminal://auth#error=${encodeURIComponent(message)}`);
  }
}
