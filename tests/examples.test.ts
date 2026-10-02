/**
 * The examples are real lobbyhop games: run each through the harness so a
 * change to the kit that breaks an example fails CI.
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from '../src/testing/index.js';
import { assertJsonSafe, nextFloat, nextInt } from '../src/det/index.js';
import { game as arena } from '../examples/arena/game.js';
import type { State as ArenaState } from '../examples/arena/game.js';
import { game as counter } from '../examples/counter/game.js';
import { game as tictactoe } from '../examples/tictactoe/game.js';
import type { State as TttState } from '../examples/tictactoe/game.js';
import { game as cursors } from '../examples/cursors/game.js';
import type { State as CursorState } from '../examples/cursors/game.js';

describe('examples', () => {
  it('counter: a race to the target ends the game for everyone', () => {
    const h = createHarness(counter, { clients: 2, seed: 'counter' });
    h.run(600);
    h.host().setSettings({ target: 10 });
    h.run(600);
    h.startGame();
    h.run(5000, (t) => t % 100 === 0 && h.clients.forEach((c) => c.submit({ type: 'click' })));
    expect(h.clients.every((c) => c.phase === 'over')).toBe(true);
    h.assertInSync();
  });

  it('arena: three players and a bot stay in sync on a jittery network', () => {
    const h = createHarness(arena, { clients: 3, seed: 'arena' });
    h.run(600);
    h.startGame();
    h.run(60_000, (t) => {
      if (t % 200 !== 0) return;
      for (const c of h.clients) {
        const s = c.state as ArenaState | null;
        const me = s && c.seat !== null ? s.players[c.seat] : null;
        if (!me) continue;
        if (nextFloat(h.rng) < 0.7) c.submit({ type: 'move', dx: nextInt(h.rng, 3) - 1, dy: nextInt(h.rng, 3) - 1 });
        else c.submit({ type: 'wall', x: Math.floor(me.x + nextInt(h.rng, 7) - 3), y: Math.floor(me.y + nextInt(h.rng, 7) - 3) });
      }
    });
    h.freeze();
    h.assertInSync();
    const s = (h.room.engine as unknown as { state: ArenaState }).state;
    expect(s.players.length).toBe(4);
    expect(s.players.reduce((a, p) => a + p.score, 0)).toBeGreaterThan(5);
    assertJsonSafe(s);
  });

  it('arena: without bots there is one runner per player', () => {
    const h = createHarness(arena, { clients: 2, seed: 'arena-nobots' });
    h.run(600);
    h.host().setSettings({ bots: false });
    h.run(600);
    h.startGame();
    expect((h.clients[0].state as ArenaState).players.length).toBe(2);
  });

  it('tictactoe: plays to a result; spectators can watch', () => {
    const h = createHarness(tictactoe, { clients: 3, seed: 'ttt' });
    h.run(600);
    h.startGame();
    h.run(600);
    const watcher = h.clients.find((c) => c.seat === null)!;
    expect(watcher.state).not.toBeNull();
    let guard = 0;
    while (h.clients[0].phase !== 'over' && guard++ < 20) {
      const s = h.clients[0].state as TttState;
      const mover = h.clients.find((c) => c.seat === s.seats[s.turn === 'X' ? 0 : 1])!;
      mover.submit({ type: 'place', cell: s.board.findIndex((x) => x === null) });
      h.run(600);
    }
    expect((watcher.state as TttState).winner).not.toBeNull();
    h.assertInSync();
  });

  it('cursors: drop in, move, drop out', () => {
    const h = createHarness(cursors, { clients: 2, seed: 'cursors' });
    h.run(1000);
    h.clients[1].submit({ type: 'aim', x: 1, y: 0 });
    h.run(1500);
    const s = h.clients[0].state as CursorState;
    expect(s.cursors.find((c) => c.seat === h.clients[1].seat)!.x).toBeGreaterThan(0.95);
    h.disconnect(1);
    h.run(6000);
    expect((h.clients[0].state as CursorState).cursors.length).toBe(1);
  });
});
