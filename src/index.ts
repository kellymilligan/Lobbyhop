/**
 * lobbyhop: agent-first multiplayer for browser games and experiences.
 *
 * This entry holds what both client and server import: the game definition
 * helpers and the wire protocol types. See docs/GUIDE.md.
 *
 *   lobbyhop            defineLockstep, defineStateSync, ok, reject, presets, types
 *   lobbyhop/client     joinRoom, RoomClient, room URL + profile helpers
 *   lobbyhop/cloudflare createRoomServer (Durable Object), routeRooms (Worker fetch)
 *   lobbyhop/node       createNodeServer (ws), for traditional hosting and local tests
 *   lobbyhop/server     RoomCore, for writing your own host adapter
 *   lobbyhop/testing    createHarness: whole rooms in memory over a jittery network
 *   lobbyhop/det        seeded RNG, deterministic maths, hashing, JSON checks
 *   lobbyhop/lobby-ui   mountLobby, mountStatus: drop-in framework-free lobby UI
 */
export * from './shared/game.js';
export * from './shared/protocol.js';
export { applyPatch, cloneJson, diff, jsonEqual } from './shared/patch.js';
export type { Patch, PatchOp } from './shared/patch.js';
