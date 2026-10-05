import { describe, expect, it } from 'vitest';
import { createHarness } from '../src/testing/index.js';
import { RoomCore } from '../src/server/index.js';
import type { RoomSave } from '../src/server/index.js';
import { PROTOCOL_VERSION } from '../src/index.js';
import type { ServerMsg } from '../src/index.js';
import { world } from './fixtures.js';
import type { WorldView } from './fixtures.js';

describe('persistent worlds', () => {
  it('delta sync: views stay identical to the server through spawns, pushes, deletes and late joiners', () => {
    const h = createHarness(world, { clients: 2, seed: 'delta', room: { emptyTtlMs: null } });
    h.run(1000);
    for (let i = 0; i < 20; i++) h.clients[i % 2].submit({ type: 'spawn', x: i * 2 });
    h.run(2000);
    h.clients[0].submit({ type: 'push', id: '3' });
    const late = h.addClient();
    h.run(1500);
    h.clients[late].submit({ type: 'spawn', x: 1 });
    h.run(3000);
    h.freeze(1000);
    h.assertInSync();
    const v = h.clients[late].state as WorldView;
    expect(Object.keys(v.things).length).toBe(20); // 21 spawned, thing 3 pushed off the edge
    expect(JSON.stringify(v)).not.toContain('"v"'); // server-only field stripped by view
  });

  it('delta sync sends patches, much smaller than full views, and nothing while the world rests', () => {
    const frames: string[] = [];
    let now = 0;
    const room = new RoomCore(world, { send: (_c, d) => frames.push(d), close: () => {}, setClock: () => {}, now: () => now });
    room.onConnect('a');
    room.onMessage('a', JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, game: 'world@2', token: 'token-aaaa', name: 'A', colour: '' }));
    for (let i = 0; i < 100; i++) room.onMessage('a', JSON.stringify({ t: 'input', cmd: { type: 'spawn', x: i % 50 }, id: i + 1 }));
    // Let everything fall and come to rest.
    for (let i = 0; i < 40; i++) ((now += 50), room.pump());
    frames.length = 0;
    room.onMessage('a', JSON.stringify({ t: 'input', cmd: { type: 'push', id: '7' }, id: 999 }));
    now += 50;
    room.pump();
    const msg = JSON.parse(frames.at(-1)!) as Extract<ServerMsg, { t: 'state' }>;
    expect(msg.patch).toBeDefined();
    expect(msg.state).toBeUndefined();
    const full = JSON.stringify(world.view!(room.state!, 0)).length;
    expect(frames.at(-1)!.length).toBeLessThan(full / 10);
    // A resting world (only `t` ticks) sends tiny patches.
    for (let i = 0; i < 30; i++) ((now += 50), room.pump());
    frames.length = 0;
    now += 50;
    room.pump();
    expect(frames.every((f) => f.length < 120)).toBe(true);
  });

  it('a never-expiring room keeps its world through long empty periods, and restores it', () => {
    const h = createHarness(world, { clients: 1, seed: 'forever', room: { emptyTtlMs: null } });
    h.run(1000);
    for (let i = 0; i < 5; i++) h.clients[0].submit({ type: 'spawn', x: i });
    h.run(2000);
    h.disconnect(0);
    h.run(24 * 60 * 60 * 1000 / 100); // a long empty stretch (harness steps are cheap)
    const save = h.saves.at(-1)!;
    expect(save).not.toBeNull();
    expect(Object.keys((save.engine as { state: { things: object } }).state.things).length).toBe(5);
    // A fresh process restores it, and the next visitor sees the same world.
    const room = new RoomCore(world, { send: () => {}, close: () => {}, setClock: () => {}, now: () => 0 });
    expect(room.restore(JSON.parse(JSON.stringify(save)) as RoomSave)).toBe(true);
    expect(Object.keys(room.state!.things).length).toBe(5);
  });

  it('idle worlds with viewers connected do not rewrite identical saves', () => {
    const still = { ...world, step: undefined };
    const h = createHarness(still, { clients: 1, seed: 'still', room: { emptyTtlMs: null, saveEveryMs: 1000 } });
    h.run(1000);
    h.clients[0].submit({ type: 'spawn', x: 1 });
    h.run(3000);
    const n = h.saves.length;
    h.run(20_000);
    expect(h.saves.length).toBe(n);
  });

  it('migrate upgrades a save from an older version; without it the save is ignored', () => {
    const old: RoomSave = {
      v: 1,
      game: 'world@1',
      phase: 'playing',
      paused: false,
      settings: {},
      members: [],
      banned: [],
      chat: [],
      engine: { tick: 50, state: { things: { '1': { x: 1, y: 0, v: 0, owner: 0 } } } } as never,
    };
    const room = new RoomCore(world, { send: () => {}, close: () => {}, setClock: () => {}, now: () => 0 });
    expect(room.restore(old)).toBe(true);
    expect(room.state!.next).toBe(99);
    expect(room.state!.things['1'].x).toBe(1);
    const noMigrate = new RoomCore({ ...world, migrate: undefined }, { send: () => {}, close: () => {}, setClock: () => {}, now: () => 0 });
    expect(noMigrate.restore(old)).toBe(false);
    const otherGame = new RoomCore(world, { send: () => {}, close: () => {}, setClock: () => {}, now: () => 0 });
    expect(otherGame.restore({ ...old, game: 'other@1' })).toBe(false);
  });
});
