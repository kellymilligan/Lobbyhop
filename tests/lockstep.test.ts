import { describe, expect, it } from 'vitest';
import { createHarness } from '../src/testing/index.js';
import { RoomCore } from '../src/server/index.js';
import type { ServerMsg } from '../src/index.js';
import { PROTOCOL_VERSION } from '../src/index.js';
import { nextFloat } from '../src/det/index.js';
import { brawl, randomBrawlCmd } from './fixtures.js';
import type { BrawlState } from './fixtures.js';

const server = (h: { room: RoomCore }) => (h.room.engine as unknown as { state: BrawlState }).state;

describe('lobby', () => {
  it('assigns seats, unique colours and exactly one host', () => {
    const h = createHarness(brawl, { clients: 3 });
    h.run(600);
    const m = h.clients[0].members;
    expect(m.map((x) => x.seat)).toEqual([0, 1, 2]);
    expect(new Set(m.map((x) => x.colour)).size).toBe(3);
    // Join order depends on network timing: the first to arrive hosts and takes seat 0.
    expect(h.clients.filter((c) => c.host).length).toBe(1);
    expect(h.host().seat).toBe(0);
  });

  it('host transfers when the host leaves, and a lobby leaver frees their seat', () => {
    const h = createHarness(brawl, { clients: 3 });
    h.run(600);
    const hostIdx = h.clients.indexOf(h.host());
    h.disconnect(hostIdx);
    h.run(600);
    const rest = h.clients.filter((_, i) => i !== hostIdx);
    expect(rest.filter((c) => c.host).length).toBe(1);
    expect(rest[0].members.map((m) => m.seat)).toEqual([0, 1]);
    expect(rest.map((c) => c.seat).sort()).toEqual([0, 1]);
  });

  it('only the host can change settings, and they are validated', () => {
    const h = createHarness(brawl, { clients: 2 });
    h.run(600);
    const guest = h.clients.find((c) => !c.host)!;
    guest.setSettings({ minutes: 3 });
    h.run(600);
    expect(h.clients[0].settings.minutes).toBe(10);
    h.host().setSettings({ minutes: 999, bots: false });
    h.run(600);
    expect(h.clients.every((c) => c.settings.minutes === 30 && c.settings.bots === false)).toBe(true);
  });

  it('profile changes are broadcast and colours stay unique', () => {
    const h = createHarness(brawl, { clients: 2 });
    h.run(600);
    const [a, b] = h.clients;
    b.setProfile({ name: 'Kelly <script>', colour: a.me!.colour });
    h.run(600);
    const mb = a.members.find((m) => m.seat === b.seat)!;
    expect(mb.name).toBe('Kelly script');
    expect(mb.colour).not.toBe(a.me!.colour);
  });

  it('rejects clients for another game version', () => {
    const sent: ServerMsg[] = [];
    const room = new RoomCore(brawl, { send: (_c, d) => sent.push(JSON.parse(d)), close: () => {}, setClock: () => {}, now: () => 0 });
    room.onConnect('x');
    room.onMessage('x', JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, game: 'brawl@0', token: 'abcdefghij', name: 'a', colour: '' }));
    expect(sent[0]).toMatchObject({ t: 'error', code: 'version' });
  });

  it('the host can kick a player, who cannot rejoin', () => {
    const h = createHarness(brawl, { clients: 2 });
    h.run(600);
    const guestIdx = h.clients.findIndex((c) => !c.host);
    h.host().kick(h.clients[guestIdx].seat!);
    h.run(600);
    expect(h.clients[guestIdx].error?.code).toBe('kicked');
    expect(h.host().members.length).toBe(1);
    h.reconnect(guestIdx);
    h.run(600);
    expect(h.host().members.length).toBe(1);
  });
});

