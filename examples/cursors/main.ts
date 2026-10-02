import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountStatus } from 'lobbyhop/lobby-ui';
import { game } from './game';
import type { Event, State } from './game';

const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });
mountStatus(room, { pause: false });

const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const ctx = canvas.getContext('2d')!;
const nameInput = document.querySelector<HTMLInputElement>('#name')!;
const count = document.querySelector<HTMLSpanElement>('#count')!;
const share = document.querySelector<HTMLButtonElement>('#share')!;
nameInput.value = room.profile.name;
nameInput.onchange = () => room.setProfile({ name: nameInput.value });
share.onclick = () => navigator.clipboard?.writeText(location.href).then(() => (share.textContent = 'Copied!'));

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
}
addEventListener('resize', resize);
resize();

// Input: throttle pointer updates to ~15 per second. The server eases toward
// the latest target, and other clients interpolate, so motion stays smooth.
let aim: [number, number] | null = null;
let lastSend = 0;
canvas.addEventListener('pointermove', (e) => (aim = [e.clientX / innerWidth, e.clientY / innerHeight]));
canvas.addEventListener('pointerdown', (e) => {
  aim = [e.clientX / innerWidth, e.clientY / innerHeight];
  room.submit({ type: 'spark', x: aim[0], y: aim[1] });
});

const sparks: { x: number; y: number; colour: string; t: number }[] = [];
let last = performance.now();
function frame(now: number) {
  if (aim && now - lastSend > 66) {
    room.submit({ type: 'aim', x: aim[0], y: aim[1] });
    aim = null;
    lastSend = now;
  }
  const { state, prev, alpha, events } = room.advance((now - last) / 1000);
  last = now;
  const colourOf = (seat: number) => room.members.find((m) => m.seat === seat)?.colour ?? '#fff';
  for (const e of events as Event[]) sparks.push({ x: e.x, y: e.y, colour: colourOf(e.seat), t: now });

  ctx.fillStyle = '#0d0f17';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const s = state as State | null;
  const p = prev as State | null;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const k = (now - sparks[i].t) / 700;
    if (k > 1) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = sparks[i].colour;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sparks[i].x * canvas.width, sparks[i].y * canvas.height, 8 + k * 60, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (s) {
    for (const c of s.cursors) {
      // Snapshot interpolation: blend from the previous view to the latest.
      const was = p?.cursors.find((x) => x.seat === c.seat) ?? c;
      const x = (was.x + (c.x - was.x) * alpha) * canvas.width;
      const y = (was.y + (c.y - was.y) * alpha) * canvas.height;
      const m = room.members.find((mm) => mm.seat === c.seat);
      ctx.fillStyle = m?.colour ?? '#fff';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y + 20);
      ctx.lineTo(x + 11, y + 12);
      ctx.lineTo(x + 20, y + 12);
      ctx.closePath();
      ctx.fill();
      ctx.font = `${13 * Math.min(2, devicePixelRatio || 1)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(`${m?.name ?? '…'}${c.seat === room.seat ? ' (you)' : ''}`, x + 16, y + 34);
    }
    count.textContent = `${s.cursors.length} here`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { lobbyhop: unknown }).lobbyhop = { room };
