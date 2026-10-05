/**
 * The persistent block world: Box3D on the server, delta-synced views,
 * dragging, the invisible container, and save/restore of a physics world.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../src/testing/index.js';
import { RoomCore } from '../src/server/index.js';
import type { RoomSave } from '../src/server/index.js';
import { setBox3DModule } from '../examples/blocks/physics/box3d.js';
import { BOUNDS, game } from '../examples/blocks/game.js';
import type { View } from '../examples/blocks/game.js';

beforeAll(() => setBox3DModule(new WebAssembly.Module(readFileSync('examples/blocks/physics/box3d.wasm'))));

const awake = (h: { serverState(): { blocks: Record<string, { v?: unknown }> } | null }) => Object.values(h.serverState()!.blocks).filter((b) => b.v).length;

describe('blocks example', () => {
  it('the pile settles and goes to sleep; views stay in sync via patches', () => {
    const h = createHarness(game, { clients: 2, seed: 'pile', room: { emptyTtlMs: null } });
    h.run(1000);
    expect(Object.keys((h.clients[0].state as View).blocks).length).toBe(100);
    h.run(15_000);
    expect(awake(h)).toBe(0);
    h.freeze(1000);
    h.assertInSync();
    // Everything is inside the container.
    for (const b of Object.values(h.serverState()!.blocks)) {
      expect(Math.abs(b.p[0])).toBeLessThan(BOUNDS.x);
      expect(Math.abs(b.p[2])).toBeLessThan(BOUNDS.z);
      expect(b.p[1]).toBeGreaterThan(0);
    }
  });

  it('a visitor can grab, carry and drop a block; others see it; nobody can steal it mid-carry', () => {
    const h = createHarness(game, { clients: 2, seed: 'carry', room: { emptyTtlMs: null } });
    h.run(12_000);
    const [a, b] = h.clients;
    const id = '42';
    a.submit({ type: 'grab', id, t: [4, 3, 4] });
    h.run(500);
    const rejects: string[] = [];
    b.on('reject', (r) => rejects.push(r));
    b.submit({ type: 'grab', id, t: [-4, 3, -4] });
    h.run(2500);
    expect(rejects).toEqual(['Someone else is holding that block.']);
    const held = h.serverState()!.blocks[id].p;
    expect(Math.hypot(held[0] - 4, held[1] - 3, held[2] - 4)).toBeLessThan(0.3);
    expect((b.state as View).holds[String(a.seat)]).toBe(id);
    // Dragging outside the container is clamped inside it.
    a.submit({ type: 'drag', t: [50, 50, 50] });
    h.run(2000);
    const p = h.serverState()!.blocks[id].p;
    expect(p[0]).toBeLessThan(BOUNDS.x);
    expect(p[1]).toBeLessThan(BOUNDS.height);
    a.submit({ type: 'turn' });
    a.submit({ type: 'release' });
    h.run(8000);
    expect(h.serverState()!.blocks[id].p[1]).toBeLessThan(3); // fell
    expect(Object.keys(h.serverState()!.holds)).toEqual([]);
    h.freeze(1000);
    h.assertInSync();
  });

  it('a visitor who drops off releases their block', () => {
    const h = createHarness(game, { clients: 2, seed: 'drop', room: { emptyTtlMs: null } });
    h.run(3000);
    h.clients[1].submit({ type: 'grab', id: '7', t: [0, 4, 0] });
    h.clients[1].submit({ type: 'aim', p: [0, 4, 0] });
    h.run(1000);
    h.disconnect(1);
    h.run(6000);
    expect(h.serverState()!.holds).toEqual({});
    expect(h.serverState()!.cursors).not.toHaveProperty(String(h.clients[1].seat));
  });

  it('a saved world restores exactly and stays still (rebuilt physics, sleeping bodies)', () => {
    const h = createHarness(game, { clients: 1, seed: 'save', room: { emptyTtlMs: null } });
    h.run(15_000);
    h.disconnect(0);
    h.run(1000);
    const save = JSON.parse(JSON.stringify(h.saves.at(-1))) as RoomSave;
    const before = JSON.stringify((save.engine as { state: { blocks: unknown } }).state.blocks);
    let now = 0;
    const room = new RoomCore(game, { send: () => {}, close: () => {}, setClock: () => {}, now: () => now }, { emptyTtlMs: null });
    expect(room.restore(save)).toBe(true);
    room.onConnect('x');
    room.onMessage('x', JSON.stringify({ t: 'hello', v: 3, game: 'blocks@1', token: 'visitor-123', name: 'V', colour: '' }));
    for (let i = 0; i < 100; i++) ((now += 16), room.pump());
    expect(JSON.stringify(room.state!.blocks)).toBe(before);
  });
});
