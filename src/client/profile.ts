/**
 * Room codes in the URL, and a persistent player profile. Together they give
 * "share a link to play together" and "refresh to rejoin your seat".
 */
import type { Profile } from './session.js';

/** Unambiguous lowercase letters and digits (no 0/o, 1/l/i). */
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A random room code. 6 chars ≈ 887 million combinations: unguessable enough for casual play. */
export function newRoomCode(length = 6): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

/** Sanitises a code from a URL or user input. */
export function cleanRoomCode(code: string | null | undefined): string | null {
  const c = String(code ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
  return c.length >= 3 ? c : null;
}

/** The room code in the page URL (`?room=abc123`), or null. */
export function roomFromUrl(param = 'room'): string | null {
  if (typeof location === 'undefined') return null;
  return cleanRoomCode(new URLSearchParams(location.search).get(param));
}

/**
 * The room for this page: the code in the URL, or (with `create: true`, the
 * default) a new code written into the URL with `history.replaceState`, so a
 * refresh rejoins the same room and the address bar is the share link.
 */
export function getRoomCode(opts: { param?: string; create?: boolean; length?: number } = {}): string | null {
  const param = opts.param ?? 'room';
  const existing = roomFromUrl(param);
  if (existing || opts.create === false) return existing;
  const code = newRoomCode(opts.length);
  setRoomInUrl(code, param);
  return code;
}

/** Writes (or with null, removes) the room code in the URL without reloading. */
export function setRoomInUrl(code: string | null, param = 'room') {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  if (code) url.searchParams.set(param, code);
  else url.searchParams.delete(param);
  history.replaceState(history.state, '', url);
}

/** The shareable link for a room. */
export function shareLink(code: string, param = 'room'): string {
  if (typeof location === 'undefined') return `?${param}=${code}`;
  const url = new URL(location.href);
  url.searchParams.set(param, code);
  url.hash = '';
  return url.toString();
}

/** Loads (or creates and saves) the player's profile from localStorage. */
export function loadProfile(key = 'lobbyhop.profile', defaults: { name?: string; colour?: string } = {}): Profile {
  try {
    const p = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null') as Profile | null;
    if (p && typeof p.token === 'string' && p.token.length >= 8) return p;
  } catch {
    // Fall through to a fresh profile.
  }
  const p: Profile = { token: randomToken(), name: defaults.name ?? randomName(), colour: defaults.colour ?? '' };
  saveProfile(key, p);
  return p;
}

export function saveProfile(key: string, p: Profile) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(p));
  } catch {
    // Storage can be blocked (private mode); the session still works, it just won't survive a refresh.
  }
}

function randomToken(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const ADJ = ['Swift', 'Quiet', 'Bright', 'Lucky', 'Brave', 'Clever', 'Merry', 'Bold', 'Calm', 'Keen'];
const NOUN = ['Otter', 'Falcon', 'Fox', 'Heron', 'Lynx', 'Panda', 'Raven', 'Tiger', 'Wren', 'Badger'];
function randomName() {
  const b = new Uint8Array(2);
  globalThis.crypto.getRandomValues(b);
  return `${ADJ[b[0] % ADJ.length]} ${NOUN[b[1] % NOUN.length]}`;
}

/**
 * Picks the session token for this tab in a room, so that:
 * - a refresh keeps the same token (same seat);
 * - closing the tab and reopening the link keeps the same token;
 * - a second tab in the same browser gets its own token (its own seat)
 *   instead of kicking the first tab out.
 * The browser-wide profile token is "claimed" by one live tab per room via a
 * heartbeat in localStorage; other tabs use a per-tab token in sessionStorage.
 */
export function tabToken(profileToken: string, room: string, scope = 'lobbyhop'): { token: string; release(): void } {
  const ls = safeStorage('localStorage');
  const ss = safeStorage('sessionStorage');
  if (!ls || !ss) return { token: profileToken, release() {} };
  const lockKey = `${scope}.lock.${room}`;
  const tabKey = `${scope}.tab.${room}`;
  const me = randomToken();
  const now = () => Date.now();
  const readLock = (): { tab: string; at: number } | null => {
    try {
      return JSON.parse(ls.getItem(lockKey) ?? 'null');
    } catch {
      return null;
    }
  };
  const lock = readLock();
  const taken = !!lock && lock.tab !== me && now() - lock.at < 5000;
  let token: string;
  if (!taken) token = profileToken;
  else {
    // Another live tab holds the browser's seat in this room: use (or keep) a tab-only identity.
    const mine = ss.getItem(tabKey);
    token = mine && mine !== profileToken ? mine : randomToken();
  }
  ss.setItem(tabKey, token);
  let timer: ReturnType<typeof setInterval> | null = null;
  const beat = () => ls.setItem(lockKey, JSON.stringify({ tab: me, at: now() }));
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (readLock()?.tab === me) ls.removeItem(lockKey);
  };
  if (token === profileToken) {
    beat();
    timer = setInterval(beat, 2000);
    // A refresh releases the claim, so the reloaded page reclaims the same seat.
    if (typeof addEventListener === 'function') addEventListener('pagehide', release);
  }
  return { token, release };
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const s = (globalThis as unknown as Record<string, Storage | undefined>)[kind];
    if (!s) return null;
    s.getItem('x');
    return s;
  } catch {
    return null;
  }
}
