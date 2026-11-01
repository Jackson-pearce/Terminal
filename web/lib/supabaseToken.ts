import { createClient } from '@supabase/supabase-js';

export interface MintedTokenResult {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  email: string;
  handle: string;
  display_name: string;
}

export async function getSupabaseTokenForEmail(email: string): Promise<MintedTokenResult> {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error('Supabase is not configured on this deployment.');
  }

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
      throw new Error('This account is not on the workspace allow-list.');
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
    throw new Error('Could not provision a Supabase user.');
  }

  // 3. Mint a Supabase session for that user (server-side, no password).
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !link.properties?.hashed_token) {
    throw new Error('Could not create a Supabase session.');
  }
  const { data: supabaseSession, error: verifyError } = await admin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError || !supabaseSession?.session) {
    throw new Error('Supabase session could not be verified.');
  }

  return {
    access_token: supabaseSession.session.access_token,
    refresh_token: supabaseSession.session.refresh_token,
    expires_at: supabaseSession.session.expires_at,
    email,
    handle: member?.handle ?? email.split('@')[0],
    display_name: member?.display_name ?? email.split('@')[0],
  };
}
