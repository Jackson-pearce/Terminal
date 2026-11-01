import type { ChatRoom, Member, Message, ReplyRef, UploadProgress } from './types';

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
  }
  return data as T;
}

export async function checkHealth(base: string) {
  const response = await fetch(`${base}/api/health`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(3500),
  });
  const data = await parse<{ status: string; service: string; compat?: string }>(response);
  return data.status === 'ok' && (data.service === 'terminal' || data.service === 'quad' || data.compat === 'quad');
}

export type OAuthStep = { needed: 'pin' | 'setup'; email: string; name: string; handle?: string };

export async function oauthExchange(base: string, ticket: string) {
  return parse<OAuthStep>(
    await fetch(`${base}/api/auth/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    }),
  );
}

export async function oauthFinish(base: string, ticket: string, pin: string, handle?: string, invite?: string) {
  return parse<{ token: string; member: Member }>(
    await fetch(`${base}/api/auth/oauth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, pin, handle: handle || null, invite: invite || '' }),
    }),
  );
}

export async function logout(base: string, token: string) {
  await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateProfile(base: string, token: string, body: { name: string; handle: string }) {
  return parse<{ member: Member }>(
    await fetch(`${base}/api/profile`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function changePin(base: string, token: string, current: string, next: string) {
  return parse<{ ok: boolean }>(
    await fetch(`${base}/api/auth/pin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, new: next }),
    }),
  );
}

export async function createRoom(base: string, token: string, name: string, topic = '') {
  return parse<{ room: ChatRoom; rooms: ChatRoom[] }>(
    await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, topic }),
    }),
  );
}

export async function postMessage(
  base: string,
  token: string,
  body: { room: string; text: string; clientId: string; replyTo?: ReplyRef },
) {
  return parse<{ message: Message }>(
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function markRoomRead(base: string, token: string, room: string) {
  return parse<{ updated: string[] }>(
    await fetch(`${base}/api/messages/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room }),
    }),
  );
}

export function uploadWithProgress(
  base: string,
  token: string,
  room: string,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ message: Message }> {
  if (file.size > 15 * 1024 * 1024) {
    return Promise.reject(new Error('Files must be 15 MB or smaller.'));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/api/files`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) {
        // Map upload progress across 45% -> 100%
        const ratio = event.loaded / Math.max(1, event.total);
        const percent = Math.min(99, Math.round(45 + ratio * 55));
        onProgress({
          phase: 'uploading',
          percent,
          detail: `Uploading ${file.name} (${percent}%)…`,
        });
      }
    };

    xhr.onload = () => {
      let parsed: any = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed.message) {
        onProgress?.({ phase: 'uploading', percent: 100, detail: 'Upload complete' });
        resolve(parsed as { message: Message });
      } else {
        reject(new Error(typeof parsed.detail === 'string' ? parsed.detail : `Upload failed (${xhr.status}).`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error while uploading file.'));
    xhr.ontimeout = () => reject(new Error('File upload timed out.'));
    xhr.timeout = 60_000;

    const form = new FormData();
    form.append('room', room);
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export async function fileBlob(base: string, token: string, id: string, mime: string) {
  const response = await fetch(`${base}/api/files/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Your session expired.' : 'Unable to open this file.');
  }
  const buffer = await response.arrayBuffer();
  return new Blob([buffer], { type: mime || 'application/octet-stream' });
}
