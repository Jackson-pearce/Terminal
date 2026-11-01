import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

export function CameraModal({
  onClose,
  onCapture,
}: {
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => {
    let alive = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access requires HTTPS or localhost.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(media => {
        if (!alive) {
          media.getTracks().forEach(track => track.stop());
          return;
        }
        stream.current = media;
        if (video.current) video.current.srcObject = media;
        setReady(true);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Camera permission was denied.'));
    return () => {
      alive = false;
      stream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  function capture() {
    if (!video.current || !ready) return;
    const vw = video.current.videoWidth;
    const vh = video.current.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, 1920 / Math.max(vw, vh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video.current, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      blob => {
        if (blob) {
          const isWebp = blob.type === 'image/webp';
          onCapture(
            new File([blob], `photo-${Date.now()}.${isWebp ? 'webp' : 'jpg'}`, {
              type: isWebp ? 'image/webp' : 'image/jpeg',
            }),
          );
        }
      },
      'image/webp',
      0.8,
    );
  }

  return (
    <div className="term-modal-backdrop" role="dialog" aria-modal="true" aria-label="Take a photo">
      <div className="term-camera-modal">
        <header className="term-modal-header">
          <h2>Capture Photo</h2>
          <button type="button" className="term-icon-btn" onClick={onClose} aria-label="Close camera">
            <X size={18} />
          </button>
        </header>
        <div className="term-camera-preview">
          <video ref={video} autoPlay playsInline muted />
          {error && <p>{error}</p>}
        </div>
        <div className="term-camera-footer">
          <button type="button" className="term-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="term-btn-primary" disabled={!ready} onClick={capture}>
            <Camera size={16} /> Take photo
          </button>
        </div>
      </div>
    </div>
  );
}
