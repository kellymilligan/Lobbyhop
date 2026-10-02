/** Cloudflare: one Durable Object per room, and the built game for everything else. */
import { createRoomServer, createWorker } from 'lobbyhop/cloudflare';
import { game } from './game';

export const Room = createRoomServer(game);
export default createWorker({ binding: 'Room' });
