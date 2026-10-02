import type { Json, Setup } from '../shared/game.js';

/** What a sync engine needs from the room. */
export interface EngineHost {
  send(conn: string, data: string): void;
  /** Everyone receiving game traffic: seated players and spectators. */
  viewers(): { conn: string; seat: number | null }[];
  reject(conn: string | null, id: number | undefined, reason: string): void;
  now(): number;
  /** The game reached its end. */
  over(): void;
  log(...args: unknown[]): void;
}

/** Server half of a sync model (lockstep or state sync). */
export interface ServerEngine {
  readonly tick: number;
  readonly running: boolean;
  start(setup: Setup<unknown>): void;
  /** A player's input (untrusted). */
  input(conn: string, seat: number, cmd: unknown, id: number): void;
  /** A command from a server hook. */
  system(seat: number, cmd: unknown): void;
  /** Called on the room clock. */
  pump(): void;
  /** Client-reported hash (lockstep). */
  hash(conn: string, tick: number, hash: number): void;
  /** Sends the full current state (or view) to one connection. */
  snapshot(conn: string, seat: number | null): void;
  /** How often pump() should run while playing, in ms. */
  readonly clockMs: number;
  /** Re-anchor the clock to now (after pause or restore). */
  rebase(): void;
  clear(): void;
  save(): Json;
  restore(data: Json): void;
}

export function safeApply<R>(fn: () => R, log: (...a: unknown[]) => void): R | { ok: false; reason: string } {
  try {
    return fn();
  } catch (e) {
    log('apply threw', e);
    return { ok: false, reason: 'That action failed on the server.' };
  }
}
