import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Server,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import LoginButton, { GoogleMark } from '../auth/LoginButton';
import { LockScreen } from '../security/LockScreen';
import { useLockManager } from '../security/useLockManager';
import type { Chat } from './useChat';

export function Brand() {
  return (
    <div className="term-brand">
      <span className="term-logo-box">
        <TerminalIcon size={16} strokeWidth={2.4} />
      </span>
      <span className="term-brand-text">Terminal</span>
    </div>
  );
}

export function Auth({ chat }: { chat: Chat }) {
  const lock = useLockManager();
  const [ticket, setTicket] = useState<string | null>(null);
  const [step, setStep] = useState<'signin' | 'pin' | 'setup'>('signin');
  const [identity, setIdentity] = useState<{ email: string; name: string; handle?: string } | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [handle, setHandle] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState(chat.server);

  const reset = () => {
    setTicket(null);
    setStep('signin');
    setIdentity(null);
    setPin('');
    setConfirmPin('');
    setHandle('');
    setInvite('');
    setError('');
  };

  // Capture one-time OAuth ticket from redirect query string
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returned = params.get('quad_oauth');
    if (!returned) return;
    params.delete('quad_oauth');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    setTicket(returned);
  }, []);

  // Exchange ticket with Python server once online
  useEffect(() => {
    if (!ticket || identity || resolving || !chat.online) return;
    setResolving(true);
    setError('');
    chat
      .exchangeTicket(ticket)
      .then(result => {
        setIdentity({ email: result.email, name: result.name, handle: result.handle });
        if (result.needed === 'setup') {
          setHandle(result.name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24));
          setStep('setup');
        } else {
          setStep('pin');
        }
      })
      .catch(err => {
        setTicket(null);
        setError(err instanceof Error ? err.message : 'Could not complete Google authentication.');
      })
      .finally(() => setResolving(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, identity, resolving, chat.online]);

  // Post-login High-Security LockScreen (supports both Standard PIN and Duress PIN!)
  if (step === 'pin' && ticket) {
    return (
      <LockScreen
        serverUrl={chat.server}
        accountLabel={identity?.handle ? `@${identity.handle}` : identity?.name}
        accountSubLabel={identity?.email}
        verifyWithServer={async enteredPin => {
          await chat.finishOAuth(ticket, enteredPin);
        }}
        onSignOut={reset}
      />
    );
  }

  async function submitSetup(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!chat.online) {
      setError('Start the Python server on localhost:8000 first.');
      return;
    }
    if (!ticket) {
      setError('Sign in with Google first.');
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError('Standard PIN must be 6 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PIN confirmation does not match.');
      return;
    }
    if (!handle.trim()) {
      setError('Enter a username (3–24 chars).');
      return;
    }
    if (!invite.trim()) {
      setError('Enter the server invite code.');
      return;
    }
    setBusy(true);
    try {
      await chat.finishOAuth(ticket, pin, handle, invite);
      await lock.recordInitialPinFromSetup(pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account setup failed.');
    } finally {
      setBusy(false);
    }
  }

  const nonLocalHttp = (() => {
    try {
      const u = new URL(chat.server);
      const lan = /^(localhost|127\.0\.0\.1|::1|\[::1\]|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(u.hostname);
    return u.protocol === 'http:' && !lan;
    } catch {
      return false;
    }
  })();

  return (
    <div className="term-auth-shell">
      <div className="term-auth-card">
        <header className="term-auth-head">
          <Brand />
          <span className={`term-server-pill ${chat.online ? 'online' : 'offline'}`}>
            <span className="term-dot" />
            {chat.checking ? 'Checking server' : chat.online ? 'Server online' : 'Server offline'}
          </span>
        </header>

        {step === 'signin' ? (
          <div className="term-auth-body">
            <h1>Sign in to Terminal</h1>
            <p className="term-auth-sub">
              Private self-hosted workspace. Authenticate with Google, then unlock with your PIN.
            </p>

            <LoginButton
              serverUrl={chat.server}
              disabled={!chat.online || chat.checking}
              onStart={() => setError('')}
            />

            {resolving && (
              <div className="term-auth-status">
                <RefreshCw size={14} className="spin" /> Verifying Google session…
              </div>
            )}

            {error && (
              <div className="term-alert-error" role="alert">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={submitSetup} className="term-auth-body term-form-grid">
            <div>
              <h1>Initialize Account</h1>
              <p className="term-auth-sub">Choose your handle and 6-digit unlock PIN for this server.</p>
            </div>

            <div className="term-identity-bar">
              <GoogleMark size={16} />
              <div>
                <strong>{identity?.name}</strong>
                <small>{identity?.email}</small>
              </div>
              <button type="button" className="term-link-btn" onClick={reset}>
                Switch
              </button>
            </div>

            <label>
              USERNAME
              <input
                value={handle}
                onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                autoComplete="username"
                maxLength={24}
                placeholder="e.g. operator"
                required
              />
            </label>

            <div className="term-two-col">
              <label>
                6-DIGIT PIN
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={pin}
                  onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="new-password"
                  placeholder="6 digits"
                  required
                />
              </label>
              <label>
                CONFIRM PIN
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={confirmPin}
                  onChange={e => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="new-password"
                  placeholder="6 digits"
                  required
                />
              </label>
            </div>

            <label>
              SERVER INVITE CODE
              <input
                type="password"
                value={invite}
                onChange={e => setInvite(e.target.value)}
                placeholder="Enter invite code from server/data/invite.txt"
                autoComplete="off"
                required
              />
            </label>

            {error && (
              <div className="term-alert-error" role="alert">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            )}

            <button className="term-btn-primary" type="submit" disabled={busy || !chat.online}>
              {busy ? (
                <>
                  <RefreshCw size={15} className="spin" /> Creating account…
                </>
              ) : (
                <>
                  Create Account <ArrowRight size={16} />
                </>
              )}
            </button>

            <button type="button" className="term-btn-ghost" onClick={reset}>
              <ArrowLeft size={14} /> Use another Google account
            </button>
          </form>
        )}

        <footer className="term-auth-foot">
          <div className="term-endpoint-summary">
            <div className="term-endpoint-meta">
              <Server size={14} />
              <span>{chat.server}</span>
            </div>
            <button
              type="button"
              className="term-link-btn"
              onClick={() => {
                setAddress(chat.server);
                setAddressOpen(!addressOpen);
              }}
            >
              {addressOpen ? <X size={14} /> : 'Endpoint'}
            </button>
          </div>

          {addressOpen && (
            <form
              className="term-endpoint-edit"
              onSubmit={e => {
                e.preventDefault();
                try {
                  chat.changeServer(address);
                  setAddressOpen(false);
                  reset();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Invalid server URL');
                }
              }}
            >
              <input
                id="server-address"
                aria-label="Server URL"
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="http://localhost:8000"
              />
              <button type="submit" className="term-btn-secondary">
                Apply
              </button>
            </form>
          )}

          {!chat.online && !chat.checking && (
            <div className="term-offline-banner">
              <span>
                Python server inactive. Run <code>python server/app.py</code>
              </span>
              <button type="button" className="term-link-btn" onClick={chat.recheck}>
                Retry
              </button>
            </div>
          )}

          {nonLocalHttp && (
            <p className="term-warn-text">Remote HTTP detected — use HTTPS outside localhost.</p>
          )}
        </footer>
      </div>

      {chat.notice && (
        <div className="toast" role="status">
          {chat.notice}
        </div>
      )}
    </div>
  );
}

export function OfflineScreen({ chat }: { chat: Chat }) {
  return (
    <div className="term-offline-overlay" role="dialog" aria-modal="true">
      <div className="term-offline-modal">
        <div className="term-offline-icon">
          <Server size={24} />
        </div>
        <h2>Python Server Offline</h2>
        <p>
          Terminal requires an active connection to <code>{chat.server}</code>. Workspace access is suspended until
          the Python process resumes.
        </p>
        <div className="term-offline-btns">
          <button type="button" className="term-btn-primary" onClick={chat.recheck}>
            <RefreshCw size={15} /> Reconnect
          </button>
          <button type="button" className="term-btn-ghost" onClick={chat.signOut}>
            <ArrowLeft size={14} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
