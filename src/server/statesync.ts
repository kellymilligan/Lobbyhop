/**
 * Authoritative state sync. Only the server runs the game. Commands are
 * applied as they arrive; each player is sent their `view` of the state when
 * it changes (immediately for event-driven games, at `sendRate` otherwise).
 */
import type { Json, Setup, StateSyncGame } from '../shared/game.js';
import type { EngineHost, ServerEngine } from './engine.js';
import { safeApply } from './engine.js';

export class StateSyncEngine<S> implements ServerEngine {
  state: S | null = null;
  tick = 0;
  private events: unknown[] = [];
  private dirty = false;
  private acks = new Map<string, number[]>();
  private last = new Map<string, string>();
  private clockBase = 0;
  private tickBase = 0;
  private lastSend = 0;
  private readonly maxCatchUp: number;

  constructor(
    private game: StateSyncGame<S, unknown, unknown, unknown, unknown>,
    private host: EngineHost,
    private opts: { tickRate: number; sendRate: number },
  ) {
    this.maxCatchUp = Math.max(1, opts.tickRate * 5);
  }

  get running() {
    return this.state !== null;
  }

  /** Real-time: run at the faster of tick and send rate. Event-driven: a 1 s housekeeping beat. */
  get clockMs() {
    const hz = Math.max(this.opts.tickRate, this.opts.sendRate);
    return hz > 0 ? Math.max(16, Math.round(1000 / hz)) : 1000;
  }

  start(setup: Setup<unknown>) {
    this.state = this.game.create(setup);
    this.tick = 0;
    this.events = [];
    this.acks.clear();
    this.last.clear();
    this.dirty = false;
    this.rebase();
  }

  clear() {
    this.state = null;
    this.tick = 0;
    this.events = [];
    this.acks.clear();
    this.last.clear();
  }

  rebase() {
    this.clockBase = this.host.now();
    this.tickBase = this.tick;
  }

  input(conn: string, seat: number, cmd: unknown, id: number) {
    const s = this.state;
    if (!s) return;
    const r = safeApply(() => this.game.apply(s, cmd, { seat, system: false }), this.host.log);
    if (!r.ok) return this.host.reject(conn, id, r.reason);
    if (r.events) this.events.push(...r.events);
    this.dirty = true;
    const list = this.acks.get(conn);
    if (list) list.push(id);
    else this.acks.set(conn, [id]);
    this.afterChange();
  }

  system(seat: number, cmd: unknown) {
    const s = this.state;
    if (!s) return;
    const r = safeApply(() => this.game.apply(s, cmd, { seat, system: true }), this.host.log);
    if (!r.ok) return;
    if (r.events) this.events.push(...r.events);
    this.dirty = true;
    this.afterChange();
  }

  private afterChange() {
    if (this.opts.tickRate === 0) this.flush();
    if (this.state && this.game.isOver?.(this.state)) {
      this.flush();
      this.host.over();
    }
  }

  pump() {
    const s = this.state;
    if (!s) return;
    const { tickRate, sendRate } = this.opts;
    const now = this.host.now();
    if (tickRate > 0 && this.game.step) {
      let target = this.tickBase + Math.floor(((now - this.clockBase) * tickRate) / 1000);
      if (target - this.tick > this.maxCatchUp) {
        target = this.tick + this.maxCatchUp;
        this.clockBase = now;
        this.tickBase = target;
      }
      let over = false;
      while (this.tick < target && !over) {
        const ev = this.game.step(s);
        if (ev) this.events.push(...ev);
        this.tick++;
        this.dirty = true;
        over = this.game.isOver?.(s) ?? false;
      }
      if (over) {
        this.flush();
        return this.host.over();
      }
    }
    if (sendRate > 0 && now - this.lastSend >= 1000 / sendRate - 1) this.flush();
  }

  /** Sends changed views (plus pending events and acks) to every viewer. */
  flush() {
    const s = this.state;
    if (!s) return;
    this.lastSend = this.host.now();
    if (!this.dirty && this.acks.size === 0 && this.events.length === 0) return;
    const events = this.events.length ? JSON.stringify(this.events) : '';
    this.events = [];
    const view = this.game.view;
    const shared = view ? '' : JSON.stringify(s);
    const bySeat = new Map<number | null, string>();
    for (const v of this.host.viewers()) {
      let json = shared;
      if (view) {
        json = bySeat.get(v.seat) ?? JSON.stringify(view(s, v.seat));
        bySeat.set(v.seat, json);
      }
      const ack = this.acks.get(v.conn);
      if (json === this.last.get(v.conn) && !events && !ack) continue;
      this.last.set(v.conn, json);
      let msg = `{"t":"state","tick":${this.tick},"state":${json}`;
      if (events) msg += `,"events":${events}`;
      if (ack) msg += `,"ack":${JSON.stringify(ack)}`;
      this.host.send(v.conn, msg + '}');
    }
    this.acks.clear();
    this.dirty = false;
  }

  hash() {}

  snapshot(conn: string, seat: number | null) {
    const s = this.state;
    if (!s) return;
    const json = JSON.stringify(this.game.view ? this.game.view(s, seat) : s);
    this.last.set(conn, json);
    this.host.send(conn, `{"t":"snapshot","tick":${this.tick},"state":${json}}`);
  }

  forget(conn: string) {
    this.last.delete(conn);
    this.acks.delete(conn);
  }

  save(): Json {
    return this.state ? ({ tick: this.tick, state: this.state } as unknown as Json) : null;
  }

  restore(data: Json) {
    const d = data as { tick: number; state: S } | null;
    if (!d) return this.clear();
    this.state = d.state;
    this.tick = d.tick;
    this.events = [];
    this.acks.clear();
    this.last.clear();
    this.rebase();
  }
}
