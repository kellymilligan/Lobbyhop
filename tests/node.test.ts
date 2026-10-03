import { afterAll, describe, expect, it } from 'vitest';
import { createNodeServer } from '../src/node/index.js';
import { joinRoom } from '../src/client/index.js';
import type { JoinedRoom } from '../src/client/index.js';
import { brawl, randomBrawlCmd, secrets } from './fixtures.js';
import type { SecretsView } from './fixtures.js';
import { seedRng, stateHash } from '../src/det/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

describe('node adapter over real WebSockets', () => {
  const server = createNodeServer(brawl, {});
  const other = createNodeServer(secrets, {});
  const lagServer = createNodeServer(secrets, {});
  const joined: JoinedRoom<any>[] = [];
  afterAll(async () => {
    for (const j of joined) j.leave();
    await server.close();
    await other.close();
    await lagServer.close();
  });

  it('two lockstep clients play in sync through the Node server', async () => {
    const { port } = await server.listen(0);
    const host = `localhost:${port}`;
    const mk = (i: number) => {
      const r = joinRoom(brawl, { room: 'nodetest', host, profile: { token: `node-token-${i}`, name: `N${i}`, colour: '' }, pingMs: 100 });
      joined.push(r);
      return r;
    };
    const a = mk(0);
    await until(() => a.host);
    const b = mk(1);
    await until(() => a.members.length === 2 && b.seat === 1);
    a.start();
    await until(() => a.state !== null && b.state !== null);
    const rng = seedRng('node');
    let last = performance.now();
    const loop = setInterval(() => {
      const now = performance.now();
      for (const c of [a, b]) c.advance((now - last) / 1000);
      last = now;
      if (Math.random() < 0.3) for (const c of [a, b]) c.submit(randomBrawlCmd(rng, c.state, c.seat));
    }, 16);
    await wait(2500);
    a.setPaused(true);
    await until(() => a.paused && b.paused && a.tick === a.frontier && b.tick === b.frontier && a.tick === b.tick, 5000);
    clearInterval(loop);
    const srv = (server.rooms.get('nodetest')!.engine as unknown as { state: unknown; tick: number });
    expect(a.tick).toBe(srv.tick);
    expect(stateHash(a.state)).toBe(stateHash(srv.state));
    expect(stateHash(b.state)).toBe(stateHash(srv.state));
    expect(a.rtt).not.toBeNull();
  });

  it('simulateLatency holds inputs in pending for about the round trip', { timeout: 20_000 }, async () => {
    const { port } = await lagServer.listen(0);
    const host = `127.0.0.1:${port}`;
    const a = joinRoom(secrets, { room: 'lagtest', host, profile: { token: 'lag-token-0', name: 'A', colour: '' }, simulateLatency: 400 });
    const b = joinRoom(secrets, { room: 'lagtest', host, profile: { token: 'lag-token-1', name: 'B', colour: '' } });
    joined.push(a, b);
    await until(() => a.members.length === 2 && b.members.length === 2 && (a.host || b.host), 8000);
    // b has no added latency, so it usually arrives first and hosts.
    (a.host ? a : b).start();
    await until(() => a.state !== null && b.state !== null, 8000);
    const v = a.state as SecretsView;
    const me = v.seats[v.turn] === a.seat ? a : b;
    const other_ = me === a ? b : a;
    me.setSimulatedLatency(600);
    const t0 = Date.now();
    me.submit({ type: 'guess', target: other_.seat!, value: 99 });
    expect(me.pending.length).toBe(1);
    await until(() => me.pending.length === 0, 5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  });

  it('state sync views over real WebSockets, and a refresh reclaims the seat', async () => {
    const { port } = await other.listen(0);
    const host = `127.0.0.1:${port}`;
    const p0 = { token: 'secret-token-0', name: 'A', colour: '' };
    const a = joinRoom(secrets, { room: 'sstest', host, profile: p0 });
    const b = joinRoom(secrets, { room: 'sstest', host, profile: { token: 'secret-token-1', name: 'B', colour: '' } });
    joined.push(a, b);
    await until(() => a.members.length === 2 && a.host);
    a.start();
    await until(() => a.state !== null && b.state !== null);
    const seat = a.seat;
    a.leave();
    const a2 = joinRoom(secrets, { room: 'sstest', host, profile: p0 });
    joined.push(a2);
    await until(() => a2.state !== null);
    expect(a2.seat).toBe(seat);
    expect((a2.state as SecretsView).mySecret).toBe((a.state as SecretsView).mySecret);
  });
});
