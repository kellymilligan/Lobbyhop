/**
 * Small but non-trivial games used by the test suite.
 */
import { defineLockstep, defineStateSync, ok, reject } from '../src/index.js';
import { atan2, cos, nextFloat, nextInt, seedRng, sin } from '../src/det/index.js';
import type { Rng } from '../src/det/index.js';

// ---------------------------------------------------------------------------
// Brawl: lockstep. Units wander and fight; players spawn and steer them.
// ---------------------------------------------------------------------------

export interface Unit {
  id: number;
  owner: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  hp: number;
}
export interface BrawlPlayer {
  seat: number;
  name: string;
  gold: number;
  bot: boolean;
  kills: number;
}
export interface BrawlState {
  rng: Rng;
  tick: number;
  players: BrawlPlayer[];
  units: Unit[];
  nextId: number;
  endTick: number;
}
export type BrawlCmd = { type: 'spawn'; x: number; y: number } | { type: 'steer'; unit: number; x: number; y: number } | { type: 'bot'; on: boolean } | { type: 'join'; name: string } | { type: 'end' };
export type BrawlEvent = { type: 'spawned'; id: number; owner: number } | { type: 'died'; id: number; by: number };

export const brawl = defineLockstep<BrawlState, BrawlCmd, { minutes: number; bots: boolean }, BrawlEvent>({
  name: 'brawl',
  tickRate: 30,
  seats: { min: 1, max: 4 },
  settings: {
    defaults: { minutes: 10, bots: true },
    validate: (raw, cur) => {
      const r = (raw ?? {}) as Partial<{ minutes: number; bots: boolean }>;
      const minutes = typeof r.minutes === 'number' ? Math.min(30, Math.max(1, Math.round(r.minutes))) : cur.minutes;
      return { minutes, bots: typeof r.bots === 'boolean' ? r.bots : cur.bots };
    },
  },
  idleMs: 5_000,
  hooks: {
    idle: () => ({ type: 'bot', on: true }),
    return: () => ({ type: 'bot', on: false }),
    join: (info) => ({ type: 'join', name: info.name }),
  },
  create({ seed, seats, settings }) {
    return {
      rng: seedRng(seed),
      tick: 0,
      players: seats.map((s) => ({ seat: s.seat, name: s.name, gold: 100, bot: false, kills: 0 })),
      units: [],
      nextId: 1,
      endTick: settings.minutes * 60 * 30,
    };
  },
  apply(s, cmd, from) {
    const p = s.players.find((x) => x.seat === from.seat);
    switch (cmd.type) {
      case 'join':
        if (!from.system) return reject('Not allowed.');
        if (!p) s.players.push({ seat: from.seat, name: cmd.name, gold: 100, bot: false, kills: 0 });
        return ok();
      case 'bot':
        if (!from.system || !p) return reject('Not allowed.');
        p.bot = cmd.on;
        return ok();
      case 'end':
        s.endTick = s.tick;
        return ok();
      case 'spawn': {
        if (!p) return reject('No such player.');
        if (p.gold < 10) return reject('Not enough gold.');
        if (!(cmd.x >= 0 && cmd.x <= 100 && cmd.y >= 0 && cmd.y <= 100)) return reject('Out of bounds.');
        p.gold -= 10;
        const id = s.nextId++;
        s.units.push({ id, owner: from.seat, x: cmd.x, y: cmd.y, tx: cmd.x, ty: cmd.y, hp: 30 });
        return ok([{ type: 'spawned', id, owner: from.seat }]);
      }
      case 'steer': {
        const u = s.units.find((x) => x.id === cmd.unit);
        if (!u || u.owner !== from.seat) return reject('Not your unit.');
        u.tx = cmd.x;
        u.ty = cmd.y;
        return ok();
      }
    }
  },
  step(s) {
    const events: BrawlEvent[] = [];
    s.tick++;
    if (s.tick % 30 === 0) for (const p of s.players) p.gold += 5;
    for (const p of s.players) {
      if (p.bot && s.tick % 45 === 0 && p.gold >= 10) {
        p.gold -= 10;
        const id = s.nextId++;
        const x = nextFloat(s.rng) * 100;
        const y = nextFloat(s.rng) * 100;
        s.units.push({ id, owner: p.seat, x, y, tx: x, ty: y, hp: 30 });
      }
    }
    for (const u of s.units) {
      if (nextInt(s.rng, 60) === 0) {
        const a = nextFloat(s.rng) * 6.283;
        u.tx = Math.min(100, Math.max(0, u.x + cos(a) * 20));
        u.ty = Math.min(100, Math.max(0, u.y + sin(a) * 20));
      }
      const dx = u.tx - u.x;
      const dy = u.ty - u.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.5) {
        const a = atan2(dy, dx);
        u.x += cos(a) * 0.5;
        u.y += sin(a) * 0.5;
      }
    }
    for (const u of s.units) {
      if (u.hp <= 0) continue;
      for (const v of s.units) {
        if (v.owner === u.owner || v.hp <= 0) continue;
        const dx = v.x - u.x;
        const dy = v.y - u.y;
        if (dx * dx + dy * dy < 9) {
          v.hp -= 1 + nextInt(s.rng, 3);
          if (v.hp <= 0) {
            events.push({ type: 'died', id: v.id, by: u.owner });
            const k = s.players.find((p) => p.seat === u.owner);
            if (k) k.kills++;
          }
        }
      }
    }
    s.units = s.units.filter((u) => u.hp > 0);
    return events;
  },
  isOver: (s) => s.tick >= s.endTick,
});

