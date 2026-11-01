import { useState } from 'react';
import { Check, Network, Palette, Shield, UserRound, X } from 'lucide-react';
import { SecuritySettings } from '../security/SecuritySettings';
import { useLockManager } from '../security/useLockManager';
import { Avatar } from './shared';
import type { TurnConfig } from './types';
import type { Chat } from './useChat';

export type Theme = { mode: 'dark'; color: string; preset: string };

export const presets = [
  { name: 'Emerald', color: '#10b981' },
  { name: 'Cyan', color: '#06b6d4' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Cobalt', color: '#3b82f6' },
  { name: 'Violet', color: '#8b5cf6' },
];

export function loadTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem('terminal.theme.v3') || 'null');
    if (saved && /^#[0-9a-f]{6}$/i.test(saved.color)) {
      return { mode: 'dark', color: saved.color, preset: saved.preset || 'Emerald' };
    }
  } catch {
    /* default */
  }
  return { mode: 'dark', color: presets[0].color, preset: presets[0].name };
}

export function Settings({
  chat,
  theme,
  setTheme,
  turn,
  setTurn,
  onClose,
}: {
  chat: Chat;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  turn: TurnConfig;
  setTurn: (turn: TurnConfig) => void;
  onClose: () => void;
}) {
  const lock = useLockManager();
  const isNormalUnlock = lock.appStatus === 'UNLOCKED_NORMAL';

  const [tab, setTab] = useState<'profile' | 'appearance' | 'security' | 'network'>('profile');
  const [name, setName] = useState(chat.session?.member.name || '');
  const [handle, setHandle] = useState(chat.session?.member.handle || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyTheme = (next: Theme) => {
    const enforcedDark: Theme = { ...next, mode: 'dark' };
    setTheme(enforcedDark);
    try {
      localStorage.setItem('terminal.theme.v3', JSON.stringify(enforcedDark));
    } catch {
      /* ignore */
    }
  };

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await chat.saveProfile(name, handle);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="term-modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="term-settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="term-modal-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="term-icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <nav className="term-settings-tabs" aria-label="Settings sections">
          <button
            type="button"
            className={tab === 'profile' ? 'active' : ''}
            onClick={() => {
              setTab('profile');
              setError('');
            }}
          >
            <UserRound size={15} /> Profile
          </button>
          <button
            type="button"
            className={tab === 'appearance' ? 'active' : ''}
            onClick={() => {
              setTab('appearance');
              setError('');
            }}
          >
            <Palette size={15} /> Appearance
          </button>
          {isNormalUnlock && (
            <button
              type="button"
              className={tab === 'security' ? 'active' : ''}
              onClick={() => {
                setTab('security');
                setError('');
              }}
            >
              <Shield size={15} /> Security
            </button>
          )}
          <button
            type="button"
            className={tab === 'network' ? 'active' : ''}
            onClick={() => {
              setTab('network');
              setError('');
            }}
          >
            <Network size={15} /> Calls / TURN
          </button>
        </nav>

        <div className="term-modal-body">
          {tab === 'profile' && (
            <form className="term-form-grid" onSubmit={saveProfile}>
              <div className="term-profile-preview">
                <Avatar member={chat.session?.member} size="lg" />
                <div>
                  <strong>{chat.session?.member.name}</strong>
                  <span>@{chat.session?.member.handle}</span>
                </div>
              </div>
              <label>
                DISPLAY NAME
                <input value={name} onChange={e => setName(e.target.value)} maxLength={40} required />
              </label>
              <label>
                USERNAME
                <input
                  value={handle}
                  onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  maxLength={24}
                  required
                />
                <small>3–24 lowercase letters, numbers, or underscores.</small>
              </label>
              {error && <p className="term-alert-error">{error}</p>}
              <button type="submit" className="term-btn-primary" disabled={busy}>
                Save changes
              </button>
            </form>
          )}

          {tab === 'appearance' && (
            <div className="term-form-grid">
              <div>
                <h3 className="term-subhead">Accent Color</h3>
                <p className="term-subcopy">Terminal runs in permanent dark mode. Customize your workspace accent.</p>
              </div>
              <div className="term-theme-grid">
                {presets.map(preset => (
                  <button
                    type="button"
                    key={preset.name}
                    className={`term-theme-chip ${theme.preset === preset.name ? 'selected' : ''}`}
                    onClick={() => applyTheme({ mode: 'dark', color: preset.color, preset: preset.name })}
                  >
                    <span className="term-swatch" style={{ background: preset.color }}>
                      {theme.preset === preset.name && <Check size={14} />}
                    </span>
                    <span>{preset.name}</span>
                  </button>
                ))}
                <label className={`term-theme-chip ${theme.preset === 'Custom' ? 'selected' : ''}`}>
                  <span
                    className="term-swatch"
                    style={{
                      background:
                        theme.preset === 'Custom'
                          ? theme.color
                          : 'conic-gradient(#10b981, #06b6d4, #3b82f6, #8b5cf6, #f59e0b, #10b981)',
                    }}
                  >
                    {theme.preset === 'Custom' && <Check size={14} />}
                    <input
                      type="color"
                      value={theme.color}
                      onChange={e => applyTheme({ mode: 'dark', color: e.target.value, preset: 'Custom' })}
                      aria-label="Choose custom accent color"
                    />
                  </span>
                  <span>Custom</span>
                </label>
              </div>
            </div>
          )}

          {tab === 'security' && isNormalUnlock && (
            <SecuritySettings
              serverUrl={chat.server}
              authToken={chat.session?.token || ''}
              onToast={chat.toast}
              onFullResetSignOut={() => {
                onClose();
                chat.signOut();
              }}
            />
          )}

          {tab === 'network' && (
            <div className="term-form-grid">
              <div>
                <h3 className="term-subhead">WebRTC TURN Relay</h3>
                <p className="term-subcopy">
                  Direct peer-to-peer calls use STUN by default. Add an optional TURN relay for strict NAT networks
                  (kept in memory only).
                </p>
              </div>
              <label>
                TURN URL
                <input
                  value={turn.url}
                  onChange={e => setTurn({ ...turn, url: e.target.value })}
                  placeholder="turn:relay.example.com:3478"
                />
              </label>
              <label>
                TURN USERNAME
                <input value={turn.username} onChange={e => setTurn({ ...turn, username: e.target.value })} />
              </label>
              <label>
                TURN CREDENTIAL
                <input
                  type="password"
                  value={turn.credential}
                  onChange={e => setTurn({ ...turn, credential: e.target.value })}
                />
              </label>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
