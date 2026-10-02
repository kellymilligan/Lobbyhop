/**
 * Client half of a room, free of DOM and sockets so it runs in browsers, Node
 * bots and the in-memory test harness alike. `joinRoom` (./socket) wires it to
 * a real WebSocket.
 *
 * Lockstep: runs the same deterministic sim as the server, but never past the
 * latest turn the server announced (the "frontier"). State sync: holds the
 * latest view from the server plus the previous one, for interpolation.
 */
import type { AnyGame, CommandOf, EventOf, Json, LockstepGame, SettingsOf, StateOf } from '../shared/game.js';
import { rules } from '../shared/game.js';
import type { ChatLine, ClientMsg, ErrorCode, MemberView, RoomPhase, ServerMsg, StampedCommand } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { stateHash } from '../det/index.js';

/** How far behind the frontier lockstep aims to run, as a jitter buffer (ticks). */
const TARGET_LAG = 3;

export interface Profile {
  /** Secret per-browser token that lets a refresh reclaim the same seat. */
  token: string;
  name: string;
  colour: string;
  meta?: Json | null;
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface PendingInput<C> {
  id: number;
  cmd: C;
  /** performance.now()-style ms when submitted. */
  at: number;
}

/** What `advance` returns each frame. */
export interface Frame<S, E> {
  /** Current state (lockstep: the local sim; state sync: the latest view). Null until the game starts. */
  state: S | null;
  /** State sync only: the previous view, to interpolate from. Lockstep keeps previous positions in the state itself. */
  prev: S | null;
  /** Interpolation factor in [0, 1] between the last tick (or view) and the next. */
  alpha: number;
  /** Game events produced since the last frame (sounds, effects, UI notices). */
  events: E[];
}

export interface RoomEvents<G extends AnyGame> {
  /** Anything changed (lobby, connection, state replaced). Cheap to re-render on. */
  change: () => void;
  /** A message for the player: rejected input, resync, etc. */
  notice: (text: string) => void;
  /** One of your inputs was rejected. */
  reject: (reason: string, input: PendingInput<CommandOf<G>> | undefined) => void;
  chat: (line: ChatLine) => void;
  /** The state was replaced wholesale (start, rejoin, resync): reset caches keyed on the old state. */
  snapshot: (state: StateOf<G>) => void;
  /** The room moved to another phase. */
  phase: (phase: RoomPhase) => void;
}

export interface RoomClientOptions {
  /** Drop pending (optimistic) inputs not confirmed after this long (default 3000 ms). */
  pendingTimeoutMs?: number;
  /** Clock used for pending timeouts and RTT (default performance.now). */
  now?: () => number;
}

export class RoomClient<G extends AnyGame> {
  // Connection and lobby --------------------------------------------------
  status: ConnectionStatus = 'connecting';
  /** Fatal error (version mismatch, room full, kicked…). The socket stops reconnecting. */
  error: { code: ErrorCode; reason: string } | null = null;
  /** Your seat, or null when spectating (or before welcome). */
  seat: number | null = null;
  host = false;
  phase: RoomPhase = 'lobby';
  members: MemberView[] = [];
  spectators = 0;
  paused = false;
  settings: SettingsOf<G>;
  chat: ChatLine[] = [];
  /** Round-trip time in ms (smoothed), or null until measured. */
  rtt: number | null = null;

  // Game -----------------------------------------------------------------
  state: StateOf<G> | null = null;
  /** State sync: the view before `state`. */
  prev: StateOf<G> | null = null;
  /** Current simulation tick (lockstep) or the tick of the latest view (state sync). */
  tick = 0;
  /** Lockstep: latest tick the server has cleared us to simulate to. */
  frontier = 0;
  /** Inputs sent but not yet confirmed: draw these as optimistic "ghosts". */
  pending: PendingInput<CommandOf<G>>[] = [];
  /** Bumped whenever a snapshot replaces the state. */
  snapshots = 0;
  desyncs = 0;

  readonly rules: ReturnType<typeof rules>;
  private turns: { at: number; cmds: StampedCommand[] }[] = [];
  /** Lockstep: the server said 'over', but our sim hasn't reached the final tick yet. */
  private overPending = false;
  private events: EventOf<G>[] = [];
  private acc = 0;
  private nextId = 1;
  private viewAt = 0;
  private viewGap: number;
  private pings = new Map<number, number>();
  private listeners: { [K in keyof RoomEvents<G>]?: Set<RoomEvents<G>[K]> } = {};
  private readonly now: () => number;
  private readonly pendingTimeoutMs: number;

  constructor(
    readonly game: G,
    private transport: (msg: ClientMsg) => void,
    public profile: Profile,
    options: RoomClientOptions = {},
  ) {
    this.rules = rules(game);
    this.settings = (game.settings?.defaults ?? {}) as SettingsOf<G>;
    this.now = options.now ?? (() => (globalThis.performance ?? Date).now());
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? 3000;
    this.viewGap = this.rules.sendRate > 0 ? 1000 / this.rules.sendRate : 0;
  }

