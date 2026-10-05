/** Node: the same persistent world over `ws`, saved to PERSIST_DIR. */
import { existsSync, readFileSync } from 'node:fs';
import { createNodeServer } from 'lobbyhop/node';
import { setBox3DModule } from './physics/box3d.js';
import { game } from './game';

// Works from the lobbyhop repo root or from a pulled copy of this example.
const wasmPath = process.env.BOX3D_WASM ?? (existsSync('physics/box3d.wasm') ? 'physics/box3d.wasm' : 'examples/blocks/physics/box3d.wasm');
setBox3DModule(new WebAssembly.Module(readFileSync(wasmPath)));
const server = createNodeServer(game, {
  static: process.env.STATIC_DIR ?? 'dist',
  persistDir: process.env.PERSIST_DIR ?? '.rooms',
  emptyTtlMs: null,
  saveEveryMs: 2_000,
  maxConnections: 128,
});
const { port } = await server.listen();
console.log(`blocks: http://localhost:${port}`);
