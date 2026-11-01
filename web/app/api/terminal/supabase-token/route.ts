import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getSupabaseTokenForEmail } from '@/lib/supabaseToken';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  try {
    const token = await getSupabaseTokenForEmail(email);
    return NextResponse.json(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error.';
    const status = message.includes('allow-list') ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
