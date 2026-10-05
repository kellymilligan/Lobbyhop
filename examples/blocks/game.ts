/**
 * Blocks: a persistent shared world. 100 blocks start in a pile inside an
 * invisible container; anyone who visits can pick them up, carry, turn and
 * stack them, and the world stays as the last visitor left it.
 *
 * State sync with deltas: the server alone runs Box3D (physics/box3d.ts) and
 * sends each client only the blocks that moved. Resting (sleeping) blocks cost
 * nothing on the wire. Keep the room alive forever with `emptyTtlMs: null`
 * (see worker.ts).
 */
import { defineStateSync, ok, reject } from 'lobbyhop';
import { nextFloat, nextInt, seedRng } from 'lobbyhop/det';
import { BoxWorld } from './physics/box3d.js';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** Inside dimensions of the invisible container (metres). */
export const BOUNDS = { x: 10, z: 10, height: 12 };
const TICK_RATE = 60;
const BLOCKS = 100;

export const COLOURS = ['#f2d0a4', '#e8a87c', '#c38d9e', '#41b3a3', '#85cdca', '#e27d60', '#f5f1e3', '#7d8ca3'];

/** Block shapes (half-extents): cubes, bricks, planks, pillars and slabs. */
const SHAPES: Vec3[] = [
  [0.5, 0.5, 0.5],
  [1, 0.5, 0.5],
  [1.5, 0.25, 0.5],
  [0.25, 1, 0.25],
  [1, 0.25, 1],
];

export interface Block {
  /** Half-extents. */
  s: Vec3;
  /** Colour index into COLOURS. */
  c: number;
  p: Vec3;
  q: Quat;
  /** Server-only: velocities of moving blocks (restores a mid-fall world exactly). */
  v?: Vec3;
  w?: Vec3;
}

export interface State {
  blocks: Record<string, Block>;
  /** Who's carrying what: seat → block id and drag target. */
  holds: Record<string, { id: string; t: Vec3 }>;
  /** Everyone's 3D pointer, for co-presence. */
  cursors: Record<string, Vec3>;
}

/** What clients receive: no velocities, holds reduced to seat → block id. */
export interface View {
  blocks: Record<string, { s: Vec3; c: number; p: Vec3; q: Quat }>;
  holds: Record<string, string>;
  cursors: Record<string, Vec3>;
}

export type Command =
  | { type: 'grab'; id: string; t: Vec3 }
  | { type: 'drag'; t: Vec3 }
  | { type: 'turn' }
  | { type: 'release' }
  | { type: 'aim'; p: Vec3 }
  /** Server hook only: a visitor left. */
  | { type: 'leave' };

// --- Physics: one Box3D world per state object, rebuilt from JSON after a restore ---

interface Physics {
  world: BoxWorld;
  handles: Map<string, number>;
  ids: string[];
}
const physics = new WeakMap<State, Physics>();

function physicsFor(s: State): Physics {
  let ph = physics.get(s);
  if (ph) return ph;
  const world = BoxWorld.create([0, -10, 0]);
  // The floor, four walls and a ceiling: blocks can't leave the world.
  const { x, z, height } = BOUNDS;
  const t = 1;
  world.addStatic([x + t, t, z + t], [0, -t, 0], 0.7);
  world.addStatic([t, height, z + t], [x + t, height, 0]);
  world.addStatic([t, height, z + t], [-x - t, height, 0]);
  world.addStatic([x + t, height, t], [0, height, z + t]);
  world.addStatic([x + t, height, t], [0, height, -z - t]);
  world.addStatic([x + t, t, z + t], [0, height + t, 0]);
  const handles = new Map<string, number>();
  const ids = Object.keys(s.blocks).sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    const b = s.blocks[id];
    // Blocks that were resting when saved come back asleep, so stacks don't twitch on wake-up.
    handles.set(id, world.addBox({ half: b.s, p: b.p, q: b.q, v: b.v, w: b.w, awake: !!b.v, density: 1, friction: 0.7 }));
  }
  ph = { world, handles, ids };
  physics.set(s, ph);
  return ph;
}

const q3 = (n: number) => Math.round(n * 1000) / 1000;
const q4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const inside = (t: Vec3): Vec3 => [clamp(t[0], -BOUNDS.x + 0.5, BOUNDS.x - 0.5), clamp(t[1], 0.3, BOUNDS.height - 0.5), clamp(t[2], -BOUNDS.z + 0.5, BOUNDS.z - 0.5)];
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Quaternion product a·b. */
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const YAW_90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

