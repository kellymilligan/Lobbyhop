# API reference

Every export, by entry point. The source is in `src/`, and every export has a
doc comment.

## `lobbyhop`

Shared by client and server.

| Export | |
|---|---|
| `defineLockstep<S, C, Settings, E>(def)` | Lockstep game definition ([GUIDE](GUIDE.md#define-your-game)). Optional `canStart(seats, settings) → reason \| null` adds a start rule. |
| `defineStateSync<S, C, Settings, E, View>(def)` | State-sync game definition. |
| `ok(events?)`, `reject(reason)` | Return values for `apply`. |
| `startBlocker(game, seats, settings)` | The shared start check (`seats.min`, then `canStart`). |
| `presets` | `turnBased`, `casual`, `realtime`, `strategy`, `action` ([CHOOSING](CHOOSING.md)). |
| `DEFAULT_PALETTE` | Eight lobby colours. |
| `PROTOCOL_VERSION` and types `ClientMsg`, `ServerMsg`, `MemberView`, `ChatLine`, `RoomPhase`, `StampedCommand` | Wire protocol ([PROTOCOL](PROTOCOL.md)). |
| Types `LockstepGame`, `StateSyncGame`, `AnyGame`, `SeatInfo`, `Setup`, `Origin`, `ApplyResult`, `GameHooks`, `Json` | |
| Types `StateOf<G>`, `CommandOf<G>`, `SettingsOf<G>`, `EventOf<G>` | Pull types back out of a definition. |

## `lobbyhop/client`

| Export | |
|---|---|
| `joinRoom(game, { room, host?, prefix?, profile?, profileKey?, pingMs?, pendingTimeoutMs?, simulateLatency?, WebSocket? })` | Connects with auto-reconnect. Returns a `JoinedRoom<G>`: a `RoomClient` plus `leave()`, `url` and `setSimulatedLatency(ms \| [min, max])` (dev aid). Type stored rooms as `JoinedRoom<typeof game>` to keep `leave()`. |
| `RoomClient` | Transport-free session (used by `joinRoom`, the harness and bots). Fields and methods are below. |
| `getRoomCode({ param?, create?, length? })` | The `?room=` code from the URL, or a new one written into the URL with `history.replaceState`. |
| `roomFromUrl(param?)`, `setRoomInUrl(code \| null, param?)`, `shareLink(code, param?)`, `newRoomCode(length?)`, `cleanRoomCode(s)` | URL helpers. |
| `loadProfile(key?, defaults?)`, `saveProfile(key, profile)` | `{ token, name, colour, meta }` in localStorage. |
| `tabToken(profileToken, room, scope?) → { token, release }` | Used by `joinRoom`: one live tab per room claims the browser's token, other tabs get their own. A refresh keeps yours. |
| `roomUrl(room, host?, prefix?)` | The WebSocket URL a room uses. |

### `RoomClient`

**Fields:**
- connection and identity: `status`, `error`, `seat`, `host`, `me`;
- room: `phase`, `members`, `spectators`, `paused`, `settings`, `chat`,
  `rtt`;
- game: `state`, `prev`, `tick`, `frontier`, `pending`, `snapshots`,
  `desyncs`, `profile`;
- config: `game` (the definition), `rules` (resolved: `max`, `min`,
  `palette`, `tickRate`, `turnMs`, `hashEvery`, `sendRate`, `lobby`,
  `version`);
- getters: `connected`, `spectating`, `ready` (you), `allReady`, `notReady` (connected non-host players who aren't ready), `startBlocker` (why the host can't start, or null).

**Methods:**

| Method | |
|---|---|
| `advance(dtSeconds) → { state, prev, alpha, events }` | Call every frame. |
| `submit(cmd) → id \| null` | Send intent. |
| `setProfile({ name?, colour?, meta? })` | |
| `say(text)` | |
| `setReady(bool)` | Ready-up, in the lobby or at game over. Soft: never blocks `start()`. |
| `start()`, `setSettings(partial)`, `setPaused(bool)`, `toLobby()`, `kick(seat)` | Host only. |
| `on(event, fn) → unsubscribe` | Events: `change`, `notice`, `reject`, `chat`, `snapshot`, `phase`. |
| `opened()`, `closed(willRetry)`, `receive(msg)`, `ping()` | Transport hooks, for custom transports. |

## `lobbyhop/lobby-ui`

| Export | |
|---|---|
| `mountLobby(room, { title?, subtitle?, settings?, emptySeat?, colours?, chat?, ready?, showOver?, overPlacement?, overText?, onLeave?, param?, code?, labels?, container? }) → { el, destroy }` | The lobby overlay. |
| `mountStatus(room, { pause?, param?, container? }) → { el, destroy }` | The in-game chip. |
| Types `SettingField` (`toggle` \| `number` \| `select`), `LobbyLabels`, `LobbyOptions` | |

## `lobbyhop/cloudflare`

| Export | |
|---|---|
| `createRoomServer(game, options?)` | The Durable Object class. Export it under `class_name`. Options are the [server options](GUIDE.md#server-options). |
| `createWorker({ binding?, assets?, prefix? })` | A Worker `{ fetch }`: rooms under the prefix, assets for everything else. |
| `routeRooms(request, namespace, { prefix? }) → Promise<Response> \| null` | For custom Workers. |

## `lobbyhop/node`

| Export | |
|---|---|
| `createNodeServer(game, { port?, hostname?, prefix?, static?, persistDir?, origins?, maxConnections?, ...serverOptions })` | Returns `{ http, rooms, listen(port?), close(), handleUpgrade(req, socket, head) }`. Needs `npm i ws`. |

## `lobbyhop/server`

| Export | |
|---|---|
| `RoomCore(game, io, options?)` | The platform-free room. Adapters call `onConnect`, `onMessage`, `onClose`, `pump`, `alarm`, `restore`, `serialize`. `room.state` is the authoritative game state (typed). |
| Types `RoomIO` (`send`, `close`, `setClock`, `now`, `seed?`, `save?`, `schedule?`, `log?`), `RoomOptions`, `RoomLimits`, `RoomSave` | |
| `LockstepEngine`, `StateSyncEngine` | The sync engines (used by `RoomCore`). |

## `lobbyhop/testing`

| Export | |
|---|---|
| `createHarness(game, { clients?, seed?, latency?, stepMs?, room?, persist? })` | A room, clients and a fake network in memory ([GUIDE](GUIDE.md#test-it)). `h.serverState()` gives the authoritative state, typed. |
| `recordHashes(game, { seed, ticks, seats?, settings?, hashEvery?, input?, roundTripAt? }) → number[]` | Headless scripted lockstep run, for cross-engine checks. `seats` is a count (default 2: seats 0..n-1, as a room seats them) or explicit seat numbers. `input(tick, rng, state)` gets your typed state. |

## `lobbyhop/det`

| Export | |
|---|---|
| `seedRng(seed: string \| number) → Rng` | Seeded sfc32. `Rng` is a 4-number tuple; store it in your state. |
| `nextU32(rng)` | Integer in [0, 2³²). |
| `nextFloat(rng)` | Float in [0, 1). |
| `nextInt(rng, n)` | Integer in [0, n). |
| `nextRange(rng, min, max)` | Float in [min, max). |
| `pick(rng, items)` | A random element. |
| `shuffle(rng, items)` | Fisher–Yates, in place; returns `items`. |
| `pickWeighted(rng, weights)` | An index, chosen by weight. |
| `sin(x)`, `cos(x)` | Error < 1e-6. |
| `atan2(y, x)` | Result in [-π, π]. |
| `wrapAngle(a)` | Wraps to [-π, π]. |
| `powi(base, intExp)` | Exact integer power. |
| `length(x, y)` | `Math.sqrt(x*x + y*y)`. |
| `quantise(x, step = 1/1024)` | Rounds to a step. |
| `PI`, `TAU` | |
| `hashString(str)`, `stateHash(state)` | FNV-1a. `stateHash` hashes the JSON of the state. |
| `assertJsonSafe(state)` | Throws on values JSON would mangle. |
| `AUDIT_PATTERNS` | What `lobbyhop audit` looks for. |

## CLI: `npx lobbyhop`

`docs [ls|cat|find]` · `skill` · `init` · `examples [pull]` · `audit` ·
`e2e` · `determinism` · `bot`. Run `npx lobbyhop help` for the options.

- `e2e` options: `--url`, `-n`, `--seconds`, `--script` (`act(page, i, round, ctx)`), `--lobby ui|api`, `--viewport WxH`, `--no-screenshots`, `--out`.
- `bot` options: `--host`, `--room`, `--name`, `--start`, `--count`, `--status <s>`.
- These tools use `esbuild` and `playwright` from your project (optional peer dependencies): `npm i -D esbuild playwright`.
