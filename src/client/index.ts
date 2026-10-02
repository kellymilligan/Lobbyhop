/**
 * Browser side: join a room by code, drive your game loop from it, and keep
 * the share link + profile in order.
 */
export { RoomClient } from './session.js';
export type { ConnectionStatus, Frame, PendingInput, Profile, RoomClientOptions, RoomEvents } from './session.js';
export { joinRoom, roomUrl } from './socket.js';
export type { JoinedRoom, JoinOptions } from './socket.js';
export { cleanRoomCode, getRoomCode, loadProfile, newRoomCode, roomFromUrl, saveProfile, setRoomInUrl, shareLink } from './profile.js';
export type { ChatLine, MemberView, RoomPhase } from '../shared/protocol.js';
