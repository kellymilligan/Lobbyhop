import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
import { game, H, W } from './game';
import type { Command, Event, State } from './game';

const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });

mountLobby(room, {
  title: 'Orb Arena',
  subtitle: 'Share the link. Collect orbs; drop walls to block rivals.',
  emptySeat: (s) => (s.bots ? 'Bot' : 'Open seat'),
  settings: [
    { key: 'bots', label: 'Fill empty seats with bots', type: 'toggle' },
    { key: 'target', label: 'Orbs to win', type: 'number', min: 5, max: 50, step: 5 },
    { key: 'minutes', label: 'Time limit (minutes)', type: 'number', min: 1, max: 10 },
  ],
  overText: (r) => {
    const s = r.state as State | null;
    const w = s && s.winner !== null ? s.players[s.winner] : null;
    return w ? `${w.name} wins with ${w.score} orbs.` : 'Game over.';
  },
});
mountStatus(room);

// ---------------------------------------------------------------------------
// Input: send intent only when it changes (lockstep traffic stays tiny).
// ---------------------------------------------------------------------------
const keys = new Set<string>();
let touchDir: [number, number] | null = null;
let sent = '0,0';
function syncMove() {
  const me = room.seat === null ? null : (room.state as State | null)?.players[room.seat];
  if (!me || me.bot || room.phase !== 'playing') return;
  let dx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  let dy = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
  if (touchDir) [dx, dy] = touchDir;
  const key = `${dx},${dy}`;
  if (key === sent) return;
  if (room.submit({ type: 'move', dx, dy }) !== null) sent = key;
}
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  keys.add(e.key.toLowerCase());
  syncMove();
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  syncMove();
});
addEventListener('blur', () => {
  keys.clear();
  syncMove();
});

const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const ctx = canvas.getContext('2d')!;
let scale = 20;
let ox = 0;
let oy = 0;
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  scale = Math.min(canvas.width / (W + 2), canvas.height / (H + 2));
  ox = (canvas.width - W * scale) / 2;
  oy = (canvas.height - H * scale) / 2;
}
addEventListener('resize', resize);
resize();

const toWorld = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  const k = canvas.width / r.width;
  return [((e.clientX - r.left) * k - ox) / scale, ((e.clientY - r.top) * k - oy) / scale];
};
let down: { t: number; id: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { t: performance.now(), id: e.pointerId };
  if (e.pointerType === 'touch') steer(e);
});
canvas.addEventListener('pointermove', (e) => down?.id === e.pointerId && e.pointerType === 'touch' && steer(e));
canvas.addEventListener('pointerup', (e) => {
  const tap = down && performance.now() - down.t < 220;
  down = null;
  if (touchDir) {
    touchDir = null;
    syncMove();
  }
  if (tap) {
    const [x, y] = toWorld(e);
    room.submit({ type: 'wall', x: Math.floor(x), y: Math.floor(y) });
  }
});
function steer(e: PointerEvent) {
  const me = room.seat === null ? null : (room.state as State | null)?.players[room.seat];
  if (!me) return;
  const [x, y] = toWorld(e);
  const dx = x - me.x;
  const dy = y - me.y;
  touchDir = [Math.abs(dx) > 0.6 ? Math.sign(dx) : 0, Math.abs(dy) > 0.6 ? Math.sign(dy) : 0];
  syncMove();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const pops: { x: number; y: number; colour: string; t: number }[] = [];
const hud = document.querySelector<HTMLDivElement>('#hud')!;
room.on('snapshot', () => (sent = '0,0'));

let last = performance.now();
function frame(now: number) {
  const { state, alpha, events } = room.advance((now - last) / 1000);
  last = now;
  const s = state as State | null;
  for (const e of events as Event[]) if (e.type === 'orb') pops.push({ x: e.x, y: e.y, colour: s!.players[e.seat].colour, t: now });
  draw(s, alpha, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function draw(s: State | null, alpha: number, now: number) {
  ctx.fillStyle = '#0d0f17';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  // Floor grid.
  ctx.fillStyle = '#151a28';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.04;
  for (let x = 0; x <= W; x++) line(x, 0, x, H);
  for (let y = 0; y <= H; y++) line(0, y, W, y);
  if (s) {
    for (const w of s.walls) {
      ctx.globalAlpha = Math.min(1, w.ttl / 30);
      ctx.fillStyle = s.players[w.owner]?.colour ?? '#888';
      ctx.fillRect(w.x + 0.06, w.y + 0.06, 0.88, 0.88);
    }
    ctx.globalAlpha = 1;
    // Ghost walls: our pending (sent, not yet confirmed) walls, drawn instantly.
    const mine = room.seat === null ? null : s.players[room.seat];
    for (const p of room.pending) {
      const c = p.cmd as Command;
      if (c.type !== 'wall') continue;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = mine?.colour ?? '#fff';
      ctx.fillRect(c.x + 0.06, c.y + 0.06, 0.88, 0.88);
    }
    ctx.globalAlpha = 1;
    for (const o of s.orbs) {
      const pulse = 0.22 + 0.04 * Math.sin(now / 200 + o.id);
      ctx.fillStyle = '#ffe9a8';
      ctx.shadowColor = '#ffd36a';
      ctx.shadowBlur = 12;
      circle(o.x, o.y, pulse);
    }
    ctx.shadowBlur = 0;
    for (const p of s.players) {
      // Interpolate between the previous and current tick for smooth motion at any frame rate.
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      ctx.fillStyle = p.colour;
      circle(x, y, 0.45);
      if (p.seat === room.seat) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.arc(x, y, 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '0.6px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.name}${p.bot ? ' 🤖' : ''}`, x, y - 0.8);
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const k = (now - pops[i].t) / 400;
      if (k > 1) {
        pops.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = pops[i].colour;
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.arc(pops[i].x, pops[i].y, 0.3 + k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const left = Math.max(0, Math.ceil((s.endTick - s.tick) / 30));
    hud.innerHTML = `<b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b> · first to ${s.target}<br>` + s.players.map((p) => `<span style="color:${p.colour}">●</span> ${escapeHtml(p.name)} ${p.score}`).join('&nbsp;&nbsp;');
  } else hud.textContent = '';
  ctx.restore();
}

function line(x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function circle(x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function escapeHtml(t: string) {
  return t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Debug handle for e2e tests and the console.
(window as unknown as { lobbyhop: unknown }).lobbyhop = { room };
