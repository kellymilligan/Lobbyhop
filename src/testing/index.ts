/**
 * A whole room in memory: one server, N clients, and a simulated network that
 * delivers each message after a random delay (ordered per connection, like a
 * WebSocket). Time is fake, so minutes of play run in seconds.
 *
 *   const h = createHarness(game, { clients: 3 });
 *   h.run(600);              // let everyone join
 *   h.startGame();
 *   h.run(60_000, (t) => { if (t % 250 === 0) for (const c of h.clients) c.submit(randomCmd()); });
 *   h.assertInSync();        // throws with details on any mismatch
 *
 * Framework-free: works with Vitest, Jest, node:test or a plain script.
 */
import type { AnyGame, EventOf, StateSyncGame } from '../shared/game.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { hashString, nextInt, seedRng } from '../det/index.js';
import type { Rng } from '../det/index.js';
import type { Profile } from '../client/session.js';
import { RoomClient } from '../client/session.js';
import type { RoomOptions, RoomSave } from '../server/room.js';
import { RoomCore } from '../server/room.js';

export interface HarnessOptions {
  /** Clients that connect at the start (default 2). */
  clients?: number;
  /** Seeds network jitter and the game seed (default 'harness'). */
  seed?: string;
  /** Per-message latency range in ms (default [20, 250]). */
  latency?: [number, number];
  /** Simulation step in ms (default 10). Clients `advance` every step. */
  stepMs?: number;
  /** Options passed to the RoomCore (limits, ttl…). */
  room?: RoomOptions;
  /** Record persistence saves in `h.saves` (default true). */
  persist?: boolean;
}

export interface Harness<G extends AnyGame> {
  room: RoomCore<G>;
  clients: RoomClient<G>[];
  /** Seeded RNG for driving random inputs. */
  rng: Rng;
  /** Every save the room requested (latest last; null = deleted). */
  saves: (RoomSave | null)[];
  /** Game events each client's `advance` produced, in order (the harness drives advance for you). */
  events: EventOf<G>[][];
  /** Fake clock, ms. */
  now(): number;
  /** Runs `ms` of simulated time; `each(t)` is called every step. */
  run(ms: number, each?: (t: number) => void): void;
  /** Runs until `cond()` is true (or throws after `maxMs`). */
  until(cond: () => boolean, maxMs?: number): void;
  /** The client that is currently host. */
  host(): RoomClient<G>;
  /** Host starts the game; runs until every seated client has state. */
  startGame(): void;
  /** Stops the server clock and lets clients drain to it. Returns the server tick. */
  freeze(ms?: number): number;
  unfreeze(): void;
  /** Throws unless every client matches the server (lockstep: tick + hash; state sync: latest view). */
  assertInSync(): void;
  /** Drops client i's connection (server sees a close). */
  disconnect(i: number): void;
  /** Reconnects client i on a fresh connection id, reusing its profile (token). */
  reconnect(i: number): void;
  /** Adds and connects another client. Returns its index. */
  addClient(profile?: Partial<Profile>): number;
}

