/** Node: rooms over `ws`, plus the built game. For Fly/Railway/Render/VPS/Docker or local use. */
import { createNodeServer } from 'lobbyhop/node';
import { game } from './game';

const server = createNodeServer(game, { static: process.env.STATIC_DIR ?? 'dist', persistDir: process.env.PERSIST_DIR });
const { port } = await server.listen();
console.log(`tictactoe: http://localhost:${port}`);