  /** Your member entry, if seated. */
  get me(): MemberView | undefined {
    return this.members.find((m) => m.seat === this.seat);
  }

  get connected() {
    return this.status === 'open';
  }

  get spectating() {
    return this.status === 'open' && this.seat === null && this.members.length > 0;
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends keyof RoomEvents<G>>(event: K, fn: RoomEvents<G>[K]): () => void {
    const set = (this.listeners[event] ??= new Set() as never) as Set<RoomEvents<G>[K]>;
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit<K extends keyof RoomEvents<G>>(event: K, ...args: Parameters<RoomEvents<G>[K]>) {
    const set = this.listeners[event] as Set<(...a: unknown[]) => void> | undefined;
    if (set) for (const fn of set) fn(...args);
  }

  // Transport hooks ------------------------------------------------------

  /** Call when the socket (re)opens. */
  opened() {
    this.status = 'open';
    const { token, name, colour, meta } = this.profile;
    this.send({ t: 'hello', v: PROTOCOL_VERSION, game: this.rules.version, token, name, colour, meta: meta ?? null });
    this.emit('change');
  }

  /** Call when the socket closes. */
  closed(willRetry = true) {
    this.status = willRetry && !this.error ? 'reconnecting' : 'closed';
    this.emit('change');
  }

  /** Feed one server message in. */
  receive(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        this.seat = msg.seat;
        this.host = msg.host;
        break;
      case 'room': {
        const was = this.phase;
        // Lockstep: report 'over' only once our own sim reaches the final tick, so
        // game-over UI sees the same final state (winner etc.) the server ended on.
        this.overPending = msg.phase === 'over' && this.game.mode === 'lockstep' && this.state !== null && this.tick < this.frontier;
        this.phase = this.overPending ? 'playing' : msg.phase;
        this.members = msg.members;
        this.spectators = msg.spectators;
        this.paused = msg.paused;
        this.settings = msg.settings as SettingsOf<G>;
        if (msg.chat) this.chat = msg.chat;
        if (msg.phase === 'lobby') this.reset();
        if (was !== this.phase) this.emit('phase', this.phase);
        break;
      }
      case 'snapshot':
        this.state = msg.state as StateOf<G>;
        this.prev = null;
        this.tick = msg.tick;
        this.frontier = msg.tick;
        this.turns = [];
        this.acc = 0;
        this.viewAt = this.now();
        this.pending = [];
        this.snapshots++;
        this.emit('snapshot', msg.state as StateOf<G>);
        break;
      case 'turn':
        if (msg.cmds.length) this.turns.push({ at: msg.at, cmds: msg.cmds });
        this.frontier = Math.max(this.frontier, msg.upTo);
        return; // Hot path: no 'change' event for every turn.
      case 'state': {
        this.prev = this.state;
        this.state = msg.state as StateOf<G>;
        this.tick = msg.tick;
        const now = this.now();
        if (this.viewAt && this.rules.sendRate > 0) this.viewGap = this.viewGap * 0.8 + Math.min(1000, now - this.viewAt) * 0.2;
        this.viewAt = now;
        if (msg.events) this.events.push(...(msg.events as EventOf<G>[]));
        if (msg.ack) {
          const done = new Set(msg.ack);
          this.pending = this.pending.filter((p) => !done.has(p.id));
        }
        if (this.rules.sendRate > 0) return; // Real-time views arrive often; render loops pick them up.
        break;
      }
      case 'reject': {
        const input = msg.id === undefined ? undefined : this.pending.find((p) => p.id === msg.id);
        if (input) this.pending = this.pending.filter((p) => p !== input);
        this.emit('reject', msg.reason, input);
        this.emit('notice', msg.reason);
        break;
      }
      case 'desync':
        this.desyncs++;
        this.emit('notice', 'Resynchronising with the server…');
        break;
      case 'chat':
        this.chat = [...this.chat.slice(-99), msg.line];
        this.emit('chat', msg.line);
        break;
      case 'pong': {
        const sent = this.pings.get(msg.id);
        this.pings.delete(msg.id);
        if (sent !== undefined) {
          const rtt = this.now() - sent;
          this.rtt = Math.round(this.rtt === null ? rtt : this.rtt * 0.7 + rtt * 0.3);
        }
        return;
      }
      case 'notice':
        this.emit('notice', msg.text);
        break;
      case 'error':
        this.error = { code: msg.code, reason: msg.reason };
        this.status = 'closed';
        break;
    }
    this.emit('change');
  }

  // Lobby actions --------------------------------------------------------

  /** Update your name / colour / meta (in the lobby). */
  setProfile(p: { name?: string; colour?: string; meta?: Json | null }) {
    this.profile = { ...this.profile, ...p };
    this.send({ t: 'profile', ...p });
    this.emit('change');
  }

  /** Host: change settings (partial; validated by the server). */
  setSettings(settings: Partial<SettingsOf<G>>) {
    this.send({ t: 'settings', settings: settings as Json });
  }

  /** Host: start the game (also rematch from 'over'). */
  start() {
    this.send({ t: 'start' });
  }

  /** Host: pause or resume. */
  setPaused(paused: boolean) {
    this.send({ t: 'pause', paused });
  }

  /** Host: end the game and return everyone to the lobby. */
  toLobby() {
    this.send({ t: 'toLobby' });
  }

  /** Host: remove a player from the room. */
  kick(seat: number) {
    this.send({ t: 'kick', seat });
  }

  /** Send a chat line. */
  say(text: string) {
    this.send({ t: 'chat', text });
  }

  /** Measure round-trip time (joinRoom calls this every few seconds). */
  ping() {
    const id = this.nextId++;
    this.pings.set(id, this.now());
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!);
    this.send({ t: 'ping', id });
  }

