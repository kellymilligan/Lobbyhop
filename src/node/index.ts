/**
 * Node adapter: rooms over the `ws` package, for traditional hosting (Fly.io,
 * Railway, Render, a VPS, Docker) and for local development and tests
 * without wrangler. Optionally serves your built game from the same origin.
 *
 *   import { createNodeServer } from 'lobbyhop/node';
 *   import { game } from './src/game';
 *   const server = createNodeServer(game, { port: 8787, static: 'dist' });
 *   await server.listen();
 *
 * Requires `npm i ws`. One process holds all rooms in memory; set
 * `persistDir` to survive restarts. To scale past one machine, route each
 * room code to a fixed instance (see docs/DEPLOY.md).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnyGame } from '../shared/game.js';
import type { RoomOptions, RoomSave } from '../server/room.js';
import { RoomCore } from '../server/room.js';

export interface NodeServerOptions extends RoomOptions {
  /** Port for `listen()` (default: $PORT or 8787). */
  port?: number;
  /** Host to bind (default 0.0.0.0). */
  hostname?: string;
  /** Path prefix for rooms (default `/rooms`). */
  prefix?: string;
  /** Directory of static files to serve (your built game), with SPA fallback to index.html. */
  static?: string;
  /** Persist rooms as JSON files here so they survive restarts. */
  persistDir?: string;
  /** Allowed page origins for WebSocket connections (default: any). */
  origins?: string[];
  /** Max connections per room (default 64). */
  maxConnections?: number;
  /** Log room events (default false). */
  debug?: boolean;
}

export interface NodeRoomServer {
  /** The underlying http server (attach your own routes with `server.http.on('request', …)` before listen if you don't use `static`). */
  readonly http: Server;
  /** Live rooms by code. */
  readonly rooms: Map<string, RoomCore>;
  listen(port?: number): Promise<{ port: number }>;
  close(): Promise<void>;
  /** Handle an upgrade from your own http server (Express, Fastify…). Returns false if the path isn't a room. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', fn: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', fn: () => void): void;
  readyState: number;
}
interface WssLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsLike) => void): void;
  close(): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Creates a room server for one game. Load `ws` lazily so browser bundles never see it. */
export function createNodeServer<G extends AnyGame>(game: G, options: NodeServerOptions = {}): NodeRoomServer {
  const prefix = (options.prefix ?? '/rooms').replace(/\/+$/, '');
  const rooms = new Map<string, RoomCore>();
  const staticDir = options.static ? resolve(options.static) : null;
  const persistDir = options.persistDir ? resolve(options.persistDir) : null;
  if (persistDir) mkdirSync(persistDir, { recursive: true });
  const log = options.debug ? (...a: unknown[]) => console.log('[lobbyhop]', ...a) : undefined;
  let wss: WssLike | null = null;
  const pendingWss = import('ws').then((m) => {
    const WSS = (m as { WebSocketServer: new (o: object) => WssLike }).WebSocketServer;
    wss = new WSS({ noServer: true, maxPayload: options.limits?.maxMessageBytes ?? 32_768 * 2 });
    return wss;
  });

  const roomFile = (code: string) => join(persistDir!, `${code}.json`);

  const getRoom = (code: string) => {
    let room = rooms.get(code);
    if (room) return room;
    const sockets = new Map<string, WsLike>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let alarm: ReturnType<typeof setTimeout> | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let latest: RoomSave | null = null;
    const created: RoomCore = new RoomCore(
      game,
      {
        send: (conn, data) => {
          const ws = sockets.get(conn);
          if (ws && ws.readyState === 1) ws.send(data);
        },
        close: (conn, code, reason) => {
          const ws = sockets.get(conn);
          sockets.delete(conn);
          ws?.close(code, reason);
        },
        setClock: (ms) => {
          if (timer) clearInterval(timer);
          timer = ms === null ? null : setInterval(() => created.pump(), ms);
        },
        now: () => Date.now(),
        save: persistDir
          ? (data) => {
              latest = data;
              if (data === null) {
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = null;
                rmSync(roomFile(code), { force: true });
                return;
              }
              // Coalesce bursts of saves into one write.
              saveTimer ??= setTimeout(() => {
                saveTimer = null;
                if (!latest) return;
                const tmp = `${roomFile(code)}.tmp`;
                writeFileSync(tmp, JSON.stringify(latest));
                renameSync(tmp, roomFile(code));
              }, 250);
              saveTimer.unref?.();
            }
          : undefined,
        schedule: (ms) => {
          if (alarm) clearTimeout(alarm);
          alarm =
            ms === null
              ? null
              : setTimeout(() => {
                  created.alarm();
                  if (created.connections === 0) {
                    if (timer) clearInterval(timer);
                    rooms.delete(code);
                  }
                }, ms);
          alarm?.unref?.();
        },
        log,
      },
      options,
    );
    (created as unknown as { sockets: Map<string, WsLike> }).sockets = sockets;
    if (persistDir && existsSync(roomFile(code))) {
      try {
        created.restore(JSON.parse(readFileSync(roomFile(code), 'utf8')) as RoomSave);
      } catch (e) {
        console.error(`[lobbyhop] could not restore room ${code}`, e);
      }
    }
    rooms.set(code, created);
    room = created;
    return room;
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(prefix + '/')) return false;
    const code = decodeURIComponent(url.pathname.slice(prefix.length + 1)).toLowerCase();
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!/^[a-z0-9-]{3,32}$/.test(code)) {
      reject(400, 'Bad Request');
      return true;
    }
    const origin = req.headers.origin;
    if (options.origins?.length && origin && !options.origins.includes(origin)) {
      reject(403, 'Forbidden');
      return true;
    }
    void pendingWss.then((server) => {
      const room = getRoom(code);
      const sockets = (room as unknown as { sockets: Map<string, WsLike> }).sockets;
      if (sockets.size >= (options.maxConnections ?? 64)) return reject(503, 'Service Unavailable');
      server.handleUpgrade(req, socket, head, (ws) => {
        const id = randomUUID();
        sockets.set(id, ws);
        room.onConnect(id);
        ws.on('message', (data, isBinary) => {
          if (!isBinary) room.onMessage(id, String(data));
        });
        const closed = () => {
          sockets.delete(id);
          room.onClose(id);
        };
        ws.on('close', closed);
        ws.on('error', closed);
      });
    });
    return true;
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if (!staticDir) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('lobbyhop room server');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    let file = resolve(join(staticDir, decodeURIComponent(url.pathname)));
    if (file !== staticDir && !file.startsWith(staticDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const index = join(file, 'index.html');
      file = existsSync(index) ? index : join(staticDir, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  const http = createServer(serveStatic);
  http.on('upgrade', (req, socket, head) => {
    if (!handleUpgrade(req, socket, head)) socket.destroy();
  });

  return {
    http,
    rooms,
    handleUpgrade,
    async listen(port) {
      await pendingWss;
      const p = port ?? options.port ?? Number(process.env.PORT ?? 8787);
      await new Promise<void>((ok, fail) => {
        http.once('error', fail);
        http.listen(p, options.hostname ?? '0.0.0.0', () => ok());
      });
      const addr = http.address();
      return { port: typeof addr === 'object' && addr ? addr.port : p };
    },
    async close() {
      for (const room of rooms.values()) {
        const sockets = (room as unknown as { sockets: Map<string, WsLike> }).sockets;
        for (const ws of sockets.values()) ws.close(1001, 'server shutting down');
      }
      wss?.close();
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}
