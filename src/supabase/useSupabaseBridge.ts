import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applySupabaseSession, getSupabase, supabaseEnabled, supabaseErrorText } from './client';
import type { ChatRoom, Member } from '../chat/types';
import { createSupabaseBridge, type SupabaseBridge, type WireMessage } from './transport';

export interface SupabaseIdentity {
  email: string;
  handle: string;
  displayName: string;
}

interface Options {
  serverUrl: string;
  authToken?: string;
  onMessage: (message: WireMessage) => void;
  onTyping: (room: string, author: string, on: boolean) => void;
  onRead: (room: string, reader: string, ids: string[]) => void;
  onPresence?: (online: Record<string, boolean>) => void;
  onDirectory?: (members: Member[]) => void;
  onRooms?: (rooms: ChatRoom[]) => void;
  onError?: (text: string) => void;
}

const gateway = (import.meta.env.VITE_TERMINAL_API as string | undefined)?.trim() || '';

/**
 * Acquires a Supabase session for the signed-in member and keeps a realtime
 * bridge alive. The secret key never reaches the browser: the token is minted
 * by Vercel (NextAuth) or by the Python server.
 */
export function useSupabaseBridge(options: Options) {
  const [active, setActive] = useState(false);
  const [identity, setIdentity] = useState<SupabaseIdentity | null>(null);
  const [error, setError] = useState('');
  const bridgeRef = useRef<SupabaseBridge | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!supabaseEnabled) {
      setActive(false);
      return;
    }
    let cancelled = false;

    async function connect() {
      try {
        let token: string | null = null;
        let refresh = '';
        let meta: Partial<SupabaseIdentity> = {};

        if (gateway) {
          // Vercel / NextAuth gateway — uses the NextAuth session cookie.
          const response = await fetch(`${gateway.replace(/\/+$/, '')}/api/terminal/supabase-token`, {
            credentials: 'include',
          });
          if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.error || 'Could not obtain a workspace session.');
          }
          const data = await response.json();
          token = data.access_token;
          refresh = data.refresh_token || '';
          meta = { email: data.email, handle: data.handle, displayName: data.display_name };
        } else if (optionsRef.current.authToken) {
          // Local Python deployment mints the same session server-side.
          const response = await fetch(`${optionsRef.current.serverUrl.replace(/\/+$/, '')}/api/supabase/token`, {
            headers: { Authorization: `Bearer ${optionsRef.current.authToken}` },
          });
          if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.error || 'Could not obtain a workspace session.');
          }
          const data = await response.json();
          token = data.access_token;
          refresh = data.refresh_token || '';
          meta = { email: data.email, handle: data.handle, displayName: data.display_name };
        }

        if (!token || cancelled) return;
        await applySupabaseSession(token, refresh);
        const client = getSupabase();
        if (!client) return;

        const bridge = createSupabaseBridge({
          accessToken: token,
          onMessage: message => optionsRef.current.onMessage(message),
          onTyping: (room, author, on) => optionsRef.current.onTyping(room, author, on),
          onRead: (room, reader, ids) => optionsRef.current.onRead(room, reader, ids),
          onPresence: online => optionsRef.current.onPresence?.(online),
          onError: text => optionsRef.current.onError?.(text),
        });
        bridgeRef.current = bridge;
        setIdentity({
          email: meta.email || '',
          handle: meta.handle || '',
          displayName: meta.displayName || '',
        });
        setActive(true);
        setError('');

        // Realtime presence + the workspace directory.
        if (meta.email) void bridge.trackPresence?.(meta.email);
        void bridge.listMembers?.().then(list => {
          if (cancelled || !list?.length) return;
          optionsRef.current.onDirectory?.(
            list.map(row => ({
              id: row.email,
              name: row.display_name || row.email.split('@')[0],
              handle: row.handle || row.email.split('@')[0],
              hue: row.hue || '#10b981',
              initials: (row.display_name || row.email)
                .split(/\s+/)
                .slice(0, 2)
                .map(part => part[0] || '')
                .join('')
                .toUpperCase(),
            })),
          );
        }).catch(() => {});
        void bridge.listRooms?.().then(list => {
          if (cancelled || !list?.length) return;
          optionsRef.current.onRooms?.(
            list.map(row => ({ id: row.id, name: row.name, topic: row.topic, system: row.is_system })),
          );
        }).catch(() => {});
      } catch (err) {
        if (cancelled) return;
        setActive(false);
        setError(supabaseErrorText(err));
        optionsRef.current.onError?.(err instanceof Error ? err.message : 'Supabase connection failed.');
      }
    }

    void connect();
    return () => {
      cancelled = true;
      bridgeRef.current?.destroy?.();
      bridgeRef.current = null;
    };
  }, [optionsRef.current.serverUrl, optionsRef.current.authToken]);

  const loadHistory = useCallback(async (room: string, limit = 120): Promise<WireMessage[]> => {
    const client = getSupabase();
    if (!client) return [];
    const { data, error } = await client
      .from('terminal_messages')
      .select('*')
      .eq('room', room)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(supabaseErrorText(error));
    return (data || []).reverse() as unknown as WireMessage[];
  }, []);

  const sendMessage = useCallback(async (input: {
    room: string;
    body: string;
    clientId: string;
    replyTo?: { id: string; authorName: string; preview: string } | null;
  }) => {
    const bridge = bridgeRef.current;
    if (!bridge?.send) throw new Error('Supabase is not connected yet.');
    return bridge.send(input);
  }, []);

  const sendTyping = useCallback(async (room: string, author: string, on: boolean) => {
    await bridgeRef.current?.sendTyping?.(room, author, on);
  }, []);

  const markRead = useCallback(async (room: string, reader: string) => {
    const ids = await bridgeRef.current?.markRead?.(room, reader);
    return ids || [];
  }, []);

  const uploadMedia = useCallback(async (file: File, room: string) => {
    const bridge = bridgeRef.current;
    if (!bridge?.upload) throw new Error('Supabase is not connected yet.');
    return bridge.upload(file, room);
  }, []);

  // Stable identity: the chat state depends on this object, so it must not
  // change on every render (that would reconnect the realtime socket).
  return useMemo(
    () => ({ active, identity, error, loadHistory, sendMessage, sendTyping, markRead, uploadMedia }),
    [active, identity, error, loadHistory, sendMessage, sendTyping, markRead, uploadMedia],
  );
}
