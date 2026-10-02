/**
 * Cursors: a shared space with no lobby. Open the link and you're in; close
 * the tab and your cursor fades out. Real-time state sync at 20 Hz with
 * client interpolation, the shape of most "rich experience" multiplayer
 * (shared canvases, co-presence, virtual rooms).
 */
import { defineStateSync, ok, presets, reject } from 'lobbyhop';

export interface Cursor {
  seat: number;
  x: number;
  y: number;
  /** Where the pointer is heading; the server eases toward it. */
  tx: number;
  ty: number;
}
export interface State {
  cursors: Cursor[];
}
export type Command = { type: 'aim'; x: number; y: number } | { type: 'spark'; x: number; y: number } | { type: 'join' } | { type: 'leave' };
export type Event = { type: 'spark'; seat: number; x: number; y: number };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);

export const game = defineStateSync<State, Command, Record<string, never>, Event>({
  name: 'cursors',
  ...presets.realtime,
  lobby: false,
  seats: { max: 16 },
  idleMs: 5_000,
  hooks: {
    join: () => ({ type: 'join' }),
    idle: () => ({ type: 'leave' }),
  },
  create: ({ seats }) => ({ cursors: seats.map((s) => ({ seat: s.seat, x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 })) }),
  apply(s, cmd, from) {
    if (cmd.type === 'join' || cmd.type === 'leave') {
      if (!from.system) return reject('Not allowed.');
      s.cursors = s.cursors.filter((c) => c.seat !== from.seat);
      if (cmd.type === 'join') s.cursors.push({ seat: from.seat, x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
      return ok();
    }
    const c = s.cursors.find((x) => x.seat === from.seat);
    if (!c) return reject('No cursor.');
    if (cmd.type === 'aim') {
      c.tx = clamp01(cmd.x);
      c.ty = clamp01(cmd.y);
      return ok();
    }
    return ok([{ type: 'spark', seat: from.seat, x: clamp01(cmd.x), y: clamp01(cmd.y) }]);
  },
  step(s) {
    for (const c of s.cursors) {
      c.x += (c.tx - c.x) * 0.5;
      c.y += (c.ty - c.y) * 0.5;
      // Keep the state compact (and the change detection effective).
      c.x = Math.round(c.x * 10000) / 10000;
      c.y = Math.round(c.y * 10000) / 10000;
    }
  },
});
