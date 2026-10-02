/**
 * Platform-free room server. Host adapters (`lobbyhop/cloudflare`,
 * `lobbyhop/node`) wrap `RoomCore`; you only need this module to write a new
 * adapter or to drive rooms in tests.
 */
export { RoomCore, cleanName } from './room.js';
export type { RoomIO, RoomLimits, RoomOptions, RoomSave } from './room.js';
export { LockstepEngine } from './lockstep.js';
export { StateSyncEngine } from './statesync.js';
export type { EngineHost, ServerEngine } from './engine.js';
