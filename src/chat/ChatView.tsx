import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Camera as NativeCamera, CameraResultType, CameraSource } from '@capacitor/camera';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Hash,
  Lock,
  LogOut,
  Mic,
  Paperclip,
  Phone,
  Plus,
  RotateCw,
  Search,
  Send,
  Settings2,
  Square,
  ThumbsUp,
  UploadCloud,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useLockManager } from '../security/useLockManager';
import { Brand } from './Auth';
import { Attachment } from './Attachment';
import { CallOverlay } from './CallOverlay';
import { CameraModal } from './CameraModal';
import { Settings, type Theme } from './Settings';
import { Avatar, dayLabel, timeLabel } from './shared';
import { directRoom, GENERAL, normalizeRoomId, type Member, type Message, type ReplyRef, type TurnConfig } from './types';
import { useCall } from './useCall';
import type { Chat } from './useChat';
import { useBackHandler, useIsNarrowViewport } from '../lib/backButton';

function getLast(messages: Message[], roomId: string) {
  const canonical = normalizeRoomId(roomId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (normalizeRoomId(messages[i].room) === canonical) return messages[i];
  }
  return undefined;
}

function previewText(message?: Message, own = false) {
  if (!message) return 'No messages yet';
  if (message.file) {
    const kind = message.file.mime.startsWith('audio/')
      ? 'Voice note'
      : message.file.mime.startsWith('image/')
        ? 'Image'
        : message.file.mime.startsWith('video/')
          ? 'Video'
          : message.file.name;
    return `${own ? 'You: ' : ''}${kind}`;
  }
  return `${own ? 'You: ' : ''}${message.text}`;
}

function findMember(members: Member[], id: string) {
  return members.find(m => m.id === id);
}

