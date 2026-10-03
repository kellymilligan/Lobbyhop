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
  return recordHashes(game, {
    seed,
    // Two "humans" (seats 0 and 1, as a room would seat them) follow a seeded script; bots fill the rest.
    seats: 2,
    settings: { bots: true, target: 1000, minutes: 60 },
    ticks: minutes * 60 * game.tickRate,
    input: (t, rng, s) => {
      if (t % 12 !== 0) return [];
      return [0, 1].map((seat): [number, Command] =>
        nextInt(rng, 4) === 0
          ? [seat, { type: 'wall', x: Math.floor(s.players[seat].x) + nextInt(rng, 5) - 2, y: Math.floor(s.players[seat].y) + nextInt(rng, 5) - 2 }]
          : [seat, { type: 'move', dx: nextInt(rng, 3) - 1, dy: nextInt(rng, 3) - 1 }],
      );
    },
  });
}

(globalThis as unknown as { runScenario: typeof runScenario }).runScenario = runScenario;
