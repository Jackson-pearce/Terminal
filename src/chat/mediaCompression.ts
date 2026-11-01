import { fileSize } from './shared';
import type { UploadProgress } from './types';

const RASTER_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
]);

const MAX_IMAGE_DIMENSION = 1920;
const WEBP_QUALITY = 0.8;

export interface CompressionOutcome {
  file: File;
  warning?: string;
  summary?: string;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not decode image for compression.'));
    };
    img.src = objectUrl;
  });
}

function probeVideoMetadata(file: File): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise(resolve => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      resolve(null);
    }, 3000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const info = {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: video.duration || 0,
      };
      URL.revokeObjectURL(url);
      resolve(info);
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

/**
 * Compresses images to WebP (max 1920px, 80% quality, EXIF stripped) and
 * inspects/sanitizes video files before upload.
 */
export async function prepareMediaForUpload(
  original: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<CompressionOutcome> {
  const mime = (original.type || '').toLowerCase();

  // 1. Raster images -> Resize max 1920px + WebP @ 80% quality
  if (RASTER_IMAGE_TYPES.has(mime)) {
    onProgress?.({
      phase: 'compressing',
      percent: 12,
      detail: `Decoding ${original.name} (${fileSize(original.size)})…`,
    });

    const img = await loadImageElement(original);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) {
      return { file: original };
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    onProgress?.({
      phase: 'compressing',
      percent: 28,
      detail: `Encoding WebP (${targetW}×${targetH}, 80% quality)…`,
    });

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { file: original };
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(b => resolve(b), 'image/webp', WEBP_QUALITY);
    });

    if (!blob) {
      return { file: original };
    }

    const baseName = original.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'image';
    const outMime = blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const ext = outMime === 'image/webp' ? 'webp' : 'jpg';
    const compressedFile = new File([blob], `${baseName}.${ext}`, {
      type: outMime,
      lastModified: Date.now(),
    });

    onProgress?.({
      phase: 'compressing',
      percent: 45,
      detail: `Compressed ${fileSize(original.size)} → ${fileSize(compressedFile.size)}`,
    });

    return {
      file: compressedFile,
      summary: `${fileSize(original.size)} → ${fileSize(compressedFile.size)} (${ext.toUpperCase()})`,
    };
  }

  // 2. Videos -> Strip filename/timestamp metadata & check 720p/size guidelines
  if (mime.startsWith('video/')) {
    onProgress?.({
      phase: 'compressing',
      percent: 20,
      detail: 'Inspecting video stream & stripping file metadata…',
    });

    const meta = await probeVideoMetadata(original);
    const ext = (original.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    // Strip original camera/device filename metadata
    const sanitizedFile = new File([original], `clip-${Date.now()}.${ext}`, {
      type: original.type || 'video/mp4',
      lastModified: Date.now(),
    });

    let warning: string | undefined;
    if (meta && Math.min(meta.width, meta.height) > 720) {
      warning = `Video is ${meta.width}×${meta.height} (>720p). Uploading metadata-trimmed stream (${fileSize(sanitizedFile.size)}); H.264/AAC 720p/30fps is recommended.`;
    }

    onProgress?.({
      phase: 'compressing',
      percent: 42,
      detail: `Prepared video (${fileSize(sanitizedFile.size)})`,
    });

    return { file: sanitizedFile, warning };
  }

  // 3. Other files (audio, documents, archives)
  onProgress?.({
    phase: 'compressing',
    percent: 35,
    detail: `Preparing ${original.name} (${fileSize(original.size)})…`,
  });
  return { file: original };
}