export function randomBrawlCmd(rng: Rng, state: BrawlState | null, seat: number | null): BrawlCmd {
  const mine = state?.units.filter((u) => u.owner === seat) ?? [];
  if (mine.length && nextFloat(rng) < 0.4) {
    const u = mine[nextInt(rng, mine.length)];
    return { type: 'steer', unit: u.id, x: nextFloat(rng) * 100, y: nextFloat(rng) * 100 };
  }
  return { type: 'spawn', x: nextFloat(rng) * 100, y: nextFloat(rng) * 100 };
}

// ---------------------------------------------------------------------------
// Secrets: turn-based state sync with hidden information.
// ---------------------------------------------------------------------------

export interface SecretsState {
  secrets: number[];
  guesses: { seat: number; target: number; value: number; right: boolean }[];
  turn: number;
  seats: number[];
  winner: number | null;
}
export interface SecretsView {
  mySecret: number | null;
  guesses: SecretsState['guesses'];
  turn: number;
  seats: number[];
  winner: number | null;
}
export type SecretsCmd = { type: 'guess'; target: number; value: number };

export const secrets = defineStateSync<SecretsState, SecretsCmd, Record<string, never>, { type: 'guessed'; right: boolean }, SecretsView>({
  name: 'secrets',
  tickRate: 0,
  seats: { min: 2, max: 4 },
  create({ seed, seats }) {
    const rng = seedRng(seed);
    return { secrets: seats.map(() => 1 + nextInt(rng, 10)), guesses: [], turn: 0, seats: seats.map((s) => s.seat), winner: null };
  },
  apply(s, cmd, from) {
    if (s.seats[s.turn] !== from.seat) return reject('Not your turn.');
    const ti = s.seats.indexOf(cmd.target);
    if (ti < 0 || cmd.target === from.seat) return reject('Pick another player.');
    const right = s.secrets[ti] === cmd.value;
    s.guesses.push({ seat: from.seat, target: cmd.target, value: cmd.value, right });
    if (right) s.winner = from.seat;
    s.turn = (s.turn + 1) % s.seats.length;
    return ok([{ type: 'guessed', right }]);
  },
  view(s, seat) {
    const i = seat === null ? -1 : s.seats.indexOf(seat);
    return { mySecret: i >= 0 ? s.secrets[i] : null, guesses: s.guesses, turn: s.turn, seats: s.seats, winner: s.winner };
  },
  isOver: (s) => s.winner !== null,
});

// ---------------------------------------------------------------------------
// Drift: real-time state sync with no lobby (drop-in, drop-out).
// ---------------------------------------------------------------------------

