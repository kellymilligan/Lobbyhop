# Guide

lobbyhop adds "share a link, play together" to a browser game or
experience. You write one **game definition** (rules as plain functions).
lobbyhop provides the rooms, lobby, seats, reconnects, sync, hosting and
tests. The renderer doesn't matter: WebGPU, WebGL, Canvas2D and DOM all work.

- New to multiplayer? Read [CHOOSING.md](CHOOSING.md) first. It explains the
  two sync models and the trade-offs in plain terms.
- An agent adding multiplayer to a project? Follow
  [skills/lobbyhop/SKILL.md](../skills/lobbyhop/SKILL.md) step by step.

## Contents

1. [The five-minute version](#the-five-minute-version)
2. [Concepts](#concepts)
3. [Define your game](#define-your-game)
4. [Wire up the client](#wire-up-the-client)
5. [Host the rooms](#host-the-rooms)
6. [Test it](#test-it)
7. [Hooks, drop-in rooms and late joiners](#hooks-drop-in-rooms-and-late-joiners)
8. [Server options](#server-options)
9. [Examples](#examples)
10. [Retrofitting an existing game](#retrofitting-an-existing-game)

## The five-minute version

```sh
npm i lobbyhop
npx lobbyhop init --mode statesync --host cloudflare
npm i -D wrangler
```

**`src/multiplayer/game.ts`** is shared by the browser and the server:

```ts
import { defineStateSync, ok, reject, presets } from 'lobbyhop';

export const game = defineStateSync<{ count: number[] }, { type: 'click' }>({
  name: 'clicker',
  ...presets.turnBased,
  seats: { min: 1, max: 4 },
  create: ({ seats }) => ({ count: seats.map(() => 0) }),
  apply(state, cmd, from) {
    state.count[from.seat]++;
    return ok();
  },
});
```

**In the browser:**

```ts
import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
import { game } from './multiplayer/game';

const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });
mountLobby(room, { title: 'Clicker' });
mountStatus(room);

button.onclick = () => room.submit({ type: 'click' });
function frame(now) {
  const { state, alpha, events } = room.advance(dt);
  if (state) render(state, alpha, events);
  requestAnimationFrame(frame);
}
```

**Run it:**

```sh
npx vite build && npx wrangler dev     # http://localhost:8787 serves the game and the rooms
```

Open it in two tabs (or send the link to another device). The URL gains a
`?room=abc123` code: that's the share link, and a refresh rejoins the same
seat.

## Concepts

| Term | Meaning |
|---|---|
| **Room** | One game session, addressed by a code in the URL (`?room=k3m9xq`). It's created on first connect. On Cloudflare each room is a Durable Object; on Node it's an entry in a map. |
| **Seat** | A player slot. In the lobby, seats follow join order (0, 1, 2 …), and they stay fixed for the whole game. Your game state should be keyed by seat. |
| **Token** | A random secret that identifies you in a room. It's kept in `localStorage`, so reconnecting, refreshing, or closing the tab and reopening the link all reclaim your seat. A second tab in the same browser gets its own token, and so its own seat (`tabToken`), so you can test with two tabs. |
| **Host** | The first connected seat. The host changes settings, starts, pauses, kicks and returns everyone to the lobby. If the host leaves, the next player becomes host. |
| **Phase** | `lobby` → `playing` → `over`, then back to `lobby` or a rematch. |
| **Spectator** | Someone who couldn't get a seat (the room was full or the game had started). Spectators receive the game but can't act. |
| **Command** | Player intent, such as `{ type: 'move', dx: 1 }`. Clients only ever send commands. The server stamps each one with the sender's seat, so nobody can act for someone else. |
| **Event** | Something that happened, returned by `apply`/`step` (e.g. `{ type: 'hit' }`). Use events for sounds, effects and toasts. |

### Two sync models

| | **Lockstep** (`defineLockstep`) | **State sync** (`defineStateSync`) |
|---|---|---|
| Who runs the game | Every client and the server | Only the server |
| What travels | Commands only (tiny) | Each player's view of the state |
| Needs determinism | **Yes** ([DETERMINISM.md](DETERMINISM.md)) | No |
| Hidden information | No: every client has the full state | Yes, via `view(state, seat)` |
| Good for | RTS, tower defence, sims, lots of units | Turn-based, party, card and board games, co-op, shared spaces |
| Input delay | About one turn plus latency (100–250 ms) | Latency (50–150 ms) |

[CHOOSING.md](CHOOSING.md) covers this properly, including genres and tick rates.

## Define your game

A game definition is a plain object shared by client and server. Wrap it in
`defineLockstep` or `defineStateSync` for type inference.

### Fields for both models

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Short id. Clients for another game (or version) can't join. |
| `version` | | Bump it when state or command shapes change. Out-of-date clients are asked to refresh. Default 1. |
| `tickRate` | yes | Ticks per second. Lockstep: 20–60. State sync: 0 means event-driven (turn-based); 10–30 for real-time. |
| `create({ seed, seats, settings })` | yes | Builds the starting state. `seats` are the humans present (`{ seat, name, colour, meta }`), always numbered 0..n-1 with no gaps. Seed your RNG from `seed`. |
| `apply(state, cmd, from)` | yes | Validates and applies one command, mutating `state`. Returns `ok(events?)` or `reject('reason')`. `from` is `{ seat, system }`. **Validate everything**: commands come from untrusted clients. |
| `isOver(state)` | | True ends the game (phase `over`). |
| `seats` | | `{ min, max, palette }`. Defaults: 1, 8, and a built-in 8-colour palette. |
| `settings` | | `{ defaults, validate? }`. Host-editable settings, passed to `create`. Without `validate`, only keys whose type matches the default are accepted. |
| `hooks` | | `{ join, idle, return }`: server-issued commands. See [Hooks](#hooks-drop-in-rooms-and-late-joiners). |
| `lobby` | | `false` starts the room on first arrival, and others join live. Default true. |
| `idleMs` | | How long a seat may be disconnected before `hooks.idle` fires. Default 30 s. |
| `spectators` | | Allow spectators. Default true. |
| `canStart(seats, settings)` | | Extra start rule that depends on who's here and the settings, e.g. "without bots you need at least two players". Return a reason string to block, or null. The server rejects `start` with it, and the lobby disables Start and shows the reason (`room.startBlocker`). |

### Lockstep-only fields

| Field | What it does |
|---|---|
| `step(state)` | **Required.** Advances exactly one tick. Returns events. |
| `turnMs` | How often the server issues turns. Default 100 ms. |
| `hashEvery` | How often clients report a state hash for desync detection. Default about 5 s worth of ticks. |
| `hash(state)` | A custom fingerprint. Default: FNV-1a over `JSON.stringify(state)`. |

### State-sync-only fields

| Field | What it does |
|---|---|
| `step(state)` | Optional. Real-time games advance here at `tickRate`. |
| `view(state, seat)` | What a seat (or `null` for spectators) may see. Default: the whole state. Use it for hands, fog of war and secret roles. |
| `sendRate` | Broadcasts per second when `tickRate > 0`. Default: `tickRate`, max 30. Only changed views are sent. |

### Presets

```ts
import { presets } from 'lobbyhop';
presets.turnBased  // { tickRate: 0 }               state sync
presets.casual     // { tickRate: 10 }              state sync
presets.realtime   // { tickRate: 20 }              state sync
presets.strategy   // { tickRate: 30, turnMs: 100 } lockstep
presets.action     // { tickRate: 60, turnMs: 50 }  lockstep
```

### Rules of thumb

- **State is plain JSON:** objects, arrays, numbers, strings, booleans and
  null. No classes, Maps, Sets, functions or `undefined`.
  `assertJsonSafe(state)` from `lobbyhop/det` checks this.
- **Key state by seat,** and keep presentation (names, colours) in
  `room.members` on the client. Copy names into state only if the rules need
  them.
- **Bots live inside the game,** as simulation logic for seats without a
  human. In lockstep they cost no bandwidth.
- **Commands are intent,** not results. Send `{ type: 'build', x, y }`, not
  "I now have a tower".

## Wire up the client

```ts
import { getRoomCode, joinRoom } from 'lobbyhop/client';

const room = joinRoom(game, {
  room: getRoomCode()!,                   // ?room= from the URL, or a new code written into it
  host: import.meta.env.VITE_ROOM_HOST,   // dev: localhost:8787. Production: omit (same origin)
});
```

`joinRoom` returns a `RoomClient` that auto-reconnects with backoff.

### Reading room state

All of these are plain fields: read them whenever you render.

| Field | |
|---|---|
| `room.status` | `'connecting' \| 'open' \| 'reconnecting' \| 'closed'` |
| `room.error` | `{ code, reason }` on a fatal error (out of date, full, kicked). The socket stops retrying. |
| `room.phase` | `'lobby' \| 'playing' \| 'over'` |
| `room.seat`, `room.host`, `room.me` | Your seat (null when spectating), whether you're host, and your member entry. |
| `room.members` | `{ seat, name, colour, connected, host, ready, meta }[]` |
| `room.ready`, `room.allReady`, `room.notReady` | Whether you're ready; whether every connected non-host player is; and who isn't. |
| `room.startBlocker` | Why the host can't start yet (`seats.min` or your `canStart`), or null. |
| `room.settings`, `room.paused`, `room.spectators`, `room.chat`, `room.rtt` | |
| `room.state` | Lockstep: your local simulation. State sync: your latest view. Null in the lobby. |
| `room.pending` | Commands you've sent that aren't confirmed yet: `{ id, cmd, at }[]`. Draw these as optimistic "ghosts". |
| `room.tick`, `room.frontier` | Lockstep: your tick, and how far the server has cleared you to go. |

### Actions

`room.submit(cmd)` · `room.setProfile({ name, colour, meta })` · `room.say(text)` ·
`room.setReady(bool)` · `room.start()` · `room.setSettings({...})` · `room.setPaused(bool)` ·
`room.toLobby()` · `room.kick(seat)` · `room.leave()`. The server ignores host-only actions from non-hosts.

### Events

```ts
room.on('change', render);          // lobby, connection or state replaced
room.on('notice', toast);           // rejected input, resync…
room.on('reject', (reason, input) => …);
room.on('snapshot', (state) => …);  // state replaced wholesale: reset caches keyed on the old state
room.on('phase', (phase) => …);
room.on('chat', (line) => …);
```

### The game loop

Call `room.advance(dtSeconds)` once per animation frame:

```ts
let last = performance.now();
function frame(now: number) {
  const { state, prev, alpha, events } = room.advance((now - last) / 1000);
  last = now;
  if (state) {
    for (const e of events) playEffect(e);
    draw(state, prev, alpha);
  }
  requestAnimationFrame(frame);
}
```

- **Lockstep:** `advance` runs the simulation up to (and slightly behind) the
  server's frontier. It sprints when far behind and eases off when close.
  `alpha` is the fraction of the way to the next tick. Keep previous
  positions in state (`px, py`) and draw `lerp(px, x, alpha)`.
- **State sync:** `advance` returns the latest view, the previous one, and
  `alpha` from previous to latest. Draw `lerp(prev.x, state.x, alpha)`.
- **Pass the real elapsed time.** If your single-player loop clamps `dt`
  (say to 0.1 s), don't reuse that clamp here. `advance` already clamps to
  1 s and sprints up to 30× to catch up after a stall or a hidden tab; a
  pre-clamped `dt` slows that recovery.

### Feel the latency (dev aid)

```ts
const lag = Number(new URLSearchParams(location.search).get('lag') ?? 0);
const room = joinRoom(game, { room, simulateLatency: lag });   // ?lag=250 adds 250 ms round trip
room.setSimulatedLatency([150, 400]);                           // or change it live, with jitter
```

This delays everything this client sends and receives, in order. Use it to
test ghosts and interpolation under a slow connection, or in e2e to keep
inputs pending long enough to screenshot them. Leave it off in production.

### Turn-based games: no loop needed

Board, card and turn-based games can skip `requestAnimationFrame` entirely:
re-render on `'change'`, and call `room.advance(0)` at the top of the render
to collect events and expire stale pending inputs. `examples/tictactoe` is
the template:

```ts
function render() {
  const { state, events } = room.advance(0);
  if (!state) return;               // lobby
  draw(state, room.pending);        // pending = your optimistic, unconfirmed moves
}
room.on('change', render);
```

### Optimistic UI (ghosts)

Lockstep input lands about 100–250 ms after you send it. Draw your pending
commands immediately so the game feels instant:

```ts
for (const p of room.pending) if (p.cmd.type === 'build') drawGhost(p.cmd.x, p.cmd.y);
```

An entry leaves `pending` when its turn lands (lockstep), when the server
applies it (state sync), when it's rejected, or after 3 s.

### Input: send intent, and only when it changes

- **Good:** a held direction is one `move` command when the keys change.
  `examples/arena` does this.
- **Bad:** sending `move` every frame. You'll hit the rate limit (30 per
  second by default) and waste bandwidth.
- For pointers in state sync, throttle to about 15 per second.
  `examples/cursors` does this.
- **Held, repeating actions** (auto-fire while a key is down) become a flag
  in state: send `{ type: 'fire', on: true }` on press and `on: false` on
  release, and let `step` fire while the flag is set.

### Lobby UI

```ts
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
mountLobby(room, {
  title: 'Orb Arena',
  subtitle: 'Collect orbs; drop walls.',
  settings: [
    { key: 'bots', label: 'Fill empty seats with bots', type: 'toggle' },
    { key: 'minutes', label: 'Minutes', type: 'number', min: 1, max: 10 },
    { key: 'map', label: 'Map', type: 'select', options: [{ value: 'a', label: 'Forest' }] },
  ],
  emptySeat: (s) => (s.bots ? 'Bot' : 'Open seat'),
  overText: (r) => `${winnerName(r)} wins!`,
});
mountStatus(room);   // in-game chip: room code, ping, reconnecting, host pause
```

The lobby is a framework-free frosted-glass overlay. It shows itself in the
lobby (and at game over, with rematch and back to lobby) and hides during
play. It includes:
- the share link with copy (native share on phones);
- a name field and colour swatches (taken colours are disabled);
- seats, with host, away and kick controls;
- host settings, chat, and start (disabled until `seats.min`);
- ready-up (below).

- **Ready-up:** players toggle "I'm ready", seats show a ready chip, and the
  host's button reads "Start · 2/3 ready".
  - It's a soft signal. If anyone isn't ready, the host gets "Not everyone is
    ready (names). Start anyway?" and can go ahead.
  - The host doesn't ready up: starting is how the host says ready.
  - Ready clears when a game starts and when the host changes settings, so
    players confirm the new rules.
  - It also works at game over, for a rematch.
  - Disconnected players aren't waited on.
  - Pass `ready: false` to hide it.
  - For a custom lobby, use `room.setReady`, `room.allReady` and
    `room.notReady`.

- **Colours:** lobby colours come from `seats.palette`. If players have fixed
  roles with fixed colours (red and yellow discs, white and black pieces),
  set `palette` to exactly those colours in seat order. Pass `colours: false`
  to hide the picker.
- **Game-over panel:** this sits at the bottom of the screen by default, so
  the final board stays visible. Use `overPlacement: 'center'` to centre it,
  or `showOver: false` to draw your own (call `room.start()` for a rematch
  and `room.toLobby()` to return to the lobby).

Theme it with CSS variables: `--lh-bg`, `--lh-fg`, `--lh-dim`, `--lh-accent`,
`--lh-accent-fg`, `--lh-border`, `--lh-radius`, `--lh-font`, `--lh-blur`.

To build your own lobby in React, Preact or anything else, render from the
`RoomClient` fields above and re-render on `'change'`.

### Disable single-player affordances in rooms

When networked:
- turn off speed-up controls;
- turn off local autosave and resume;
- turn off "autoplay my seat", and any debug hook that mutates state locally.

In lockstep, any local mutation desyncs you. The server will repair it by
snapshot, but your game will stutter.

## Host the rooms

| | Cloudflare (recommended) | Node |
|---|---|---|
| Code | `createRoomServer(game)` + `createWorker()` from `lobbyhop/cloudflare` | `createNodeServer(game, { static: 'dist' })` from `lobbyhop/node` |
| Config | `wrangler.jsonc` (template from `npx lobbyhop init`) | `PORT`, `PERSIST_DIR`, `STATIC_DIR` env vars |
| Rooms persist | Yes (Durable Object storage) | With `persistDir` |
| Scales | Automatically, one Durable Object per room, worldwide | One process. Shard by room code to go further. |
| Cost | Free plan covers hobby use | Your server |

Both serve your built game and the rooms from one origin, so production
clients need no `host` option. Step-by-step instructions are in
[DEPLOY.md](DEPLOY.md).

## Test it

### In-memory harness (unit tests, seconds)

```ts
import { createHarness } from 'lobbyhop/testing';

const h = createHarness(game, { clients: 3, latency: [20, 250] });
h.run(600);                    // hellos arrive, seats assigned
h.startGame();
h.run(60_000, (t) => {         // a minute of fake time
  if (t % 250 === 0) for (const c of h.clients) c.submit(randomCommand(h.rng, c.state, c.seat));
});
h.freeze();                    // stop the server clock; clients drain to it
h.assertInSync();              // throws with details on any mismatch
```

The harness also has:
- `h.disconnect(i)` and `h.reconnect(i)`;
- `h.addClient()`;
- `h.until(cond)`;
- `h.saves` (persistence) and `h.events[i]` (events each client saw);
- `h.serverState()`: the authoritative state, typed;
- `h.room` (the server).

It's framework-free, so it works with Vitest, Jest or `node:test`.

### Real browsers

```sh
npx lobbyhop e2e --url http://localhost:8787/ -n 3     # one Chromium per player; pauses, compares tick + hash
```

Your page must expose `window.lobbyhop = { room }`.

- **Lobby:** with the stock lobby (`mountLobby`) the runner clicks through the
  real UI. Otherwise it drives the room API (`setProfile`, `setReady`,
  `start`), so custom lobbies need no special markup. Force either with
  `--lobby ui|api`.
- **Checks:** lockstep runs pause and compare tick and hash. Turn-based state
  sync compares every client's view (unless the game has a per-seat `view`).
  Every run fails on page errors.
- **Driving your game:** pass `--script actions.mjs`, a module exporting
  `async act(page, playerIndex, round, ctx)`.
  - It's called for every player each round, about 200 ms apart. Rounds are
    synchronised, so one slow page slows everyone's round: schedule by game
    state, not round count.
  - `playerIndex` follows arrival order, so 0 is the host.
  - `ctx` is `{ out, room, url, players, pages, shot(page, name) }`; `shot`
    saves an extra screenshot into `--out`.
  - Read seat, turn and state inside `page.evaluate(() => window.lobbyhop.room…)`,
    then click or press keys with Playwright.
  - See `examples/arena/e2e-actions.mjs`.
- **Heavy 3D pages:** under software rendering, 3+ browsers can make
  screenshots slow. Screenshots that time out are skipped with a note, not
  fatal. Use `--viewport 800x500`, a lite mode in your game (a `?lite` query
  on `--url` is passed through), or `--no-screenshots`.

### Determinism across engines (lockstep)

```sh
npx lobbyhop determinism src/multiplayer/determinism.ts --require-all
```

Your scenario calls `recordHashes(game, {...})` from `lobbyhop/testing`.
Copy `examples/arena/determinism.ts` to start.

### A headless player

```sh
npx lobbyhop bot path/to/brain.ts --host localhost:8787 --room abc123 --start
```

## Hooks, drop-in rooms and late joiners

Hooks return a command that the server applies on a seat's behalf, with
`from.system === true`. In lockstep these travel in the turn stream, so every
client applies them on the same tick.

```ts
hooks: {
  join: (info) => ({ type: 'join', name: info.name }),  // someone arrived mid-game
  idle: (seat) => ({ type: 'bot', on: true }),          // disconnected for idleMs
  return: (seat) => ({ type: 'bot', on: false }),       // came back after idle fired
},
apply(state, cmd, from) {
  if (cmd.type === 'bot' && !from.system) return reject('Not allowed.');  // clients can't send system commands
  …
}
```

- **Late joiners:** with a `join` hook, people arriving mid-game take the
  lowest free seat. Without one, they spectate until the next game.
- **Drop-in rooms** (`lobby: false`): the room starts when the first person
  arrives, and everyone else joins live through `join`. When a seat goes idle,
  it's freed after `idle` fires, so a returning player joins afresh. Use this
  for shared spaces and persistent worlds. See `examples/cursors`.

## Server options

Pass these to `createRoomServer(game, options)` or
`createNodeServer(game, options)`:

| Option | Default | |
|---|---|---|
| `limits.inputsPerSecond` | 30 | Per connection, with a burst of twice that. Excess is rejected with "Slow down." |
| `limits.chatPerSecond` | 1 | Burst of 5. |
| `limits.maxMessageBytes` | 32768 | Larger messages are rejected. Connections are dropped after 20 malformed messages. |
| `emptyTtlMs` | 15 min | An empty room is deleted after this long. |
| `saveEveryMs` | 10 s | How often to persist while playing. Saves also happen on start, game over, lobby changes and when the last player leaves. |
| `chatHistory` | 50 | Chat lines kept for newcomers. |
| `origins` | any | Allowed page origins for WebSockets, e.g. `['https://mygame.com']`. |
| `debug` | false | Log room events. |

## Examples

| Example | Model | Shows |
|---|---|---|
| `examples/counter` | lockstep, 10 Hz | The smallest complete game (about 30 lines of rules); settings; game over |
| `examples/arena` | lockstep, 30 Hz | Real-time Canvas2D; interpolation; ghost walls; bots in the sim; idle takeover; e2e script; determinism scenario; bot brain |
| `examples/tictactoe` | state sync, turn-based | Optimistic moves; spectators; no game loop |
| `examples/cursors` | state sync, 20 Hz, no lobby | Drop-in and drop-out; snapshot interpolation; events |

```sh
npm run server arena              # build + wrangler dev on :8787
npm run server arena -- --node    # same with the Node adapter
npm run dev:example arena         # Vite HMR on :5173 (with `npm run server arena` running)
npx lobbyhop examples pull arena my-arena   # copy into your project
```

## Retrofitting an existing game

1. **Choose the model** ([CHOOSING.md](CHOOSING.md)). If the game already has
   a deterministic, fixed-tick simulation that takes commands, lockstep is
   natural.
2. **Lockstep only: audit determinism.** Run `npx lobbyhop audit src/sim` and
   fix the hits ([DETERMINISM.md](DETERMINISM.md)).
3. **Write the game definition** around your existing `createGame`,
   `applyCommand` and `step`. Remove any `player` field from commands: the
   server provides `from.seat`. If your command union already carries
   `player`:

   ```ts
   type WithoutPlayer<T> = T extends unknown ? Omit<T, 'player'> : never;  // distributes over the union
   type Intent = WithoutPlayer<Command>;
   // game.ts:  apply(state, cmd, from) => applyCommand(state, { ...cmd, player: from.seat } as Command)
   // client:   const { player: _, ...intent } = cmd; room.submit(intent);
   ```
4. **Add a harness test** that runs 3 clients with random commands and checks
   `assertInSync()`.
5. **Replace local stepping** with `room.advance(dt)`. Route input through
   `room.submit`, use `alpha` for interpolation, and disable speed controls
   and autosave when networked.
6. **Make the renderer data-driven** by the state's player count (with bots
   off, a 3-player room has 3 lanes, not 8). Reset caches on the `'snapshot'`
   event.
7. **Mount the lobby and status chip,** and expose `window.lobbyhop = { room }`.
8. **Add the Worker** (`npx lobbyhop init --host cloudflare`), run
   `wrangler dev`, then `npx lobbyhop e2e`.
9. **Deploy** ([DEPLOY.md](DEPLOY.md)).

Things that went wrong in real games, and their fixes, are in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
