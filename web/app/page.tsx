import { getServerSession } from 'next-auth';
import { auth } from '@/lib/auth';
import LoginButton from '@/components/LoginButton';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams?: { error?: string; callbackUrl?: string };
}) {
  const session = await auth();
  const appUrl = process.env.TERMINAL_APP_URL || 'http://localhost:8000';

  return (
    <main className="shell">
      <div className="logo">
        <span>&gt;_</span> Terminal
      </div>
      <h1>{session ? 'You’re signed in.' : 'Sign in to Terminal'}</h1>
      <p>
        {session
          ? `Signed in as ${session.user?.email}. Continue to your private workspace.`
          : 'Authenticate with Google. Your six-digit PIN is the second factor that actually unlocks the workspace.'}
      </p>
      {searchParams?.error && (
        <div className="error">
          Google sign-in failed: {searchParams.error}. Check the authorized redirect URI and OAuth credentials.
        </div>
      )}
      {session ? (
        <a className="google" href={appUrl}>
          Open Terminal
        </a>
      ) : (
        <LoginButton callbackUrl={`${appUrl}/api/auth/callback`} />
      )}
      <div className="meta">
        <span>Private by intention</span>
        <span>localhost:8000 · Vercel auth</span>
      </div>
    </main>
  );
}
