export const GENERAL = 'general';
export const GROUP = GENERAL;

export interface ChatRoom {
  id: string;
  name: string;
  topic?: string;
  system?: boolean;
}

export const BUILTIN_GENERAL_ROOM: ChatRoom = {
  id: GENERAL,
  name: 'General',
  topic: 'Primary workspace channel — always active',
  system: true,
};

export interface Member {
  id: string;
  name: string;
  handle: string;
  hue: string;
  initials: string;
  joinedAt?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ReplyRef {
  id: string;
  authorName: string;
  preview: string;
}

export type MessageStatus = 'sending' | 'sent' | 'read' | 'failed';

export interface Message {
  id: string;
  room: string;
  author: string;
  ts: number;
  text: string;
  file?: Attachment;
  replyTo?: ReplyRef;
  reactions?: Record<string, string[]>;
  readBy?: string[];
  clientId?: string;
  status?: MessageStatus;
  pending?: boolean;
  failed?: boolean;
}

export interface Session {
  token: string;
  member: Member;
}

export interface Signal {
  type: 'offer' | 'answer' | 'candidate' | 'end' | 'decline';
  callId: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  video?: boolean;
}

export interface SignalEvent {
  id: number;
  from: string;
  data: Signal;
}

export interface TurnConfig {
  url: string;
  username: string;
  credential: string;
}

export interface UploadProgress {
  phase: 'compressing' | 'uploading';
  percent: number;
  detail: string;
}

export function directRoom(a: string, b: string) {
  return `dm:${[a, b].sort().join(':')}`;
}

export function normalizeRoomId(room: string) {
  return room === 'all-four' || !room ? GENERAL : room;
}

export function defaultServer() {
  try {
    const saved = localStorage.getItem('terminal.server.v3');
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  const loc = window.location;
  // If served directly from the Python server (e.g. http://localhost:8000), use that exact origin.
  if (
    (loc.protocol === 'http:' || loc.protocol === 'https:') &&
    loc.port !== '5173' &&
    loc.hostname !== '' &&
    !(loc.protocol === 'https:' && loc.hostname === 'localhost' && !loc.port)
  ) {
    return loc.origin;
  }
  return 'http://localhost:8000';
}

export function normalizeServer(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use an http:// or https:// server address.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Remove credentials, query strings, and fragments from the address.');
  }
  return url.toString().replace(/\/+$/, '');
}