export function createHarness<G extends AnyGame>(game: G, opts: HarnessOptions = {}): Harness<G> {
  const seed = opts.seed ?? 'harness';
  const rng = seedRng(`harness:${seed}`);
  const net = seedRng(`net:${seed}`);
  const [minLat, maxLat] = opts.latency ?? [20, 250];
  const stepMs = opts.stepMs ?? 10;
  let now = 0;
  let clockMs: number | null = null;
  let nextPump = 0;
  let alarmAt: number | null = null;
  let seq = 0;
  let connSeq = 0;
  const saves: (RoomSave | null)[] = [];
  const inflight: { at: number; seq: number; deliver: () => void }[] = [];
  const lastAt = new Map<string, number>();
  const post = (channel: string, deliver: () => void) => {
    // Ordered per channel: never earlier than the previous message on it.
    const at = Math.max(now + minLat + nextInt(net, Math.max(1, maxLat - minLat)), lastAt.get(channel) ?? 0);
    lastAt.set(channel, at);
    inflight.push({ at, seq: seq++, deliver });
  };

  const clients: RoomClient<G>[] = [];
  const events: EventOf<G>[][] = [];
  /** conn id per client index (null while disconnected). */
  const connOf: (string | null)[] = [];
  const clientOf = new Map<string, number>();

  const room = new RoomCore(
    game,
    {
      send: (conn, data) => {
        const i = clientOf.get(conn);
        if (i === undefined) return;
        post(`s>${conn}`, () => {
          if (connOf[i] === conn) clients[i].receive(JSON.parse(data) as ServerMsg);
        });
      },
      close: (conn) => {
        const i = clientOf.get(conn);
        room.onClose(conn);
        if (i === undefined) return;
        // Deliver after the error message that was sent just before.
        post(`s>${conn}`, () => {
          clientOf.delete(conn);
          if (connOf[i] !== conn) return;
          connOf[i] = null;
          clients[i].closed(false);
        });
      },
      setClock: (ms) => {
        clockMs = ms;
        nextPump = now + (ms ?? 0);
      },
      now: () => now,
      seed: () => `game-${seed}`,
      save: opts.persist === false ? undefined : (d) => saves.push(d ? (JSON.parse(JSON.stringify(d)) as RoomSave) : null),
      schedule: (ms) => (alarmAt = ms === null ? null : now + ms),
    },
    opts.room,
  );

  const connect = (i: number) => {
    const conn = `c${connSeq++}`;
    connOf[i] = conn;
    clientOf.set(conn, i);
    room.onConnect(conn);
    clients[i].opened();
  };

  const addClient = (profile: Partial<Profile> = {}) => {
    const i = clients.length;
    const palette = room.rules.palette;
    const p: Profile = { token: `token-${seed}-${i}`, name: `Player ${i}`, colour: palette[i % palette.length], ...profile };
    const client = new RoomClient(
      game,
      (m: ClientMsg) => {
        const conn = connOf[i];
        if (conn) post(`c>${conn}`, () => clientOf.has(conn) && room.onMessage(conn, JSON.stringify(m)));
      },
      p,
      { now: () => now },
    );
    clients.push(client);
    events.push([]);
    connect(i);
    return i;
  };

  for (let i = 0; i < (opts.clients ?? 2); i++) addClient();

  let frozen = false;
  const run = (ms: number, each?: (t: number) => void) => {
    const end = now + ms;
    while (now < end) {
      now += stepMs;
      inflight.sort((a, b) => a.at - b.at || a.seq - b.seq);
      while (inflight.length && inflight[0].at <= now) inflight.shift()!.deliver();
      if (clockMs !== null && now >= nextPump && !frozen) {
        room.pump();
        nextPump = now + (clockMs ?? 0);
      }
      if (alarmAt !== null && now >= alarmAt) {
        alarmAt = null;
        room.alarm();
      }
      for (let i = 0; i < clients.length; i++) {
        if (!connOf[i]) continue;
        const f = clients[i].advance(stepMs / 1000);
        if (f.events.length) events[i].push(...f.events);
      }
      each?.(now);
    }
  };

  const h: Harness<G> = {
    room,
    clients,
    rng,
    saves,
    events,
    now: () => now,
    run,
    until(cond, maxMs = 30_000) {
      const end = now + maxMs;
      while (!cond()) {
        if (now >= end) throw new Error(`harness: condition not met within ${maxMs} ms`);
        run(stepMs);
      }
    },
    host() {
      const c = clients.find((x, i) => x.host && connOf[i]);
      if (!c) throw new Error('harness: no host yet (run a little first so hellos arrive)');
      return c;
    },
    startGame() {
      h.until(() => clients.some((x, i) => x.host && connOf[i]));
      h.host().start();
      h.until(() => clients.every((c, i) => !connOf[i] || c.seat === null || (c.state !== null && c.phase === 'playing')));
    },
    freeze(ms = 3000) {
      frozen = true;
      run(ms);
      return room.engine.tick;
    },
    unfreeze() {
      frozen = false;
      room.engine.rebase();
    },
    assertInSync() {
      const server = (room.engine as unknown as { state: unknown }).state;
      if (server === null) throw new Error('harness: no game running');
      const problems: string[] = [];
      clients.forEach((c, i) => {
        if (!connOf[i] || c.state === null) return;
        if (game.mode === 'lockstep') {
          const sh = game.hash ? game.hash(server) : hashString(JSON.stringify(server));
          const ch = game.hash ? game.hash(c.state) : hashString(JSON.stringify(c.state));
          if (c.tick !== room.engine.tick) problems.push(`client ${i} at tick ${c.tick}, server at ${room.engine.tick} (frozen long enough?)`);
          else if (sh !== ch) problems.push(`client ${i} hash ${ch} != server ${sh} at tick ${c.tick}`);
          if (c.desyncs) problems.push(`client ${i} had ${c.desyncs} desync(s)`);
        } else {
          const g = game as StateSyncGame<unknown, unknown, unknown, unknown, unknown>;
          const want = JSON.stringify(g.view ? g.view(server, c.seat) : server);
          if (JSON.stringify(c.state) !== want) problems.push(`client ${i} view differs from the server's`);
        }
      });
      if (problems.length) throw new Error(`harness: out of sync\n  ${problems.join('\n  ')}`);
    },
    disconnect(i) {
      const conn = connOf[i];
      if (!conn) return;
      connOf[i] = null;
      clientOf.delete(conn);
      room.onClose(conn);
      clients[i].closed(true);
    },
    reconnect(i) {
      if (connOf[i]) h.disconnect(i);
      connect(i);
    },
    addClient,
  };
  return h;
}

