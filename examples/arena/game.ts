/**
 * Orb Arena: a small real-time lockstep game. Move with WASD / arrows (or
 * hold a finger to steer), click or tap to drop a wall, collect orbs.
 *
 * Shows the lockstep essentials: a deterministic sim (seeded RNG in state,
 * no Math.random / trig), bots inside the sim, previous positions kept in
 * state for render interpolation, idle-seat takeover by a bot, and inputs
 * sent only when they change.
 */
import { defineLockstep, ok, reject } from 'lobbyhop';
import type { SeatInfo } from 'lobbyhop';
import { nextFloat, nextInt, seedRng } from 'lobbyhop/det';
import type { Rng } from 'lobbyhop/det';

export const W = 40;
export const H = 24;
const SPEED = 0.22;
const RADIUS = 0.45;
const WALL_TTL = 30 * 8;
const WALL_COOLDOWN = 30;
const ORBS = 7;
const PALETTE = ['#e5484d', '#3e9bff', '#30a46c', '#f5a524'];

export interface Player {
  seat: number;
  name: string;
  colour: string;
  /** Current and previous-tick position (render interpolates between them). */
  x: number;
  y: number;
  px: number;
  py: number;
  /** Held direction, each -1, 0 or 1. */
  dx: number;
  dy: number;
  score: number;
  bot: boolean;
  /** True for seats that started with a human. */
  human: boolean;
  wallCd: number;
  /** Bot brain: current target. */
  goal: number;
}
export interface Orb {
  id: number;
  x: number;
  y: number;
}
export interface Wall {
  id: number;
  owner: number;
  x: number;
  y: number;
  ttl: number;
}
export interface State {
  rng: Rng;
  tick: number;
  players: Player[];
  orbs: Orb[];
  walls: Wall[];
  nextId: number;
  target: number;
  endTick: number;
  winner: number | null;
}

export interface Settings {
  bots: boolean;
  target: number;
  minutes: number;
}

export type Command =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'wall'; x: number; y: number }
  /** Server hooks only: a bot takes over an idle seat, or hands it back. */
  | { type: 'bot'; on: boolean };

export type Event = { type: 'orb'; seat: number; x: number; y: number } | { type: 'wall'; seat: number } | { type: 'win'; seat: number };

const BOT_NAMES = ['Bolt', 'Pip', 'Nyx', 'Moss'];

function spawnPoint(seat: number): [number, number] {
  const corners: [number, number][] = [
    [3, 3],
    [W - 3, H - 3],
    [W - 3, 3],
    [3, H - 3],
  ];
  return corners[seat % 4];
}

