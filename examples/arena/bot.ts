/**
 * A brain for tools/bot.mjs: heads for the nearest orb.
 *   node tools/bot.mjs examples/arena/bot.ts --host localhost:8787 --room abc123
 */
import type { Command, State } from './game';
export { game } from './game';

export const thinkMs = 250;

export function decide(state: State, seat: number): Command[] {
  const me = state.players[seat];
  if (!me) return [];
  const d2 = (o: { x: number; y: number }) => (o.x - me.x) * (o.x - me.x) + (o.y - me.y) * (o.y - me.y);
  let best = state.orbs[0];
  for (const o of state.orbs) if (d2(o) < d2(best)) best = o;
  if (!best) return [];
  const dx = Math.abs(best.x - me.x) > 0.3 ? Math.sign(best.x - me.x) : 0;
  const dy = Math.abs(best.y - me.y) > 0.3 ? Math.sign(best.y - me.y) : 0;
  // Only send when the direction changes: intent, not a stream.
  return dx === me.dx && dy === me.dy ? [] : [{ type: 'move', dx, dy }];
}
