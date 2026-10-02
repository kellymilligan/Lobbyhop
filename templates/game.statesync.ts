/**
 * State-sync game definition: only the server runs this; each player is sent
 * their `view`. No determinism needed. Shared by the browser and the server.
 */
import { defineStateSync, ok, presets, reject } from 'lobbyhop';

export interface State {
  turn: number;
  scores: number[];
  secret: number;
}

/** What one player may see (hidden information stays on the server). */
export interface View {
  turn: number;
  scores: number[];
}

export type Command = { type: 'guess'; value: number };

export const game = defineStateSync<State, Command, Record<string, never>, never, View>({
  name: '{{NAME}}',
  version: 1,
  ...presets.turnBased, // tickRate 0: state changes only on commands. Use presets.realtime for 20 Hz.
  seats: { min: 2, max: 6 },
  create: ({ seats, seed }) => ({ turn: 0, scores: seats.map(() => 0), secret: seed.length % 10 }),
  apply(state, cmd, from) {
    if (state.turn % state.scores.length !== from.seat) return reject('Not your turn.');
    if (cmd.value === state.secret) state.scores[from.seat]++;
    state.turn++;
    return ok();
  },
  view: (state) => ({ turn: state.turn, scores: state.scores }),
});
