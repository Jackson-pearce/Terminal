import { useEffect, useState } from 'react';
import { Download, FileText, Film, Image as ImageIcon, LoaderCircle, Maximize2, X } from 'lucide-react';
import { fileBlob } from './api';
import { exportFile } from './exportFile';
import { fileSize } from './shared';
import type { Attachment as FileInfo } from './types';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
]);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

export function Attachment({
  file,
  server,
  token,
  mine,
}: {
  file: FileInfo;
  server: string;
  token: string;
  mine: boolean;
}) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  const isImage = IMAGE_TYPES.has(file.mime);
  const isAudio = AUDIO_TYPES.has(file.mime);
  const isVideo = VIDEO_TYPES.has(file.mime);

  useEffect(() => {
    if (!isImage && !isAudio && !isVideo) return;
    if (token === 'decoy-local-token') return;
    let alive = true;
    let objectUrl = '';
    fileBlob(server, token, file.id, file.mime)
      .then(blob => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.mime, server, token, isImage, isAudio, isVideo]);

  async function download() {
    if (token === 'decoy-local-token') return;
    setLoading(true);
    try {
      const blob = await fileBlob(server, token, file.id, file.mime);
      await exportFile(blob, file.name, 'Save or share file');
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (isImage && url) {
    return (
      <>
        <div className="attachment-image">
          <img src={url} alt={file.name} onClick={() => setLightbox(true)} />
          <div className="attachment-image-actions">
            <button type="button" onClick={() => setLightbox(true)} aria-label="View full size">
              <Maximize2 size={14} />
            </button>
            <button type="button" onClick={download} aria-label={`Download ${file.name}`}>
              <Download size={14} />
            </button>
          </div>
        </div>
        {lightbox && (
          <div className="term-lightbox" onClick={() => setLightbox(false)} role="dialog" aria-modal="true">
            <button
              type="button"
              className="term-lightbox-close"
              onClick={() => setLightbox(false)}
              aria-label="Close image preview"
            >
              <X size={20} />
            </button>
            <img src={url} alt={file.name} onClick={e => e.stopPropagation()} />
          </div>
        )}
      </>
    );
  }

  if (isAudio && url) {
    return (
      <div className="attachment-audio">
        <div className="audio-caption">
          <span>VOICE NOTE</span>
          <span>{fileSize(file.size)}</span>
        </div>
        <audio controls preload="metadata" src={url}>
          Your browser cannot play this audio.
        </audio>
        <button type="button" onClick={download}>
          Save audio
        </button>
      </div>
    );
  }

  if (isVideo && url) {
    return (
      <div className="attachment-video">
        <video controls preload="metadata" playsInline src={url} />
        <div className="video-caption">
          <span>{file.name}</span>
          <button type="button" onClick={download}>
            <Download size={13} /> {fileSize(file.size)}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className={`attachment-file ${mine ? 'mine' : ''}`} onClick={download} disabled={loading}>
      <span className="attachment-file-icon">
        {isImage ? <ImageIcon size={18} /> : isVideo ? <Film size={18} /> : <FileText size={18} />}
      </span>
      <span className="attachment-file-name">
        <strong>{file.name}</strong>
        <small>{failed ? 'Retry download' : fileSize(file.size)}</small>
      </span>
      {loading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
    </button>
  );
}