export function ChatView({
  chat,
  theme,
  setTheme,
}: {
  chat: Chat;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const lock = useLockManager();
  const me = chat.session!.member;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  // On narrow screens the directory is a drawer (off by default); on wide
  // screens it is a docked column.
  const [showPeople, setShowPeople] = useState(
    () => (typeof window === 'undefined' ? true : window.innerWidth > 1060),
  );
  const [mobileList, setMobileList] = useState(false);
  const [search, setSearch] = useState('');
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState('');
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomTopic, setNewRoomTopic] = useState('');
  const [replyTarget, setReplyTarget] = useState<ReplyRef | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [turn, setTurn] = useState<TurnConfig>({ url: '', username: '', credential: '' });

  // Android hardware back button: close whichever modal/drawer/sub-view is
  // open, instead of letting the OS exit the app. Order doesn't matter much
  // here since normally only one of these is open at a time; whichever was
  // toggled open most recently takes priority.
  const isNarrow = useIsNarrowViewport();
  useBackHandler(cameraOpen, () => setCameraOpen(false));
  useBackHandler(settingsOpen, () => setSettingsOpen(false));
  useBackHandler(newRoomOpen, () => setNewRoomOpen(false));
  useBackHandler(threadSearchOpen, () => {
    setThreadSearchOpen(false);
    setThreadQuery('');
  });
  useBackHandler(isNarrow && showPeople, () => setShowPeople(false));
  useBackHandler(isNarrow && !mobileList, () => setMobileList(true));

  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordStream = useRef<MediaStream | null>(null);
  const recordTimer = useRef<number | undefined>(undefined);
  const cancelRecording = useRef(false);
  const recordingRoom = useRef('');
  const nearBottom = useRef(true);
  const prevMsgCount = useRef(0);
  const currentRoom = useRef(chat.room);
  currentRoom.current = chat.room;

  const call = useCall(
    chat.signals,
    chat.sendSignal,
    chat.online && chat.link === 'live',
    chat.toast,
    turn,
    chat.presence,
  );

  const isDirect = chat.room.startsWith('dm:');
  const activeChannel = !isDirect
    ? chat.rooms.find(r => normalizeRoomId(r.id) === normalizeRoomId(chat.room)) || chat.rooms[0]
    : undefined;
  const peerId = isDirect ? chat.room.split(':').slice(1).find(id => id !== me.id) || '' : '';
  const other = findMember(chat.members, peerId);

  const otherMembers = useMemo(
    () => chat.members.filter(member => member.id !== me.id),
    [chat.members, me.id],
  );

  const q = search.toLowerCase().trim();
  const visibleChannels = useMemo(
    () => (q ? chat.rooms.filter(r => `${r.name} ${r.topic || ''}`.toLowerCase().includes(q)) : chat.rooms),
    [chat.rooms, q],
  );
  const visibleMembers = useMemo(
    () => (q ? otherMembers.filter(m => `${m.name} ${m.handle}`.toLowerCase().includes(q)) : otherMembers),
    [otherMembers, q],
  );

  const roomMessages = useMemo(() => {
    const canonical = normalizeRoomId(chat.room);
    const list = chat.messages.filter(m => normalizeRoomId(m.room) === canonical);
    if (!threadQuery.trim()) return list;
    const needle = threadQuery.toLowerCase().trim();
    return list.filter(m => `${m.text} ${m.file?.name || ''}`.toLowerCase().includes(needle));
  }, [chat.messages, chat.room, threadQuery]);

  const onlineCount = Object.values(chat.presence).filter(Boolean).length;
  const typingMembers = (chat.typing[normalizeRoomId(chat.room)] || [])
    .filter(id => id !== me.id)
    .map(id => findMember(chat.members, id)?.name || 'Someone');

  // Anchor scroll cleanly on room switch without jumping during optimistic ID swaps
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    nearBottom.current = true;
    prevMsgCount.current = roomMessages.length;
    setReplyTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.room]);

  useEffect(() => {
    const countIncreased = roomMessages.length > prevMsgCount.current;
    prevMsgCount.current = roomMessages.length;
    if (countIncreased && nearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [roomMessages.length]);

  // Mark unseen incoming messages in active room as read when viewed/focused
  useEffect(() => {
    const hasUnreadFromOthers = roomMessages.some(
      m => m.author !== me.id && !(m.readBy || []).includes(me.id),
    );
    if (hasUnreadFromOthers && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
      chat.markRoomAsRead(chat.room);
    }
    const onFocus = () => chat.markRoomAsRead(chat.room);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [chat, chat.room, me.id, roomMessages]);

  useEffect(() => {
    return () => {
      cancelRecording.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      recordStream.current?.getTracks().forEach(track => track.stop());
      window.clearInterval(recordTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!chat.online && recorder.current?.state === 'recording') {
      cancelRecording.current = true;
      recorder.current.stop();
    }
  }, [chat.online]);

  const selectRoom = (nextRoom: string) => {
    if (recorder.current?.state === 'recording') {
      stopRecording(true);
      chat.toast('Voice recording cancelled on room switch.');
    }
    chat.sendTyping(false);
    chat.openRoom(nextRoom);
    setDraft('');
    setMobileList(false);
  };

  const handleSend = () => {
    if (draft.length > 4000) {
      chat.toast('Messages are capped at 4,000 characters.');
      return;
    }
    nearBottom.current = true;
    if (chat.send(draft, replyTarget || undefined)) {
      setDraft('');
      setReplyTarget(null);
      chat.sendTyping(false);
      textareaRef.current?.focus();
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    chat.sendTyping(Boolean(value.trim()));
  };

  async function uploadFile(file?: File | null, targetRoom?: string) {
    if (!file) return;
    setUploading(true);
    nearBottom.current = true;
    try {
      await chat.upload(file, targetRoom);
    } catch (err) {
      chat.toast(err instanceof Error ? err.message : 'Could not send file.');
    } finally {
      setUploading(false);
    }
  }

  async function openCamera() {
    if (Capacitor.isNativePlatform()) {
      try {
        const photo = await NativeCamera.getPhoto({
          quality: 85,
          allowEditing: false,
          source: CameraSource.Camera,
          resultType: CameraResultType.Uri,
        });
        if (!photo.webPath) throw new Error('Could not read camera frame.');
        const blob = await (await fetch(photo.webPath)).blob();
        await uploadFile(
          new File([blob], `photo-${Date.now()}.${photo.format || 'jpg'}`, {
            type: blob.type || 'image/jpeg',
          }),
        );
      } catch (err) {
        if (err instanceof Error && !/cancel/i.test(err.message)) chat.toast(err.message);
      }
    } else {
      setCameraOpen(true);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      chat.toast('Microphone requires HTTPS or localhost.');
      return;
    }
    try {
      const requestedRoom = chat.room;
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (currentRoom.current !== requestedRoom) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      recordStream.current = media;
      cancelRecording.current = false;
      recordingRoom.current = requestedRoom;
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type =>
        MediaRecorder.isTypeSupported(type),
      );
      const next = new MediaRecorder(media, preferred ? { mimeType: preferred } : undefined);
      recorder.current = next;
      const chunks: BlobPart[] = [];
      next.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      next.onstop = () => {
        window.clearInterval(recordTimer.current);
        media.getTracks().forEach(track => track.stop());
        recordStream.current = null;
        recorder.current = null;
        setRecording(false);
        if (cancelRecording.current || !chunks.length) return;
        const mime = (next.mimeType || 'audio/webm').split(';')[0];
        const extension = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
        const blob = new Blob(chunks, { type: mime });
        void uploadFile(new File([blob], `voice-${Date.now()}.${extension}`, { type: mime }), recordingRoom.current);
      };
      next.start();
      setRecordingSeconds(0);
      setRecording(true);
      let elapsed = 0;
      recordTimer.current = window.setInterval(() => {
        elapsed++;
        setRecordingSeconds(elapsed);
        if (elapsed >= 120 && next.state === 'recording') next.stop();
      }, 1000);
    } catch (err) {
      recordStream.current?.getTracks().forEach(track => track.stop());
      chat.toast(err instanceof Error ? err.message : 'Microphone access denied.');
    }
  }

  function stopRecording(cancel = false) {
    cancelRecording.current = cancel;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }

  async function submitNewChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    try {
      await chat.createChannel(newRoomName.trim(), newRoomTopic.trim());
      setNewRoomName('');
      setNewRoomTopic('');
      setNewRoomOpen(false);
    } catch (err) {
      chat.toast(err instanceof Error ? err.message : 'Could not create channel.');
    }
  }

  function triggerLockScreen() {
    call.hangup();
    lock.lockApp();
  }

  function copyServerUrl() {
    navigator.clipboard
      ?.writeText(chat.server)
      .then(() => chat.toast('Server URL copied to clipboard.'))
      .catch(() => chat.toast(chat.server));
  }

  return (
    <div
      className="term-workspace"
      style={{ '--accent': theme.color } as React.CSSProperties}
      onDragOver={e => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) void uploadFile(dropped);
      }}
    >
      {/* Left Navigation Rail */}
      <aside className="term-rail">
        <button
          type="button"
          className="term-rail-logo"
          onClick={() => selectRoom(GENERAL)}
          title="Terminal — #general"
          aria-label="Open General channel"
        >
          <span>&gt;_</span>
        </button>

        <div className="term-rail-nav">
          <button
            type="button"
            className={`term-rail-btn ${!showPeople || mobileList ? 'active' : ''}`}
            title="Channels & Direct Messages"
            aria-label="Conversations"
            onClick={() => setMobileList(true)}
          >
            <Hash size={19} />
          </button>
          <button
            type="button"
            className={`term-rail-btn ${showPeople ? 'active' : ''}`}
            title="Toggle Directory"
            aria-label="People"
            onClick={() => setShowPeople(v => !v)}
          >
            <Users size={19} />
          </button>
        </div>

        <div className="term-rail-footer">
          <button
            type="button"
            className="term-rail-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <Settings2 size={19} />
          </button>
          <button
            type="button"
            className="term-rail-btn"
            onClick={triggerLockScreen}
            title="Lock Terminal (PIN Keypad)"
            aria-label="Lock chat"
          >
            <Lock size={18} />
          </button>
          <button
            type="button"
            className="term-rail-btn"
            onClick={() => {
              call.hangup();
              chat.signOut();
            }}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={18} />
          </button>
          <Avatar member={me} size="sm" online />
        </div>
      </aside>

      {/* Channels & Direct Messages Sidebar */}
      <aside className={`term-sidebar ${mobileList ? 'mobile-visible' : ''}`}>
        <header className="term-sidebar-head">
          <Brand />
          <div className="term-sidebar-head-actions">
            <span className={`term-conn-tag ${chat.link === 'live' ? 'live' : ''}`}>
              <span className="term-dot" />
              {chat.link === 'live' ? 'LIVE' : 'SYNC'}
            </span>
            <button
              type="button"
              className="term-icon-btn mobile-only-btn"
              onClick={triggerLockScreen}
              aria-label="Lock chat"
              title="Lock Terminal"
            >
              <Lock size={16} />
            </button>
            <button
              type="button"
              className="term-icon-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
            >
              <Settings2 size={16} />
            </button>
          </div>
        </header>

        <div className="term-search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter channels or people…"
            aria-label="Search channels or people"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="term-sidebar-scroll">
          {/* CHANNELS — General is ALWAYS guaranteed present */}
          <div className="term-section-header">
            <span>CHANNELS ({visibleChannels.length})</span>
            <button
              type="button"
              className="term-section-action"
              onClick={() => setNewRoomOpen(v => !v)}
              aria-label="Create channel"
              title="Create channel"
            >
              <Plus size={14} />
            </button>
          </div>

          {newRoomOpen && (
            <form className="term-new-room-form" onSubmit={submitNewChannel}>
              <input
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                placeholder="channel-name"
                maxLength={26}
                autoFocus
                required
              />
              <input
                value={newRoomTopic}
                onChange={e => setNewRoomTopic(e.target.value)}
                placeholder="Topic (optional)"
                maxLength={80}
              />
              <div className="term-new-room-btns">
                <button type="button" className="term-btn-ghost" onClick={() => setNewRoomOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="term-btn-primary">
                  Create
                </button>
              </div>
            </form>
          )}

          {visibleChannels.map(ch => {
            const selected = !isDirect && normalizeRoomId(chat.room) === normalizeRoomId(ch.id);
            const last = getLast(chat.messages, ch.id);
            const unreadCount = chat.unread[normalizeRoomId(ch.id)] || 0;
            const chTyping = (chat.typing[normalizeRoomId(ch.id)] || []).filter(id => id !== me.id);
            return (
              <button
                type="button"
                key={ch.id}
                className={`term-nav-row ${selected ? 'selected' : ''}`}
                onClick={() => selectRoom(ch.id)}
              >
                <Avatar group size="sm" />
                <span className="term-nav-copy">
                  <span className="term-nav-top">
                    <strong>{ch.name}</strong>
                    {last && <small>{timeLabel(last.ts)}</small>}
                  </span>
                  <span className="term-nav-bottom">
                    <span className={chTyping.length ? 'is-typing' : ''}>
                      {chTyping.length
                        ? 'Someone is typing…'
                        : last
                          ? previewText(last, last.author === me.id)
                          : ch.topic || 'Channel ready'}
                    </span>
                    {unreadCount > 0 && <b className="term-unread-pill">{unreadCount}</b>}
                  </span>
                </span>
              </button>
            );
          })}

          {/* DIRECT MESSAGES */}
          <div className="term-section-header">
            <span>DIRECT MESSAGES ({otherMembers.length})</span>
          </div>

          {visibleMembers.map(member => {
            const dm = directRoom(me.id, member.id);
            const selected = chat.room === dm;
            const last = getLast(chat.messages, dm);
            const isPeerTyping = (chat.typing[dm] || []).includes(member.id);
            const unreadCount = chat.unread[dm] || 0;
            return (
              <button
                type="button"
                key={member.id}
                className={`term-nav-row ${selected ? 'selected' : ''}`}
                onClick={() => selectRoom(dm)}
              >
                <Avatar member={member} size="sm" online={Boolean(chat.presence[member.id])} />
                <span className="term-nav-copy">
                  <span className="term-nav-top">
                    <strong>{member.name}</strong>
                    {last && <small>{timeLabel(last.ts)}</small>}
                  </span>
                  <span className="term-nav-bottom">
                    <span className={isPeerTyping ? 'is-typing' : ''}>
                      {isPeerTyping
                        ? 'typing…'
                        : last
                          ? previewText(last, last.author === me.id)
                          : chat.presence[member.id]
                            ? 'Online'
                            : `@${member.handle}`}
                    </span>
                    {unreadCount > 0 && <b className="term-unread-pill">{unreadCount}</b>}
                  </span>
                </span>
              </button>
            );
          })}

          {visibleMembers.length === 0 && (
            <div className="term-sidebar-empty">
              {q ? 'No matching members.' : 'Invite teammates to start direct messages.'}
            </div>
          )}
        </div>

        <button type="button" className="term-user-bar" onClick={() => setSettingsOpen(true)}>
          <Avatar member={me} size="sm" online />
          <span className="term-user-meta">
            <strong>{me.name}</strong>
            <small>@{me.handle}</small>
          </span>
          <Settings2 size={15} />
        </button>
      </aside>

      {/* Main Message Thread */}
      <main className={`term-thread ${mobileList ? 'mobile-hidden' : ''}`}>
        {dragOver && (
          <div className="term-drop-overlay">
            <UploadCloud size={32} />
            <strong>Drop media or file to compress &amp; send</strong>
            <span>Images auto-convert to 1920px WebP (80%)</span>
          </div>
        )}

        <header className="term-thread-header">
          <button
            type="button"
            className="term-icon-btn mobile-back-btn"
            onClick={() => setMobileList(true)}
            aria-label="Back to conversations"
          >
            <ArrowLeft size={19} />
          </button>

          <Avatar
            member={other}
            group={!isDirect}
            size="sm"
            online={isDirect ? Boolean(chat.presence[peerId]) : undefined}
          />

          <div className="term-thread-title">
            <h2>{!isDirect ? activeChannel?.name || 'General' : other?.name || 'Direct Message'}</h2>
            <p>
              <span className={`term-dot ${!isDirect || chat.presence[peerId] ? 'online' : ''}`} />
              {!isDirect
                ? `${onlineCount} online · ${chat.members.length || 1} members${activeChannel?.topic ? ` · ${activeChannel.topic}` : ''}`
                : chat.presence[peerId]
                  ? `Online · @${other?.handle || ''}`
                  : `Offline · @${other?.handle || ''}`}
            </p>
          </div>

          <div className="term-thread-actions">
            {isDirect && (
              <>
                <button
                  type="button"
                  className="term-icon-btn"
                  disabled={!chat.presence[peerId] || chat.link !== 'live'}
                  onClick={() => call.start(peerId, false)}
                  aria-label="Start voice call"
                  title="Start voice call"
                >
                  <Phone size={17} />
                </button>
                <button
                  type="button"
                  className="term-icon-btn"
                  disabled={!chat.presence[peerId] || chat.link !== 'live'}
                  onClick={() => call.start(peerId, true)}
                  aria-label="Start video call"
                  title="Start video call"
                >
                  <Video size={18} />
                </button>
              </>
            )}
            <button
              type="button"
              className={`term-icon-btn ${threadSearchOpen ? 'active' : ''}`}
              onClick={() => {
                setThreadSearchOpen(v => !v);
                setThreadQuery('');
              }}
              aria-label="Filter messages"
              title="Filter messages"
            >
              <Search size={17} />
            </button>
            <button
              type="button"
              className="term-icon-btn"
              onClick={triggerLockScreen}
              aria-label="Lock workspace"
              title="Lock workspace"
            >
              <Lock size={17} />
            </button>
            <button
              type="button"
              className={`term-icon-btn people-toggle ${showPeople ? 'active' : ''}`}
              onClick={() => setShowPeople(v => !v)}
              aria-label={showPeople ? 'Hide people panel' : 'Show people panel'}
              title="Directory"
            >
              <Users size={17} />
            </button>
          </div>
        </header>

        {threadSearchOpen && (
          <div className="term-thread-filter">
            <Search size={14} />
            <input
              value={threadQuery}
              onChange={e => setThreadQuery(e.target.value)}
              placeholder="Search messages in this conversation…"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                setThreadQuery('');
                setThreadSearchOpen(false);
              }}
              aria-label="Close message search"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div
          className="term-messages-scroller"
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget;
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
        >
          <div className="term-messages-inner">
            {roomMessages.length === 0 && (
              <div className="term-empty-thread">
                <div className="term-empty-badge">
                  <Hash size={22} />
                </div>
                <h3>{!isDirect ? `#${activeChannel?.id || 'general'}` : other?.name || 'Direct Message'}</h3>
                <p>
                  {threadQuery
                    ? 'No messages match your filter.'
                    : !isDirect
                      ? 'Channel initialized. Messages and files are encrypted at rest on your server.'
                      : `Direct encrypted channel with @${other?.handle || 'peer'}.`}
                </p>
              </div>
            )}

            {roomMessages.map((message, index) => {
              const previous = roomMessages[index - 1];
              const next = roomMessages[index + 1];
              const mine = message.author === me.id;
              const author = findMember(chat.members, message.author);
              const samePrevious =
                Boolean(previous) &&
                previous.author === message.author &&
                new Date(previous.ts).toDateString() === new Date(message.ts).toDateString() &&
                message.ts - previous.ts < 5 * 60 * 1000;
              const sameNext =
                Boolean(next) &&
                next.author === message.author &&
                new Date(next.ts).toDateString() === new Date(message.ts).toDateString() &&
                next.ts - message.ts < 5 * 60 * 1000;
              const newDay =
                !previous || new Date(previous.ts).toDateString() !== new Date(message.ts).toDateString();

              const likes = message.reactions?.like || [];
              const stableKey = message.clientId || message.id;
              const msgStatus = message.status || (message.failed ? 'failed' : message.pending ? 'sending' : 'sent');

              return (
                <div key={stableKey} className="term-msg-group">
                  {newDay && (
                    <div className="term-day-line">
                      <span />
                      <b>{dayLabel(message.ts)}</b>
                      <span />
                    </div>
                  )}

                  <div className={`term-msg-row ${mine ? 'mine' : ''} ${samePrevious ? 'compact' : ''}`}>
                    {!mine && (
                      <div className="term-msg-avatar">
                        {!samePrevious ? <Avatar member={author} size="sm" /> : null}
                      </div>
                    )}

                    <div className="term-msg-col">
                      {!mine && !samePrevious && (
                        <div className="term-msg-sender">
                          <strong>{author?.name || 'Member'}</strong>
                          <span>@{author?.handle || 'user'}</span>
                        </div>
                      )}

                      <div className="term-bubble-wrap">
                        <div
                          className={`term-bubble ${message.file ? 'has-media' : ''} ${
                            msgStatus === 'failed' ? 'is-failed' : ''
                          }`}
                        >
                          {message.replyTo && (
                            <div className="term-reply-quote">
                              <strong>{message.replyTo.authorName}</strong>
                              <span>{message.replyTo.preview}</span>
                            </div>
                          )}
                          {message.file && (
                            <Attachment
                              file={message.file}
                              server={chat.server}
                              token={chat.session!.token}
                              mine={mine}
                            />
                          )}
                          {message.text && <p>{message.text}</p>}
                        </div>

                        <div className="term-msg-hover-tools">
                          <button
                            type="button"
                            className="term-tool-btn"
                            onClick={() => chat.react(message.id, 'like')}
                            disabled={msgStatus === 'sending' || msgStatus === 'failed'}
                            aria-label={likes.includes(me.id) ? 'Remove like' : 'Like message'}
                            title="Like message"
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <button
                            type="button"
                            className="term-tool-btn"
                            onClick={() =>
                              setReplyTarget({
                                id: message.id,
                                authorName: mine ? 'You' : author?.name || 'Member',
                                preview: message.text || message.file?.name || 'Attachment',
                              })
                            }
                            aria-label="Reply to message"
                            title="Reply"
                          >
                            <CornerUpLeft size={13} />
                          </button>
                        </div>
                      </div>

                      {likes.length > 0 && (
                        <button
                          type="button"
                          className={`term-reaction-pill ${likes.includes(me.id) ? 'selected' : ''}`}
                          onClick={() => chat.react(message.id, 'like')}
                          aria-label={`${likes.length} likes; toggle yours`}
                        >
                          <ThumbsUp size={11} />
                          <span>{likes.length}</span>
                        </button>
                      )}

                      {(!sameNext || msgStatus === 'failed' || msgStatus === 'sending') && (
                        <div className="term-msg-meta">
                          <span>{timeLabel(message.ts)}</span>
                          {mine && (
                            <>
                              {msgStatus === 'sending' && (
                                <span className="term-delivery sending">
                                  <Clock size={11} /> Sending…
                                </span>
                              )}
                              {msgStatus === 'sent' && (
                                <span className="term-delivery sent" title="Sent">
                                  <Check size={13} /> Sent
                                </span>
                              )}
                              {msgStatus === 'read' && (
                                <span className="term-delivery read" title="Read">
                                  <CheckCheck size={14} /> Read
                                </span>
                              )}
                              {msgStatus === 'failed' && (
                                <span className="term-delivery failed">
                                  <AlertCircle size={12} /> Failed
                                  <button
                                    type="button"
                                    className="term-retry-btn"
                                    onClick={() => chat.retryMessage(stableKey)}
                                  >
                                    <RotateCw size={11} /> Retry
                                  </button>
                                  <button
                                    type="button"
                                    className="term-dismiss-btn"
                                    onClick={() => chat.dismissFailedMessage(stableKey)}
                                  >
                                    Dismiss
                                  </button>
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Composer + Typing Pill + Media Compression/Upload Progress */}
        <div className="term-composer-zone">
          {typingMembers.length > 0 && (
            <div className="term-typing-pill" role="status" aria-live="polite">
              <span className="term-typing-dots">
                <i />
                <i />
                <i />
              </span>
              <span>
                {typingMembers.join(', ')} {typingMembers.length > 1 ? 'are' : 'is'} typing...
              </span>
            </div>
          )}

          {chat.uploadProgress && (
            <div className="term-upload-progress" role="progressbar" aria-valuenow={chat.uploadProgress.percent}>
              <div className="term-upload-meta">
                <span className="term-upload-stage">
                  {chat.uploadProgress.phase === 'compressing' ? 'COMPRESSING MEDIA' : 'UPLOADING'}
                </span>
                <span className="term-upload-detail">{chat.uploadProgress.detail}</span>
                <strong>{chat.uploadProgress.percent}%</strong>
              </div>
              <div className="term-upload-track">
                <div className="term-upload-fill" style={{ width: `${chat.uploadProgress.percent}%` }} />
              </div>
            </div>
          )}

          {replyTarget && (
            <div className="term-reply-banner">
              <CornerUpLeft size={14} />
              <div>
                <strong>Replying to {replyTarget.authorName}</strong>
                <span>{replyTarget.preview}</span>
              </div>
              <button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">
                <X size={14} />
              </button>
            </div>
          )}

          {recording ? (
            <div className="term-recording-bar">
              <span className="term-rec-dot" />
              <span>Recording voice message</span>
              <strong>
                {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, '0')}
              </strong>
              <button type="button" className="term-btn-ghost" onClick={() => stopRecording(true)}>
                Cancel
              </button>
              <button type="button" className="term-btn-primary record-send" onClick={() => stopRecording(false)}>
                <Square size={12} fill="currentColor" /> Send
              </button>
            </div>
          ) : (
            <div className="term-composer-box">
              <input
                className="visually-hidden"
                ref={fileInput}
                type="file"
                onChange={e => {
                  void uploadFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="term-compose-btn"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                title="Attach file or media (images auto-compress to WebP)"
                aria-label="Share a file"
              >
                <Paperclip size={18} />
              </button>
              <button
                type="button"
                className="term-compose-btn"
                onClick={openCamera}
                disabled={uploading}
                title="Take photo"
                aria-label="Take a photo"
              >
                <Camera size={18} />
              </button>
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                maxLength={4000}
                onChange={e => handleDraftChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  uploading
                    ? 'Processing media…'
                    : !isDirect
                      ? `Message #${activeChannel?.id || 'general'}…`
                      : `Message @${other?.handle || 'peer'}…`
                }
                disabled={uploading}
                aria-label="Write a message"
              />
              <button
                type="button"
                className="term-compose-btn"
                onClick={startRecording}
                disabled={uploading}
                title="Record voice note"
                aria-label="Record a voice message"
              >
                <Mic size={18} />
              </button>
              <button
                type="button"
                className="term-send-btn"
                onClick={handleSend}
                disabled={!draft.trim() || uploading}
                aria-label="Send message"
              >
                <Send size={16} />
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Right Member Directory Drawer */}
      {showPeople && (
        <aside className="term-directory">
          <header className="term-directory-head">
            <div>
              <h2>Directory</h2>
              <span>{chat.members.length} registered</span>
            </div>
            <button
              type="button"
              className="term-icon-btn"
              onClick={() => setShowPeople(false)}
              aria-label="Close people panel"
            >
              <X size={16} />
            </button>
          </header>

          <div className="term-directory-list">
            {chat.members.map(member => (
              <button
                type="button"
                key={member.id}
                className="term-member-row"
                onClick={() => {
                  if (member.id !== me.id) selectRoom(directRoom(me.id, member.id));
                }}
                disabled={member.id === me.id}
              >
                <Avatar member={member} size="sm" online={Boolean(chat.presence[member.id])} />
                <div>
                  <strong>
                    {member.name}
                    {member.id === me.id ? ' (you)' : ''}
                  </strong>
                  <small>
                    @{member.handle} · {chat.presence[member.id] ? 'online' : 'offline'}
                  </small>
                </div>
              </button>
            ))}
          </div>

          <div className="term-directory-foot">
            <div className="term-server-card">
              <code>{chat.server}</code>
              <button type="button" className="term-btn-ghost" onClick={copyServerUrl}>
                <Copy size={13} /> Copy server URL
              </button>
            </div>
          </div>
        </aside>
      )}

      {showPeople && (
        <button
          type="button"
          className="term-drawer-scrim"
          aria-label="Close directory"
          onClick={() => setShowPeople(false)}
        />
      )}

      {/* Native-app bottom navigation (mobile only) */}
      <nav className="term-tabbar" aria-label="Primary">
        <button type="button" className={mobileList ? 'active' : ''} onClick={() => setMobileList(true)}>
          <Hash size={20} />
          <span>Channels</span>
        </button>
        <button type="button" className={showPeople ? 'active' : ''} onClick={() => setShowPeople(true)}>
          <Users size={20} />
          <span>People</span>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={20} />
          <span>Settings</span>
        </button>
        <button type="button" onClick={triggerLockScreen}>
          <Lock size={20} />
          <span>Lock</span>
        </button>
      </nav>

      {settingsOpen && (
        <Settings
          chat={chat}
          theme={theme}
          setTheme={setTheme}
          turn={turn}
          setTurn={setTurn}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {cameraOpen && (
        <CameraModal
          onClose={() => setCameraOpen(false)}
          onCapture={file => {
            setCameraOpen(false);
            void uploadFile(file);
          }}
        />
      )}
      <CallOverlay call={call} members={chat.members} />
      {chat.notice && (
        <div className="toast" role="status">
          {chat.notice}
        </div>
      )}
    </div>
  );
}