function makePlayer(seat: number, info: SeatInfo | null, colour: string): Player {
  const [x, y] = spawnPoint(seat);
  return { seat, name: info?.name ?? BOT_NAMES[seat % 4], colour, x, y, px: x, py: y, dx: 0, dy: 0, score: 0, bot: !info, human: !!info, wallCd: 0, goal: -1 };
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function blocked(s: State, x: number, y: number): boolean {
  if (x < RADIUS || y < RADIUS || x > W - RADIUS || y > H - RADIUS) return true;
  for (const w of s.walls) {
    // Circle vs unit-square cell.
    const cx = Math.max(w.x, Math.min(x, w.x + 1));
    const cy = Math.max(w.y, Math.min(y, w.y + 1));
    const ddx = x - cx;
    const ddy = y - cy;
    if (ddx * ddx + ddy * ddy < RADIUS * RADIUS) return true;
  }
  return false;
}

function spawnOrb(s: State) {
  for (let tries = 0; tries < 20; tries++) {
    const x = 1 + nextInt(s.rng, W - 2) + 0.5;
    const y = 1 + nextInt(s.rng, H - 2) + 0.5;
    if (!blocked(s, x, y)) {
      s.orbs.push({ id: s.nextId++, x, y });
      return;
    }
  }
}

function thinkBot(s: State, p: Player) {
  // Re-plan every 10 ticks: head for the nearest orb, with a little noise.
  if (s.tick % 10 !== p.seat) return;
  let best: Orb | null = null;
  let bestD = Infinity;
  for (const o of s.orbs) {
    const d = (o.x - p.x) * (o.x - p.x) + (o.y - p.y) * (o.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (!best) return;
  p.goal = best.id;
  const tx = best.x + (nextFloat(s.rng) - 0.5) * 2;
  const ty = best.y + (nextFloat(s.rng) - 0.5) * 2;
  p.dx = Math.abs(tx - p.x) > 0.3 ? sign(tx - p.x) : 0;
  p.dy = Math.abs(ty - p.y) > 0.3 ? sign(ty - p.y) : 0;
  if (nextInt(s.rng, 40) === 0) p.dx = -p.dx;
}

export const game = defineLockstep<State, Command, Settings, Event>({
  name: 'arena',
  version: 1,
  tickRate: 30,
  turnMs: 100,
  seats: { min: 1, max: 4, palette: PALETTE },
  settings: {
    defaults: { bots: true, target: 15, minutes: 3 },
    validate: (raw, cur) => {
      const r = (raw ?? {}) as Partial<Settings>;
      return {
        bots: typeof r.bots === 'boolean' ? r.bots : cur.bots,
        target: typeof r.target === 'number' ? Math.max(5, Math.min(50, Math.round(r.target))) : cur.target,
        minutes: typeof r.minutes === 'number' ? Math.max(1, Math.min(10, Math.round(r.minutes))) : cur.minutes,
      };
    },
  },
  // A start rule that depends on settings: solo play needs bots to play against.
  canStart: (seats, settings) => (!settings.bots && seats.length < 2 ? 'Without bots you need at least two players.' : null),
  idleMs: 15_000,
  hooks: {
    idle: () => ({ type: 'bot', on: true }),
    return: () => ({ type: 'bot', on: false }),
  },
  create({ seed, seats, settings }) {
    const count = settings.bots ? 4 : Math.max(1, seats.length);
    const used = new Set(seats.map((s) => s.colour)); // lobbyhop-audit-ignore: local lookup, never stored
    const spare = PALETTE.filter((c) => !used.has(c));
    const players = Array.from({ length: count }, (_, i) => {
      const info = seats.find((s) => s.seat === i) ?? null;
      return makePlayer(i, info, info?.colour ?? spare.shift() ?? PALETTE[i]);
    });
    const s: State = { rng: seedRng(seed), tick: 0, players, orbs: [], walls: [], nextId: 1, target: settings.target, endTick: settings.minutes * 60 * 30, winner: null };
    for (let i = 0; i < ORBS; i++) spawnOrb(s);
    return s;
  },
  apply(s, cmd, from) {
    const p = s.players[from.seat];
    if (!p) return reject('You have no runner.');
    switch (cmd.type) {
      case 'move':
        if (p.bot) return reject('A bot is playing this seat.');
        p.dx = sign(cmd.dx);
        p.dy = sign(cmd.dy);
        return ok();
      case 'wall': {
        if (p.bot) return reject('A bot is playing this seat.');
        const x = Math.floor(cmd.x);
        const y = Math.floor(cmd.y);
        if (p.wallCd > 0) return reject('Wall on cooldown.');
        if (x < 0 || y < 0 || x >= W || y >= H) return reject('Out of the arena.');
        if ((x + 0.5 - p.x) * (x + 0.5 - p.x) + (y + 0.5 - p.y) * (y + 0.5 - p.y) > 36) return reject('Too far away.');
        if (s.walls.some((w) => w.x === x && w.y === y)) return reject('Already a wall there.');
        if (s.players.some((q) => q.x > x - RADIUS && q.x < x + 1 + RADIUS && q.y > y - RADIUS && q.y < y + 1 + RADIUS)) return reject('Someone is standing there.');
        s.walls.push({ id: s.nextId++, owner: p.seat, x, y, ttl: WALL_TTL });
        p.wallCd = WALL_COOLDOWN;
        return ok([{ type: 'wall', seat: p.seat }]);
      }
      case 'bot':
        if (!from.system) return reject('Not allowed.');
        p.bot = cmd.on && true;
        if (!cmd.on) {
          p.dx = 0;
          p.dy = 0;
        }
        return ok();
    }
  },
  step(s) {
    const events: Event[] = [];
    s.tick++;
    for (const w of s.walls) w.ttl--;
    s.walls = s.walls.filter((w) => w.ttl > 0);
    for (const p of s.players) {
      p.px = p.x;
      p.py = p.y;
      if (p.wallCd > 0) p.wallCd--;
      if (p.bot) thinkBot(s, p);
      if (!p.dx && !p.dy) continue;
      // Diagonals at the same speed: 1/√2, computed with exact arithmetic.
      const k = p.dx && p.dy ? SPEED * 0.7071067811865476 : SPEED;
      // Axis-separated movement so runners slide along walls.
      const nx = p.x + p.dx * k;
      if (!blocked(s, nx, p.y)) p.x = nx;
      const ny = p.y + p.dy * k;
      if (!blocked(s, p.x, ny)) p.y = ny;
    }
    for (const p of s.players) {
      for (let i = s.orbs.length - 1; i >= 0; i--) {
        const o = s.orbs[i];
        if ((o.x - p.x) * (o.x - p.x) + (o.y - p.y) * (o.y - p.y) < 0.8) {
          s.orbs.splice(i, 1);
          p.score++;
          events.push({ type: 'orb', seat: p.seat, x: o.x, y: o.y });
          if (p.score >= s.target && s.winner === null) s.winner = p.seat;
        }
      }
    }
    while (s.orbs.length < ORBS) spawnOrb(s);
    if (s.winner === null && s.tick >= s.endTick) {
      // Time's up: highest score wins; ties go to the lower seat.
      s.winner = s.players.reduce((a, b) => (b.score > a.score ? b : a)).seat;
    }
    if (s.winner !== null) events.push({ type: 'win', seat: s.winner });
    return events;
  },
  isOver: (s) => s.winner !== null,
});