export interface ScenarioOptions<C> {
  seed: string;
  /** Seats with a human (default [0, 1]). */
  seats?: number[];
  /** Settings to create the game with (default: the game's defaults). */
  settings?: unknown;
  /** Ticks to simulate (stops early if the game ends). */
  ticks: number;
  /** Record a hash every this many ticks (default: the game's hashEvery, ≈ 5 s). */
  hashEvery?: number;
  /** Scripted input: called every tick with a seeded RNG; return [seat, command] pairs to apply. */
  input?: (tick: number, rng: Rng, state: unknown) => [number, C][];
  /** Pass the state through JSON at this tick, as a snapshot/reconnect would (default: halfway). */
  roundTripAt?: number;
}

/**
 * Runs a lockstep game headless and records state hashes at fixed ticks.
 * Pure code with no Node or DOM APIs, so it can be bundled and run in every
 * browser engine: tools/determinism.mjs compares the results across engines.
 */
export function recordHashes<S, C>(game: import('../shared/game.js').LockstepGame<S, C, any, any>, opts: ScenarioOptions<C>): number[] {
  const seats = (opts.seats ?? [0, 1]).map((seat) => ({ seat, name: `P${seat}`, colour: '', meta: null }));
  let s = game.create({ seed: opts.seed, seats, settings: (opts.settings ?? game.settings?.defaults ?? {}) as never });
  const rng = seedRng(`script:${opts.seed}`);
  const every = opts.hashEvery ?? game.hashEvery ?? Math.round(game.tickRate * 5);
  const roundTrip = opts.roundTripAt ?? opts.ticks >> 1;
  const hash = (x: S) => (game.hash ? game.hash(x) : hashString(JSON.stringify(x)));
  const out: number[] = [];
  let t = 0;
  for (; t < opts.ticks && !(game.isOver?.(s) ?? false); t++) {
    for (const [seat, cmd] of opts.input?.(t, rng, s) ?? []) game.apply(s, cmd, { seat, system: false });
    game.step(s);
    if ((t + 1) % every === 0) out.push(hash(s));
    if (t === roundTrip) s = JSON.parse(JSON.stringify(s)) as S;
  }
  out.push(t, hash(s));
  return out;
}
