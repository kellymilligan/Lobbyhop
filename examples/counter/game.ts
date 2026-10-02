/**
 * Counter race: the smallest complete lobbyhop game. First to the target wins.
 * This file is shared by the browser (main.ts) and the room server (worker.ts / server.ts).
 */
import { defineLockstep, ok, reject } from 'lobbyhop';

export interface State {
  /** Clicks per seat. */
  counts: number[];
  target: number;
  winner: number | null;
}

export type Command = { type: 'click' };

export const game = defineLockstep<State, Command, { target: number }>({
  name: 'counter',
  tickRate: 10,
  seats: { min: 1, max: 4 },
  settings: { defaults: { target: 25 } },
  create: ({ seats, settings }) => ({
    counts: seats.map(() => 0),
    target: settings.target,
    winner: null,
  }),
  apply(state, _cmd, from) {
    if (state.winner !== null) return reject('The race is over.');
    state.counts[from.seat]++;
    if (state.counts[from.seat] >= state.target) state.winner = from.seat;
    return ok();
  },
  step() {},
  isOver: (state) => state.winner !== null,
});