  // Game -----------------------------------------------------------------

  /**
   * Sends intent. Lockstep: it takes effect when the server echoes it back in
   * a turn. State sync: when the server applies it. Until then it sits in
   * `pending`, so you can draw it optimistically. Returns its id (or null if
   * not playing).
   */
  submit(cmd: CommandOf<G>): number | null {
    if (this.phase !== 'playing' || this.overPending || this.seat === null || this.status !== 'open') return null;
    const id = this.nextId++;
    this.pending.push({ id, cmd, at: this.now() });
    this.send({ t: 'input', cmd: cmd as Json, id });
    return id;
  }

  /**
   * Call once per animation frame with the real elapsed time in seconds.
   * Lockstep: runs the sim up to (and gently behind) the frontier, slightly
   * faster when far behind and slower when close. Returns state, events and
   * the render interpolation alpha.
   */
  advance(dtSeconds: number): Frame<StateOf<G>, EventOf<G>> {
    const now = this.now();
    if (this.pending.length && now - this.pending[0].at > this.pendingTimeoutMs) {
      this.pending = this.pending.filter((p) => now - p.at <= this.pendingTimeoutMs);
    }
    if (this.game.mode === 'lockstep') return this.advanceLockstep(this.game, dtSeconds);
    const events = this.events;
    this.events = [];
    const alpha = this.viewGap > 0 && this.prev ? Math.min(1, (now - this.viewAt) / this.viewGap) : 1;
    return { state: this.state, prev: this.prev, alpha, events };
  }

  private advanceLockstep(game: LockstepGame<any, any, any, any>, dt: number): Frame<StateOf<G>, EventOf<G>> {
    const events = this.events;
    this.events = [];
    const s = this.state;
    // No early return when paused: the server simply stops issuing turns, so we
    // finish what we were cleared for and come to rest on the same tick as everyone.
    if (!s) return { state: null, prev: null, alpha: 1, events };
    const lag = this.frontier - this.tick;
    // Ease back to TARGET_LAG; far behind (a slow machine, a hidden tab) sprint to catch up.
    const rate = lag > TARGET_LAG * 2 ? Math.min(30, 1 + (lag - TARGET_LAG * 2) / 6) : lag < TARGET_LAG ? 0.85 : 1;
    this.acc += Math.min(Math.max(dt, 0), 1) * this.rules.tickRate * rate;
    const hashEvery = this.rules.hashEvery;
    while (this.acc >= 1 && this.tick < this.frontier) {
      this.applyDue(game, s, events);
      const ev = game.step(s);
      if (ev) events.push(...ev);
      this.tick++;
      this.acc -= 1;
      if (this.tick % hashEvery === 0 && this.seat !== null) this.send({ t: 'hash', tick: this.tick, hash: game.hash ? game.hash(s) : stateHash(s) });
    }
    // At the frontier, commands for this tick may still be due (e.g. the game ended on a command).
    if (this.tick === this.frontier) this.applyDue(game, s, events);
    // Don't bank time while stalled at the frontier, or we'd lurch forward later.
    if (this.tick >= this.frontier) this.acc = Math.min(this.acc, 1);
    if (this.overPending && this.tick >= this.frontier) {
      this.overPending = false;
      this.phase = 'over';
      this.emit('phase', 'over');
      this.emit('change');
    }
    return { state: s, prev: null, alpha: Math.min(1, this.acc), events };
  }

  private applyDue(game: LockstepGame<any, any, any, any>, s: unknown, events: EventOf<G>[]) {
    while (this.turns.length && this.turns[0].at <= this.tick) {
      const turn = this.turns.shift()!;
      // A stale turn should never happen on an ordered transport; the next hash check repairs us.
      if (turn.at < this.tick) continue;
      for (const c of turn.cmds) {
        const r = game.apply(s, c.c, { seat: c.s, system: c.y === 1 });
        if (r.ok && r.events) events.push(...r.events);
        if (c.s === this.seat && c.i !== undefined) this.pending = this.pending.filter((p) => p.id !== c.i);
      }
    }
  }

  private reset() {
    this.overPending = false;
    this.state = null;
    this.prev = null;
    this.tick = 0;
    this.frontier = 0;
    this.turns = [];
    this.pending = [];
    this.events = [];
    this.acc = 0;
  }

  private send(msg: ClientMsg) {
    this.transport(msg);
  }
}

