import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { prepareMediaForUpload } from './mediaCompression';
import {
  BUILTIN_GENERAL_ROOM,
  defaultServer,
  GENERAL,
  normalizeRoomId,
  normalizeServer,
  type ChatRoom,
  type Member,
  type Message,
  type MessageStatus,
  type ReplyRef,
  type Session,
  type Signal,
  type SignalEvent,
  type UploadProgress,
} from './types';
import { buildDecoyWorkspace } from '../security/EmergencyService';
import { useSupabaseBridge } from '../supabase/useSupabaseBridge';
import { gatewayEnabled, gatewayUrl } from '../lib/auth';
import type { WireMessage } from '../supabase/transport';

export type LinkState = 'connecting' | 'live' | 'reconnecting' | 'offline';

function ensureGeneralFirst(incoming?: ChatRoom[]): ChatRoom[] {
  const custom = (incoming || []).filter(r => r && r.id && normalizeRoomId(r.id) !== GENERAL);
  return [BUILTIN_GENERAL_ROOM, ...custom];
}

function deriveMessageStatus(msg: Message, selfId?: string): MessageStatus {
  if (msg.failed || msg.status === 'failed') return 'failed';
  if (msg.pending || msg.status === 'sending') return 'sending';
  const readers = msg.readBy || [];
  const readByOther = selfId
    ? readers.some(uid => uid !== selfId && uid !== msg.author)
    : readers.length > 1;
  if (readByOther || msg.status === 'read') return 'read';
  return 'sent';
}

function hydrateMessage(msg: Message, selfId?: string): Message {
  const normalized: Message = {
    ...msg,
    room: normalizeRoomId(msg.room),
    readBy: Array.isArray(msg.readBy) ? msg.readBy : [msg.author],
  };
  normalized.status = deriveMessageStatus(normalized, selfId);
  return normalized;
}

