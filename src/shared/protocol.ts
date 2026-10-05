/**
 * Wire protocol: JSON text frames over one WebSocket per player.
 * See docs/PROTOCOL.md for the full semantics.
 */
import type { Json } from './game.js';
import type { Patch } from './patch.js';

export const PROTOCOL_VERSION = 3;

export type RoomPhase = 'lobby' | 'playing' | 'over';

/** A seated player as everyone in the room sees them. */
export interface MemberView {
  seat: number;
  name: string;
  colour: string;
  connected: boolean;
  host: boolean;
  /** Says they're ready to start (a soft signal: the host can start anyway). Cleared when a game starts or settings change. */
  ready: boolean;
  meta: Json | null;
}

export interface ChatLine {
  seat: number | null;
  name: string;
  text: string;
  /** Server time (ms since epoch). */
  at: number;
}

/** A command as it travels in a lockstep turn, stamped by the server. */
export interface StampedCommand<C = unknown> {
  /** Seat that issued it (stamped by the server, never trusted from clients). */
  s: number;
  /** The command. */
  c: C;
  /** Client-local id, so the sender can match its pending (optimistic) input. */
  i?: number;
  /** 1 when issued by a server hook rather than the player. */
  y?: 1;
}

export type ErrorCode = 'version' | 'game' | 'full' | 'started' | 'kicked' | 'replaced' | 'invalid';

export type ClientMsg =
  | { t: 'hello'; v: number; game: string; token: string; name: string; colour: string; meta?: Json | null }
  | { t: 'profile'; name?: string; colour?: string; meta?: Json | null }
  | { t: 'settings'; settings: Json }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'pause'; paused: boolean }
  | { t: 'toLobby' }
  | { t: 'kick'; seat: number }
  | { t: 'input'; cmd: Json; id: number }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; id: number };

export type ServerMsg =
  /** Your seat (null = spectating) and whether you're host. Re-sent when either changes. */
  | { t: 'welcome'; seat: number | null; host: boolean }
  | { t: 'room'; phase: RoomPhase; members: MemberView[]; spectators: number; paused: boolean; settings: Json; chat?: ChatLine[] }
  /** Full state: on start, (re)join and desync repair. Lockstep: the whole state. State sync: your view. */
  | { t: 'snapshot'; tick: number; state: Json }
  /** Lockstep: apply `cmds` at tick `at`, then you may simulate up to `upTo`. */
  | { t: 'turn'; at: number; upTo: number; cmds: StampedCommand[] }
  /**
   * State sync: your current view (or, for `delta` games, a `patch` to apply to
   * your last one), events since the last update, and ids of your inputs now
   * reflected in it.
   */
  | { t: 'state'; tick: number; state?: Json; patch?: Patch; events?: Json[]; ack?: number[] }
  | { t: 'reject'; id?: number; reason: string }
  | { t: 'desync'; tick: number }
  | { t: 'chat'; line: ChatLine }
  | { t: 'pong'; id: number }
  | { t: 'notice'; text: string }
  /** Fatal for this connection (version mismatch, room full, kicked…). */
  | { t: 'error'; code: ErrorCode; reason: string };
