import AES from 'crypto-js/aes';
import Utf8 from 'crypto-js/enc-utf8';
import * as SecureStore from './secureStore';
import { SECURE_KEYS, wipeSensitiveLocalStorage } from './secureStore';
import type { ChatRoom, Member, Message } from '../chat/types';

export interface CoordinatesPayload {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface EmergencyAlertPayload {
  timestamp: string;
  queuedAt?: string;
  location: CoordinatesPayload | null;
  device: string;
}

export interface ForensicDuressEntry {
  id: string;
  timestamp: string;
  alertDispatched: boolean;
  queuedForRetry: boolean;
  locationCaptured: boolean;
  wipedItemsCount: number;
}

const FORENSIC_CIPHER_SALT = 'terminal.forensic.envelope.v1';

async function getQuietLocation(): Promise<CoordinatesPayload | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    // CRITICAL COVERT RULE: Only query geolocation if permission is ALREADY granted.
    // Prompting an OS permission dialog during duress would alert an attacker.
    if (navigator.permissions?.query) {
      const perm = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      if (perm.state !== 'granted') return null;
    } else {
      return null;
    }
    return await new Promise<CoordinatesPayload | null>(resolve => {
      const timer = window.setTimeout(() => resolve(null), 2500);
      navigator.geolocation.getCurrentPosition(
        pos => {
          window.clearTimeout(timer);
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        () => {
          window.clearTimeout(timer);
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 2200, maximumAge: 120_000 },
      );
    });
  } catch {
    return null;
  }
}

async function resolveEndpoint(serverUrl: string): Promise<string> {
  const custom = await SecureStore.getItemAsync(SECURE_KEYS.EMERGENCY_ENDPOINT);
  if (custom && custom.trim()) return custom.trim();
  return `${serverUrl.replace(/\/+$/, '')}/api/emergency-alert`;
}

async function postAlert(endpoint: string, payload: EmergencyAlertPayload, authToken?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      keepalive: true,
      signal: AbortSignal.timeout(4500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function enqueueOfflineAlert(payload: EmergencyAlertPayload): Promise<void> {
  try {
    const existingRaw = await SecureStore.getItemAsync(SECURE_KEYS.QUEUED_ALERTS);
    const list: EmergencyAlertPayload[] = existingRaw ? JSON.parse(existingRaw) : [];
    list.push({ ...payload, queuedAt: payload.timestamp });
    await SecureStore.setItemAsync(SECURE_KEYS.QUEUED_ALERTS, JSON.stringify(list.slice(-25)));
  } catch {
    /* silent */
  }
}

export async function retryQueuedEmergencyAlerts(serverUrl: string, authToken?: string): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_KEYS.QUEUED_ALERTS);
    if (!raw) return 0;
    const queue: EmergencyAlertPayload[] = JSON.parse(raw);
    if (!Array.isArray(queue) || queue.length === 0) return 0;

    const endpoint = await resolveEndpoint(serverUrl);
    const remaining: EmergencyAlertPayload[] = [];
    let delivered = 0;

    for (const item of queue) {
      const ok = await postAlert(endpoint, item, authToken);
      if (ok) delivered++;
      else remaining.push(item);
    }

    if (remaining.length === 0) {
      await SecureStore.deleteItemAsync(SECURE_KEYS.QUEUED_ALERTS);
    } else {
      await SecureStore.setItemAsync(SECURE_KEYS.QUEUED_ALERTS, JSON.stringify(remaining));
    }
    return delivered;
  } catch {
    return 0;
  }
}

export async function getQueuedAlertCount(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_KEYS.QUEUED_ALERTS);
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

async function appendForensicEntry(entry: ForensicDuressEntry): Promise<void> {
  try {
    const stdHash = (await SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH)) || 'fallback';
    const key = `${FORENSIC_CIPHER_SALT}:${stdHash}`;
    const existing = await getForensicLogs();
    const updated = [entry, ...existing].slice(0, 50);
    const ciphertext = AES.encrypt(JSON.stringify(updated), key).toString();
    await SecureStore.setItemAsync(SECURE_KEYS.FORENSIC_LOG, ciphertext);
  } catch {
    /* silent under duress */
  }
}

