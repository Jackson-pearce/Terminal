import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Delete, Lock, LogOut, RotateCcw, Terminal as TerminalIcon } from 'lucide-react';
import { MAX_FAILED_ATTEMPTS, useLockManager } from './useLockManager';

export interface LockScreenProps {
  serverUrl: string;
  authToken?: string;
  accountLabel?: string;
  accountSubLabel?: string;
  /** Provided when completing the PIN step right after Google OAuth sign-in */
  verifyWithServer?: (pin: string) => Promise<void>;
  onSignOut: () => void;
}

export function LockScreen({
  serverUrl,
  authToken,
  accountLabel,
  accountSubLabel,
  verifyWithServer,
  onSignOut,
}: LockScreenProps) {
  const lock = useLockManager();
  const targetLength = verifyWithServer ? 6 : lock.pinLength;

  const [digits, setDigits] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [confirmWipe, setConfirmWipe] = useState(false);

  // Live 60-second lockout countdown
  useEffect(() => {
    if (!lock.lockoutUntil) {
      setRemainingSeconds(0);
      return;
    }
    const tick = () => {
      const diff = Math.max(0, Math.ceil((lock.lockoutUntil! - Date.now()) / 1000));
      setRemainingSeconds(diff);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [lock.lockoutUntil]);

  const isLockedOut = remainingSeconds > 0;

  const triggerShake = useCallback((msg: string) => {
    setErrorText(msg);
    setShaking(false);
    window.requestAnimationFrame(() => {
      setShaking(true);
      window.setTimeout(() => setShaking(false), 460);
    });
  }, []);

  const handleSubmit = useCallback(
    async (pinValue: string) => {
      if (submitting || isLockedOut || pinValue.length !== targetLength) return;
      setSubmitting(true);
      setErrorText('');
      const res = await lock.submitPin(pinValue, {
        serverUrl,
        authToken,
        verifyWithServer,
      });
      setSubmitting(false);
      if (!res.ok) {
        setDigits('');
        triggerShake(res.error || 'Incorrect PIN.');
      }
      // On success (either UNLOCKED_NORMAL or UNLOCKED_DURESS), `appStatus` transitions
      // identically without any visual distinction.
    },
    [authToken, isLockedOut, lock, serverUrl, submitting, targetLength, triggerShake, verifyWithServer],
  );

  const appendDigit = useCallback(
    (d: string) => {
      if (submitting || isLockedOut) return;
      setErrorText('');
      setDigits(prev => {
        if (prev.length >= targetLength) return prev;
        const next = prev + d;
        if (next.length === targetLength) {
          window.setTimeout(() => {
            void handleSubmit(next);
          }, 60);
        }
        return next;
      });
    },
    [handleSubmit, isLockedOut, submitting, targetLength],
  );

  const backspace = useCallback(() => {
    if (submitting || isLockedOut) return;
    setErrorText('');
    setDigits(prev => prev.slice(0, -1));
  }, [isLockedOut, submitting]);

  const clearDigits = useCallback(() => {
    if (submitting || isLockedOut) return;
    setErrorText('');
    setDigits('');
  }, [isLockedOut, submitting]);

  // Support physical numeric keyboard entry cleanly
  useEffect(() => {
    if (confirmWipe) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        appendDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearDigits();
      } else if (e.key === 'Enter' && digits.length === targetLength) {
        e.preventDefault();
        void handleSubmit(digits);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendDigit, backspace, clearDigits, confirmWipe, digits, handleSubmit, targetLength]);

  async function executeRecoveryWipe() {
    await lock.resetAllAndWipe();
    setConfirmWipe(false);
    onSignOut();
  }

  const attemptsRemaining = MAX_FAILED_ATTEMPTS - lock.failedAttempts;

  return (
    <div className="term-lock-screen" data-testid="lock-screen">
      <div className="term-lock-card">
        <header className="term-lock-header">
          <div className="term-brand-row">
            <span className="term-logo-box">
              <TerminalIcon size={16} />
            </span>
            <span className="term-brand-name">TERMINAL</span>
            <span className="term-badge-lock">
              <Lock size={11} /> LOCKED
            </span>
          </div>
          {accountLabel && (
            <div className="term-lock-identity">
              <span className="term-lock-user">{accountLabel}</span>
              {accountSubLabel && <span className="term-lock-email">{accountSubLabel}</span>}
            </div>
          )}
        </header>

        {confirmWipe ? (
          <div className="term-wipe-box" role="alertdialog" aria-labelledby="wipe-title">
            <div className="term-wipe-icon">
              <AlertTriangle size={22} />
            </div>
            <h2 id="wipe-title">Reset PINs &amp; Wipe Local Data?</h2>
            <p>
              If you forgot your Standard or Duress PIN, this resets all stored PIN hashes, wipes local cached data on
              this device, and signs out of your current session.
            </p>
            <div className="term-wipe-actions">
              <button type="button" className="term-btn-ghost" onClick={() => setConfirmWipe(false)}>
                Cancel
              </button>
              <button type="button" className="term-btn-danger" onClick={executeRecoveryWipe}>
                Reset All &amp; Wipe
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="term-lock-prompt">
              <h1>Enter {targetLength}-digit PIN</h1>
              <p>
                {isLockedOut
                  ? `Keypad locked due to failed attempts. Retry in ${remainingSeconds}s.`
                  : 'Authenticate to unlock encrypted workspace'}
              </p>
            </div>

            {/* Accessible hidden input for screen readers / automation fallback */}
            <input
              type="password"
              inputMode="numeric"
              aria-label={`Enter ${targetLength}-digit PIN`}
              className="visually-hidden"
              maxLength={targetLength}
              value={digits}
              disabled={isLockedOut || submitting}
              onChange={e => {
                const clean = e.target.value.replace(/\D/g, '').slice(0, targetLength);
                setDigits(clean);
                if (clean.length === targetLength) {
                  void handleSubmit(clean);
                }
              }}
            />

            <div
              className={`term-pin-dots ${shaking ? 'is-shaking' : ''} ${isLockedOut ? 'is-locked-out' : ''}`}
              aria-live="polite"
            >
              {Array.from({ length: targetLength }).map((_, idx) => {
                const filled = idx < digits.length;
                return (
                  <span
                    key={idx}
                    className={`term-pin-dot ${filled ? 'filled' : ''} ${errorText ? 'has-error' : ''}`}
                  />
                );
              })}
            </div>

            <div className="term-lock-status" role="status" aria-live="assertive">
              {isLockedOut ? (
                <span className="term-status-lockout">
                  LOCKOUT ACTIVE — {String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:
                  {String(remainingSeconds % 60).padStart(2, '0')}
                </span>
              ) : errorText ? (
                <span className="term-status-error">
                  {errorText} ({attemptsRemaining} {attemptsRemaining === 1 ? 'attempt' : 'attempts'} left)
                </span>
              ) : submitting ? (
                <span className="term-status-neutral">Verifying…</span>
              ) : (
                <span className="term-status-neutral">&nbsp;</span>
              )}
            </div>

            <div className="term-keypad" role="group" aria-label="PIN numeric keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                <button
                  key={num}
                  type="button"
                  className="term-key"
                  disabled={isLockedOut || submitting}
                  onClick={() => appendDigit(num)}
                >
                  {num}
                </button>
              ))}
              <button
                type="button"
                className="term-key term-key-fn"
                disabled={isLockedOut || submitting || digits.length === 0}
                onClick={clearDigits}
                aria-label="Clear PIN"
                title="Clear"
              >
                CLR
              </button>
              <button
                type="button"
                className="term-key"
                disabled={isLockedOut || submitting}
                onClick={() => appendDigit('0')}
              >
                0
              </button>
              <button
                type="button"
                className="term-key term-key-fn"
                disabled={isLockedOut || submitting || digits.length === 0}
                onClick={backspace}
                aria-label="Backspace"
                title="Backspace"
              >
                <Delete size={18} />
              </button>
            </div>

            <footer className="term-lock-footer">
              <button type="button" className="term-link-muted" onClick={() => setConfirmWipe(true)}>
                <RotateCcw size={13} /> Forgot PIN? Reset &amp; wipe
              </button>
              <button type="button" className="term-link-muted" onClick={onSignOut}>
                <LogOut size={13} /> Sign out
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}


/**
 * First-run PIN creation (used when the account signs in through the Vercel
 * gateway and has no local PIN yet).
 */
export function PinSetup({
  accountLabel,
  onDone,
  onCancel,
}: {
  accountLabel?: string;
  onDone: (pin: string) => void;
  onCancel?: () => void;
}) {
  const lock = useLockManager();
  const [stage, setStage] = useState<'create' | 'confirm'>('create');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState('');
  const length = lock.pinLength;

  const press = (value: string) => {
    setError('');
    const next = (stage === 'create' ? first : second) + value;
    if (next.length < length) {
      if (stage === 'create') setFirst(next);
      else setSecond(next);
      return;
    }
    if (stage === 'create') {
      setFirst(next);
      setSecond('');
      setStage('confirm');
      return;
    }
    if (next !== first) {
      setError('Those PINs did not match. Start again.');
      setFirst('');
      setSecond('');
      setStage('create');
      return;
    }
    void lock.recordInitialPinFromSetup(next).then(() => onDone(next));
  };

  const backspace = () => {
    setError('');
    if (stage === 'confirm') setSecond(prev => prev.slice(0, -1));
    else setFirst(prev => prev.slice(0, -1));
  };

  const digits = stage === 'create' ? first : second;

  return (
    <div className="term-lock-screen" data-testid="pin-setup">
      <div className="term-lock-card">
        <header className="term-lock-header">
          <div className="term-brand-row">
            <span className="term-logo-box">
              <TerminalIcon size={16} />
            </span>
            <span className="term-brand-name">TERMINAL</span>
            <span className="term-badge-lock">
              <Lock size={11} /> SETUP
            </span>
          </div>
          {accountLabel && (
            <div className="term-lock-identity">
              <span className="term-lock-user">{accountLabel}</span>
            </div>
          )}
        </header>

        <div className="term-lock-prompt">
          <h1>{stage === 'create' ? `Choose a ${length}-digit PIN` : 'Confirm your PIN'}</h1>
          <p>
            {stage === 'create'
              ? 'This PIN unlocks the workspace on this device.'
              : 'Enter the same PIN once more.'}
          </p>
        </div>

        <div className={`term-pin-dots ${error ? 'is-shaking' : ''}`}>
          {Array.from({ length }).map((_, index) => (
            <span key={index} className={`term-pin-dot ${index < digits.length ? 'filled' : ''} ${error ? 'has-error' : ''}`} />
          ))}
        </div>

        <div className="term-lock-status" role="status" aria-live="assertive">
          {error ? <span className="term-status-error">{error}</span> : <span className="term-status-neutral">&nbsp;</span>}
        </div>

        <div className="term-keypad" role="group" aria-label="PIN numeric keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(number => (
            <button key={number} type="button" className="term-key" onClick={() => press(number)}>
              {number}
            </button>
          ))}
          <button type="button" className="term-key term-key-fn" onClick={onCancel} aria-label="Cancel">
            ESC
          </button>
          <button type="button" className="term-key" onClick={() => press('0')}>
            0
          </button>
          <button type="button" className="term-key term-key-fn" onClick={backspace} aria-label="Backspace">
            <Delete size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
