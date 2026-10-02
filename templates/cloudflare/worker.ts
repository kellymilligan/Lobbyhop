/**
 * Cloudflare Worker: one Durable Object per room, and your built game for
 * everything else (same origin, so the client needs no host config).
 */
import { createRoomServer, createWorker } from 'lobbyhop/cloudflare';
import { game } from '{{GAME_IMPORT}}';

// Must match "class_name" in wrangler.jsonc.
export const Room = createRoomServer(game);
export default createWorker({ binding: 'Room' });