export async function getForensicLogs(): Promise<ForensicDuressEntry[]> {
  try {
    const ciphertext = await SecureStore.getItemAsync(SECURE_KEYS.FORENSIC_LOG);
    if (!ciphertext) return [];
    const stdHash = (await SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH)) || 'fallback';
    const key = `${FORENSIC_CIPHER_SALT}:${stdHash}`;
    const plain = AES.decrypt(ciphertext, key).toString(Utf8);
    if (!plain) return [];
    const parsed = JSON.parse(plain);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function clearForensicLogs(): Promise<void> {
  await SecureStore.deleteItemAsync(SECURE_KEYS.FORENSIC_LOG);
}

/**
 * Executes all covert duress actions in the background without blocking or
 * altering the unlock animation:
 * 1. Wipes non-PIN local caches/storage.
 * 2. Captures quiet geolocation (only if already granted) and sends a silent HTTP POST.
 * 3. Queues the alert in SecureStore if offline for automatic retry on next launch.
 * 4. Writes an AES-encrypted local forensic log entry.
 */
export async function triggerDuressProtocol(params: {
  serverUrl: string;
  authToken?: string;
}): Promise<void> {
  try {
    const wipedItemsCount = wipeSensitiveLocalStorage();
    const timestamp = new Date().toISOString();
    const location = await getQuietLocation();
    const device = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : 'terminal-client';
    const payload: EmergencyAlertPayload = { timestamp, location, device };

    const endpoint = await resolveEndpoint(params.serverUrl);
    const dispatched = await postAlert(endpoint, payload, params.authToken);
    if (!dispatched) {
      await enqueueOfflineAlert(payload);
    }

    await appendForensicEntry({
      id: `fl_${Date.now().toString(36)}`,
      timestamp,
      alertDispatched: dispatched,
      queuedForRetry: !dispatched,
      locationCaptured: location !== null,
      wipedItemsCount,
    });
  } catch {
    /* Never surface errors during duress */
  }
}

/**
 * Generates an ordinary, believable decoy workspace when `appStatus === 'UNLOCKED_DURESS'`
 * so the UI looks 100% identical to a normal unlocked session while hiding real contacts
 * and real conversation history.
 */
export function buildDecoyWorkspace(self?: Member | null): {
  selfMember: Member;
  rooms: ChatRoom[];
  members: Member[];
  presence: Record<string, boolean>;
  messages: Message[];
} {
  const me: Member = self ?? {
    id: 'u_self_local',
    name: 'Operator',
    handle: 'operator',
    hue: '#10b981',
    initials: 'OP',
  };
  const peers: Member[] = [
    { id: 'u_decoy_sam', name: 'Sam Rivera', handle: 'srivera', hue: '#06b6d4', initials: 'SR' },
    { id: 'u_decoy_lin', name: 'Lin Chen', handle: 'lchen', hue: '#3b82f6', initials: 'LC' },
  ];
  const rooms: ChatRoom[] = [
    { id: 'general', name: 'General', topic: 'Primary workspace channel — always active', system: true },
    { id: 'notes', name: 'Notes', topic: 'Daily sync and reminders', system: false },
  ];
  const now = Date.now();
  const min = 60_000;
  const messages: Message[] = [
    {
      id: 'decoy_1',
      room: 'general',
      author: 'u_decoy_sam',
      ts: now - 140 * min,
      text: 'Morning — pushed the updated build script and README notes.',
      status: 'read',
      readBy: ['u_decoy_sam', 'u_decoy_lin', me.id],
    },
    {
      id: 'decoy_2',
      room: 'general',
      author: 'u_decoy_lin',
      ts: now - 118 * min,
      text: 'Looks good on my machine. Catching up on docs after lunch.',
      status: 'read',
      readBy: ['u_decoy_lin', 'u_decoy_sam', me.id],
    },
    {
      id: 'decoy_3',
      room: 'general',
      author: me.id,
      ts: now - 95 * min,
      text: 'Sounds good, ping me if anything comes up.',
      status: 'read',
      readBy: [me.id, 'u_decoy_sam', 'u_decoy_lin'],
    },
  ];
  return {
    selfMember: me,
    rooms,
    members: [me, ...peers],
    presence: { [me.id]: true, u_decoy_sam: true, u_decoy_lin: false },
    messages,
  };
}
