/**
 * Tic-tac-toe: turn-based state sync. The server runs the rules; clients only
 * render the state they're sent. No determinism needed, no clock: the room
 * only does work when someone moves (`presets.turnBased` sets tickRate: 0).
 */
import { defineStateSync, ok, presets, reject } from 'lobbyhop';

export type Mark = 'X' | 'O';
export interface State {
  board: (Mark | null)[];
  /** Seat playing X and O. */
  seats: [number, number];
  turn: Mark;
  winner: Mark | 'draw' | null;
  line: number[] | null;
}
export type Command = { type: 'place'; cell: number };

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const game = defineStateSync<State, Command>({
  name: 'tictactoe',
  ...presets.turnBased,
  seats: { min: 2, max: 2 },
  create: ({ seats }) => ({ board: Array(9).fill(null), seats: [seats[0].seat, seats[1].seat], turn: 'X', winner: null, line: null }),
  apply(s, cmd, from) {
    const mark: Mark | null = from.seat === s.seats[0] ? 'X' : from.seat === s.seats[1] ? 'O' : null;
    if (!mark) return reject('You are not playing.');
    if (s.winner) return reject('The game is over.');
    if (mark !== s.turn) return reject('Not your turn.');
    if (!Number.isInteger(cmd.cell) || cmd.cell < 0 || cmd.cell > 8 || s.board[cmd.cell]) return reject('Pick an empty square.');
    s.board[cmd.cell] = mark;
    const line = LINES.find((l) => l.every((i) => s.board[i] === mark));
    if (line) {
      s.winner = mark;
      s.line = line;
    } else if (s.board.every(Boolean)) s.winner = 'draw';
    s.turn = mark === 'X' ? 'O' : 'X';
    return ok();
  },
  isOver: (s) => s.winner !== null,
});