describe('lockstep', () => {
  it('three players stay in sync with the server through a busy game on a jittery network', () => {
    const h = createHarness(brawl, { clients: 3, seed: 'busy' });
    h.run(600);
    h.startGame();
    let acted = 0;
    h.run(150_000, (t) => {
      if (t % 250 !== 0) return;
      for (const c of h.clients) {
        if (c.submit(randomBrawlCmd(h.rng, c.state, c.seat)) !== null) acted++;
      }
    });
    h.freeze();
    h.assertInSync();
    expect(acted).toBeGreaterThan(1500);
    expect(server(h).units.length + server(h).players.reduce((a, p) => a + p.kills, 0)).toBeGreaterThan(20);
    for (const c of h.clients) expect(c.desyncs).toBe(0);
  });

  it('a client cannot act for another seat', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'spoof' });
    h.run(600);
    h.startGame();
    const guest = h.clients.find((c) => !c.host)!;
    // Even with a forged field, the server stamps the sender's seat.
    guest.submit({ type: 'spawn', x: 42, y: 42, owner: 0 } as never);
    h.run(1000);
    const u = server(h).units.find((x) => x.x === 42 && x.y === 42);
    expect(u?.owner).toBe(guest.seat);
  });

  it('clients cannot issue system commands', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'sys' });
    h.run(600);
    h.startGame();
    const rejects: string[] = [];
    h.clients[0].on('reject', (r) => rejects.push(r));
    h.clients[0].submit({ type: 'bot', on: true });
    h.run(1000);
    expect(rejects).toEqual(['Not allowed.']);
    expect(server(h).players.every((p) => !p.bot)).toBe(true);
  });

  it('pending inputs clear when their turn lands, or on reject', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'pending' });
    h.run(600);
    h.startGame();
    const c = h.clients[0];
    c.submit({ type: 'spawn', x: 1, y: 1 });
    expect(c.pending.length).toBe(1);
    h.run(1500);
    expect(c.pending.length).toBe(0);
    c.submit({ type: 'spawn', x: 500, y: 1 });
    h.run(1500);
    expect(c.pending.length).toBe(0);
  });

  it('pause drains every client to the same tick and rejects input', () => {
    const h = createHarness(brawl, { clients: 3, seed: 'pause' });
    h.run(600);
    h.startGame();
    h.run(5000, (t) => t % 300 === 0 && h.clients.forEach((c) => c.submit(randomBrawlCmd(h.rng, c.state, c.seat))));
    h.host().setPaused(true);
    h.run(3000);
    const tick = h.room.engine.tick;
    expect(h.clients.every((c) => c.paused && c.tick === tick)).toBe(true);
    h.assertInSync();
    const rejects: string[] = [];
    h.clients[1].on('reject', (r) => rejects.push(r));
    h.clients[1].submit({ type: 'spawn', x: 5, y: 5 });
    h.run(1000);
    expect(rejects).toEqual(['The game is paused.']);
    expect(h.room.engine.tick).toBe(tick);
    h.host().setPaused(false);
    h.run(3000);
    expect(h.room.engine.tick).toBeGreaterThan(tick + 60);
  });

  it('a reconnecting player gets a snapshot and rejoins in sync', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'rejoin' });
    h.run(600);
    h.startGame();
    h.run(20_000, (t) => t % 400 === 0 && h.clients.forEach((c) => c.submit(randomBrawlCmd(h.rng, c.state, c.seat))));
    const seat = h.clients[1].seat;
    h.disconnect(1);
    h.run(3_000);
    h.reconnect(1);
    h.run(10_000, (t) => t % 400 === 0 && h.clients.forEach((c) => c.submit(randomBrawlCmd(h.rng, c.state, c.seat))));
    expect(h.clients[1].seat).toBe(seat);
    expect(h.clients[1].snapshots).toBe(2);
    h.freeze();
    h.assertInSync();
  });

  it('a desynced client is detected and repaired by snapshot', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'desync' });
    h.run(600);
    h.startGame();
    h.run(3000);
    // Corrupt one client's local state, as a non-deterministic sim would.
    (h.clients[1].state as BrawlState).players[0].gold += 1;
    h.run(10_000);
    expect(h.clients[1].desyncs).toBe(1);
    h.freeze();
    h.clients[1].desyncs = 0;
    h.assertInSync();
  });

  it('idle seats are handed to a bot, and given back on return', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'idle' });
    h.run(600);
    h.startGame();
    const guestIdx = h.clients.findIndex((c) => !c.host);
    const seat = h.clients[guestIdx].seat!;
    h.disconnect(guestIdx);
    h.run(7_000);
    expect(server(h).players[seat].bot).toBe(true);
    expect((h.host().state as BrawlState).players[seat].bot).toBe(true);
    h.reconnect(guestIdx);
    h.run(2_000);
    expect(server(h).players[seat].bot).toBe(false);
    h.freeze();
    h.assertInSync();
  });

  it('late joiners join live via the join hook; extra people spectate', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'late' });
    h.run(600);
    h.startGame();
    h.run(2000);
    const a = h.addClient({ name: 'Late' });
    h.run(2000);
    expect(h.clients[a].seat).toBe(2);
    expect(server(h).players.map((p) => p.name)).toContain('Late');
    h.addClient();
    const s = h.addClient();
    h.run(2000);
    expect(h.clients[s].seat).toBeNull();
    expect(h.clients[s].spectating).toBe(true);
    expect(h.clients[s].state).not.toBeNull();
    expect(h.clients[0].spectators).toBe(1);
    h.freeze();
    h.assertInSync();
  });

  it('game over, then back to the lobby, then a rematch', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'over' });
    h.run(600);
    h.host().setSettings({ minutes: 1 });
    h.run(600);
    h.startGame();
    h.until(() => h.clients.every((c) => c.phase === 'over'), 70_000);
    // Clients drain to the final tick.
    h.run(2000);
    h.assertInSync();
    h.host().toLobby();
    h.run(600);
    expect(h.clients.every((c) => c.phase === 'lobby' && c.state === null)).toBe(true);
    h.startGame();
    expect(h.clients.every((c) => c.tick < 100)).toBe(true);
  });

  it('a command can end the game on the tick it is applied', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'end' });
    h.run(600);
    h.startGame();
    h.run(2000);
    h.clients[0].submit({ type: 'end' });
    h.until(() => h.clients.every((c) => c.phase === 'over'));
    h.run(1000);
    h.assertInSync();
  });
});

