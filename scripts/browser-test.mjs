import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const data = await mkdtemp(path.join(os.tmpdir(), 'terminal-browser-'));
await mkdir('artifacts', { recursive: true });
const port = process.env.TERMINAL_TEST_PORT || '8124';
const base = `http://localhost:${port}`;
const harness = path.join(data, 'harness.py');

await writeFile(
  harness,
  `
import os, sys, uvicorn
sys.path.insert(0, os.environ["TERMINAL_SERVER_DIR"])
import app as server

async def fake_exchange(code, verifier):
    return {"access_token": code}

async def fake_profile(token):
    name = token.split("@")[0]
    return {"sub": "g-" + token, "email": token, "name": name.title(), "picture": ""}

server.exchange_code = fake_exchange
server.fetch_profile = fake_profile
uvicorn.run(server.app, host="127.0.0.1", port=int(os.environ["TERMINAL_PORT"]), log_level="warning")
`,
);

let serverLog = '';
const startServer = () => {
  const handle = spawn(process.env.TERMINAL_PYTHON || 'python3', [harness], {
    env: {
      ...process.env,
      TERMINAL_DATA_DIR: data,
      QUAD_DATA_DIR: data,
      TERMINAL_INVITE_CODE: 'browser-test-invite',
      TERMINAL_PORT: port,
      TERMINAL_SERVER_DIR: path.resolve('server'),
      GOOGLE_CLIENT_ID: 'stub.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'stub-secret',
      TERMINAL_PUBLIC_URL: base,
      QUAD_PUBLIC_URL: base,
      TERMINAL_ALLOWED_ORIGINS: `${base},http://localhost:8000,http://localhost:5173`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.stdout.on('data', chunk => {
    serverLog += chunk.toString();
  });
  handle.stderr.on('data', chunk => {
    serverLog += chunk.toString();
  });
  return handle;
};

let server = startServer();
const check = (label, condition) => {
  if (!condition) throw new Error(label);
  console.log(`PASS ${label}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function googleTicket(email) {
  const start = await fetch(`${base}/api/oauth/google/start?origin=${encodeURIComponent(base)}`, {
    redirect: 'manual',
  });
  const location = start.headers.get('location') || '';
  check(
    `server redirects ${email} to Google with PKCE and signed state`,
    location.includes('accounts.google.com') &&
      location.includes('code_challenge') &&
      location.includes('state='),
  );
  const state = new URL(location).searchParams.get('state');
  const callback = await fetch(
    `${base}/api/oauth/google/callback?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  );
  const target = callback.headers.get('location') || '';
  return new URL(target, base).searchParams.get('quad_oauth');
}

async function enterKeypadPin(page, pin) {
  await page.getByTestId('lock-screen').waitFor({ timeout: 10000 });
  for (const ch of pin) {
    await page.locator('.term-keypad .term-key', { hasText: ch }).first().click();
  }
}

let browser;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  const makeContext = async (mobile = false) =>
    browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      acceptDownloads: true,
      permissions: ['microphone', 'camera'],
    });

  const aContext = await makeContext();
  const bContext = await makeContext();
  const alice = await aContext.newPage();
  const blair = await bContext.newPage();
  for (const page of [alice, blair]) {
    page.on('pageerror', error => console.error('PAGE ERROR', error.message));
  }

  // 1. Check dark-mode login screen & LoginButton handoff
  await alice.goto(base);
  await alice.getByText('Server online').waitFor({ timeout: 10000 });
  await sleep(300);
  await alice.screenshot({ path: 'artifacts/auth.png', fullPage: true });
  const bodyTextAuth = await alice.locator('body').innerText();
  check('app is named Terminal and has no "No rooms yet" slop', bodyTextAuth.includes('Terminal') && !bodyTextAuth.includes('No rooms yet'));

  await Promise.all([
    alice.waitForURL('**accounts.google.com**', { timeout: 10000 }),
    alice.getByRole('button', { name: 'Sign in with Google' }).click(),
  ]);
  check('Sign in with Google button hands off to Google OAuth', alice.url().includes('accounts.google.com'));

  async function setupAccount(page, { name, pin, email }) {
    const ticket = await googleTicket(email);
    await page.goto(`${base}/?quad_oauth=${encodeURIComponent(ticket)}`);
    await page.getByText('Initialize Account').waitFor({ timeout: 15000 });
    await page.getByPlaceholder('e.g. operator').fill(name.toLowerCase());
    const pinInputs = page.locator('input[inputmode="numeric"]');
    await pinInputs.nth(0).fill(pin);
    await pinInputs.nth(1).fill(pin);
    await page.getByPlaceholder(/Enter invite code/).fill('browser-test-invite');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder(/Message #general/).waitFor({ timeout: 15000 });
    check(`${name} completes initial setup and lands directly in #general`, true);
  }

  await setupAccount(alice, { name: 'Alice', pin: '123456', email: 'alice@example.com' });
  await setupAccount(blair, { name: 'Blair', pin: '654321', email: 'blair@example.com' });

  // Verify General room is always present and zero "No rooms yet" text exists
  const wsBody = await alice.locator('body').innerText();
  check(
    'General room is always present without "No rooms yet"',
    wsBody.includes('General') && !wsBody.includes('No rooms yet'),
  );

  // 2. Realtime Typing Indicator + Optimistic UI + Blue Read Receipts
  await blair.getByPlaceholder(/Message #general/).fill('Typing check...');
  await alice.locator('.term-typing-pill').waitFor({ timeout: 6000 });
  check('realtime typing indicator pill appears for room peer', true);
  await blair.getByPlaceholder(/Message #general/).fill('');
  await alice.locator('.term-typing-pill').waitFor({ state: 'detached', timeout: 6000 });
  check('typing_stop hides typing indicator pill cleanly', true);

  await alice.getByPlaceholder(/Message #general/).fill('Optimistic message in General');
  await alice.getByPlaceholder(/Message #general/).press('Enter');
  await blair.locator('main').getByText('Optimistic message in General').waitFor({ timeout: 10000 });
  // Because Blair is viewing #general, Blair marks it read -> Alice sees "Read" blue double-checkmarks!
  await alice.locator('.term-delivery.read').first().waitFor({ timeout: 10000 });
  check('optimistic send resolves and upgrades to blue Read double-checkmarks', true);

  // 3. Create custom channel (#ops)
  await alice.getByRole('button', { name: 'Create channel' }).click();
  await alice.getByPlaceholder('channel-name').fill('ops');
  await alice.getByPlaceholder('Topic (optional)').fill('System operations');
  await alice.locator('.term-new-room-form').getByRole('button', { name: 'Create' }).click();
  await blair.locator('.term-sidebar').getByText('ops', { exact: true }).waitFor({ timeout: 10000 });
  check('custom channel creation syncs live across clients', true);

  // 4. Direct messages, automatic 1920px WebP image compression, voice, camera, and WebRTC calls
  await alice.locator('.term-sidebar .term-nav-row').filter({ hasText: 'Blair' }).click();
  await blair.locator('.term-sidebar .term-nav-row').filter({ hasText: 'Alice' }).click();
  await alice.getByPlaceholder(/Message @blair/).fill('Direct encrypted message');
  await alice.getByPlaceholder(/Message @blair/).press('Enter');
  await blair.locator('main').getByText('Direct encrypted message').waitFor();

  // Generate a large 2400x1600 PNG in-browser and upload via file input to verify automatic WebP compression
  const bigPngBase64 = await alice.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 2400;
    c.height = 1600;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 2400, 1600);
    ctx.fillStyle = '#10b981';
    ctx.fillRect(200, 200, 800, 600);
    return c.toDataURL('image/png').split(',')[1];
  });
  await alice.locator('.term-composer-box input[type="file"]').setInputFiles({
    name: 'oversized-capture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(bigPngBase64, 'base64'),
  });
  await blair.locator('.attachment-image img').first().waitFor({ timeout: 15000 });
  const naturalWidth = await blair.locator('.attachment-image img').first().evaluate(img => img.naturalWidth);
  check('2400px PNG was automatically compressed to <=1920px WebP before upload', naturalWidth === 1920);

  await sleep(400);
  await alice.screenshot({ path: 'artifacts/chat.png', fullPage: true });

  // Voice recording
  await alice.getByRole('button', { name: 'Record a voice message' }).click();
  await alice.getByText('Recording voice message').waitFor();
  await sleep(1200);
  await alice.locator('.record-send').click();
  await blair.locator('audio[controls]').waitFor({ timeout: 15000 });
  check('voice note records and plays back', true);

  // Camera capture
  await alice.getByRole('button', { name: 'Take a photo' }).click();
  const camDialog = alice.getByRole('dialog', { name: 'Take a photo' });
  await camDialog.waitFor();
  await sleep(1000);
  await camDialog.getByRole('button', { name: 'Take photo' }).click();
  await sleep(1200);
  check('camera modal captures WebP photo', (await blair.locator('.attachment-image img').count()) >= 2);

  // WebRTC Audio Call
  await alice.getByRole('button', { name: 'Start voice call' }).click();
  await blair.getByRole('dialog', { name: 'Incoming voice call' }).waitFor({ timeout: 15000 });
  await blair.getByRole('button', { name: 'Answer call' }).click();
  await alice.getByText('Connected peer to peer').waitFor({ timeout: 30000 });
  check('WebRTC P2P voice call connects', true);
  await alice.getByRole('button', { name: 'End call' }).first().click();

  // 5. High-Security LockScreen + Standard PIN + Duress (Panic) PIN Flow
  await alice.locator('.term-rail').getByRole('button', { name: 'Open settings' }).click();
  await alice.locator('.term-settings-tabs').getByRole('button', { name: 'Security' }).click();
  await alice.getByPlaceholder('Standard PIN').fill('123456');
  await alice.getByPlaceholder('Different 6-digit PIN').fill('911911');
  await alice.getByPlaceholder('Repeat Duress PIN').fill('911911');
  await alice.locator('.term-checkbox-row input[type="checkbox"]').check();
  await alice.getByRole('button', { name: 'Enable Duress PIN' }).click();
  await alice.getByText('ARMED', { exact: true }).waitFor({ timeout: 5000 });
  await alice.screenshot({ path: 'artifacts/security-settings.png', fullPage: true });
  await alice.getByRole('button', { name: 'Close settings' }).click();
  check('Duress (Panic) PIN armed in SecuritySettings', true);

  // Engage LockScreen manually
  await alice.getByRole('button', { name: 'Lock workspace' }).click();
  await alice.getByTestId('lock-screen').waitFor({ timeout: 5000 });
  await alice.screenshot({ path: 'artifacts/lock-screen.png', fullPage: true });

  // Wrong PIN triggers shake + decrements attempts
  await enterKeypadPin(alice, '000000');
  await alice.getByText(/4 attempts left/).waitFor({ timeout: 5000 });
  check('wrong PIN triggers error shake and attempt counter', true);

  // Standard PIN unlocks normal workspace
  await enterKeypadPin(alice, '123456');
  await alice.locator('main').getByText('Direct encrypted message').waitFor({ timeout: 10000 });
  check('Standard PIN unlocks real workspace', true);

  // Lock again and enter DURESS PIN -> must look identical, hide real DMs & Security tab, and silently POST alert
  await alice.getByRole('button', { name: 'Lock workspace' }).click();
  await enterKeypadPin(alice, '911911');
  await alice.getByPlaceholder(/Message #general/).waitFor({ timeout: 10000 });
  await sleep(600);
  await alice.screenshot({ path: 'artifacts/duress-decoy.png', fullPage: true });
  const decoyText = await alice.locator('body').innerText();
  check(
    'Duress PIN launches identical-looking Decoy Workspace without real messages or warnings',
    decoyText.includes('General') &&
      !decoyText.includes('Direct encrypted message') &&
      !decoyText.toLowerCase().includes('duress') &&
      !decoyText.toLowerCase().includes('decoy'),
  );

  // Verify Security tab is completely hidden under UNLOCKED_DURESS
  await alice.locator('.term-rail').getByRole('button', { name: 'Open settings' }).click();
  const secTabCountInDuress = await alice.locator('.term-settings-tabs').getByRole('button', { name: 'Security' }).count();
  check('SecuritySettings tab is hidden while in UNLOCKED_DURESS', secTabCountInDuress === 0);
  await alice.getByRole('button', { name: 'Close settings' }).click();

  // Verify silent /api/emergency-alert was received and encrypted on server disk
  const emergencyPath = path.join(data, 'emergency_alerts.enc.json');
  await access(emergencyPath);
  const emergencyRaw = await readFile(emergencyPath, 'utf8');
  check('silent covert HTTP POST to /api/emergency-alert stored encrypted alert on server', emergencyRaw.includes('"enc"'));

  // Re-lock and unlock with Standard PIN -> forensic log records the duress event!
  await alice.getByRole('button', { name: 'Lock workspace' }).click();
  await enterKeypadPin(alice, '123456');
  await alice.getByPlaceholder(/Message #general/).waitFor({ timeout: 10000 });
  await alice.locator('.term-rail').getByRole('button', { name: 'Open settings' }).click();
  await alice.locator('.term-settings-tabs').getByRole('button', { name: 'Security' }).click();
  await alice.locator('.term-forensic-list li').first().waitFor({ timeout: 5000 });
  check('encrypted local forensic log recorded the duress activation for later review', true);
  await alice.getByRole('button', { name: 'Close settings' }).click();

  // 6. Returning Google sign-in routes straight to LockScreen keypad
  const phoneCtx = await makeContext(true);
  const phone = await phoneCtx.newPage();
  await phone.goto(base);
  await phone.getByText('Server online').waitFor();
  await phone.screenshot({ path: 'artifacts/mobile-auth.png', fullPage: true });
  await phone.goto(`${base}/?quad_oauth=${encodeURIComponent(await googleTicket('alice@example.com'))}`);
  await enterKeypadPin(phone, '123456');
  await phone.getByPlaceholder(/Message #general/).waitFor({ timeout: 15000 });
  await phone.screenshot({ path: 'artifacts/mobile-thread.png', fullPage: true });
  await phone.getByRole('button', { name: 'Back to conversations' }).click();
  await phone.locator('.term-sidebar.mobile-visible').waitFor();
  await phone.screenshot({ path: 'artifacts/mobile-list.png', fullPage: true });
  check('mobile Google sign-in + LockScreen keypad + thread navigation work cleanly', true);

  // 7. Server offline suspends workspace
  server.kill('SIGTERM');
  await blair.getByText('Python Server Offline').waitFor({ timeout: 12000 });
  check('workspace locks immediately when Python server stops', true);

  console.log('All Terminal browser integration checks passed.');
} catch (error) {
  console.error(error);
  console.error('Server log:', serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await rm(data, { recursive: true, force: true });
}
