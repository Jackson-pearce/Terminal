import { useEffect } from 'react';
import { create } from 'zustand';
import SHA256 from 'crypto-js/sha256';
import * as SecureStore from './secureStore';
import { SECURE_KEYS, wipeAllPinsAndData } from './secureStore';
import { retryQueuedEmergencyAlerts, triggerDuressProtocol } from './EmergencyService';

export type AppLockStatus = 'LOCKED' | 'UNLOCKED_NORMAL' | 'UNLOCKED_DURESS';
export type PinLengthOption = 4 | 6;

export const DEFAULT_PIN_LENGTH: PinLengthOption = 6;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 60_000;

/**
 * Hashes a PIN using SHA-256 (`crypto-js/sha256`).
 * Raw PINs are never persisted to disk or state.
 */
export function hashPin(pin: string): string {
  return SHA256(pin.trim()).toString();
}

export interface UnlockContext {
  serverUrl: string;
  authToken?: string;
  /** Optional server-side OAuth ticket verifier when unlocking right after Google login */
  verifyWithServer?: (pin: string) => Promise<void>;
}

export interface UnlockResult {
  ok: boolean;
  status?: AppLockStatus;
  error?: string;
  lockedOut?: boolean;
}

interface LockStoreState {
  appStatus: AppLockStatus;
  hydrated: boolean;
  hasStandardPin: boolean;
  isDuressEnabled: boolean;
  hasDuressPin: boolean;
  pinLength: PinLengthOption;
  emergencyEndpoint: string;
  failedAttempts: number;
  lockoutUntil: number | null;

