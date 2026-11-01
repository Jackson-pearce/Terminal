import AES from 'crypto-js/aes';
import Utf8 from 'crypto-js/enc-utf8';

/**
 * SecureStore adapter implementing the `expo-secure-store` async interface
 * (`getItemAsync`, `setItemAsync`, `deleteItemAsync`) for Web and Capacitor
 * WebViews. Values are AES-encrypted at rest under an isolated vault prefix.
 * Raw PINs are never passed into SecureStore — only SHA-256 hashes and
 * encrypted forensic/queue payloads.
 */
const VAULT_PREFIX = 'terminal.secure.v1.';
const DEVICE_KEY_SLOT = 'terminal.vault.dk.v1';

export const SECURE_KEYS = {
  STANDARD_PIN_HASH: 'standard_pin_hash',
  DURESS_PIN_HASH: 'duress_pin_hash',
  IS_DURESS_ENABLED: 'is_duress_enabled',
  PIN_LENGTH: 'pin_length',
  EMERGENCY_ENDPOINT: 'emergency_endpoint',
  FORENSIC_LOG: 'forensic_duress_log',
  QUEUED_ALERTS: 'queued_duress_alerts',
} as const;

const PROTECTED_VAULT_SLOTS = new Set<string>([
  DEVICE_KEY_SLOT,
  `${VAULT_PREFIX}${SECURE_KEYS.STANDARD_PIN_HASH}`,
  `${VAULT_PREFIX}${SECURE_KEYS.DURESS_PIN_HASH}`,
  `${VAULT_PREFIX}${SECURE_KEYS.IS_DURESS_ENABLED}`,
  `${VAULT_PREFIX}${SECURE_KEYS.PIN_LENGTH}`,
  `${VAULT_PREFIX}${SECURE_KEYS.EMERGENCY_ENDPOINT}`,
  `${VAULT_PREFIX}${SECURE_KEYS.FORENSIC_LOG}`,
  `${VAULT_PREFIX}${SECURE_KEYS.QUEUED_ALERTS}`,
  'terminal.server.v3',
  'terminal.theme.v3',
]);

const memoryFallback = new Map<string, string>();

function getDeviceSecret(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY_SLOT);
    if (existing && existing.length >= 32) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const generated = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_KEY_SLOT, generated);
    return generated;
  } catch {
    const existing = memoryFallback.get(DEVICE_KEY_SLOT);
    if (existing) return existing;
    const fallback = 'terminal-ephemeral-vault-key-fallback-32b';
    memoryFallback.set(DEVICE_KEY_SLOT, fallback);
    return fallback;
  }
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  const slot = `${VAULT_PREFIX}${key}`;
  const encrypted = AES.encrypt(value, getDeviceSecret()).toString();
  try {
    localStorage.setItem(slot, encrypted);
  } catch {
    memoryFallback.set(slot, encrypted);
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  const slot = `${VAULT_PREFIX}${key}`;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(slot);
  } catch {
    raw = memoryFallback.get(slot) ?? null;
  }
  if (!raw) return null;
  try {
    const bytes = AES.decrypt(raw, getDeviceSecret());
    const plaintext = bytes.toString(Utf8);
    return plaintext || null;
  } catch {
    return null;
  }
}

export async function deleteItemAsync(key: string): Promise<void> {
  const slot = `${VAULT_PREFIX}${key}`;
  try {
    localStorage.removeItem(slot);
  } catch {
    /* ignore */
  }
  memoryFallback.delete(slot);
}

/**
 * Covert wipe during Duress Unlock: removes cached sessions, drafts, attachments,
 * and application storage while preserving PIN hashes and forensic records so an
 * observer sees normal PIN behavior without exposing sensitive data.
 */
export function wipeSensitiveLocalStorage(): number {
  let wiped = 0;
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !PROTECTED_VAULT_SLOTS.has(k)) {
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) {
      localStorage.removeItem(k);
      wiped++;
    }
  } catch {
    /* storage blocked */
  }
  try {
    wiped += sessionStorage.length;
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  return wiped;
}

/**
 * Complete reset when the user initiates "Forgot PIN / Recovery Reset".
 * Wipes ALL PIN hashes, duress settings, and local caches.
 */
export async function wipeAllPinsAndData(): Promise<void> {
  await Promise.all([
    deleteItemAsync(SECURE_KEYS.STANDARD_PIN_HASH),
    deleteItemAsync(SECURE_KEYS.DURESS_PIN_HASH),
    deleteItemAsync(SECURE_KEYS.IS_DURESS_ENABLED),
    deleteItemAsync(SECURE_KEYS.PIN_LENGTH),
    deleteItemAsync(SECURE_KEYS.EMERGENCY_ENDPOINT),
    deleteItemAsync(SECURE_KEYS.FORENSIC_LOG),
    deleteItemAsync(SECURE_KEYS.QUEUED_ALERTS),
  ]);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  memoryFallback.clear();
}
