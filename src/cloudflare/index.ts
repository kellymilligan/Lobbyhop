/**
 * Cloudflare adapter: one Durable Object per room, plus a Worker `fetch`
 * that routes `/rooms/<code>` to it and serves your built game for
 * everything else. One deploy, one origin, no CORS.
 *
 *   // worker.ts
 *   import { createRoomServer, createWorker } from 'lobbyhop/cloudflare';
 *   import { game } from './src/game';
 *   export const Room = createRoomServer(game);
 *   export default createWorker({ binding: 'Room' });
 *
 * Pair with templates/cloudflare/wrangler.jsonc. Durable Objects with SQLite
 * storage run on the Workers Free plan.
 */
import type { AnyGame } from '../shared/game.js';
import type { RoomOptions, RoomSave } from '../server/room.js';
import { RoomCore } from '../server/room.js';

// Minimal structural types, so this module needs no @cloudflare/workers-types
// (which clash with DOM types in browser projects).
interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface DOState {
  storage: DOStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };

export interface CloudflareRoomOptions extends RoomOptions {
  /** Allowed page origins for WebSocket connections (default: any). E.g. ['https://mygame.com']. */
  origins?: string[];
  /** Log room events with console.log (default false). */
  debug?: boolean;
}

/** Largest chunk written to one storage value (well under every DO storage limit). */
const CHUNK = 96 * 1024;
const MAX_CONNECTIONS = 64;

/**
 * Creates the Durable Object class for a game's rooms. Export it from your
 * Worker under the `class_name` in wrangler.jsonc.
 */
export function createRoomServer<G extends AnyGame>(game: G, options: CloudflareRoomOptions = {}) {
  return class LobbyhopRoom {
    readonly core: RoomCore<G>;
    private sockets = new Map<string, CfWebSocket>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private chunks = 0;
    private saving: Promise<void> = Promise.resolve();

    constructor(
      private ctx: DOState,
      _env: unknown,
    ) {
      const log = options.debug ? (...a: unknown[]) => console.log('[lobbyhop]', ...a) : undefined;
      this.core = new RoomCore(
        game,
        {
          send: (conn, data) => {
            try {
              this.sockets.get(conn)?.send(data);
            } catch {
              // Socket already closing; its close event will clean up.
            }
          },
          close: (conn, code, reason) => {
            const ws = this.sockets.get(conn);
            this.sockets.delete(conn);
            try {
              ws?.close(code, reason);
            } catch {
              // Already closed.
            }
          },
          setClock: (ms) => {
            if (this.timer) clearInterval(this.timer);
            this.timer = ms === null ? null : setInterval(() => this.core.pump(), ms);
          },
          now: () => Date.now(),
          save: (data) => this.persist(data),
          schedule: (ms) => {
            void (ms === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(Date.now() + ms));
          },
          log,
        },
        options,
      );
      void ctx.blockConcurrencyWhile(async () => {
        const n = (await ctx.storage.get<number>('room:n')) ?? 0;
        if (!n) return;
        const keys = Array.from({ length: n }, (_, i) => `room:${i}`);
        const parts = await ctx.storage.get<string>(keys);
        const json = keys.map((k) => parts.get(k) ?? '').join('');
        try {
          this.core.restore(JSON.parse(json) as RoomSave);
          this.chunks = n;
        } catch (e) {
          console.error('[lobbyhop] could not restore room', e);
        }
      });
    }

    async fetch(request: Request): Promise<Response> {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      if (!originAllowed(request, options.origins)) return new Response('Origin not allowed', { status: 403 });
      if (this.sockets.size >= MAX_CONNECTIONS) return new Response('Room is busy', { status: 503 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      const id = crypto.randomUUID();
      this.sockets.set(id, server);
      this.core.onConnect(id);
      server.addEventListener('message', (e) => this.core.onMessage(id, typeof e.data === 'string' ? e.data : ''));
      const closed = () => {
        this.sockets.delete(id);
        this.core.onClose(id);
      };
      server.addEventListener('close', closed);
      server.addEventListener('error', closed);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }

    async alarm() {
      this.core.alarm();
    }

    private persist(data: RoomSave | null) {
      // Serialise writes so a slow save can't land after a newer one.
      this.saving = this.saving.then(async () => {
        const storage = this.ctx.storage;
        if (!data) {
          await storage.deleteAll();
          this.chunks = 0;
          return;
        }
        const json = JSON.stringify(data);
        const n = Math.max(1, Math.ceil(json.length / CHUNK));
        const entries: Record<string, unknown> = { 'room:n': n };
        for (let i = 0; i < n; i++) entries[`room:${i}`] = json.slice(i * CHUNK, (i + 1) * CHUNK);
        const keys = Object.keys(entries);
        for (let i = 0; i < keys.length; i += 128) await storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, entries[k]])));
        if (this.chunks > n) await storage.delete(Array.from({ length: this.chunks - n }, (_, i) => `room:${n + i}`));
        this.chunks = n;
      });
      this.saving.catch((e) => console.error('[lobbyhop] save failed', e));
    }
  };
}

export interface RouteOptions {
  /** Path prefix for rooms (default `/rooms`). Must match the client's `prefix`. */
  prefix?: string;
}

/**
 * Routes `/<prefix>/<code>` WebSocket requests to the room's Durable Object.
 * Returns null for any other path, so you can fall through to your own routes.
 */
export function routeRooms(request: Request, namespace: DONamespace, opts: RouteOptions = {}): Promise<Response> | null {
  const prefix = (opts.prefix ?? '/rooms').replace(/\/+$/, '');
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix + '/')) return null;
  const code = decodeURIComponent(url.pathname.slice(prefix.length + 1)).toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(code)) return Promise.resolve(new Response('Bad room code', { status: 400 }));
  return namespace.get(namespace.idFromName(code)).fetch(request);
}

export interface WorkerOptions extends RouteOptions {
  /** Name of the Durable Object binding in wrangler.jsonc (default `Room`). */
  binding?: string;
  /** Name of the static assets binding (default `ASSETS`). Set to null if you don't serve assets. */
  assets?: string | null;
}

/** A complete Worker: rooms under `/rooms/*`, your built game for everything else. */
export function createWorker(opts: WorkerOptions = {}) {
  const binding = opts.binding ?? 'Room';
  const assets = opts.assets === undefined ? 'ASSETS' : opts.assets;
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      const ns = env[binding] as DONamespace | undefined;
      if (!ns) return new Response(`lobbyhop: no Durable Object binding named "${binding}" (check wrangler.jsonc)`, { status: 500 });
      const routed = routeRooms(request, ns, opts);
      if (routed) return routed;
      const fetcher = assets ? (env[assets] as { fetch(r: Request): Promise<Response> } | undefined) : undefined;
      return fetcher ? fetcher.fetch(request) : new Response('Not found', { status: 404 });
    },
  };
}

function originAllowed(request: Request, origins: string[] | undefined): boolean {
  if (!origins?.length) return true;
  const o = request.headers.get('Origin');
  return !o || origins.includes(o);
}
