import { auth } from '@/lib/auth';
import { getSupabaseTokenForEmail } from '@/lib/supabaseToken';
import LoginButton from '@/components/LoginButton';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams?: { error?: string; callbackUrl?: string };
}) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  let tokenData = null;
  let tokenError = null;

  if (email) {
    try {
      tokenData = await getSupabaseTokenForEmail(email);
    } catch (err) {
      tokenError = err instanceof Error ? err.message : 'Could not initialize session.';
    }
  }

  const deepLink = tokenData
    ? `terminal://auth#access_token=${encodeURIComponent(tokenData.access_token)}&refresh_token=${encodeURIComponent(tokenData.refresh_token)}&email=${encodeURIComponent(tokenData.email)}&handle=${encodeURIComponent(tokenData.handle)}&name=${encodeURIComponent(tokenData.display_name)}`
    : 'terminal://auth';

  return (
    <main className="shell">
      <div className="logo">
        <span>&gt;_</span> Terminal
      </div>
      <h1>{session ? 'You’re signed in.' : 'Sign in to Terminal'}</h1>
      <p>
        {session
          ? `Signed in as ${session.user?.email}. Redirecting to Terminal app...`
          : 'Authenticate with Google. Your six-digit PIN is the second factor that actually unlocks the workspace.'}
      </p>
      {tokenError && (
        <div className="error">
          Workspace Error: {tokenError}
        </div>
      )}
      {searchParams?.error && (
        <div className="error">
          Google sign-in failed: {searchParams.error}. Check the authorized redirect URI and OAuth credentials.
        </div>
      )}
      {session ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', maxWidth: '320px', margin: '1rem auto 0' }}>
          <a
            className="google"
            href={deepLink}
            style={{ textAlign: 'center', justifyContent: 'center', textDecoration: 'none' }}
          >
            Open Terminal App
          </a>
          <script
            dangerouslySetInnerHTML={{
              __html: `setTimeout(function(){ window.location.href = "${deepLink}"; }, 300);`,
            }}
          />
        </div>
      ) : (
        <LoginButton callbackUrl="terminal://auth" />
      )}
      <div className="meta">
        <span>Private by intention</span>
        <span>terminalquad.vercel.app</span>
      </div>
    </main>
  );
}
