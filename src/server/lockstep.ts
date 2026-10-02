/**
 * Server-clocked lockstep. The room owns the clock and runs the same
 * simulation headless. Every turn it validates queued commands against its
 * own state, steps to wall-clock time and broadcasts
 * `turn { at, upTo, cmds }`. Clients never simulate past `upTo`.
 */
import type { Json, LockstepGame, Setup } from '../shared/game.js';
import type { StampedCommand } from '../shared/protocol.js';
import { stateHash } from '../det/index.js';
import type { EngineHost, ServerEngine } from './engine.js';
import { safeApply } from './engine.js';

interface Queued {
  seat: number;
  cmd: unknown;
  id?: number;
  conn: string | null;
  system: boolean;
}

export class LockstepEngine<S> implements ServerEngine {
  state: S | null = null;
  tick = 0;
  private queue: Queued[] = [];
  private clockBase = 0;
  private tickBase = 0;
  private hashes = new Map<number, number>();
  private snap: { tick: number; json: string } | null = null;
  private readonly maxCatchUp: number;

  constructor(
    private game: LockstepGame<S, unknown, unknown, unknown>,
    private host: EngineHost,
    private opts: { tickRate: number; turnMs: number; hashEvery: number },
  ) {
    this.maxCatchUp = opts.tickRate * 5;
  }

  get running() {
    return this.state !== null;
  }

  get clockMs() {
    return this.opts.turnMs;
  }

  start(setup: Setup<unknown>) {
    this.state = this.game.create(setup);
    this.tick = 0;
    this.queue = [];
    this.hashes.clear();
    this.snap = null;
    this.rebase();
  }

  clear() {
    this.state = null;
    this.tick = 0;
    this.queue = [];
    this.hashes.clear();
    this.snap = null;
  }

  rebase() {
    this.clockBase = this.host.now();
    this.tickBase = this.tick;
  }

  input(conn: string, seat: number, cmd: unknown, id: number) {
    this.queue.push({ seat, cmd, id, conn, system: false });
  }

  system(seat: number, cmd: unknown) {
    this.queue.push({ seat, cmd, conn: null, system: true });
  }

  pump() {
    const s = this.state;
    if (!s) return;
    const { tickRate, hashEvery } = this.opts;
    const now = this.host.now();
    let target = this.tickBase + Math.floor(((now - this.clockBase) * tickRate) / 1000);
    if (target - this.tick > this.maxCatchUp) {
      // The host stalled (suspended, overloaded): don't fast-forward forever.
      target = this.tick + this.maxCatchUp;
      this.clockBase = now;
      this.tickBase = target;
    }
    if (target <= this.tick) return;
    const at = this.tick;
    const cmds: StampedCommand[] = [];
    for (const q of this.queue) {
      const r = safeApply(() => this.game.apply(s, q.cmd, { seat: q.seat, system: q.system }), this.host.log);
      if (r.ok) {
        const c: StampedCommand = { s: q.seat, c: q.cmd };
        if (q.id !== undefined) c.i = q.id;
        if (q.system) c.y = 1;
        cmds.push(c);
      } else if (!q.system) this.host.reject(q.conn, q.id, r.reason);
    }
    this.queue = [];
    let over = this.game.isOver?.(s) ?? false;
    while (this.tick < target && !over) {
      this.game.step(s);
      this.tick++;
      if (this.tick % hashEvery === 0) {
        this.hashes.set(this.tick, this.game.hash ? this.game.hash(s) : stateHash(s));
        this.hashes.delete(this.tick - hashEvery * 20);
      }
      over = this.game.isOver?.(s) ?? false;
    }
    const msg = JSON.stringify({ t: 'turn', at, upTo: this.tick, cmds });
    for (const v of this.host.viewers()) this.host.send(v.conn, msg);
    if (over) this.host.over();
  }

  hash(conn: string, tick: number, hash: number) {
    const mine = this.hashes.get(tick);
    if (mine === undefined || mine === hash || !this.state) return;
    this.host.log(`desync on ${conn} at tick ${tick}`);
    this.host.send(conn, JSON.stringify({ t: 'desync', tick }));
    this.snapshot(conn);
  }

  snapshot(conn: string) {
    if (!this.state) return;
    if (this.snap?.tick !== this.tick) this.snap = { tick: this.tick, json: JSON.stringify({ t: 'snapshot', tick: this.tick, state: this.state }) };
    this.host.send(conn, this.snap.json);
  }

  save(): Json {
    return this.state ? ({ tick: this.tick, state: this.state } as unknown as Json) : null;
  }

  restore(data: Json) {
    const d = data as { tick: number; state: S } | null;
    if (!d) return this.clear();
    this.state = d.state;
    this.tick = d.tick;
    this.queue = [];
    this.hashes.clear();
    this.snap = null;
    this.rebase();
  }
}
