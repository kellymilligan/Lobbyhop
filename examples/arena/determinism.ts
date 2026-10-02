/**
 * Scripted arena games for the cross-engine determinism check:
 *   node tools/determinism.mjs examples/arena/determinism.ts
 * Bundled and run identically in Node, Chromium, Firefox and WebKit.
 */
import { recordHashes } from 'lobbyhop/testing';
import { nextInt } from 'lobbyhop/det';
import { game } from './game';
import type { Command } from './game';

export function runScenario(seed: string, minutes: number): number[] {
  return recordHashes<unknown, Command>(game as never, {
    seed,
    // Two "humans" follow a seeded script; the other seats are bots.
    seats: [0, 2],
    settings: { bots: true, target: 1000, minutes: 60 },
    ticks: minutes * 60 * game.tickRate,
    input: (t, rng, state) => {
      if (t % 12 !== 0) return [];
      const s = state as { players: { x: number; y: number }[] };
      return [0, 2].map((seat): [number, Command] =>
        nextInt(rng, 4) === 0
          ? [seat, { type: 'wall', x: Math.floor(s.players[seat].x) + nextInt(rng, 5) - 2, y: Math.floor(s.players[seat].y) + nextInt(rng, 5) - 2 }]
          : [seat, { type: 'move', dx: nextInt(rng, 3) - 1, dy: nextInt(rng, 3) - 1 }],
      );
    },
  });
}

(globalThis as unknown as { runScenario: typeof runScenario }).runScenario = runScenario;
