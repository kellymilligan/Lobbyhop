/**
 * Browser (and Node 22+) glue: a small auto-reconnecting WebSocket, and
 * `joinRoom`, which connects a RoomClient to a room by code.
 */
import type { AnyGame } from '../shared/game.js';
import type { ServerMsg } from '../shared/protocol.js';
import type { Profile, RoomClientOptions } from './session.js';
import { RoomClient } from './session.js';
import { loadProfile, saveProfile, tabToken } from './profile.js';

export interface JoinOptions extends RoomClientOptions {
  /** Room code (e.g. from `getRoomCode()`). */
  room: string;
  /**
   * Where rooms are served: a host like `localhost:8787` or `game.example.com`,
   * or a full `ws(s)://` / `http(s)://` origin. Default: the page's own host
   * (Cloudflare and the Node server serve the game and the rooms from one origin).
   */
  host?: string;
  /** Path prefix rooms are served under (default `/rooms`). */
  prefix?: string;
  /** Profile to join with (default: loaded from localStorage, and saved on change). */
  profile?: Profile;
  /** localStorage key for the profile (default `lobbyhop.profile.<game name>`). */
  profileKey?: string;
  /** Ping interval for the RTT estimate, ms (default 3000; 0 disables). */
  pingMs?: number;
  /** WebSocket implementation (default globalThis.WebSocket). */
  WebSocket?: typeof WebSocket;
}

export interface JoinedRoom<G extends AnyGame> extends RoomClient<G> {
  /** Close the socket for good. */
  leave(): void;
  /** The WebSocket URL in use. */
  readonly url: string;
}

/** Builds the WebSocket URL for a room. */
export function roomUrl(room: string, host?: string, prefix = '/rooms'): string {
  const loc = (globalThis as { location?: Location }).location;
  let h = host || loc?.host;
  if (!h) throw new Error('lobbyhop: no host given and no page location to default to');
  let secure = loc ? loc.protocol === 'https:' : true;
  const m = /^(wss?|https?):\/\/(.*)$/i.exec(h);
  if (m) {
    secure = /^(wss|https)$/i.test(m[1]);
    h = m[2];
  } else if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(h)) secure = false;
  h = h.replace(/\/+$/, '');
  return `${secure ? 'wss' : 'ws'}://${h}${prefix}/${encodeURIComponent(room)}`;
}

/**
 * Joins a room. Returns the live RoomClient (plus `leave()`); it reconnects
 * automatically and reclaims your seat with the token in your profile.
 *
 *   const room = joinRoom(game, { room: getRoomCode() });
 *   room.on('change', render);
 *   // each frame: const { state, alpha, events } = room.advance(dt);
 */
export function joinRoom<G extends AnyGame>(game: G, opts: JoinOptions): JoinedRoom<G> {
  const key = opts.profileKey ?? `lobbyhop.profile.${game.name}`;
  const saved = opts.profile ?? loadProfile(key, { colour: game.seats?.palette?.[0] });
  // Two tabs in one browser get separate seats; a refresh keeps yours (see tabToken).
  const claim = opts.profile ? null : tabToken(saved.token, opts.room, key);
  const profile = claim ? { ...saved, token: claim.token } : saved;
  const url = roomUrl(opts.room, opts.host, opts.prefix);
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;

  const client = new RoomClient(game, (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m)), profile, opts) as JoinedRoom<G>;

  const connect = () => {
    if (stopped) return;
    const sock = new WS(url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      client.opened();
    };
    sock.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      client.receive(msg);
      if (msg.t === 'error') stop();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      const again = !stopped && !client.error;
      client.closed(again);
      if (again) {
        // Exponential backoff with jitter: 0.5 s, 1 s, 2 s … capped at 10 s.
        const delay = Math.min(10_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt++;
        retry = setTimeout(connect, delay);
      }
    };
    sock.onerror = () => {
      // onclose follows and handles the retry.
    };
  };

  const stop = () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (pinger) clearInterval(pinger);
    if (typeof removeEventListener === 'function') {
      removeEventListener('online', reconnectNow);
      removeEventListener('visibilitychange', reconnectNow);
    }
  };

  // Retry immediately when the network or tab comes back, instead of waiting out the backoff.
  const reconnectNow = () => {
    if (stopped || ws || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    if (retry) clearTimeout(retry);
    attempt = 0;
    connect();
  };
  if (typeof addEventListener === 'function') {
    addEventListener('online', reconnectNow);
    addEventListener('visibilitychange', reconnectNow);
  }

  const setProfile = client.setProfile.bind(client);
  client.setProfile = (p) => {
    setProfile(p);
    if (!opts.profile) saveProfile(key, { ...client.profile, token: saved.token });
  };
  client.leave = () => {
    stop();
    claim?.release();
    const sock = ws;
    ws = null;
    sock?.close(1000, 'leave');
    client.closed(false);
  };
  Object.defineProperty(client, 'url', { value: url });

  const pingMs = opts.pingMs ?? 3000;
  if (pingMs > 0) pinger = setInterval(() => client.connected && client.ping(), pingMs);
  connect();
  return client;
}