export interface DriftState {
  cursors: { seat: number; name: string; x: number; y: number; vx: number; vy: number }[];
  t: number;
}
export type DriftCmd = { type: 'aim'; vx: number; vy: number } | { type: 'join'; name: string } | { type: 'leave' };

export const drift = defineStateSync<DriftState, DriftCmd>({
  name: 'drift',
  tickRate: 20,
  lobby: false,
  idleMs: 2_000,
  seats: { max: 3 },
  hooks: {
    join: (info) => ({ type: 'join', name: info.name }),
    idle: () => ({ type: 'leave' }),
  },
  create({ seats }) {
    return { cursors: seats.map((s) => ({ seat: s.seat, name: s.name, x: 50, y: 50, vx: 0, vy: 0 })), t: 0 };
  },
  apply(s, cmd, from) {
    if (cmd.type === 'join') {
      if (!from.system) return reject('Not allowed.');
      s.cursors = s.cursors.filter((c) => c.seat !== from.seat);
      s.cursors.push({ seat: from.seat, name: cmd.name, x: 50, y: 50, vx: 0, vy: 0 });
      return ok();
    }
    if (cmd.type === 'leave') {
      if (!from.system) return reject('Not allowed.');
      s.cursors = s.cursors.filter((c) => c.seat !== from.seat);
      return ok();
    }
    const c = s.cursors.find((x) => x.seat === from.seat);
    if (!c) return reject('No cursor.');
    c.vx = Math.max(-1, Math.min(1, cmd.vx));
    c.vy = Math.max(-1, Math.min(1, cmd.vy));
    return ok();
  },
  step(s) {
    s.t++;
    for (const c of s.cursors) {
      c.x = Math.max(0, Math.min(100, c.x + c.vx));
      c.y = Math.max(0, Math.min(100, c.y + c.vy));
    }
  },
});

// ---------------------------------------------------------------------------
// World: a persistent, lobby-less, delta-synced state-sync game. Entities live
// in an object keyed by id; a few move each tick, most rest (like sleeping bodies).
// ---------------------------------------------------------------------------

export interface WorldThing {
  x: number;
  y: number;
  /** Server-only (velocity); stripped from views. */
  v: number;
  owner: number;
}
export interface WorldState {
  things: Record<string, WorldThing>;
  next: number;
  t: number;
}
export interface WorldView {
  things: Record<string, { x: number; y: number; owner: number }>;
  t: number;
}
export type WorldCmd = { type: 'spawn'; x: number } | { type: 'push'; id: string } | { type: 'join' } | { type: 'leave' };

export const world = defineStateSync<WorldState, WorldCmd, Record<string, never>, never, WorldView>({
  name: 'world',
  version: 2,
  tickRate: 20,
  delta: true,
  lobby: false,
  idleMs: 2_000,
  seats: { max: 8 },
  hooks: { join: () => ({ type: 'join' }), idle: () => ({ type: 'leave' }) },
  create: () => ({ things: {}, next: 1, t: 0 }),
  apply(s, cmd, from) {
    if (cmd.type === 'join' || cmd.type === 'leave') return from.system ? ok() : reject('Not allowed.');
    if (cmd.type === 'spawn') {
      s.things[String(s.next++)] = { x: cmd.x, y: 10, v: 0, owner: from.seat };
      return ok();
    }
    const t = s.things[cmd.id];
    if (!t) return reject('No such thing.');
    t.v = 1;
    return ok();
  },
  step(s) {
    s.t++;
    for (const [id, t] of Object.entries(s.things)) {
      if (t.y > 0) t.y = Math.max(0, t.y - 1); // falls, then rests
      if (t.v) t.x += t.v;
      if (t.x > 50) delete s.things[id]; // pushed off the edge
    }
  },
  view: (s) => ({ things: Object.fromEntries(Object.entries(s.things).map(([id, t]) => [id, { x: t.x, y: t.y, owner: t.owner }])), t: s.t }),
  migrate: (old, from) => (from === 1 ? { things: (old as { things: Record<string, WorldThing> }).things, next: 99, t: 0 } : null),
});
