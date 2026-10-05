/**
 * Cloudflare: one Durable Object holds the whole world (room "world"), runs
 * Box3D, and keeps the world forever (emptyTtlMs: null).
 */
import { createRoomServer, createWorker } from 'lobbyhop/cloudflare';
import box3d from './physics/box3d.wasm';
import { setBox3DModule } from './physics/box3d.js';
import { game } from './game';

setBox3DModule(box3d);

export const Room = createRoomServer(game, {
  emptyTtlMs: null, // a persistent world: never delete it when everyone leaves
  saveEveryMs: 2_000, // small state, so save often: a deploy loses at most ~2 s of building
  maxConnections: 128,
});
export default createWorker({ binding: 'Room' });
