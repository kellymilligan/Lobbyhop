/**
 * Node room server: rooms over WebSocket (`ws`), plus your built game.
 * Run: `node --experimental-strip-types server.ts` (Node 22.6+) or bundle it.
 * Hosts: Fly.io, Railway, Render, any VPS or Docker host.
 */
import { createNodeServer } from 'lobbyhop/node';
import { game } from '{{GAME_IMPORT}}';

const server = createNodeServer(game, {
  static: process.env.STATIC_DIR ?? 'dist',
  // Rooms survive restarts when this points at a persistent volume.
  persistDir: process.env.PERSIST_DIR,
});
const { port } = await server.listen();
console.log(`{{NAME}} listening on :${port}`);
