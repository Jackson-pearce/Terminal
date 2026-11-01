# Terminal

**Terminal** is an always-dark, self-hosted private messenger and P2P voice/video workspace.

- **Vercel** hosts the login (NextAuth + Google).
- **Supabase** stores incoming messages, channels, read receipts and media (Realtime + Postgres + Storage).
- **Python (`server/app.py`)** hosts WebRTC signaling, the duress alert sink, and the local fallback message store.

The app activates only while a backend is reachable, authenticates with **Google**, and protects the workspace with a **High-Security PIN & Duress (Panic) Lock Screen**.

---

## 1. Answering your questions

**"Did you add the Google API?"** — Yes.
- Client ID `520394158071-9c8vv5hnu19o0ppa019q3qqfas1vcqfi.apps.googleusercontent.com` and the client secret live in the git-ignored `.env.local` (mode `600`).
- Redirect URI (add this in Google Cloud Console): `http://localhost:8000/api/oauth/google/callback` (and `https://YOUR-VERCEL-DOMAIN/api/auth/callback/google` for the Vercel deployment).
- The secret is used **only** by the Python server / Next.js server. Verified: `dist/index.html` contains zero copies of the client secret.

**"Rotate the Supabase secret."** — The `sb_secret_…` value posted in chat is public. Rotate it in Supabase → **Project Settings → API Keys → Secret keys**, then put only the new value in `.env.local` (`SUPABASE_SECRET_KEY`) and in your Vercel env vars. The publishable key (`sb_publishable_…`) is designed for the browser and is safe there — Row Level Security protects every row.

**"It looks 50% zoomed."** — Fixed. The shell now uses a 16–17px base scale, 15.5px message text, 40–64px hit targets, a native bottom tab bar on mobile, a docked directory column on desktop, and no 10px micro-labels.

---

## 2. Configure

### `.env.local` (project root, git-ignored, `chmod 600`)

```ini
# Google OAuth — server-side only
GOOGLE_CLIENT_ID=520394158071-9c8vv5hnu19o0ppa019q3qqfas1vcqfi.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-rotated-secret
NEXTAUTH_URL=http://localhost:8000
TERMINAL_PUBLIC_URL=http://localhost:8000
NEXTAUTH_SECRET=openssl-rand-base64-32

# Supabase
SUPABASE_URL=https://YOUR-PROJECT.supabase.co        # ← paste from Project Settings → API
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co    # ← same URL, safe for the browser
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_WZmKVk5OWpav3uflK7djww_ogucfYHQ
SUPABASE_SECRET_KEY=sb_secret_ROTATED_VALUE           # ← server only, NEVER prefix with VITE_

# Vercel deployment that hosts NextAuth (optional locally)
VITE_TERMINAL_API=https://your-vercel-app.vercel.app
```

> **One thing you must fill in:** your Supabase **project URL** (`https://xxxx.supabase.co`). It was not included with the keys. Without it the app automatically stays on the Python fallback transport, so everything still works locally — but Supabase Realtime needs it.

### Supabase schema

Run [`supabase/schema.sql`](supabase/schema.sql) in **Supabase Studio → SQL Editor**. It creates:

- `terminal_members`, `terminal_invites` (who may join)
- `terminal_rooms` (seeded with **`general`**, always present) and `terminal_dm_members`
- `terminal_messages` with `read_by` arrays, indexes and **Realtime** publication
- `terminal_mark_read()` RPC + **Row Level Security** on every table
- private storage bucket `terminal-media` (15 MB limit, mime allow-list)

Seed your crew at the bottom of that file.

### Vercel deployment (login gateway)

```bash
cd web
npm install
npx vercel            # link the project
```

Add these **Vercel env vars** (Settings → Environment Variables):

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | `520394158071-…apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | your rotated secret |
| `NEXTAUTH_URL` | `https://your-vercel-app.vercel.app` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_SECRET_KEY` | your rotated secret key |
| `TERMINAL_APP_URL` | where the Terminal app is hosted |

Files: [`web/lib/auth.ts`](web/lib/auth.ts) (NextAuth, JWT strategy), [`web/app/api/auth/[...nextauth]/route.ts`](web/app/api/auth/[...nextauth]/route.ts), [`web/app/api/terminal/supabase-token/route.ts`](web/app/api/terminal/supabase-token/route.ts).

The token endpoint converts the NextAuth session into a **real Supabase JWT** on the server, so RLS keeps working and the secret never reaches the browser.

---

## 3. Run

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r server/requirements.txt
npm install
npm run build
python server/app.py          # http://localhost:8000
```

Windows helpers: `start-server.bat` (venv + build + server) and `build-android.bat` (Capacitor Android).

Invite code for new members: `python server/manage_accounts.py --show-invite`.

---

## 4. How the pieces fit

```
Vercel (NextAuth)            Supabase                     Python server
┌──────────────────┐         ┌────────────────────┐       ┌────────────────────┐
│ Google OAuth     │         │ terminal_messages  │       │ /api/health gate   │
│ session cookie   │────────▶│ Realtime + RLS     │◀─────▶│ /api/oauth/*       │
│ /supabase-token  │  token  │ terminal_rooms     │       │ /api/supabase/token│
└──────────────────┘         │ terminal_members   │       │ WebRTC signaling   │
       ▲                     │ storage:media       │       │ /api/emergency-…   │
       │                     └────────────────────┘       └────────────────────┘
       └── app (Vite SPA, Capacitor) ── publishable key ──┘
```

**Dual transport, one UI.** If Supabase is configured the app uses it for messages, typing, read receipts, presence and media; the Python server still handles P2P call signaling and the duress alert sink. Without Supabase configured the app transparently falls back to the Python server's WebSocket transport, so local development always works.

### Supabase-backed features
- **Messages** — `postgres_changes` INSERT subscription per room; optimistic local IDs; `client_id` reconciliation.
- **Typing** — `broadcast` on the `terminal` channel, debounced to one event per 2 seconds.
- **Read receipts** — `terminal_mark_read()` RPC + `broadcast 'read'` so senders get blue double-checkmarks.
- **Presence** — Realtime presence (`channel.track`) → the directory's online dots.
- **Directory** — `terminal_members` with the invite allow-list.
- **Media** — compressed WebP written to the private `terminal-media` bucket.

---

## 5. Security features (unchanged, still verified)

- **PIN & Duress PIN** — `src/security/useLockManager.ts` (Zustand, SHA-256 via `crypto-js`), `src/security/secureStore.ts` (expo-secure-store-compatible vault), `src/security/LockScreen.tsx` (keypad, shake, 5-attempt → 60s lockout), `src/security/EmergencyService.ts` (covert alert + selective wipe + encrypted forensic log), `src/security/SecuritySettings.tsx` (normal-unlock only).
- **Duress unlock looks identical** — it loads a Decoy Workspace, hides the Security tab, silently POSTs to `/api/emergency-alert`, and queues the alert offline for retry.
- **Encryption at rest** on the Python server (Fernet) — Supabase storage/rows rely on RLS instead.

## 6. Verify

```bash
npx tsc --noEmit -p tsconfig.json
npm run build
python server/selftest.py     # 40+ backend checks
node scripts/browser-test.mjs # 25 end-to-end browser checks
```