export function useChat(isDuressMode = false) {
  const [server, setServer] = useState(defaultServer);
  const [online, setOnline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [probe, setProbe] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [rooms, setRooms] = useState<ChatRoom[]>([BUILTIN_GENERAL_ROOM]);
  const [members, setMembers] = useState<Member[]>([]);
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState<Record<string, string[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [room, setRoom] = useState(GENERAL);
  const [link, setLink] = useState<LinkState>('offline');
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [socketRetry, setSocketRetry] = useState(0);
  const [pythonToken, setPythonToken] = useState<string | null>(null);

  const socket = useRef<WebSocket | null>(null);
  const roomRef = useRef(room);
  const sessionRef = useRef(session);
  const signalCounter = useRef(0);
  const retryCounter = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);

  // Typing debounce state (max once per 2000ms)
  const lastTypingSentAt = useRef<number>(0);
  const isCurrentlyTyping = useRef<boolean>(false);
  const typingStopTimer = useRef<number | undefined>(undefined);
  const peerTypingExpiryTimers = useRef<Map<string, number>>(new Map());

  roomRef.current = room;
  sessionRef.current = session;

  const supa = useSupabaseBridge({
    serverUrl: server,
    authToken: session?.token,
    onMessage: (incoming: WireMessage) => {
      const selfEmail = supaRef.current?.identity?.email;
      const hydrated: Message = {
        id: incoming.id,
        room: normalizeRoomId(incoming.room),
        author: incoming.author,
        ts: incoming.ts,
        text: incoming.text,
        file: incoming.file,
        replyTo: incoming.replyTo,
        readBy: incoming.readBy || [incoming.author],
        clientId: incoming.clientId,
      };
      hydrated.status = deriveMessageStatus(hydrated, selfEmail);
      setMessages(previous => {
        const matchIdx = previous.findIndex(old => old.id === hydrated.id || (hydrated.clientId && old.clientId === hydrated.clientId));
        if (matchIdx >= 0) {
          const copy = [...previous];
          const existing = copy[matchIdx];
          const merged: Message = {
            ...hydrated,
            readBy: [...new Set([...(existing.readBy || []), ...(hydrated.readBy || [])])],
            reactions: hydrated.reactions || existing.reactions,
            clientId: existing.clientId || hydrated.clientId,
            pending: false,
            failed: false,
          };
          merged.status = deriveMessageStatus(merged, selfEmail);
          copy[matchIdx] = merged;
          return copy;
        }
        return [...previous, hydrated];
      });
      if (hydrated.author !== selfEmail && normalizeRoomId(hydrated.room) !== normalizeRoomId(roomRef.current)) {
        setUnread(u => ({ ...u, [normalizeRoomId(hydrated.room)]: (u[normalizeRoomId(hydrated.room)] || 0) + 1 }));
      }
    },
    onTyping: (targetRoom, author, on) => setPeerTypingState(normalizeRoomId(targetRoom), author, on),
    onPresence: online => setPresence(previous => {
      const merged = { ...previous };
      Object.keys(merged).forEach(key => {
        if (!(key in online)) merged[key] = false;
      });
      Object.entries(online).forEach(([key, value]) => {
        merged[key] = value;
      });
      return merged;
    }),
    onDirectory: list => setMembers(list),
    onRooms: list => setRooms(ensureGeneralFirst(list)),
    onRead: (targetRoom, reader, ids) => {
      const set = new Set(ids);
      setMessages(prev =>
        prev.map(m => {
          if (normalizeRoomId(m.room) !== normalizeRoomId(targetRoom)) return m;
          if (set.size > 0 && !set.has(m.id)) return m;
          const readers = m.readBy || [m.author];
          if (readers.includes(reader)) return m;
          const updated: Message = { ...m, readBy: [...readers, reader] };
          updated.status = deriveMessageStatus(updated, supaRef.current?.identity?.email);
          return updated;
        }),
      );
    },
  });
  const supaRef = useRef(supa);
  supaRef.current = supa;

  const toast = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setNotice(''), 4500);
  }, []);

  // Health polling: Terminal activates only while the Python server answers /api/health
  useEffect(() => {
    let live = true;
    async function ping() {
      try {
        const ok = await api.checkHealth(server);
        if (live) setOnline(ok);
      } catch {
        if (live) setOnline(false);
      } finally {
        if (live) setChecking(false);
      }
    }
    setChecking(true);
    void ping();
    const interval = window.setInterval(ping, 5000);
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [server, probe]);

  const changeServer = useCallback((value: string) => {
    const clean = normalizeServer(value);
    setOnline(false);
    setChecking(true);
    setSession(null);
    setRooms([BUILTIN_GENERAL_ROOM]);
    setMembers([]);
    setMessages([]);
    setServer(clean);
    setProbe(n => n + 1);
    try {
      localStorage.setItem('terminal.server.v3', clean);
    } catch {
      /* non-secret preference */
    }
  }, []);

  // When Duress Mode activates, immediately sever real socket, clear any prior toasts, and load Decoy Workspace.
  useEffect(() => {
    if (!isDuressMode) return;
    window.clearTimeout(toastTimer.current);
    setNotice('');
    socket.current?.close();
    socket.current = null;
    const decoy = buildDecoyWorkspace(sessionRef.current?.member);
    if (!sessionRef.current) {
      setSession({ token: 'decoy-local-token', member: decoy.selfMember });
    }
    setRooms(ensureGeneralFirst(decoy.rooms));
    setMembers(decoy.members);
    setPresence(decoy.presence);
    setMessages(decoy.messages);
    setRoom(GENERAL);
    setUnread({});
    setTyping({});
    setLink('live');
  }, [isDuressMode]);

  const setPeerTypingState = useCallback((roomId: string, memberId: string, on: boolean) => {
    const key = `${roomId}:${memberId}`;
    const existingTimer = peerTypingExpiryTimers.current.get(key);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      peerTypingExpiryTimers.current.delete(key);
    }
    if (on) {
      const expireId = window.setTimeout(() => {
        setTyping(prev => ({
          ...prev,
          [roomId]: (prev[roomId] || []).filter(id => id !== memberId),
        }));
        peerTypingExpiryTimers.current.delete(key);
      }, 6000);
      peerTypingExpiryTimers.current.set(key, expireId);
    }
    setTyping(prev => {
      const list = prev[roomId] || [];
      const next = on ? [...new Set([...list, memberId])] : list.filter(id => id !== memberId);
      return { ...prev, [roomId]: next };
    });
  }, []);

  const markRoomAsRead = useCallback(
    (targetRoom: string) => {
      if (isDuressMode) return;
      const current = sessionRef.current;
      if (!current) return;
      const canonical = normalizeRoomId(targetRoom);
      if (supa.active) {
        void supa.markRead(canonical, supa.identity?.email || '').catch(() => {});
        return;
      }
      if (socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify({ t: 'messages_read', room: canonical }));
      } else if (online) {
        void api.markRoomRead(server, current.token, canonical).catch(() => {});
      }
    },
    [isDuressMode, online, server, supa],
  );

  // Realtime WebSocket transport (disabled in Duress Mode to prevent real network traffic)
  useEffect(() => {
    if (isDuressMode) return;
    if (!pythonToken || !online) {
      setLink('offline');
      return;
    }
    let cancelled = false;
    let reconnect: number | undefined;
    setLink(retryCounter.current ? 'reconnecting' : 'connecting');

    const wsUrl = new URL(server);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = `${wsUrl.pathname.replace(/\/$/, '')}/ws`;
    const ws = new WebSocket(wsUrl.toString());
    socket.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: pythonToken }));
    ws.onmessage = event => {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const selfId = sessionRef.current?.member.id;
      switch (payload.t) {
        case 'ready': {
          retryCounter.current = 0;
          setLink('live');
          setRooms(ensureGeneralFirst(payload.rooms));
          setMembers(payload.members || []);
          setPresence(payload.presence || {});
          if (!supa.active) {
            const hydrated = ((payload.messages || []) as Message[]).map(m =>
              hydrateMessage(m, payload.you?.id || selfId),
            );
            setMessages(hydrated);
          }
          setSession(s => (s ? { ...s, member: payload.you } : null));
          // Mark currently open room messages as read upon ready
          window.setTimeout(() => markRoomAsRead(roomRef.current), 120);
          break;
        }
        case 'rooms':
          setRooms(ensureGeneralFirst(payload.rooms));
          break;
        case 'roster':
          setMembers(payload.members || []);
          setPresence(payload.presence || {});
          setSession(s => {
            const updated = (payload.members || []).find((m: Member) => m.id === s?.member.id);
            return s && updated ? { ...s, member: updated } : s;
          });
          break;
        case 'presence':
          setPresence(payload.presence || {});
          break;
        case 'message': {
          const incoming = hydrateMessage(payload.message as Message, selfId);
          setMessages(previous => {
            // Match optimistic message by clientId or server id without changing array order/keys
            const matchIdx = previous.findIndex(
              old =>
                old.id === incoming.id ||
                (Boolean(incoming.clientId) && old.clientId === incoming.clientId),
            );
            if (matchIdx >= 0) {
              const copy = [...previous];
              const existing = copy[matchIdx];
              const mergedReadBy = [...new Set([...(existing.readBy || []), ...(incoming.readBy || [])])];
              const merged: Message = {
                ...incoming,
                readBy: mergedReadBy,
                reactions: incoming.reactions || existing.reactions,
                clientId: existing.clientId || incoming.clientId,
                pending: false,
                failed: false,
              };
              merged.status = deriveMessageStatus(merged, selfId);
              copy[matchIdx] = merged;
              return copy;
            }
            return [...previous, incoming];
          });
          if (incoming.author !== selfId) {
            setPeerTypingState(incoming.room, incoming.author, false);
            if (incoming.room !== roomRef.current) {
              setUnread(u => ({ ...u, [incoming.room]: (u[incoming.room] || 0) + 1 }));
            } else if (typeof document === 'undefined' || document.visibilityState === 'visible') {
              markRoomAsRead(incoming.room);
            }
          }
          break;
        }
        case 'typing_start':
          setPeerTypingState(normalizeRoomId(payload.room), payload.member, true);
          break;
        case 'typing_stop':
          setPeerTypingState(normalizeRoomId(payload.room), payload.member, false);
          break;
        case 'typing':
          setPeerTypingState(normalizeRoomId(payload.room), payload.member, Boolean(payload.on));
          break;
        case 'messages_read': {
          const targetRoom = normalizeRoomId(payload.room);
          const readerId = String(payload.reader || '');
          const ids = new Set<string>(payload.messageIds || []);
          setMessages(prev =>
            prev.map(m => {
              if (m.room !== targetRoom) return m;
              if (ids.size > 0 && !ids.has(m.id)) return m;
              const readers = m.readBy || [m.author];
              if (readers.includes(readerId)) return m;
              const updated: Message = { ...m, readBy: [...readers, readerId] };
              updated.status = deriveMessageStatus(updated, selfId);
              return updated;
            }),
          );
          break;
        }
        case 'reaction':
          setMessages(previous =>
            previous.map(message =>
              message.id === payload.id ? { ...message, reactions: payload.reactions } : message,
            ),
          );
          break;
        case 'signal':
          setSignals(previous => [
            ...previous.slice(-99),
            { id: ++signalCounter.current, from: payload.from, data: payload.data },
          ]);
          break;
        case 'error':
          toast(payload.text || 'Operation failed.');
          break;
      }
    };
    ws.onclose = event => {
      if (cancelled) return;
      if (event.code === 4401) {
        setSession(null);
        setMembers([]);
        setMessages([]);
        setRooms([BUILTIN_GENERAL_ROOM]);
        toast('Session expired. Sign in again.');
        return;
      }
      setLink('reconnecting');
      retryCounter.current += 1;
      reconnect = window.setTimeout(
        () => setSocketRetry(n => n + 1),
        Math.min(1000 * 2 ** Math.min(retryCounter.current, 4), 15000),
      );
    };
    return () => {
      cancelled = true;
      window.clearTimeout(reconnect);
      if (socket.current === ws) socket.current = null;
      ws.close();
    };
  }, [isDuressMode, markRoomAsRead, online, pythonToken, server, setPeerTypingState, socketRetry, toast]);

  const beginGoogle = useCallback(() => {
    if (gatewayEnabled) {
      window.location.assign(
        `${gatewayUrl}/api/auth/signin/google?callbackUrl=${encodeURIComponent(window.location.origin)}`,
      );
      return;
    }
    if (!online) throw new Error('The Python server on localhost:8000 is offline.');
    window.location.assign(
      `${server}/api/oauth/google/start?origin=${encodeURIComponent(window.location.origin)}`,
    );
  }, [server, online]);

  const exchangeTicket = useCallback(
    async (ticket: string) => {
      try {
        return await api.oauthExchange(server, ticket);
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : 'Could not reach the server to verify Google sign-in.',
        );
      }
    },
    [server],
  );

  const finishOAuth = useCallback(
    async (ticket: string, pin: string, handle?: string, invite?: string) => {
      if (!online) throw new Error('The Python server is offline.');
      const result = await api.oauthFinish(server, ticket, pin, handle, invite);
      setRoom(GENERAL);
      setRooms([BUILTIN_GENERAL_ROOM]);
      setUnread({});
      retryCounter.current = 0;
      setPythonToken(result.token);
      setSession({ token: result.token, member: result.member });
      return result;
    },
    [server, online],
  );

  const signOut = useCallback(() => {
    const current = sessionRef.current;
    if (current && !isDuressMode && current.token !== 'decoy-local-token') {
      api.logout(server, current.token).catch(() => {});
    }
    socket.current?.close();
    setPythonToken(null);
    setSession(null);
    setRooms([BUILTIN_GENERAL_ROOM]);
    setMembers([]);
    setMessages([]);
    setPresence({});
    setTyping({});
    setUnread({});
    setSignals([]);
    retryCounter.current = 0;
  }, [isDuressMode, server]);

  /** Adopt a session minted by the Vercel/NextAuth gateway (Supabase only). */
  const adoptExternalSession = useCallback((next: Session) => {
    setPythonToken(null);
    setSession(next);
    setRoom(GENERAL);
    setRooms([BUILTIN_GENERAL_ROOM]);
    setUnread({});
    retryCounter.current = 0;
  }, []);

  const openRoom = useCallback(
    (next: string) => {
      const canonical = normalizeRoomId(next);
      setRoom(canonical);
      roomRef.current = canonical;
      setUnread(u => ({ ...u, [canonical]: 0 }));
      markRoomAsRead(canonical);
    },
    [markRoomAsRead],
  );

  // When Supabase owns the message store, pull history for the active room.
  useEffect(() => {
    if (!supa.active) return;
    let cancelled = false;
    const canonical = normalizeRoomId(roomRef.current);
    supa.loadHistory(canonical)
      .then(rows => {
        if (cancelled) return;
        const mapped: Message[] = (rows as unknown as WireMessage[]).map(row => {
          const hydrated: Message = {
            id: row.id,
            room: normalizeRoomId(row.room),
            author: row.author,
            ts: row.ts,
            text: row.text,
            file: row.file,
            replyTo: row.replyTo,
            readBy: row.readBy || [row.author],
            clientId: row.clientId,
          };
          hydrated.status = deriveMessageStatus(hydrated, supaRef.current?.identity?.email);
          return hydrated;
        });
        setMessages(previous => [...previous.filter(m => normalizeRoomId(m.room) !== canonical), ...mapped]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [supa.active, room, supa]);

  // Broadcast typing_start debounced max once per 2s, and typing_stop on pause/clear
  const sendTyping = useCallback(
    (hasText: boolean) => {
      if (isDuressMode) return;
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      window.clearTimeout(typingStopTimer.current);

      if (!hasText) {
        if (isCurrentlyTyping.current) {
          isCurrentlyTyping.current = false;
          lastTypingSentAt.current = 0;
          ws.send(JSON.stringify({ t: 'typing_stop', room: roomRef.current, on: false }));
          if (supa.active) void supa.sendTyping(roomRef.current, supa.identity?.email || '', false).catch(() => {});
        }
        return;
      }

      const now = Date.now();
      if (!isCurrentlyTyping.current || now - lastTypingSentAt.current >= 2000) {
        isCurrentlyTyping.current = true;
        lastTypingSentAt.current = now;
        ws.send(JSON.stringify({ t: 'typing_start', room: roomRef.current, on: true }));
        if (supa.active) void supa.sendTyping(roomRef.current, supa.identity?.email || '', true).catch(() => {});
      }

      typingStopTimer.current = window.setTimeout(() => {
        if (isCurrentlyTyping.current && socket.current?.readyState === WebSocket.OPEN) {
          isCurrentlyTyping.current = false;
          socket.current.send(JSON.stringify({ t: 'typing_stop', room: roomRef.current, on: false }));
        }
      }, 2500);
    },
    [isDuressMode, supa],
  );

  const transmitOptimistic = useCallback(
    async (clientId: string, targetRoom: string, trimmed: string, replyTo?: ReplyRef) => {
      const current = sessionRef.current;
      if (!current) return;

      if (isDuressMode) {
        // Covert decoy behavior: looks 100% real locally without touching the network
        window.setTimeout(() => {
          setMessages(prev =>
            prev.map(m =>
              m.clientId === clientId
                ? { ...m, id: `decoy_${clientId.slice(0, 8)}`, status: 'sent', pending: false, failed: false }
                : m,
            ),
          );
        }, 140);
        window.setTimeout(() => {
          setMessages(prev =>
            prev.map(m => (m.clientId === clientId ? { ...m, status: 'read' } : m)),
          );
        }, 1600);
        return;
      }

      try {
        const res = await api.postMessage(server, current.token, {
          room: targetRoom,
          text: trimmed,
          clientId,
          replyTo,
        });
        const confirmed = hydrateMessage(res.message, current.member.id);
        setMessages(prev =>
          prev.map(m => {
            if (m.clientId !== clientId && m.id !== confirmed.id) return m;
            const mergedReadBy = [...new Set([...(m.readBy || []), ...(confirmed.readBy || [])])];
            const merged: Message = {
              ...confirmed,
              readBy: mergedReadBy,
              reactions: confirmed.reactions || m.reactions,
              clientId,
              pending: false,
              failed: false,
            };
            merged.status = deriveMessageStatus(merged, current.member.id);
            return merged;
          }),
        );
      } catch {
        setMessages(prev =>
          prev.map(m =>
            m.clientId === clientId
              ? { ...m, status: 'failed', pending: false, failed: true }
              : m,
          ),
        );
      }
    },
    [isDuressMode, server],
  );

  /**
   * Optimistic UI send:
   * 1. Creates temporary local ID & clientId immediately with `status: 'sending'`.
   * 2. Awaits server insert (`POST /api/messages`).
   * 3. Updates real ID & `status: 'sent'` on resolve, or `status: 'failed'` on reject.
   */
  const send = useCallback(
    (text: string, replyTo?: ReplyRef) => {
      const trimmed = text.trim();
      const current = sessionRef.current;
      if (!trimmed || !current) return false;

      const clientId = crypto.randomUUID();
      const targetRoom = normalizeRoomId(roomRef.current);
      const optimistic: Message = {
        id: `temp_${clientId}`,
        clientId,
        room: targetRoom,
        author: current.member.id,
        ts: Date.now(),
        text: trimmed,
        replyTo,
        readBy: [current.member.id],
        status: 'sending',
        pending: true,
        failed: false,
      };

      setMessages(prev => [...prev, optimistic]);

      if (supa.active) {
        supa.sendMessage({ room: targetRoom, body: trimmed, clientId, replyTo: replyTo || null })
          .then(confirmed => {
            setMessages(prev =>
              prev.map(m => {
                if (m.clientId !== clientId && m.id !== confirmed.id) return m;
                const merged: Message = {
                  ...m,
                  id: confirmed.id,
                  ts: confirmed.ts,
                  pending: false,
                  failed: false,
                  status: 'sent',
                };
                return merged;
              }),
            );
          })
          .catch(() => {
            setMessages(prev => prev.map(m => (m.clientId === clientId ? { ...m, status: 'failed', pending: false, failed: true } : m)));
          });
        return true;
      }

      void transmitOptimistic(clientId, targetRoom, trimmed, replyTo);
      return true;
    },
    [supa, transmitOptimistic],
  );

  const retryMessage = useCallback(
    (clientIdOrId: string) => {
      const target = messages.find(m => m.clientId === clientIdOrId || m.id === clientIdOrId);
      if (!target) return;
      const cid = target.clientId || crypto.randomUUID();
      setMessages(prev =>
        prev.map(m =>
          m === target || m.clientId === cid
            ? { ...m, clientId: cid, status: 'sending', pending: true, failed: false }
            : m,
        ),
      );
      void transmitOptimistic(cid, target.room, target.text, target.replyTo);
    },
    [messages, transmitOptimistic],
  );

  const dismissFailedMessage = useCallback((clientIdOrId: string) => {
    setMessages(prev => prev.filter(m => m.clientId !== clientIdOrId && m.id !== clientIdOrId));
  }, []);

  const createChannel = useCallback(
    async (name: string, topic = '') => {
      if (isDuressMode) {
        const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'room';
        const decoyRoom: ChatRoom = { id: slug, name: name.trim(), topic, system: false };
        setRooms(prev => ensureGeneralFirst([...prev, decoyRoom]));
        openRoom(slug);
        return decoyRoom;
      }
      if (!session) throw new Error('Sign in first.');
      const res = await api.createRoom(server, session.token, name, topic);
      setRooms(ensureGeneralFirst(res.rooms));
      openRoom(res.room.id);
      return res.room;
    },
    [isDuressMode, openRoom, server, session],
  );

  const react = useCallback(
    (id: string, reaction: 'like' | 'ack' | 'fire' = 'like') => {
      if (isDuressMode) {
        const myId = sessionRef.current?.member.id || 'u_self_local';
        setMessages(prev =>
          prev.map(m => {
            if (m.id !== id) return m;
            const cur = m.reactions?.[reaction] || [];
            const next = cur.includes(myId) ? cur.filter(x => x !== myId) : [...cur, myId];
            return { ...m, reactions: { ...(m.reactions || {}), [reaction]: next } };
          }),
        );
        return;
      }
      if (socket.current?.readyState === WebSocket.OPEN && link === 'live') {
        socket.current.send(JSON.stringify({ t: 'react', id, reaction }));
      }
    },
    [isDuressMode, link],
  );

  const sendSignal = useCallback(
    (to: string, data: Signal) => {
      if (isDuressMode) return;
      if (socket.current?.readyState !== WebSocket.OPEN || link !== 'live') {
        throw new Error('The chat connection is not ready.');
      }
      socket.current.send(JSON.stringify({ t: 'signal', to, data }));
    },
    [isDuressMode, link],
  );

  const upload = useCallback(
    async (rawFile: File, targetRoom = roomRef.current) => {
      if (isDuressMode) {
        toast('Attachment queued in local workspace.');
        return;
      }
      if (!session || !online || link !== 'live') {
        throw new Error('Reconnect to the server before sending media.');
      }
      const canonicalRoom = normalizeRoomId(targetRoom);
      try {
        const prepared = await prepareMediaForUpload(rawFile, setUploadProgress);
        if (prepared.warning) {
          toast(prepared.warning);
        }
        const result = await api.uploadWithProgress(
          server,
          session.token,
          canonicalRoom,
          prepared.file,
          setUploadProgress,
        );
        const hydrated = hydrateMessage(result.message, session.member.id);
        setMessages(previous =>
          previous.some(m => m.id === hydrated.id) ? previous : [...previous, hydrated],
        );
        if (prepared.summary) {
          toast(`Sent optimized media: ${prepared.summary}`);
        }
      } finally {
        window.setTimeout(() => setUploadProgress(null), 450);
      }
    },
    [isDuressMode, link, online, server, session, toast],
  );

  const saveProfile = useCallback(
    async (name: string, handle: string) => {
      if (!session) throw new Error('Unlock Terminal first.');
      if (isDuressMode) {
        setSession(s => (s ? { ...s, member: { ...s.member, name, handle } } : null));
        toast('Profile updated.');
        return;
      }
      const result = await api.updateProfile(server, session.token, { name, handle });
      setSession(s => (s ? { ...s, member: result.member } : null));
      toast('Profile updated.');
    },
    [isDuressMode, server, session, toast],
  );

  return {
    server,
    online,
    checking,
    recheck: () => setProbe(n => n + 1),
    changeServer,
    session,
    rooms,
    members,
    presence,
    messages,
    typing,
    unread,
    room,
    link,
    signals,
    notice,
    uploadProgress,
    supabase: { active: supa.active, identity: supa.identity, error: supa.error },
    toast,
    beginGoogle,
    exchangeTicket,
    finishOAuth,
    signOut,
    lock: signOut,
    adoptExternalSession,
    openRoom,
    createChannel,
    send,
    retryMessage,
    dismissFailedMessage,
    react,
    sendTyping,
    sendSignal,
    upload,
    saveProfile,
    markRoomAsRead,
  };
}

export type Chat = ReturnType<typeof useChat>;
