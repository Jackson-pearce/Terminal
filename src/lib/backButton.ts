import { useEffect, useState } from 'react';

// A tiny LIFO stack so any open modal/drawer/sub-view in the app can claim
// the Android hardware back button while it is open, instead of the OS
// default (which, with no webview history, exits the app immediately).
//
// Usage: useBackHandler(isOpen, () => closeThatThing())
//
// Whichever handler was registered (or re-registered) most recently sits on
// top of the stack and gets first refusal. If nothing has claimed the back
// button, the top-level listener (see App.tsx) falls through to sending the
// app to the background instead of killing it.

type Handler = () => void;

let seq = 0;
const stack: { id: number; handler: Handler }[] = [];

export function pushBackHandler(handler: Handler): () => void {
  const id = seq++;
  stack.push({ id, handler });
  return () => {
    const idx = stack.findIndex(entry => entry.id === id);
    if (idx !== -1) stack.splice(idx, 1);
  };
}

/** Called by the single top-level Capacitor listener. Returns true if something handled it. */
export function consumeBackPress(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.handler();
  return true;
}

/** Register `onBack` to run on hardware-back while `active` is true. */
export function useBackHandler(active: boolean, onBack: Handler) {
  useEffect(() => {
    if (!active) return undefined;
    return pushBackHandler(onBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** True while the viewport matches the app's mobile/drawer CSS breakpoint. */
export function useIsNarrowViewport(breakpoint = 760): boolean {
  const query = typeof window !== 'undefined' ? `(max-width: ${breakpoint}px)` : '';
  const get = () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia(query);
    const update = () => setNarrow(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakpoint]);
  return narrow;
}
