import { getSupabase, supabaseErrorText } from './client';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface WireMessage {
  id: string;
  room: string;
  author: string;
  authorName: string;
  ts: number;
  text: string;
  file?: { id: string; name: string; mime: string; size: number };
  replyTo?: { id: string; authorName: string; preview: string };
  readBy: string[];
  clientId?: string;
}

export interface SupabaseBridgeOptions {
  accessToken: string;
  onMessage: (message: WireMessage) => void;
  onTyping: (room: string, author: string, on: boolean) => void;
  onRead: (room: string, reader: string, ids: string[]) => void;
  onPresence?: (online: Record<string, boolean>) => void;
  onError?: (text: string) => void;
}

function mapRow(row: Record<string, any>): WireMessage {
  const file = row.file_path
    ? {
        id: row.file_path,
        name: row.file_name || 'attachment',
        mime: row.file_mime || 'application/octet-stream',
        size: Number(row.file_size || 0),
      }
    : undefined;
  return {
    id: String(row.id),
    room: String(row.room),
    author: String(row.author),
    authorName: String(row.author_name || row.author),
    ts: new Date(row.created_at).getTime(),
    text: String(row.body || ''),
    file,
    replyTo: row.reply_to
      ? { id: String(row.reply_to), authorName: 'Member', preview: '' }
      : undefined,
    readBy: Array.isArray(row.read_by) ? row.read_by : [],
    clientId: row.client_id || undefined,
  };
}

/**
 * Supabase-backed realtime transport.
 *  - postgres_changes  → incoming messages (realtime)
 *  - broadcast 'typing' → typing indicators
 *  - broadcast 'read'   → read receipts
 *  - storage           → compressed media
 */
export function createSupabaseBridge(options: SupabaseBridgeOptions) {
  const client = getSupabase();
  if (!client) {
    return { connected: false, send: null, sendTyping: null, upload: null };
  }

  const scoped = client;
  const channel: RealtimeChannel = scoped.channel('terminal', {
    config: { broadcast: { self: false, ack: false } },
  });

  channel
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'terminal_messages' },
      payload => {
        try {
          options.onMessage(mapRow(payload.new as Record<string, any>));
        } catch (err) {
          options.onError?.(supabaseErrorText(err));
        }
      },
    )
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      const data = payload as { room?: string; author?: string; on?: boolean };
      if (data.room && data.author) options.onTyping(data.room, data.author, Boolean(data.on));
    })
    .on('broadcast', { event: 'read' }, ({ payload }) => {
      const data = payload as { room?: string; reader?: string; ids?: string[] };
      if (data.room && data.reader) options.onRead(data.room, data.reader, data.ids || []);
    })
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState() as Record<string, Array<{ email?: string }>>;
      const online: Record<string, boolean> = {};
      Object.values(state).forEach(entries => {
        entries.forEach(entry => {
          if (entry?.email) online[entry.email] = true;
        });
      });
      options.onPresence?.(online);
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') options.onError?.('');
    });

  async function send(input: {
    room: string;
    body: string;
    clientId: string;
    replyTo?: { id: string; authorName: string; preview: string } | null;
    authorName?: string;
    file?: { path: string; name: string; mime: string; size: number } | null;
  }) {
    const { data, error } = await scoped
      .from('terminal_messages')
      .insert({
        room: input.room,
        body: input.body,
        author: (await scoped.auth.getUser()).data.user?.email ?? '',
        client_id: input.clientId,
        reply_to: input.replyTo?.id ?? null,
        file_path: input.file?.path ?? null,
        file_name: input.file?.name ?? null,
        file_mime: input.file?.mime ?? null,
        file_size: input.file?.size ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(supabaseErrorText(error));
    return mapRow(data as unknown as Record<string, any>);
  }

  async function trackPresence(email: string) {
    await channel.track({ email, at: Date.now() });
  }

  async function listMembers() {
    const { data, error } = await scoped
      .from('terminal_members')
      .select('email, handle, display_name, hue')
      .order('display_name', { ascending: true });
    if (error) throw new Error(supabaseErrorText(error));
    return (data || []) as Array<{ email: string; handle: string; display_name: string; hue: string }>;
  }

  async function listRooms() {
    const { data, error } = await scoped
      .from('terminal_rooms')
      .select('id, name, topic, is_system')
      .order('is_system', { ascending: false });
    if (error) throw new Error(supabaseErrorText(error));
    return (data || []) as Array<{ id: string; name: string; topic: string; is_system: boolean }>;
  }

  async function sendTyping(room: string, author: string, on: boolean) {
    await channel.send({ type: 'broadcast', event: 'typing', payload: { room, author, on } });
  }

  async function markRead(room: string, reader: string) {
    const { data, error } = await scoped.rpc('terminal_mark_read', { target_room: room });
    if (error) throw new Error(supabaseErrorText(error));
    const ids = (data || []).map((id: unknown) => String(id));
    await channel.send({ type: 'broadcast', event: 'read', payload: { room, reader, ids } });
    return ids;
  }

  async function upload(file: File, room: string) {
    const path = `${room}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, '_')}`;
    const { error } = await scoped.storage.from('terminal-media').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(supabaseErrorText(error));
    return { path, name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
  }

  async function signedUrl(path: string) {
    const { data, error } = await scoped.storage.from('terminal-media').createSignedUrl(path, 3600);
    if (error) throw new Error(supabaseErrorText(error));
    return data.signedUrl;
  }

  return {
    connected: true,
    channel,
    send,
    sendTyping,
    markRead,
    upload,
    signedUrl,
    trackPresence,
    listMembers,
    listRooms,
    destroy: () => {
      scoped.removeChannel(channel);
    },
  };
}

export type SupabaseBridge = ReturnType<typeof createSupabaseBridge>;
