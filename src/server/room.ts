/**
 * The room server's brain, independent of any hosting platform. The
 * Cloudflare Durable Object, the Node server and the in-memory test harness
 * all drive it through the same small `RoomIO` interface.
 *
 * Owns: lobby, seats and tokens, colours, host (and host transfer), settings,
 * start / pause / back to lobby, spectators, chat, rate limits, persistence
 * and idle-seat hooks. The sync engine (lockstep or state sync) owns the game.
 */
import type { AnyGame, Json, SeatInfo } from '../shared/game.js';
import { rules, validateSettings } from '../shared/game.js';
import type { ChatLine, ClientMsg, ErrorCode, MemberView, RoomPhase, ServerMsg } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import type { EngineHost, ServerEngine } from './engine.js';
import { LockstepEngine } from './lockstep.js';
import { StateSyncEngine } from './statesync.js';

export interface RoomIO {
  /** Send one text frame to a connection. */
  send(conn: string, data: string): void;
  /** Close a connection (after a fatal error, a kick, or a replaced session). */
  close(conn: string, code?: number, reason?: string): void;
  /** Call `room.pump()` every `ms` milliseconds; `null` stops it. */
  setClock(ms: number | null): void;
  /** Wall clock in ms. */
  now(): number;
  /** A fresh random seed (default: crypto.randomUUID()). */
  seed?(): string;
  /** Persist the room (null means it's finished: delete it). Optional. */
  save?(data: RoomSave | null): void;
  /** Call `room.alarm()` after `ms` (null cancels). Used to clean up empty rooms. Optional. */
  schedule?(ms: number | null): void;
  log?(...args: unknown[]): void;
}

export interface RoomLimits {
  /** Sustained inputs per second per connection (default 30). */
  inputsPerSecond?: number;
  /** Burst allowance (default 2 × inputsPerSecond). */
  inputBurst?: number;
  /** Chat lines per second (default 1, burst 5). */
  chatPerSecond?: number;
  /** Largest accepted message, in characters (default 32 KB). */
  maxMessageBytes?: number;
}

export interface RoomOptions {
  limits?: RoomLimits;
  /** An empty room is deleted after this long (default 15 min). */
  emptyTtlMs?: number;
  /** While playing, persist at most this often (default 10 s). */
  saveEveryMs?: number;
  /** Chat lines kept for newcomers (default 50). */
  chatHistory?: number;
}

/** What gets persisted so a room survives restarts, deploys and eviction. */
export interface RoomSave {
  v: 1;
  game: string;
  phase: RoomPhase;
  paused: boolean;
  settings: Json;
  members: { token: string; name: string; colour: string; meta: Json | null; seat: number }[];
  banned: string[];
  chat: ChatLine[];
  engine: Json;
}

interface Member {
  token: string;
  name: string;
  colour: string;
  meta: Json | null;
  seat: number;
  conn: string | null;
  goneAt: number | null;
  idleFired: boolean;
}

interface Conn {
  id: string;
  hello: boolean;
  member: Member | null;
  inputs: Bucket;
  chats: Bucket;
  strikes: number;
  welcomed: string;
  /** The hello, kept so a spectator can be seated later (back to lobby, rematch). */
  profile: Extract<ClientMsg, { t: 'hello' }> | null;
}

