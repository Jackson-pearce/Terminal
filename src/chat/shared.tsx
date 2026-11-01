import { Hash } from 'lucide-react';
import type { Member } from './types';

export function Avatar({
  member,
  size = 'md',
  online,
  group = false,
}: {
  member?: Member;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
  group?: boolean;
}) {
  const color = member?.hue || '#10b981';
  return (
    <span
      className={`avatar avatar-${size} ${group ? 'avatar-group' : ''}`}
      style={group ? undefined : { background: color }}
    >
      {group ? <Hash size={size === 'sm' ? 15 : 18} strokeWidth={2.4} /> : member?.initials || '?'}
      {typeof online === 'boolean' && <span className={`avatar-status ${online ? 'online' : ''}`} />}
    </span>
  );
}

export function timeLabel(ts: number) {
  const date = new Date(ts);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function dayLabel(ts: number) {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
