/**
 * Lockstep game definition: every client runs this simulation; only commands
 * travel. Shared by the browser and the room server.
 * Rules: deterministic and pure; see `npx lobbyhop docs cat DETERMINISM.md`.
 */
import { defineLockstep, ok, reject } from 'lobbyhop';
import { nextFloat, seedRng } from 'lobbyhop/det';
import type { Rng } from 'lobbyhop/det';

export interface State {
  rng: Rng; // All randomness comes from here, never Math.random.
  players: { seat: number; name: string; x: number; y: number; px: number; py: number }[];
}

export type Command = { type: 'move'; dx: number; dy: number };

export type Event = { type: 'bump'; seat: number };

export const game = defineLockstep<State, Command, { bots: boolean }, Event>({
  name: '{{NAME}}',
  version: 1, // Bump when State or Command change shape.
  tickRate: 30,
  turnMs: 100,
  seats: { min: 1, max: 4 },
  settings: { defaults: { bots: true } },
  create: ({ seed, seats }) => {
    const rng = seedRng(seed);
    return {
      rng,
      players: seats.map((s) => {
        const x = nextFloat(rng) * 10;
        const y = nextFloat(rng) * 10;
        return { seat: s.seat, name: s.name, x, y, px: x, py: y };
      }),
    };
  },
  apply(state, cmd, from) {
    const p = state.players.find((q) => q.seat === from.seat);
    if (!p) return reject('No player for this seat.');
    // Validate everything: commands come from untrusted clients.
    p.x += Math.sign(cmd.dx) * 0.5;
    p.y += Math.sign(cmd.dy) * 0.5;
    return ok();
  },
  step(state) {
    for (const p of state.players) {
      p.px = p.x; // Keep the previous position for render interpolation.
      p.py = p.y;
    }
    return [];
  },
});
