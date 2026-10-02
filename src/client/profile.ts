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
