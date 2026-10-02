import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
import { game } from './game';
import type { Command, Mark, State } from './game';

const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });

mountLobby(room, {
  title: 'Tic-tac-toe',
  subtitle: 'Send the link to a friend. Anyone else who joins can watch.',
  colours: false,
  overText: (r) => {
    const s = r.state as State | null;
    if (!s?.winner) return 'Game over.';
    if (s.winner === 'draw') return "It's a draw.";
    const seat = s.seats[s.winner === 'X' ? 0 : 1];
    return `${r.members.find((m) => m.seat === seat)?.name ?? s.winner} wins!`;
  },
});
mountStatus(room);

const board = document.querySelector<HTMLDivElement>('#board')!;
const info = document.querySelector<HTMLParagraphElement>('#info')!;
const cells = Array.from({ length: 9 }, (_, i) => {
  const b = document.createElement('button');
  b.onclick = () => room.submit({ type: 'place', cell: i });
  board.append(b);
  return b;
});

// Turn-based state only changes on messages, so render on 'change' (no game loop needed).
function render() {
  room.advance(0); // Drains events and expires stale pending inputs.
  const s = room.state as State | null;
  board.style.display = s ? '' : 'none';
  if (!s) return;
  const myMark: Mark | null = room.seat === s.seats[0] ? 'X' : room.seat === s.seats[1] ? 'O' : null;
  // Optimistic: show our pending move immediately, faded, until the server confirms it.
  const pending = new Set(room.pending.map((p) => (p.cmd as Command).cell));
  cells.forEach((c, i) => {
    const mark = s.board[i] ?? (pending.has(i) ? myMark : null);
    c.textContent = mark ?? '';
    c.className = `${mark === 'X' ? 'x' : mark === 'O' ? 'o' : ''} ${!s.board[i] && pending.has(i) ? 'ghost' : ''} ${s.line?.includes(i) ? 'win' : ''}`;
    c.disabled = !!s.winner || !!s.board[i] || myMark !== s.turn;
  });
  const name = (m: Mark) => room.members.find((x) => x.seat === s.seats[m === 'X' ? 0 : 1])?.name ?? m;
  info.textContent = s.winner ? (s.winner === 'draw' ? 'Draw.' : `${name(s.winner)} wins.`) : myMark === null ? `Watching · ${name(s.turn)} to move` : myMark === s.turn ? `Your move (${myMark})` : `${name(s.turn)} is thinking…`;
}
room.on('change', render);
render();

(window as unknown as { lobbyhop: unknown }).lobbyhop = { room };