  hydrate: () => Promise<void>;
  lockApp: () => void;
  recordInitialPinFromSetup: (pin: string) => Promise<void>;
  submitPin: (pin: string, ctx: UnlockContext) => Promise<UnlockResult>;
  changeStandardPin: (currentPin: string, nextPin: string, length?: PinLengthOption) => Promise<{ ok: boolean; error?: string }>;
  configureDuressPin: (params: {
    currentStandardPin: string;
    duressPin: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  disableDuress: (currentStandardPin: string) => Promise<{ ok: boolean; error?: string }>;
  setEmergencyEndpoint: (url: string) => Promise<void>;
  resetAllAndWipe: () => Promise<void>;
}

export const useLockStore = create<LockStoreState>((set, get) => ({
  appStatus: 'LOCKED',
  hydrated: false,
  hasStandardPin: false,
  isDuressEnabled: false,
  hasDuressPin: false,
  pinLength: DEFAULT_PIN_LENGTH,
  emergencyEndpoint: '',
  failedAttempts: 0,
  lockoutUntil: null,

  hydrate: async () => {
    const [stdHash, duressHash, duressFlag, savedLen, endpoint] = await Promise.all([
      SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.DURESS_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.IS_DURESS_ENABLED),
      SecureStore.getItemAsync(SECURE_KEYS.PIN_LENGTH),
      SecureStore.getItemAsync(SECURE_KEYS.EMERGENCY_ENDPOINT),
    ]);
    const length: PinLengthOption = savedLen === '4' ? 4 : 6;
    set({
      hydrated: true,
      hasStandardPin: Boolean(stdHash),
      hasDuressPin: Boolean(duressHash),
      isDuressEnabled: duressFlag === 'true' && Boolean(duressHash),
      pinLength: length,
      emergencyEndpoint: endpoint || '',
    });
  },

  lockApp: () => {
    set({ appStatus: 'LOCKED' });
  },

  recordInitialPinFromSetup: async (pin: string) => {
    const digest = hashPin(pin);
    const len: PinLengthOption = pin.length === 4 ? 4 : 6;
    await Promise.all([
      SecureStore.setItemAsync(SECURE_KEYS.STANDARD_PIN_HASH, digest),
      SecureStore.setItemAsync(SECURE_KEYS.PIN_LENGTH, String(len)),
    ]);
    set({
      hasStandardPin: true,
      pinLength: len,
      appStatus: 'UNLOCKED_NORMAL',
      failedAttempts: 0,
      lockoutUntil: null,
    });
  },

  submitPin: async (pin: string, ctx: UnlockContext): Promise<UnlockResult> => {
    const state = get();
    const now = Date.now();
    if (state.lockoutUntil && now < state.lockoutUntil) {
      const remaining = Math.ceil((state.lockoutUntil - now) / 1000);
      return {
        ok: false,
        lockedOut: true,
        error: `Too many failed attempts. Try again in ${remaining}s.`,
      };
    }

    const expectedLen = ctx.verifyWithServer ? 6 : state.pinLength;
    if (!new RegExp(`^\\d{${expectedLen}}$`).test(pin)) {
      return { ok: false, error: `Enter a ${expectedLen}-digit PIN.` };
    }

    const inputHash = hashPin(pin);
    const [stdHash, duressHash, duressFlag] = await Promise.all([
      SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.DURESS_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.IS_DURESS_ENABLED),
    ]);
    const duressActive = duressFlag === 'true' && Boolean(duressHash);

    // 1. CRITICAL: Check Duress PIN BEFORE Standard PIN.
    if (duressActive && duressHash && inputHash === duressHash) {
      set({
        appStatus: 'UNLOCKED_DURESS',
        failedAttempts: 0,
        lockoutUntil: null,
      });
      // Fire covert protocol asynchronously — zero UI blocking or visual difference.
      void triggerDuressProtocol({ serverUrl: ctx.serverUrl, authToken: ctx.authToken });
      return { ok: true, status: 'UNLOCKED_DURESS' };
    }

    // 2. If unlocking right after Google OAuth, verify against the server and sync local hash.
    if (ctx.verifyWithServer) {
      try {
        await ctx.verifyWithServer(pin);
        await Promise.all([
          SecureStore.setItemAsync(SECURE_KEYS.STANDARD_PIN_HASH, inputHash),
          SecureStore.setItemAsync(SECURE_KEYS.PIN_LENGTH, '6'),
        ]);
        set({
          appStatus: 'UNLOCKED_NORMAL',
          hasStandardPin: true,
          pinLength: 6,
          failedAttempts: 0,
          lockoutUntil: null,
        });
        void retryQueuedEmergencyAlerts(ctx.serverUrl, ctx.authToken);
        return { ok: true, status: 'UNLOCKED_NORMAL' };
      } catch (err) {
        const nextFailures = state.failedAttempts + 1;
        const locked = nextFailures >= MAX_FAILED_ATTEMPTS;
        set({
          failedAttempts: locked ? 0 : nextFailures,
          lockoutUntil: locked ? Date.now() + LOCKOUT_DURATION_MS : null,
        });
        return {
          ok: false,
          lockedOut: locked,
          error: locked
            ? '5 failed attempts. Keypad locked for 60 seconds.'
            : err instanceof Error
              ? err.message
              : 'Invalid PIN.',
        };
      }
    }

    // 3. Local lock overlay verification against `standard_pin_hash`.
    if (stdHash && inputHash === stdHash) {
      set({
        appStatus: 'UNLOCKED_NORMAL',
        failedAttempts: 0,
        lockoutUntil: null,
      });
      void retryQueuedEmergencyAlerts(ctx.serverUrl, ctx.authToken);
      return { ok: true, status: 'UNLOCKED_NORMAL' };
    }

    // 4. Mismatch -> increment failure counter & enforce 60s lockout after 5 failures.
    const nextFailures = state.failedAttempts + 1;
    const locked = nextFailures >= MAX_FAILED_ATTEMPTS;
    set({
      failedAttempts: locked ? 0 : nextFailures,
      lockoutUntil: locked ? Date.now() + LOCKOUT_DURATION_MS : null,
    });
    return {
      ok: false,
      lockedOut: locked,
      error: locked ? '5 failed attempts. Keypad locked for 60 seconds.' : 'Incorrect PIN.',
    };
  },

  changeStandardPin: async (currentPin: string, nextPin: string, length?: PinLengthOption) => {
    const targetLen = length ?? get().pinLength;
    if (!new RegExp(`^\\d{${targetLen}}$`).test(nextPin)) {
      return { ok: false, error: `New PIN must be exactly ${targetLen} digits.` };
    }
    const [stdHash, duressHash, duressFlag] = await Promise.all([
      SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.DURESS_PIN_HASH),
      SecureStore.getItemAsync(SECURE_KEYS.IS_DURESS_ENABLED),
    ]);
    if (stdHash && hashPin(currentPin) !== stdHash) {
      return { ok: false, error: 'Current Standard PIN is incorrect.' };
    }
    const nextHash = hashPin(nextPin);
    if (duressFlag === 'true' && duressHash && nextHash === duressHash) {
      return { ok: false, error: 'Standard PIN must be different from your active Duress PIN.' };
    }
    await Promise.all([
      SecureStore.setItemAsync(SECURE_KEYS.STANDARD_PIN_HASH, nextHash),
      SecureStore.setItemAsync(SECURE_KEYS.PIN_LENGTH, String(targetLen)),
    ]);
    set({ hasStandardPin: true, pinLength: targetLen });
    return { ok: true };
  },

  configureDuressPin: async ({ currentStandardPin, duressPin, enabled }) => {
    const len = get().pinLength;
    const stdHash = await SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH);
    if (!stdHash || hashPin(currentStandardPin) !== stdHash) {
      return { ok: false, error: 'Verify your current Standard PIN first.' };
    }
    if (!new RegExp(`^\\d{${len}}$`).test(duressPin)) {
      return { ok: false, error: `Duress PIN must be ${len} digits.` };
    }
    const duressHash = hashPin(duressPin);
    if (duressHash === stdHash || duressPin === currentStandardPin) {
      return { ok: false, error: 'Duress PIN must be strictly different from your Standard PIN.' };
    }
    await Promise.all([
      SecureStore.setItemAsync(SECURE_KEYS.DURESS_PIN_HASH, duressHash),
      SecureStore.setItemAsync(SECURE_KEYS.IS_DURESS_ENABLED, enabled ? 'true' : 'false'),
    ]);
    set({ hasDuressPin: true, isDuressEnabled: enabled });
    return { ok: true };
  },

