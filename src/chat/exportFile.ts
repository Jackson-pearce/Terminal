import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function asBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Unable to prepare this file.'));
    reader.readAsDataURL(blob);
  });
}

/** Native WebViews cannot reliably download blob URLs. Use the OS share sheet. */
export async function exportFile(blob: Blob, filename: string, title: string) {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'attachment';
  const path = `quad-${Date.now()}-${safeName}`;
  const result = await Filesystem.writeFile({path, directory: Directory.Cache, data: await asBase64(blob)});
  try {
    await Share.share({title, dialogTitle: title, url: result.uri});
  } finally {
    // A receiver may read the file after the share sheet closes, so leave a
    // short grace period before clearing the app-private temporary copy.
    window.setTimeout(() => {Filesystem.deleteFile({path, directory: Directory.Cache}).catch(() => {});}, 5 * 60 * 1000);
  }
}
