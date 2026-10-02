/**
 * The game definition: the one object a game provides. The same object is
 * imported by the browser client and by the room server, so they always agree
 * on rules and settings.
 */

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A human in a seat, as handed to your game's `create` and hooks. */
export interface SeatInfo {
  /** Seat index: 0-based join order in the lobby (stable for the whole game). */
  seat: number;
  name: string;
  colour: string;
  /** Free-form per-player data set by the client (e.g. a chosen faction or avatar). */
  meta: Json | null;
}

/** Everything `create` gets to build the starting state. */
export interface Setup<Settings> {
  /** A fresh random seed for this game. Seed your RNG from it. */
  seed: string;
  /** The humans present, sorted by seat. Seats without a human are yours to fill (bots) or omit. */
  seats: SeatInfo[];
  /** Host-chosen settings (validated). */
  settings: Settings;
}

/** Who issued a command: a player's seat, or the server on that seat's behalf (hooks). */
export interface Origin {
  seat: number;
  /** True for commands produced by your `hooks` (join/idle/return), never for client input. */
  system: boolean;
}

export type ApplyResult<E> = { ok: true; events?: E[] } | { ok: false; reason: string };

/** Shorthand results for `apply`. */
export const ok = <E = never>(events?: E[]): ApplyResult<E> => (events ? { ok: true, events } : { ok: true });
export const reject = (reason: string): ApplyResult<never> => ({ ok: false, reason });

export interface SeatRules {
  /** Players needed before the host can start (default 1). */
  min?: number;
  /** Seats in the room (default 8). Extra joiners become spectators. */
  max?: number;
  /** Colours offered in the lobby; each player gets a unique one. */
  palette?: string[];
}

export interface SettingsRules<Settings> {
  /** Starting settings for a new room. */
  defaults: Settings;
  /**
   * Validate and normalise host input (untrusted). Return the new settings.
   * Default: shallow-merge known keys whose type matches the default's.
   */
  validate?(raw: unknown, current: Settings): Settings;
}

/**
 * Server-issued commands. Each returns a command (applied as if from that
 * seat, with `from.system === true`) or null. In lockstep these travel in the
 * turn stream, so every client applies them on the same tick.
 */
export interface GameHooks<C> {
  /** Someone joined mid-game (rooms with `lobby: false`, or late joiners). Without this hook, late joiners spectate. */
  join?(info: SeatInfo): C | null;
  /** A seat has been disconnected for `idleMs` (hand it to a bot, forfeit, …). */
  idle?(seat: number): C | null;
  /** A seat that went idle has reconnected. */
  return?(seat: number): C | null;
}

interface GameBase<S, C, Settings, E> {
  /** Short id, checked on join so a client for another game can't join this room. */
  name: string;
  /** Bump when state/command shapes change; out-of-date clients are asked to refresh. */
  version?: number;
  /** Build the starting state. Must be deterministic given `setup`. */
  create(setup: Setup<Settings>): S;
  /** Validate and apply one command. Must be deterministic and must not throw. */
  apply(state: S, cmd: C, from: Origin): ApplyResult<E>;
  /** True when the game has ended (the room moves to the 'over' phase). */
  isOver?(state: S): boolean;
  seats?: SeatRules;
  settings?: SettingsRules<Settings>;
  hooks?: GameHooks<C>;
  /** Show a lobby before play (default true). False: the room starts as soon as someone arrives, and others join live via `hooks.join`. */
  lobby?: boolean;
  /** How long a seat may be disconnected before `hooks.idle` fires (default 30 s). */
  idleMs?: number;
  /** Let people who can't get a seat watch (default true). */
  spectators?: boolean;
}

/**
 * Lockstep: every client runs the same deterministic simulation; only commands
 * travel. Best for RTS, tower defence, sims and anything with lots of moving
 * parts. Requires determinism (see docs/DETERMINISM.md).
 */
export interface LockstepGame<S, C, Settings = Record<string, never>, E = never> extends GameBase<S, C, Settings, E> {
  mode: 'lockstep';
  /** Simulation ticks per second (e.g. 20–60). */
  tickRate: number;
  /** Advance exactly one tick. Return events for the renderer (sounds, effects). */
  step(state: S): E[] | void;
  /** State fingerprint for desync detection (default: FNV-1a over JSON). */
  hash?(state: S): number;
  /** How often the server issues turns, in ms (default 100). Input delay ≈ turnMs + latency. */
  turnMs?: number;
  /** Clients report a state hash every this many ticks (default ≈ 5 s). */
  hashEvery?: number;
}

/**
 * State sync: only the server runs the game and sends each player their view
 * of the state. No determinism needed, and hidden information stays hidden.
 * Best for turn-based, party, card and board games, and shared experiences.
 */
