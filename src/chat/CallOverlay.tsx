import { useEffect, useRef } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, X } from 'lucide-react';
import { Avatar } from './shared';
import type { Member } from './types';
import type { Call } from './useCall';
import { useBackHandler } from '../lib/backButton';

export function CallOverlay({ call, members }: { call: Call; members: Member[] }) {
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const who = members.find(m => m.id === call.call.peer);

  // Hardware back button during a call hangs up instead of exiting the app.
  useBackHandler(call.call.status !== 'idle', () => call.hangup());

  useEffect(() => {
    if (remoteVideo.current) remoteVideo.current.srcObject = call.remote;
  }, [call.remote, call.call.status]);

  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = call.local;
  }, [call.local, call.call.status]);

  if (call.call.status === 'idle') return null;

  const label =
    call.call.status === 'incoming'
      ? `Incoming ${call.call.video ? 'video' : 'voice'} call`
      : call.call.status === 'calling'
        ? 'Calling…'
        : call.call.status === 'connecting'
          ? 'Negotiating P2P stream…'
          : 'Connected peer to peer';

  return (
    <div className="term-call-backdrop" role="dialog" aria-modal="true" aria-label={label}>
      <div className={`term-call-panel ${call.call.video && call.call.status === 'connected' ? 'with-video' : ''}`}>
        <div className="term-call-top">
          <span>
            <span className="term-dot online" /> TERMINAL P2P
          </span>
          <button type="button" onClick={() => call.hangup()} aria-label="End call">
            <X size={18} />
          </button>
        </div>
        <video
          ref={remoteVideo}
          className={`term-remote-video ${call.call.video && call.remote ? 'visible' : ''}`}
          autoPlay
          playsInline
        />
        {call.call.video && call.local && (
          <video ref={localVideo} className="term-local-video" autoPlay playsInline muted />
        )}
        {(!call.call.video || !call.remote) && (
          <div className="term-call-identity">
            <Avatar member={who} size="xl" />
            <h2>{who?.name || 'Peer'}</h2>
            <p>{label}</p>
          </div>
        )}
        {call.call.video && call.remote && (
          <div className="term-call-video-label">
            <strong>{who?.name || 'Peer'}</strong>
            <span>{label}</span>
          </div>
        )}
        <div className="term-call-controls">
          {call.call.status === 'incoming' ? (
            <>
              <button
                type="button"
                className="term-call-btn decline"
                onClick={() => call.hangup()}
                aria-label="Decline call"
              >
                <PhoneOff size={20} />
              </button>
              <button type="button" className="term-call-btn accept" onClick={call.accept} aria-label="Answer call">
                <Phone size={20} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`term-call-btn ${call.muted ? 'active' : ''}`}
                onClick={call.toggleMute}
                aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {call.muted ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
              {call.call.video && (
                <button
                  type="button"
                  className={`term-call-btn ${call.cameraOff ? 'active' : ''}`}
                  onClick={call.toggleCamera}
                  aria-label={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                >
                  {call.cameraOff ? <VideoOff size={19} /> : <Video size={19} />}
                </button>
              )}
              <button
                type="button"
                className="term-call-btn decline"
                onClick={() => call.hangup()}
                aria-label="End call"
              >
                <PhoneOff size={20} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
