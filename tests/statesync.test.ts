import { describe, expect, it } from 'vitest';
import { createHarness } from '../src/testing/index.js';
import { drift, secrets } from './fixtures.js';
import type { DriftState, SecretsState, SecretsView } from './fixtures.js';

describe('state sync: turn-based with hidden information', () => {
  it('each player only sees their own secret, and turns are enforced', () => {
    const h = createHarness(secrets, { clients: 3, seed: 'secrets' });
    h.run(600);
    h.startGame();
    const srv = (h.room.engine as unknown as { state: SecretsState }).state;
    for (const c of h.clients) {
      const v = c.state as SecretsView;
      expect(v.mySecret).toBe(srv.secrets[srv.seats.indexOf(c.seat!)]);
      expect(JSON.stringify(v)).not.toContain('"secrets"');
    }
    const order = srv.seats.map((s) => h.clients.find((c) => c.seat === s)!);
    const rejects: string[] = [];
    order[1].on('reject', (r) => rejects.push(r));
    order[1].submit({ type: 'guess', target: order[0].seat!, value: 1 });
    h.run(600);
    expect(rejects).toEqual(['Not your turn.']);
    order[0].submit({ type: 'guess', target: order[1].seat!, value: 1 });
    h.run(600);
    expect((order[2].state as SecretsView).guesses.length).toBe(1);
    expect(order[0].pending.length).toBe(0);
    h.assertInSync();
  });

  it('plays to a winner; events reach every client', () => {
    const h = createHarness(secrets, { clients: 2, seed: 'win' });
    h.run(600);
    h.startGame();
    let n = 0;
    h.until(() => {
      const v = h.clients[0].state as SecretsView | null;
      if (v && v.winner === null && n++ % 20 === 0) {
        const c = h.clients.find((x) => x.seat === v.seats[v.turn])!;
        const target = v.seats.find((s) => s !== c.seat)!;
        c.submit({ type: 'guess', target, value: 1 + (Math.floor(n / 20) % 10) });
      }
      return h.clients.every((c) => c.phase === 'over');
    }, 60_000);
    expect((h.clients[1].state as SecretsView).winner).not.toBeNull();
    expect(h.events[1].length).toBeGreaterThan(0);
    expect(h.events[1].length).toBe(h.events[0].length);
  });

  it('needs the minimum number of players to start', () => {
    const h = createHarness(secrets, { clients: 1, seed: 'min' });
    h.run(600);
    const rejects: string[] = [];
    h.clients[0].on('reject', (r) => rejects.push(r));
    h.clients[0].start();
    h.run(600);
    expect(rejects[0]).toMatch(/at least 2/);
    expect(h.clients[0].phase).toBe('lobby');
  });

  it('only sends views when they change', () => {
    const h = createHarness(secrets, { clients: 2, seed: 'quiet' });
    h.run(600);
    h.startGame();
    const tickBefore = h.clients.map((c) => c.state);
    h.run(10_000);
    // Nothing happened, so the same objects are still held (no new messages).
    expect(h.clients.map((c) => c.state)).toEqual(tickBefore);
    expect(h.clients[0].state).toBe(tickBefore[0]);
  });
});

describe('state sync: real-time, lobby-less', () => {
  it('starts on first arrival; others join live; idle seats are freed', () => {
    const h = createHarness(drift, { clients: 1, seed: 'drift' });
    h.run(600);
    expect(h.clients[0].phase).toBe('playing');
    const b = h.addClient({ name: 'Bee' });
    h.run(1000);
    const srv = () => (h.room.engine as unknown as { state: DriftState }).state;
    expect(srv().cursors.map((c) => c.name)).toEqual(['Player 0', 'Bee']);
    h.clients[b].submit({ type: 'aim', vx: 1, vy: 0 });
    h.run(2000);
    const bee = (h.clients[0].state as DriftState).cursors.find((c) => c.name === 'Bee')!;
    expect(bee.x).toBeGreaterThan(70);
    // Interpolation data is available between views.
    const f = h.clients[0].advance(0.005);
    expect(f.prev).not.toBeNull();
    expect(f.alpha).toBeGreaterThanOrEqual(0);
    expect(f.alpha).toBeLessThanOrEqual(1);
    h.disconnect(b);
    h.run(3500);
    expect(srv().cursors.map((c) => c.name)).toEqual(['Player 0']);
    expect(h.clients[0].members.length).toBe(1);
    // Coming back is a fresh join.
    h.reconnect(b);
    h.run(1000);
    expect(srv().cursors.map((c) => c.name)).toEqual(['Player 0', 'Bee']);
    h.freeze(1000);
    h.assertInSync();
  });

  it('a full room makes extra arrivals spectators who still see the action', () => {
    const h = createHarness(drift, { clients: 4, seed: 'full' });
    h.run(1500);
    const spectator = h.clients.find((c) => c.seat === null)!;
    expect(spectator).toBeDefined();
    expect((spectator.state as DriftState).cursors.length).toBe(3);
  });
});