class Bucket {
  private tokens: number;
  private last = 0;
  constructor(
    private rate: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class RoomCore<G extends AnyGame = AnyGame> {
  phase: RoomPhase = 'lobby';
  paused = false;
  settings: Json;
  readonly engine: ServerEngine;
  readonly rules: ReturnType<typeof rules>;
  private members: Member[] = [];
  private conns = new Map<string, Conn>();
  private banned = new Set<string>();
  private chat: ChatLine[] = [];
  private lastSave = 0;
  private clockMs: number | null = null;
  private readonly limits: Required<RoomLimits>;
  private readonly opts: Required<Omit<RoomOptions, 'limits'>>;
  private readonly log: (...a: unknown[]) => void;

  constructor(
    readonly game: G,
    private io: RoomIO,
    options: RoomOptions = {},
  ) {
    this.rules = rules(game);
    this.settings = (game.settings?.defaults ?? {}) as Json;
    const ips = options.limits?.inputsPerSecond ?? 30;
    this.limits = {
      inputsPerSecond: ips,
      inputBurst: options.limits?.inputBurst ?? ips * 2,
      chatPerSecond: options.limits?.chatPerSecond ?? 1,
      maxMessageBytes: options.limits?.maxMessageBytes ?? 32_768,
    };
    this.opts = { emptyTtlMs: options.emptyTtlMs ?? 15 * 60_000, saveEveryMs: options.saveEveryMs ?? 10_000, chatHistory: options.chatHistory ?? 50 };
    this.log = io.log ?? (() => {});
    const host: EngineHost = {
      send: (conn, data) => this.io.send(conn, data),
      viewers: () => this.viewers(),
      reject: (conn, id, reason) => {
        if (conn && this.conns.has(conn)) this.send(conn, id === undefined ? { t: 'reject', reason } : { t: 'reject', id, reason });
      },
      now: () => this.io.now(),
      over: () => this.over(),
      log: this.log,
    };
    this.engine =
      game.mode === 'lockstep'
        ? new LockstepEngine(game, host, { tickRate: this.rules.tickRate, turnMs: this.rules.turnMs, hashEvery: this.rules.hashEvery })
        : new StateSyncEngine(game, host, { tickRate: this.rules.tickRate, sendRate: this.rules.sendRate });
  }

  /** Number of open connections (players and spectators). */
  get connections() {
    return this.conns.size;
  }

  /** Read-only view of the members (for adapters, tests and debugging). */
  get seats(): MemberView[] {
    return this.memberViews();
  }

  // -------------------------------------------------------------------------
  // Transport events
  // -------------------------------------------------------------------------

  onConnect(conn: string) {
    this.conns.set(conn, {
      id: conn,
      hello: false,
      member: null,
      inputs: new Bucket(this.limits.inputsPerSecond, this.limits.inputBurst),
      chats: new Bucket(this.limits.chatPerSecond, 5),
      strikes: 0,
      welcomed: '',
      profile: null,
    });
    this.io.schedule?.(null);
  }

  onClose(conn: string) {
    const c = this.conns.get(conn);
    if (!c) return;
    this.conns.delete(conn);
    if (this.engine instanceof StateSyncEngine) this.engine.forget(conn);
    const m = c.member;
    if (m && m.conn === conn) {
      m.conn = null;
      m.goneAt = this.io.now();
      // In the lobby a leaver frees their seat; in a game the seat is held for a reconnect.
      if (this.phase === 'lobby') this.reseat(this.members.filter((x) => x !== m));
    }
    if (c.hello) this.broadcastRoom();
    if (this.conns.size === 0) {
      this.updateClock();
      this.persist();
      this.io.schedule?.(this.opts.emptyTtlMs);
    }
  }

  onMessage(conn: string, raw: string) {
    const c = this.conns.get(conn);
    if (!c) return;
    if (typeof raw !== 'string' || raw.length > this.limits.maxMessageBytes) return this.strike(c, 'Message too large.');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return this.strike(c, 'Malformed message.');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.strike(c, 'Malformed message.');
    if (msg.t === 'hello') return this.hello(c, msg);
    if (!c.hello) return;
    const now = this.io.now();
    switch (msg.t) {
      case 'ping':
        return this.send(conn, { t: 'pong', id: Number(msg.id) || 0 });
      case 'chat':
        return this.say(c, msg.text, now);
      case 'input':
        return this.input(c, msg, now);
      case 'hash':
        if (c.member && this.phase === 'playing') this.engine.hash(conn, Number(msg.tick), Number(msg.hash));
        return;
    }
    const m = c.member;
    if (!m) return;
    const isHost = this.hostOf() === m;
    switch (msg.t) {
      case 'profile':
        if (this.phase !== 'lobby' && this.rules.lobby) return;
        if (msg.name !== undefined) m.name = cleanName(msg.name);
        if (msg.colour !== undefined) m.colour = this.freeColour(String(msg.colour), m);
        if (msg.meta !== undefined) m.meta = cleanMeta(msg.meta);
        this.broadcastRoom();
        this.persist();
        break;
      case 'settings':
        if (!isHost || this.phase !== 'lobby') return;
        this.settings = validateSettings(this.game, msg.settings, this.settings) as Json;
        this.broadcastRoom();
        this.persist();
        break;
      case 'start':
        if (!isHost || this.phase === 'playing') return;
        if (this.phase === 'over') {
          this.reseat(this.members.filter((x) => x.conn));
          this.promoteSpectators();
        }
        if (this.members.length < this.rules.min) {
          this.send(conn, { t: 'reject', reason: `You need at least ${this.rules.min} players to start.` });
          return;
        }
        this.start();
        break;
      case 'pause':
        if (!isHost || this.phase !== 'playing' || !!msg.paused === this.paused) return;
        this.paused = !!msg.paused;
        if (!this.paused) this.engine.rebase();
        this.updateClock();
        this.broadcastRoom();
        break;
      case 'toLobby':
        if (!isHost || this.phase === 'lobby') return;
        this.toLobby();
        break;
      case 'kick': {
        const target = this.members.find((x) => x.seat === Number(msg.seat));
        if (!isHost || !target || target === m) return;
        this.banned.add(target.token);
        if (target.conn) this.fatal(target.conn, 'kicked', 'The host removed you from this room.');
        if (this.phase === 'lobby') this.reseat(this.members.filter((x) => x !== target));
        this.broadcastRoom();
        this.persist();
        break;
      }
    }
  }

  /** Run on the clock set via `io.setClock`. */
  pump() {
    if (this.phase !== 'playing') return;
    const now = this.io.now();
    this.checkIdle(now);
    if (!this.paused) this.engine.pump();
    if (this.phase === 'playing' && now - this.lastSave >= this.opts.saveEveryMs) this.persist();
  }

  /** Called after `io.schedule(ms)` elapses: deletes the room if it's still empty. */
  alarm() {
    if (this.conns.size > 0) return;
    this.io.save?.(null);
    this.members = [];
    this.banned.clear();
    this.chat = [];
    this.phase = 'lobby';
    this.paused = false;
    this.settings = (this.game.settings?.defaults ?? {}) as Json;
    this.engine.clear();
    this.updateClock();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  serialize(): RoomSave {
    return {
      v: 1,
      game: this.rules.version,
      phase: this.phase,
      paused: this.paused,
      settings: this.settings,
      members: this.members.map(({ token, name, colour, meta, seat }) => ({ token, name, colour, meta, seat })),
      banned: [...this.banned],
      chat: this.chat,
      engine: this.engine.save(),
    };
  }

  /** Restore a saved room (call before any connections). Saves from another game version are ignored. */
  restore(save: RoomSave | null | undefined) {
    if (!save || save.v !== 1 || save.game !== this.rules.version) return false;
    const now = this.io.now();
    this.phase = save.phase;
    this.paused = save.paused;
    this.settings = save.settings;
    this.members = save.members.map((m) => ({ ...m, conn: null, goneAt: now, idleFired: false }));
    this.banned = new Set(save.banned);
    this.chat = save.chat ?? [];
    this.engine.restore(save.engine);
    if (this.phase !== 'lobby' && !this.engine.running) this.phase = 'lobby';
    if (this.phase === 'lobby') this.members = [];
    return true;
  }

  private persist() {
    if (!this.io.save) return;
    this.lastSave = this.io.now();
    this.io.save(this.serialize());
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  private hello(c: Conn, msg: Extract<ClientMsg, { t: 'hello' }>) {
    if (c.hello) return;
    if (msg.v !== PROTOCOL_VERSION || msg.game !== this.rules.version) {
      return this.fatal(c.id, 'version', 'This game has been updated. Refresh the page to get the latest version.');
    }
    const token = String(msg.token ?? '').slice(0, 64);
    if (token.length < 8) return this.fatal(c.id, 'invalid', 'Invalid session token.');
    if (this.banned.has(token)) return this.fatal(c.id, 'kicked', 'The host removed you from this room.');
    let m = this.members.find((x) => x.token === token) ?? null;
    if (m) {
      // Reclaiming a seat (refresh, reconnect, or the same player in a new tab).
      if (m.conn && m.conn !== c.id) {
        const old = this.conns.get(m.conn);
        if (old) old.member = null;
        this.fatal(m.conn, 'replaced', 'This seat was opened somewhere else.');
      }
      if (m.idleFired && this.phase === 'playing') {
        const cmd = this.game.hooks?.return?.(m.seat);
        if (cmd != null) this.engine.system(m.seat, cmd);
      }
    } else {
      m = this.admit(token, msg);
      if (!m && !this.rules.spectators) {
        return this.fatal(c.id, this.phase === 'lobby' ? 'full' : 'started', this.phase === 'lobby' ? 'This room is full.' : 'This game has already started.');
      }
    }
    if (m) {
      m.conn = c.id;
      m.goneAt = null;
      m.idleFired = false;
    }
    c.hello = true;
    c.member = m;
    c.profile = msg;
    if (!this.rules.lobby && this.phase === 'lobby' && m) {
      // No lobby: the first arrival starts the room; everyone else joins live.
      this.start();
      return;
    }
    this.broadcastRoom(c.id);
    if (this.phase !== 'lobby' && this.engine.running) this.engine.snapshot(c.id, m?.seat ?? null);
    this.updateClock();
    this.persist();
  }

  /** Seats a newcomer if there's room, or returns null (spectator). */
  private admit(token: string, msg: Extract<ClientMsg, { t: 'hello' }>): Member | null {
    const make = (seat: number): Member => {
      const m: Member = { token, name: cleanName(msg.name), colour: '', meta: cleanMeta(msg.meta ?? null), seat, conn: null, goneAt: null, idleFired: false };
      m.colour = this.freeColour(String(msg.colour ?? ''), m);
      return m;
    };
    if (this.phase === 'lobby') {
      if (this.members.length >= this.rules.max) return null;
      const m = make(this.members.length);
      this.members.push(m);
      return m;
    }
    const join = this.game.hooks?.join;
    if (this.phase !== 'playing' || !join) return null;
    const taken = new Set(this.members.map((x) => x.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    if (seat >= this.rules.max) return null;
    const m = make(seat);
    this.members.push(m);
    this.members.sort((a, b) => a.seat - b.seat);
    const cmd = join(this.seatInfo(m));
    if (cmd != null) this.engine.system(seat, cmd);
    return m;
  }

  private start() {
    const seats = [...this.members].sort((a, b) => a.seat - b.seat).map((m) => this.seatInfo(m));
    const seed = this.io.seed?.() ?? randomSeed();
    this.engine.start({ seed, seats, settings: this.settings });
    this.phase = 'playing';
    this.paused = false;
    this.broadcastRoom();
    for (const v of this.viewers()) this.engine.snapshot(v.conn, v.seat);
    this.updateClock();
    this.persist();
  }

  private over() {
    this.phase = 'over';
    this.updateClock();
    this.broadcastRoom();
    this.persist();
  }

  private toLobby() {
    this.engine.clear();
    this.paused = false;
    this.reseat(this.members.filter((x) => x.conn));
    this.promoteSpectators();
    if (!this.rules.lobby && this.members.length) {
      // Lobby-less rooms restart straight away.
      this.start();
      return;
    }
    this.phase = 'lobby';
    this.updateClock();
    this.broadcastRoom();
    this.persist();
  }

  private input(c: Conn, msg: Extract<ClientMsg, { t: 'input' }>, now: number) {
    const id = Number.isSafeInteger(msg.id) ? msg.id : undefined;
    const no = (reason: string) => this.send(c.id, id === undefined ? { t: 'reject', reason } : { t: 'reject', id, reason });
    if (!c.member) return no('You are spectating.');
    if (this.phase !== 'playing') return no('The game is not running.');
    if (this.paused) return no('The game is paused.');
    if (!c.inputs.take(now)) return no('Slow down.');
    if (id === undefined) return no('Malformed input.');
    this.engine.input(c.id, c.member.seat, msg.cmd, id);
  }

  private say(c: Conn, text: unknown, now: number) {
    const clean = String(text ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 280);
    if (!clean) return;
    if (!c.chats.take(now)) return this.send(c.id, { t: 'reject', reason: 'Slow down.' });
    const line: ChatLine = { seat: c.member?.seat ?? null, name: c.member?.name ?? 'Spectator', text: clean, at: now };
    this.chat.push(line);
    if (this.chat.length > this.opts.chatHistory) this.chat.shift();
    const data = JSON.stringify({ t: 'chat', line } satisfies ServerMsg);
    for (const v of this.viewers()) this.io.send(v.conn, data);
  }

  /** Seats spectators while there's room (between games). */
  private promoteSpectators() {
    for (const c of this.conns.values()) {
      if (!c.hello || c.member || !c.profile || this.members.length >= this.rules.max) continue;
      const saved = this.phase;
      this.phase = 'lobby';
      const m = this.admit(c.profile.token, c.profile);
      this.phase = saved;
      if (m) {
        m.conn = c.id;
        c.member = m;
      }
    }
  }

  private checkIdle(now: number) {
    let changed = false;
    for (const m of [...this.members]) {
      if (m.conn || m.goneAt === null || m.idleFired || now - m.goneAt < this.rules.idleMs) continue;
      m.idleFired = true;
      const cmd = this.game.hooks?.idle?.(m.seat);
      if (cmd != null) this.engine.system(m.seat, cmd);
      if (!this.rules.lobby) {
        // Drop-in rooms free the seat; a returning player joins afresh.
        this.members = this.members.filter((x) => x !== m);
        changed = true;
      }
    }
    if (changed) this.broadcastRoom();
  }

  private strike(c: Conn, reason: string) {
    c.strikes++;
    this.send(c.id, { t: 'reject', reason });
    if (c.strikes > 20) this.fatal(c.id, 'invalid', 'Too many invalid messages.');
  }

  private fatal(conn: string, code: ErrorCode, reason: string) {
    this.send(conn, { t: 'error', code, reason });
    this.io.close(conn, 4000, code);
    // Forget it now; the adapter's own close event later is a no-op.
    this.onClose(conn);
  }

  private updateClock() {
    const want = this.phase === 'playing' && !this.paused && this.conns.size > 0 ? this.engine.clockMs : null;
    if (want === this.clockMs) return;
    // Starting the clock again (after everyone left, or a pause): time didn't pass for the game.
    if (this.clockMs === null && want !== null) this.engine.rebase();
    this.clockMs = want;
    this.io.setClock(want);
  }

  private hostOf(): Member | undefined {
    return this.members.find((m) => m.conn) ?? this.members[0];
  }

  private reseat(list: Member[]) {
    // Mutate in place: connections hold references to these member objects.
    this.members = list;
    list.forEach((m, i) => (m.seat = i));
  }

  private freeColour(want: string, me: Member): string {
    const palette = this.rules.palette;
    const used = new Set(this.members.filter((x) => x !== me).map((x) => x.colour));
    if (palette.includes(want) && !used.has(want)) return want;
    return palette.find((p) => !used.has(p)) ?? palette[me.seat % palette.length];
  }

  private seatInfo(m: Member): SeatInfo {
    return { seat: m.seat, name: m.name, colour: m.colour, meta: m.meta };
  }

  private viewers(): { conn: string; seat: number | null }[] {
    const out: { conn: string; seat: number | null }[] = [];
    for (const c of this.conns.values()) if (c.hello) out.push({ conn: c.id, seat: c.member?.seat ?? null });
    return out;
  }

  private memberViews(): MemberView[] {
    const host = this.hostOf();
    return this.members.map((m) => ({ seat: m.seat, name: m.name, colour: m.colour, connected: !!m.conn, host: m === host, meta: m.meta }));
  }

  private broadcastRoom(fresh?: string) {
    const host = this.hostOf();
    let spectators = 0;
    for (const c of this.conns.values()) if (c.hello && !c.member) spectators++;
    const room: ServerMsg = { t: 'room', phase: this.phase, members: this.memberViews(), spectators, paused: this.paused, settings: this.settings };
    const data = JSON.stringify(room);
    for (const c of this.conns.values()) {
      if (!c.hello) continue;
      // Seat and host status can change (reseating, host leaves); tell people when theirs does.
      const seat = c.member?.seat ?? null;
      const isHost = !!c.member && c.member === host;
      const key = `${seat}:${isHost}`;
      if (c.welcomed !== key) {
        c.welcomed = key;
        this.send(c.id, { t: 'welcome', seat, host: isHost });
      }
      if (c.id === fresh && this.chat.length) this.send(c.id, { ...room, chat: this.chat });
      else this.io.send(c.id, data);
    }
  }

  private send(conn: string, msg: ServerMsg) {
    this.io.send(conn, JSON.stringify(msg));
  }
}

function randomSeed() {
  return globalThis.crypto?.randomUUID?.().slice(0, 13) ?? Math.random().toString(36).slice(2);
}

export function cleanName(n: unknown) {
  const s = String(n ?? '')
    .replace(/[^\p{L}\p{N}\p{Emoji_Presentation} '_.-]/gu, '')
    .trim()
    .slice(0, 20);
  return s || 'Player';
}

function cleanMeta(meta: unknown): Json | null {
  if (meta === undefined || meta === null) return null;
  try {
    const s = JSON.stringify(meta);
    return s.length > 2048 ? null : (JSON.parse(s) as Json);
  } catch {
    return null;
  }
}
