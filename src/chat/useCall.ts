import { useCallback, useEffect, useRef, useState } from 'react';
import type { Signal, SignalEvent, TurnConfig } from './types';

type Status = 'idle' | 'incoming' | 'calling' | 'connecting' | 'connected';
type CallState = {status: Status; peer: string; id: string; video: boolean; offer?: RTCSessionDescriptionInit};
const IDLE: CallState = {status: 'idle', peer: '', id: '', video: false};

export function useCall(signals: SignalEvent[], sendSignal: (to: string, data: Signal) => void, available: boolean, toast: (text: string) => void, turn: TurnConfig, presence: Record<string, boolean>) {
  const [call, setCall] = useState<CallState>(IDLE);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const callRef = useRef(call);
  const sendRef = useRef(sendSignal);
  const peer = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const localCandidates = useRef<RTCIceCandidateInit[]>([]);
  const signalingReady = useRef(false);
  const lastSignal = useRef(0);
  const signalChain = useRef(Promise.resolve());
  const timeout = useRef<number | undefined>(undefined);
  sendRef.current = sendSignal;

  const setState = useCallback((state: CallState) => { callRef.current = state; setCall(state); }, []);

  const cleanup = useCallback(() => {
    window.clearTimeout(timeout.current);
    const pc = peer.current;
    peer.current = null;
    if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.close(); }
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    pendingCandidates.current = [];
    localCandidates.current = [];
    signalingReady.current = false;
    setLocal(null); setRemote(null); setMuted(false); setCameraOff(false); setState(IDLE);
  }, [setState]);

  const hangup = useCallback((notify = true) => {
    const current = callRef.current;
    if (notify && current.status !== 'idle') {
      try { sendRef.current(current.peer, {type: current.status === 'incoming' ? 'decline' : 'end', callId: current.id}); } catch { /* already disconnected */ }
    }
    cleanup();
  }, [cleanup]);

  const createConnection = useCallback(async (target: string, callId: string, video: boolean) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require HTTPS or localhost.');
    const localStream = await navigator.mediaDevices.getUserMedia({audio: true, video});
    if (callRef.current.id !== callId) {
      localStream.getTracks().forEach(track => track.stop());
      throw new Error('Call cancelled.');
    }
    stream.current = localStream;
    setLocal(localStream);
    const iceServers: RTCIceServer[] = [{urls: 'stun:stun.l.google.com:19302'}];
    if (turn.url.trim()) iceServers.push({urls: turn.url.trim(), username: turn.username, credential: turn.credential});
    const connection = new RTCPeerConnection({iceServers});
    peer.current = connection;
    localStream.getTracks().forEach(track => connection.addTrack(track, localStream));
    connection.onicecandidate = event => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!signalingReady.current) localCandidates.current.push(candidate);
      else {
        try { sendRef.current(target, {type: 'candidate', callId, candidate}); } catch { /* the connection will close */ }
      }
    };
    connection.ontrack = event => {
      if (event.streams[0]) setRemote(event.streams[0]);
    };
    connection.onconnectionstatechange = () => {
      if (callRef.current.id !== callId) return;
      if (connection.connectionState === 'connected') {
        window.clearTimeout(timeout.current);
        setState({...callRef.current, status: 'connected'});
      } else if (connection.connectionState === 'failed') {
        toast('Could not connect directly. A TURN relay may be needed on this network.');
        hangup();
      }
    };
    return connection;
  }, [turn, hangup, setState, toast]);

  const flushLocal = useCallback((target: string, callId: string) => {
    signalingReady.current = true;
    localCandidates.current.forEach(candidate => {
      try { sendRef.current(target, {type: 'candidate', callId, candidate}); } catch { /* disconnected */ }
    });
    localCandidates.current = [];
  }, []);

  const flushRemote = useCallback(async (connection: RTCPeerConnection) => {
    for (const candidate of pendingCandidates.current) {
      try { await connection.addIceCandidate(candidate); } catch { /* a stale candidate is safe to ignore */ }
    }
    pendingCandidates.current = [];
  }, []);

  const start = useCallback(async (target: string, video: boolean) => {
    if (!available || callRef.current.status !== 'idle') return;
    const id = crypto.randomUUID();
    setState({status: 'calling', peer: target, id, video});
    try {
      const pc = await createConnection(target, id, video);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (callRef.current.id !== id) return;
      sendRef.current(target, {type: 'offer', callId: id, sdp: pc.localDescription?.toJSON(), video});
      flushLocal(target, id);
      timeout.current = window.setTimeout(() => { if (callRef.current.id === id && callRef.current.status !== 'connected') { toast('No answer yet.'); hangup(); } }, 60000);
    } catch (err) {
      if (callRef.current.id === id) { cleanup(); toast(err instanceof Error ? err.message : 'Could not start the call.'); }
    }
  }, [available, cleanup, createConnection, flushLocal, hangup, setState, toast]);

  const accept = useCallback(async () => {
    const current = callRef.current;
    if (current.status !== 'incoming' || !current.offer) return;
    setState({...current, status: 'connecting'});
    try {
      const pc = await createConnection(current.peer, current.id, current.video);
      await pc.setRemoteDescription(current.offer);
      await flushRemote(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (callRef.current.id !== current.id) return;
      sendRef.current(current.peer, {type: 'answer', callId: current.id, sdp: pc.localDescription?.toJSON()});
      flushLocal(current.peer, current.id);
      timeout.current = window.setTimeout(() => { if (callRef.current.id === current.id && callRef.current.status !== 'connected') { toast('Call could not connect. Try a TURN relay.'); hangup(); } }, 60000);
    } catch (err) {
      if (callRef.current.id === current.id) { hangup(); toast(err instanceof Error ? err.message : 'Could not answer the call.'); }
    }
  }, [createConnection, flushRemote, flushLocal, hangup, setState, toast]);

  const handleSignal = useCallback(async (event: SignalEvent) => {
    const data = event.data;
    if (!data || !data.callId) return;
    const current = callRef.current;
    if (data.type === 'offer' && data.sdp) {
      if (current.status !== 'idle') {
        try { sendRef.current(event.from, {type: 'decline', callId: data.callId}); } catch { /* disconnected */ }
      } else {
        setState({status: 'incoming', peer: event.from, id: data.callId, video: !!data.video, offer: data.sdp});
      }
      return;
    }
    if (current.id !== data.callId || current.peer !== event.from) return;
    if (data.type === 'candidate' && data.candidate) {
      if (peer.current?.remoteDescription) {
        try { await peer.current.addIceCandidate(data.candidate); } catch { /* a stale candidate is safe to ignore */ }
      } else pendingCandidates.current.push(data.candidate);
    } else if (data.type === 'answer' && data.sdp && peer.current) {
      try {
        await peer.current.setRemoteDescription(data.sdp);
        await flushRemote(peer.current);
        if (callRef.current.id === current.id) setState({...callRef.current, status: 'connecting'});
      } catch { hangup(); toast('Could not connect the call.'); }
    } else if (data.type === 'end' || data.type === 'decline') {
      cleanup();
      toast(data.type === 'decline' ? 'The call was declined.' : 'Call ended.');
    }
  }, [cleanup, flushRemote, hangup, setState, toast]);

  useEffect(() => {
    const fresh = signals.filter(event => event.id > lastSignal.current);
    if (fresh.length) lastSignal.current = fresh[fresh.length - 1].id;
    fresh.forEach(event => { signalChain.current = signalChain.current.then(() => handleSignal(event)).catch(() => {}); });
  }, [signals, handleSignal]);

  useEffect(() => {
    if (!available && callRef.current.status !== 'idle') { cleanup(); toast('Call ended because the server disconnected.'); }
  }, [available, cleanup, toast]);

  useEffect(() => {
    const current = callRef.current;
    if (current.status !== 'idle' && presence[current.peer] === false) {
      cleanup();
      toast('Call ended because the other person went offline.');
    }
  }, [presence, call.status, cleanup, toast]);

  useEffect(() => {
    if (call.status !== 'connected') return;
    const timer = window.setInterval(() => window.dispatchEvent(new Event('quad-call-activity')), 60000);
    return () => window.clearInterval(timer);
  }, [call.status]);

  useEffect(() => () => { peer.current?.close(); stream.current?.getTracks().forEach(track => track.stop()); window.clearTimeout(timeout.current); }, []);

  const toggleMute = () => { const next = !muted; stream.current?.getAudioTracks().forEach(track => {track.enabled = !next;}); setMuted(next); };
  const toggleCamera = () => { const next = !cameraOff; stream.current?.getVideoTracks().forEach(track => {track.enabled = !next;}); setCameraOff(next); };
  return {call, local, remote, muted, cameraOff, start, accept, hangup, toggleMute, toggleCamera};
}

export type Call = ReturnType<typeof useCall>;