export const game = defineStateSync<State, Command, Record<string, never>, never, View>({
  name: 'blocks',
  version: 1,
  tickRate: TICK_RATE,
  sendRate: 20,
  delta: true,
  lobby: false,
  seats: { max: 32 },
  // A visitor who drops off releases their block after a few seconds.
  idleMs: 4_000,
  hooks: { idle: () => ({ type: 'leave' }) },

  create({ seed }) {
    if (BLOCKS > 100) throw new Error('the starting heap layout fits 100 blocks under the ceiling');
    // A loose heap in the middle; it tumbles into a pile on the first tick.
    const rng = seedRng(seed);
    const blocks: Record<string, Block> = {};
    for (let i = 0; i < BLOCKS; i++) {
      const s = SHAPES[nextInt(rng, SHAPES.length)];
      // A 5 × 5 grid, four layers high: always well under the ceiling.
      const layer = Math.floor(i / 25);
      const k = i % 25;
      const yaw = nextFloat(rng) * Math.PI;
      blocks[String(i + 1)] = {
        s: [...s],
        c: nextInt(rng, COLOURS.length),
        p: [q3(((k % 5) - 2) * 2 + (nextFloat(rng) - 0.5) * 0.4), q3(1.2 + layer * 2.2), q3((Math.floor(k / 5) - 2) * 2 + (nextFloat(rng) - 0.5) * 0.4)],
        q: [0, q4(Math.sin(yaw / 2)), 0, q4(Math.cos(yaw / 2))],
        v: [0, 0, 0],
        w: [0, 0, 0],
      };
    }
    return { blocks, holds: {}, cursors: {} };
  },

  apply(s, cmd, from) {
    const seat = String(from.seat);
    switch (cmd.type) {
      case 'grab': {
        if (!s.blocks[cmd.id]) return reject('No such block.');
        if (!isVec(cmd.t)) return reject('Bad target.');
        const holder = Object.entries(s.holds).find(([k, h]) => h.id === cmd.id && k !== seat);
        if (holder) return reject('Someone else is holding that block.');
        s.holds[seat] = { id: cmd.id, t: inside(cmd.t) };
        return ok();
      }
      case 'drag': {
        const h = s.holds[seat];
        if (!h || !isVec(cmd.t)) return reject('Not holding a block.');
        h.t = inside(cmd.t);
        return ok();
      }
      case 'turn': {
        const h = s.holds[seat];
        if (!h) return reject('Not holding a block.');
        const ph = physicsFor(s);
        const b = s.blocks[h.id];
        b.q = qmul(YAW_90, b.q).map(q4) as Quat;
        ph.world.setRotation(ph.handles.get(h.id)!, b.q);
        return ok();
      }
      case 'release':
        delete s.holds[seat];
        return ok();
      case 'aim':
        if (!isVec(cmd.p)) return reject('Bad pointer.');
        s.cursors[seat] = cmd.p.map(q3) as Vec3;
        return ok();
      case 'leave':
        if (!from.system) return reject('Not allowed.');
        delete s.holds[seat];
        delete s.cursors[seat];
        return ok();
    }
  },

  step(s) {
    const ph = physicsFor(s);
    for (const h of Object.values(s.holds)) {
      const handle = ph.handles.get(h.id);
      if (handle !== undefined) ph.world.drag(handle, h.t);
    }
    ph.world.step(1 / TICK_RATE, 4);
    const bodies = ph.world.read();
    // Write back only moving blocks; quantising keeps resting blocks byte-identical, so they never re-send.
    for (const id of ph.ids) {
      const body = bodies[ph.handles.get(id)!];
      const b = s.blocks[id];
      if (!body.awake) {
        if (b.v) {
          b.p = body.p.map(q3) as Vec3;
          b.q = body.q.map(q4) as Quat;
          delete b.v;
          delete b.w;
        }
        continue;
      }
      b.p = body.p.map(q3) as Vec3;
      b.q = body.q.map(q4) as Quat;
      b.v = body.v.map(q3) as Vec3;
      b.w = body.w.map(q3) as Vec3;
    }
  },

  view: (s) => ({
    blocks: Object.fromEntries(Object.entries(s.blocks).map(([id, b]) => [id, { s: b.s, c: b.c, p: b.p, q: b.q }])),
    holds: Object.fromEntries(Object.entries(s.holds).map(([seat, h]) => [seat, h.id])),
    cursors: s.cursors,
  }),
});
