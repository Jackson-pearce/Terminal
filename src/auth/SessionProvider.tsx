import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  bootstrapGatewaySession,
  gatewayEnabled,
  signIn as startOAuthSignIn,
  type AuthSessionData,
  type SignInOptions,
} from '../lib/auth';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionContextValue {
  data: AuthSessionData | null;
  status: SessionStatus;
  setSessionData: (session: AuthSessionData | null) => void;
  setLoading: (loading: boolean) => void;
  signIn: (provider?: 'google', options?: SignInOptions) => void;
  signOut: () => void;
  registerSignOutHandler: (fn: () => void) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AuthSessionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [signOutHandler, setSignOutHandler] = useState<(() => void) | null>(null);

  // When a Vercel/NextAuth gateway is configured, adopt its session silently.
  useEffect(() => {
    if (!gatewayEnabled) return;
    let cancelled = false;
    void bootstrapGatewaySession().then(gateway => {
      if (cancelled || !gateway) return;
      setData({
        token: gateway.accessToken,
        user: {
          id: gateway.email,
          name: gateway.displayName,
          handle: gateway.handle,
          email: gateway.email,
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback((provider: 'google' = 'google', options?: SignInOptions) => {
    startOAuthSignIn(provider, options);
  }, []);

  const signOut = useCallback(() => {
    if (signOutHandler) signOutHandler();
    setData(null);
  }, [signOutHandler]);

  const registerSignOutHandler = useCallback((fn: () => void) => {
    setSignOutHandler(() => fn);
  }, []);

  const status: SessionStatus = loading ? 'loading' : data ? 'authenticated' : 'unauthenticated';

  const value = useMemo<SessionContextValue>(
    () => ({
      data,
      status,
      setSessionData: setData,
      setLoading,
      signIn,
      signOut,
      registerSignOutHandler,
    }),
    [data, registerSignOutHandler, signIn, signOut, status],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return ctx;
}
