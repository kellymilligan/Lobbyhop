import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
import { game } from './game';

// The room code lives in the URL (?room=abc123): the address bar is the share link,
// and a refresh rejoins the same seat.
const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });

mountLobby(room, {
  title: 'Counter race',
  subtitle: 'Share the link. First to the target wins.',
  settings: [{ key: 'target', label: 'Clicks to win', type: 'number', min: 5, max: 200, step: 5 }],
  overText: (r) => {
    const w = r.members.find((m) => m.seat === (r.state as typeof room.state)?.winner);
    return w ? `${w.name} wins!` : 'Race over.';
  },
});
mountStatus(room);

const button = document.querySelector<HTMLButtonElement>('#click')!;
const bars = document.querySelector<HTMLDivElement>('#bars')!;
button.onclick = () => room.submit({ type: 'click' });

let last = performance.now();
function frame(now: number) {
  const { state } = room.advance((now - last) / 1000);
  last = now;
  if (state) {
    // Count our pending (sent, not yet confirmed) clicks so the bar responds instantly.
    const mine = room.pending.length;
    bars.replaceChildren(
      ...room.members.map((m) => {
        const n = state.counts[m.seat] + (m.seat === room.seat ? mine : 0);
        const row = document.createElement('div');
        row.className = 'bar';
        row.innerHTML = `<span></span><i style="width:${Math.min(100, (n / state.target) * 100)}%;background:${m.colour}"></i><b>${n}</b>`;
        row.querySelector('span')!.textContent = m.name;
        return row;
      }),
    );
  }
  button.disabled = room.phase !== 'playing' || room.seat === null;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug handle for e2e tests and the console.
(window as unknown as { lobbyhop: unknown }).lobbyhop = { room };
