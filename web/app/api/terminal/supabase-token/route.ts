import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSession } from 'next-auth';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Exchanges the NextAuth (Google) session for a short-lived Supabase session.
 * The SUPABASE_SECRET_KEY is used here on the server only and is never sent
 * to the browser. The browser receives a normal Supabase JWT, so Row Level
 * Security keeps protecting every row.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment.' }, { status: 500 });
  }

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // 1. Confirm this address is allowed on the workspace.
    const { data: member } = await admin
      .from('terminal_members')
      .select('email, handle, display_name')
      .eq('email', email)
      .maybeSingle();

    if (!member) {
      const { data: invite } = await admin
        .from('terminal_invites')
        .select('email, handle, display_name, hue')
        .eq('email', email)
        .maybeSingle();
      if (!invite) {
        return NextResponse.json({ error: 'This account is not on the workspace allow-list.' }, { status: 403 });
      }
      await admin.from('terminal_members').upsert({
        email,
        handle: invite.handle || email.split('@')[0],
        display_name: invite.display_name || email.split('@')[0],
        hue: invite.hue || '#10b981',
      });
    }

    // 2. Make sure a Supabase auth user exists for this Google identity.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { handle: member?.handle, name: member?.display_name },
    });
    let userId = created?.user?.id;
    if (createError || !userId) {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users?.find(u => (u.email || '').toLowerCase() === email);
      userId = existing?.id;
    }
    if (!userId) {
      return NextResponse.json({ error: 'Could not provision a Supabase user.' }, { status: 500 });
    }

    // 3. Mint a Supabase session for that user (server-side, no password).
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError || !link.properties?.hashed_token) {
      return NextResponse.json({ error: 'Could not create a Supabase session.' }, { status: 502 });
    }
    const { data: supabaseSession, error: verifyError } = await admin.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: 'magiclink',
    });
    if (verifyError || !supabaseSession?.session) {
      return NextResponse.json({ error: 'Supabase session could not be verified.' }, { status: 502 });
    }

    return NextResponse.json({
      access_token: supabaseSession.session.access_token,
      refresh_token: supabaseSession.session.refresh_token,
      expires_at: supabaseSession.session.expires_at,
      email,
      handle: member?.handle ?? email.split('@')[0],
      display_name: member?.display_name ?? email.split('@')[0],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error.' },
      { status: 500 },
    );
  }
}
