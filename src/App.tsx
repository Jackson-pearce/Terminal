import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useSession } from './auth/SessionProvider';
import { Auth, OfflineScreen } from './chat/Auth';
import { ChatView } from './chat/ChatView';
import { loadTheme } from './chat/Settings';
import { useChat } from './chat/useChat';
import { LockScreen, PinSetup } from './security/LockScreen';
import { useLockManager } from './security/useLockManager';
import { consumeBackPress } from './lib/backButton';
import { applySupabaseSession } from './supabase/client';
import { gatewayEnabled } from './lib/auth';

export default function App() {
  const lock = useLockManager();
  const isDuress = lock.appStatus === 'UNLOCKED_DURESS';
  const chat = useChat(isDuress);
  const { setSessionData, registerSignOutHandler } = useSession();
  const [theme, setTheme] = useState(loadTheme);

  // Configure native dark status bar
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    import('@capacitor/status-bar')
      .then(({ StatusBar, Style }) => {
        StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
        StatusBar.setBackgroundColor({ color: '#0a0d10' }).catch(() => {});
      })
      .catch(() => {});
  }, []);

  // Hardware back button (Android): let the active screen/modal claim it
  // first (see useBackHandler calls in ChatView etc.). If nothing claims
  // it we're at the root of the app, so send it to the background like a
  // normal Android app instead of killing the webview.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removeListener: (() => void) | undefined;
    let cancelled = false;
    import('@capacitor/app').then(async ({ App: CapacitorApp }) => {
      const sub = await CapacitorApp.addListener('backButton', () => {
        if (consumeBackPress()) return;
        CapacitorApp.minimizeApp().catch(() => {});
      });
      if (cancelled) {
        sub.remove();
        return;
      }
      removeListener = () => sub.remove();
    });
    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, []);

  // Deep link listener for mobile OAuth return (e.g. terminal://auth#access_token=...)
  useEffect(() => {
    const handleUrl = (rawUrl: string) => {
      try {
        const hashOrQuery = rawUrl.includes('#')
          ? rawUrl.split('#')[1]
          : rawUrl.includes('?')
          ? rawUrl.split('?')[1]
          : '';
        if (!hashOrQuery) return;
        const params = new URLSearchParams(hashOrQuery);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token') || '';
        const email = params.get('email');
        const handle = params.get('handle') || email?.split('@')[0] || '';
        const name = params.get('name') || handle;
        if (accessToken && email) {
          void applySupabaseSession(accessToken, refreshToken).then(() => {
            setSessionData({
              token: accessToken,
              user: { id: email, email, handle, name },
            });
          });
        }
      } catch {
        /* invalid url */
      }
    };

    handleUrl(window.location.href);

    if (!Capacitor.isNativePlatform()) return;
    let removeSub: (() => void) | undefined;
    import('@capacitor/app').then(async ({ App: CapacitorApp }) => {
      const sub = await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        handleUrl(url);
      });
      removeSub = () => sub.remove();
    });
    return () => {
      removeSub?.();
    };
  }, [setSessionData]);

  // Synchronize SessionProvider with active chat session
  useEffect(() => {
    registerSignOutHandler(() => {
      chat.signOut();
      lock.lockApp();
    });
  }, [chat, lock, registerSignOutHandler]);

  // A Vercel/NextAuth session unlocks the workspace without the Python login.
  const gate = useSession();
  useEffect(() => {
    const gateUser = gate.data?.user;
    if (!gateUser || chat.session) return;
    chat.adoptExternalSession({
      token: gate.data!.token,
      member: {
        id: gateUser.id,
        name: gateUser.name,
        handle: gateUser.handle,
        hue: gateUser.hue || '#10b981',
        initials: (gateUser.name || gateUser.handle || '?')
          .split(/\s+/)
          .slice(0, 2)
          .map(part => part[0] || '')
          .join('')
          .toUpperCase(),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.data?.user?.id]);

  useEffect(() => {
    if (chat.session) {
      setSessionData({
        token: chat.session.token,
        user: {
          id: chat.session.member.id,
          name: chat.session.member.name,
          handle: chat.session.member.handle,
          hue: chat.session.member.hue,
          initials: chat.session.member.initials,
        },
      });
    } else {
      setSessionData(null);
    }
  }, [chat.session, setSessionData]);

  // Auto-engage LockScreen after 15 minutes of inactivity while unlocked
  useEffect(() => {
    if (lock.appStatus === 'LOCKED' || !chat.session) return;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lock.lockApp();
        chat.toast('Workspace locked due to inactivity.');
      }, 15 * 60 * 1000);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'quad-call-activity'];
    events.forEach(name => window.addEventListener(name, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach(name => window.removeEventListener(name, reset));
    };
  }, [chat, lock]);

  // 1. Duress Mode: render identical-looking workspace backed purely by Decoy data
  if (isDuress && chat.session) {
    return <ChatView chat={chat} theme={theme} setTheme={setTheme} />;
  }

  // 2. Unauthenticated: Google OAuth login (which transitions into LockScreen for PIN unlock)
  if (!chat.session) {
    return <Auth chat={chat} />;
  }

  // 3a. First run on this device: create the unlock PIN.
  if (lock.appStatus === 'LOCKED' && !lock.hasStandardPin) {
    return (
      <PinSetup
        accountLabel={chat.session?.member.name}
        onDone={() => undefined}
        onCancel={() => {
          chat.signOut();
          lock.lockApp();
        }}
      />
    );
  }

  // 3b. Authenticated but LOCKED: High-Security PIN / Duress Keypad LockScreen
  if (lock.appStatus === 'LOCKED') {
    return (
      <LockScreen
        serverUrl={chat.server}
        authToken={chat.session.token}
        accountLabel={chat.session.member.name}
        accountSubLabel={`@${chat.session.member.handle}`}
        onSignOut={() => {
          chat.signOut();
          lock.lockApp();
        }}
      />
    );
  }

  // 4. Normal Unlocked Workspace (gated on active Python server only when not using Vercel)
  return (
    <>
      <ChatView chat={chat} theme={theme} setTheme={setTheme} />
      {!gatewayEnabled && !chat.online && <OfflineScreen chat={chat} />}
    </>
  );
}