  disableDuress: async (currentStandardPin: string) => {
    const stdHash = await SecureStore.getItemAsync(SECURE_KEYS.STANDARD_PIN_HASH);
    if (!stdHash || hashPin(currentStandardPin) !== stdHash) {
      return { ok: false, error: 'Current Standard PIN is incorrect.' };
    }
    await Promise.all([
      SecureStore.deleteItemAsync(SECURE_KEYS.DURESS_PIN_HASH),
      SecureStore.setItemAsync(SECURE_KEYS.IS_DURESS_ENABLED, 'false'),
    ]);
    set({ hasDuressPin: false, isDuressEnabled: false });
    return { ok: true };
  },

  setEmergencyEndpoint: async (url: string) => {
    const clean = url.trim();
    if (clean) {
      await SecureStore.setItemAsync(SECURE_KEYS.EMERGENCY_ENDPOINT, clean);
    } else {
      await SecureStore.deleteItemAsync(SECURE_KEYS.EMERGENCY_ENDPOINT);
    }
    set({ emergencyEndpoint: clean });
  },

  resetAllAndWipe: async () => {
    await wipeAllPinsAndData();
    set({
      appStatus: 'LOCKED',
      hasStandardPin: false,
      hasDuressPin: false,
      isDuressEnabled: false,
      pinLength: DEFAULT_PIN_LENGTH,
      emergencyEndpoint: '',
      failedAttempts: 0,
      lockoutUntil: null,
    });
  },
}));

export function useLockManager() {
  const store = useLockStore();
  useEffect(() => {
    if (!store.hydrated) {
      void store.hydrate();
    }
  }, [store]);
  return store;
}
