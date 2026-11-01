import { useEffect, useState } from 'react';
import { AlertTriangle, Check, FileWarning, KeyRound, Lock, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import * as api from '../chat/api';
import {
  clearForensicLogs,
  type ForensicDuressEntry,
  getForensicLogs,
  getQueuedAlertCount,
} from './EmergencyService';
import { type PinLengthOption, useLockManager } from './useLockManager';

interface SecuritySettingsProps {
  serverUrl: string;
  authToken: string;
  onToast: (msg: string) => void;
  onFullResetSignOut: () => void;
}

/**
 * SecuritySettings is strictly accessible ONLY when `appStatus === 'UNLOCKED_NORMAL'`.
 * Under `UNLOCKED_DURESS`, this component refuses to render so an attacker cannot
 * discover or disable Duress Mode or inspect forensic logs.
 */
export function SecuritySettings({
  serverUrl,
  authToken,
  onToast,
  onFullResetSignOut,
}: SecuritySettingsProps) {
  const lock = useLockManager();

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [selectedLength, setSelectedLength] = useState<PinLengthOption>(lock.pinLength);

  const [duressVerifyPin, setDuressVerifyPin] = useState('');
  const [duressPin, setDuressPin] = useState('');
  const [duressConfirmPin, setDuressConfirmPin] = useState('');
  const [duressAckDistinct, setDuressAckDistinct] = useState(false);

  const [endpointInput, setEndpointInput] = useState(lock.emergencyEndpoint);
  const [forensicLogs, setForensicLogs] = useState<ForensicDuressEntry[]>([]);
  const [queuedAlerts, setQueuedAlerts] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  useEffect(() => {
    setSelectedLength(lock.pinLength);
    setEndpointInput(lock.emergencyEndpoint);
  }, [lock.pinLength, lock.emergencyEndpoint]);

  useEffect(() => {
    if (lock.appStatus !== 'UNLOCKED_NORMAL') return;
    void getForensicLogs().then(setForensicLogs);
    void getQueuedAlertCount().then(setQueuedAlerts);
  }, [lock.appStatus]);

  // Hard security gate: never expose Duress configuration in Duress Mode.
  if (lock.appStatus !== 'UNLOCKED_NORMAL') {
    return null;
  }

  async function handleStandardPinSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!new RegExp(`^\\d{${selectedLength}}$`).test(newPin)) {
      setError(`New Standard PIN must be ${selectedLength} digits.`);
      return;
    }
    if (newPin !== confirmPin) {
      setError('New Standard PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      // If 6 digits, also update the server-side account PIN hash so next OAuth login matches
      if (selectedLength === 6 && /^\d{6}$/.test(currentPin)) {
        await api.changePin(serverUrl, authToken, currentPin, newPin);
      }
      const res = await lock.changeStandardPin(currentPin, newPin, selectedLength);
      if (!res.ok) {
        setError(res.error || 'Could not update Standard PIN.');
      } else {
        setCurrentPin('');
        setNewPin('');
        setConfirmPin('');
        onToast('Standard PIN updated.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function handleEnableDuress(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!duressAckDistinct) {
      setError('Confirm that your Duress PIN is distinct and triggers Decoy Mode.');
      return;
    }
    if (duressPin !== duressConfirmPin) {
      setError('Duress PIN confirmation does not match.');
      return;
    }
    if (duressPin === duressVerifyPin) {
      setError('Duress PIN must be strictly different from your Standard PIN.');
      return;
    }
    setBusy(true);
    const res = await lock.configureDuressPin({
      currentStandardPin: duressVerifyPin,
      duressPin,
      enabled: true,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'Could not enable Duress PIN.');
      return;
    }
    setDuressVerifyPin('');
    setDuressPin('');
    setDuressConfirmPin('');
    setDuressAckDistinct(false);
    onToast('Duress (Panic) PIN armed.');
  }

  async function handleDisableDuress() {
    setError('');
    if (!duressVerifyPin) {
      setError('Enter your current Standard PIN to disarm Duress Mode.');
      return;
    }
    setBusy(true);
    const res = await lock.disableDuress(duressVerifyPin);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'Could not disable Duress PIN.');
      return;
    }
    setDuressVerifyPin('');
    onToast('Duress PIN disabled.');
  }

  async function handleSaveEndpoint(e: React.FormEvent) {
    e.preventDefault();
    await lock.setEmergencyEndpoint(endpointInput);
    onToast('Emergency alert endpoint saved.');
  }

  return (
    <div className="term-sec-settings">
      {error && (
        <div className="term-alert-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {/* 1. Standard Unlock PIN */}
      <section className="term-sec-block">
        <div className="term-sec-head">
          <div>
            <h3>
              <KeyRound size={15} /> Standard Unlock PIN
            </h3>
            <p>SHA-256 hashed in SecureStore. Protects Terminal on launch and manual lock.</p>
          </div>
          <div className="term-seg-control" role="group" aria-label="PIN digit length">
            {([6, 4] as PinLengthOption[]).map(len => (
              <button
                key={len}
                type="button"
                className={selectedLength === len ? 'active' : ''}
                onClick={() => setSelectedLength(len)}
              >
                {len} digits
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleStandardPinSave} className="term-form-grid">
          <label>
            CURRENT PIN
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={currentPin}
              onChange={e => setCurrentPin(e.target.value.replace(/\D/g, ''))}
              placeholder="Current PIN"
              autoComplete="current-password"
              required
            />
          </label>
          <div className="term-two-col">
            <label>
              NEW ({selectedLength}-DIGIT) PIN
              <input
                type="password"
                inputMode="numeric"
                maxLength={selectedLength}
                value={newPin}
                onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, selectedLength))}
                placeholder={`${selectedLength} digits`}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              CONFIRM NEW PIN
              <input
                type="password"
                inputMode="numeric"
                maxLength={selectedLength}
                value={confirmPin}
                onChange={e => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, selectedLength))}
                placeholder={`${selectedLength} digits`}
                autoComplete="new-password"
                required
              />
            </label>
          </div>
          <button type="submit" className="term-btn-primary" disabled={busy}>
            <Lock size={14} /> Update Standard PIN
          </button>
        </form>
      </section>

      {/* 2. Duress (Panic) PIN */}
      <section className="term-sec-block">
        <div className="term-sec-head">
          <div>
            <h3>
              <ShieldAlert size={15} /> Duress (Panic) PIN
            </h3>
            <p>
              Unlocks an identical-looking Decoy Workspace while silently wiping local caches, logging an encrypted
              forensic event, and POSTing an emergency alert.
            </p>
          </div>
          <span className={`term-pill-state ${lock.isDuressEnabled ? 'armed' : ''}`}>
            {lock.isDuressEnabled ? 'ARMED' : 'DISABLED'}
          </span>
        </div>

        <form onSubmit={handleEnableDuress} className="term-form-grid">
          <label>
            VERIFY CURRENT STANDARD PIN
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={duressVerifyPin}
              onChange={e => setDuressVerifyPin(e.target.value.replace(/\D/g, ''))}
              placeholder="Standard PIN"
              autoComplete="current-password"
              required
            />
          </label>

          {!lock.isDuressEnabled ? (
            <>
              <div className="term-two-col">
                <label>
                  DURESS PIN ({lock.pinLength} DIGITS)
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={lock.pinLength}
                    value={duressPin}
                    onChange={e => setDuressPin(e.target.value.replace(/\D/g, '').slice(0, lock.pinLength))}
                    placeholder={`Different ${lock.pinLength}-digit PIN`}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  CONFIRM DURESS PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={lock.pinLength}
                    value={duressConfirmPin}
                    onChange={e => setDuressConfirmPin(e.target.value.replace(/\D/g, '').slice(0, lock.pinLength))}
                    placeholder="Repeat Duress PIN"
                    autoComplete="new-password"
                    required
                  />
                </label>
              </div>

              <label className="term-checkbox-row">
                <input
                  type="checkbox"
                  checked={duressAckDistinct}
                  onChange={e => setDuressAckDistinct(e.target.checked)}
                />
                <span>
                  I confirm this Duress PIN is different from my Standard PIN and will wipe local cached data when
                  entered.
                </span>
              </label>

              <button type="submit" className="term-btn-secondary" disabled={busy}>
                <Check size={14} /> Enable Duress PIN
              </button>
            </>
          ) : (
            <button type="button" className="term-btn-danger-outline" disabled={busy} onClick={handleDisableDuress}>
              Disable Duress PIN
            </button>
          )}
        </form>

        <form onSubmit={handleSaveEndpoint} className="term-endpoint-row">
          <label>
            SILENT ALERT ENDPOINT (OPTIONAL OVERRIDE)
            <div className="term-inline-input">
              <input
                type="url"
                value={endpointInput}
                onChange={e => setEndpointInput(e.target.value)}
                placeholder={`${serverUrl}/api/emergency-alert`}
              />
              <button type="submit" className="term-btn-ghost">
                Save
              </button>
            </div>
            {queuedAlerts > 0 && (
              <small className="term-queue-note">
                {queuedAlerts} offline emergency alert(s) queued in SecureStore for retry.
              </small>
            )}
          </label>
        </form>
      </section>

      {/* 3. Encrypted Forensic Duress Log */}
      <section className="term-sec-block">
        <div className="term-sec-head">
          <div>
            <h3>
              <FileWarning size={15} /> Encrypted Forensic Log
            </h3>
            <p>AES-encrypted local record of past Duress unlocks ({forensicLogs.length} recorded).</p>
          </div>
          {forensicLogs.length > 0 && (
            <button
              type="button"
              className="term-btn-ghost"
              onClick={async () => {
                await clearForensicLogs();
                setForensicLogs([]);
                onToast('Forensic log cleared.');
              }}
            >
              <Trash2 size={13} /> Clear
            </button>
          )}
        </div>
        {forensicLogs.length === 0 ? (
          <div className="term-empty-log">No duress activations recorded on this device.</div>
        ) : (
          <ul className="term-forensic-list">
            {forensicLogs.map(entry => (
              <li key={entry.id}>
                <code>{entry.timestamp}</code>
                <span>
                  {entry.alertDispatched ? 'Alert POSTed' : entry.queuedForRetry ? 'Queued offline' : 'Pending'} ·{' '}
                  {entry.wipedItemsCount} cache keys wiped · GPS: {entry.locationCaptured ? 'yes' : 'skipped'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. PIN Recovery / Full Wipe */}
      <section className="term-sec-block term-sec-danger">
        <div className="term-sec-head">
          <div>
            <h3>
              <RotateCcw size={15} /> Recovery Reset
            </h3>
            <p>Forgot your Duress PIN? Reset all PIN hashes and wipe all local device storage.</p>
          </div>
          {!confirmWipe ? (
            <button type="button" className="term-btn-danger-outline" onClick={() => setConfirmWipe(true)}>
              Reset All PINs
            </button>
          ) : (
            <div className="term-inline-confirm">
              <button type="button" className="term-btn-ghost" onClick={() => setConfirmWipe(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="term-btn-danger"
                onClick={async () => {
                  await lock.resetAllAndWipe();
                  onFullResetSignOut();
                }}
              >
                Confirm Wipe
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