describe('limits', () => {
  it('rate-limits input floods', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'flood', room: { limits: { inputsPerSecond: 10, inputBurst: 10 } } });
    h.run(600);
    h.startGame();
    const rejects: string[] = [];
    h.clients[0].on('reject', (r) => rejects.push(r));
    for (let i = 0; i < 50; i++) h.clients[0].submit({ type: 'steer', unit: -1, x: 0, y: 0 });
    h.run(1000);
    expect(rejects.filter((r) => r === 'Slow down.').length).toBeGreaterThanOrEqual(39);
  });

  it('rejects oversized messages and eventually drops abusive connections', () => {
    const sent: ServerMsg[] = [];
    const closed: string[] = [];
    const room = new RoomCore(brawl, { send: (_c, d) => sent.push(JSON.parse(d)), close: (c) => closed.push(c), setClock: () => {}, now: () => 0 }, { limits: { maxMessageBytes: 100 } });
    room.onConnect('x');
    room.onMessage('x', 'x'.repeat(200));
    expect(sent[0]).toMatchObject({ t: 'reject', reason: 'Message too large.' });
    for (let i = 0; i < 30; i++) room.onMessage('x', '{nope');
    expect(closed).toEqual(['x']);
  });
});

describe('persistence', () => {
  it('a room restored from a save carries on, and players rejoin in sync', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'persist' });
    h.run(600);
    h.startGame();
    h.run(15_000, (t) => t % 300 === 0 && h.clients.forEach((c) => c.submit(randomBrawlCmd(h.rng, c.state, c.seat))));
    const save = h.saves.at(-1)!;
    expect(save.phase).toBe('playing');
    expect(save.members.length).toBe(2);
    // A fresh room (new process / evicted Durable Object) restores the save.
    const sent = new Map<string, ServerMsg[]>();
    const room2 = new RoomCore(brawl, {
      send: (c, d) => sent.set(c, [...(sent.get(c) ?? []), JSON.parse(d)]),
      close: () => {},
      setClock: () => {},
      now: () => 1_000_000,
    });
    expect(room2.restore(JSON.parse(JSON.stringify(save)))).toBe(true);
    room2.onConnect('a');
    room2.onMessage('a', JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, game: 'brawl@1', token: h.clients[0].profile.token, name: 'x', colour: '' }));
    const msgs = sent.get('a')!;
    expect(msgs.find((m) => m.t === 'welcome')).toMatchObject({ seat: h.clients[0].seat });
    const snap = msgs.find((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>;
    expect(snap.tick).toBe((save.engine as { tick: number }).tick);
    expect(room2.phase).toBe('playing');
  });

  it('empty rooms are deleted after the TTL', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'ttl', room: { emptyTtlMs: 5_000 } });
    h.run(600);
    h.startGame();
    h.run(1000);
    h.disconnect(0);
    h.disconnect(1);
    h.run(4_000);
    expect(h.saves.at(-1)).not.toBeNull();
    h.run(2_000);
    expect(h.saves.at(-1)).toBeNull();
    expect(h.room.phase).toBe('lobby');
  });

  it('a returning player before the TTL cancels cleanup', () => {
    const h = createHarness(brawl, { clients: 1, seed: 'ttl2', room: { emptyTtlMs: 5_000 } });
    h.run(600);
    h.disconnect(0);
    h.run(2_000);
    h.reconnect(0);
    h.run(10_000);
    expect(h.saves.at(-1)).not.toBeNull();
  });
});

describe('chat', () => {
  it('broadcasts sanitised lines and gives newcomers the history', () => {
    const h = createHarness(brawl, { clients: 2, seed: 'chat' });
    h.run(600);
    h.clients[0].say('  hello\u0007 there  ');
    h.run(600);
    expect(h.clients[1].chat.map((l) => l.text)).toEqual(['hello there']);
    const late = h.addClient();
    h.run(600);
    expect(h.clients[late].chat.map((l) => l.text)).toEqual(['hello there']);
  });
});

describe('harness', () => {
  it('is deterministic for a given seed', () => {
    const run = () => {
      const h = createHarness(brawl, { clients: 2, seed: 'repeat' });
      h.run(600);
      h.startGame();
      h.run(10_000, (t) => t % 300 === 0 && h.clients.forEach((c) => nextFloat(h.rng) < 0.7 && c.submit(randomBrawlCmd(h.rng, c.state, c.seat))));
      return JSON.stringify(server(h));
    };
    expect(run()).toBe(run());
  });
});