export interface StateSyncGame<S, C, Settings = Record<string, never>, E = never, V = S> extends GameBase<S, C, Settings, E> {
  mode: 'statesync';
  /** Server ticks per second for `step` (0 = event-driven: state changes only on commands; ideal for turn-based). */
  tickRate: number;
  /** Advance one tick (real-time games). */
  step?(state: S): E[] | void;
  /** What a seat may see (null = spectator). Default: the whole state. Use it for hands, fog of war, secrets. */
  view?(state: S, seat: number | null): V;
  /** State broadcasts per second when `tickRate > 0` (default: tickRate, max 30). Changes only: unchanged views aren't resent. */
  sendRate?: number;
}

export type AnyGame = LockstepGame<any, any, any, any> | StateSyncGame<any, any, any, any, any>;

/** Type helpers to pull a game's types back out. */
export type StateOf<G> = G extends LockstepGame<infer S, any, any, any> ? S : G extends StateSyncGame<any, any, any, any, infer V> ? V : never;
export type ServerStateOf<G> = G extends LockstepGame<infer S, any, any, any> ? S : G extends StateSyncGame<infer S, any, any, any, any> ? S : never;
export type CommandOf<G> = G extends { apply(state: any, cmd: infer C, from: Origin): any } ? C : never;
export type SettingsOf<G> = G extends { create(setup: Setup<infer T>): any } ? T : never;
export type EventOf<G> = G extends LockstepGame<any, any, any, infer E> ? E : G extends StateSyncGame<any, any, any, infer E, any> ? E : never;

/** Defines a lockstep game (identity function that fills in types). */
export function defineLockstep<S, C, Settings = Record<string, never>, E = never>(game: Omit<LockstepGame<S, C, Settings, E>, 'mode'>): LockstepGame<S, C, Settings, E> {
  return { ...game, mode: 'lockstep' };
}

/** Defines a state-sync game (identity function that fills in types). */
export function defineStateSync<S, C, Settings = Record<string, never>, E = never, V = S>(
  game: Omit<StateSyncGame<S, C, Settings, E, V>, 'mode'>,
): StateSyncGame<S, C, Settings, E, V> {
  return { ...game, mode: 'statesync' };
}

/** A colour palette that reads well on dark and light backgrounds. */
export const DEFAULT_PALETTE = ['#e5484d', '#3e9bff', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#a18072'];

/** Resolved rules with defaults applied (used internally by server and client). */
export function rules(game: AnyGame) {
  const max = Math.max(1, game.seats?.max ?? 8);
  const palette = game.seats?.palette?.length ? game.seats.palette : DEFAULT_PALETTE;
  const tickRate = game.tickRate;
  const lockstep = game.mode === 'lockstep';
  return {
    max,
    min: Math.min(max, Math.max(1, game.seats?.min ?? 1)),
    palette,
    lobby: game.lobby !== false,
    idleMs: game.idleMs ?? 30_000,
    spectators: game.spectators !== false,
    version: `${game.name}@${game.version ?? 1}`,
    tickRate,
    turnMs: lockstep ? Math.max(16, game.turnMs ?? 100) : 0,
    hashEvery: lockstep ? Math.max(1, game.hashEvery ?? Math.round(tickRate * 5)) : 0,
    sendRate: lockstep ? 0 : Math.min(30, (game as StateSyncGame<unknown, unknown>).sendRate ?? tickRate),
  };
}

export function validateSettings<Settings>(game: AnyGame, raw: unknown, current: Settings): Settings {
  const s = game.settings;
  if (!s) return current;
  if (s.validate) return s.validate(raw, current);
  if (!raw || typeof raw !== 'object') return current;
  const out = { ...current } as Record<string, unknown>;
  const defs = s.defaults as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k in defs && typeof v === typeof defs[k]) out[k] = v;
  }
  return out as Settings;
}

/**
 * Genre presets: sensible starting points you can spread into a definition.
 * See docs/GENRES.md for how to choose.
 */
export const presets = {
  /** Board, card and word games: nothing happens until someone acts. */
  turnBased: { tickRate: 0 },
  /** Party and casual games with timers: 10 Hz, changes only. */
  casual: { tickRate: 10 },
  /** Real-time state sync (co-op, .io-style, shared spaces): 20 Hz with client interpolation. */
  realtime: { tickRate: 20 },
  /** Lockstep RTS / tower defence: 30 Hz sim, 100 ms turns. */
  strategy: { tickRate: 30, turnMs: 100 },
  /** Lockstep action (more responsive, more traffic): 60 Hz sim, 50 ms turns. */
  action: { tickRate: 60, turnMs: 50 },
} as const;
