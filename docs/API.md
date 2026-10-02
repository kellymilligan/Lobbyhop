# API reference

Every export, by entry point. The source is in `src/`, and every export has a
doc comment.

## `lobbyhop`

Shared by client and server.

| Export | |
|---|---|
| `defineLockstep<S, C, Settings, E>(def)` | Lockstep game definition ([GUIDE](GUIDE.md#define-your-game)). |
| `defineStateSync<S, C, Settings, E, View>(def)` | State-sync game definition. |
| `ok(events?)`, `reject(reason)` | Return values for `apply`. |
| `presets` | `turnBased`, `casual`, `realtime`, `strategy`, `action` ([CHOOSING](CHOOSING.md)). |
| `DEFAULT_PALETTE` | Eight lobby colours. |
| `PROTOCOL_VERSION` and types `ClientMsg`, `ServerMsg`, `MemberView`, `ChatLine`, `RoomPhase`, `StampedCommand` | Wire protocol ([PROTOCOL](PROTOCOL.md)). |
| Types `LockstepGame`, `StateSyncGame`, `AnyGame`, `SeatInfo`, `Setup`, `Origin`, `ApplyResult`, `GameHooks`, `Json` | |
| Types `StateOf<G>`, `CommandOf<G>`, `SettingsOf<G>`, `EventOf<G>` | Pull types back out of a definition. |

## `lobbyhop/client`

| Export | |
|---|---|
| `joinRoom(game, { room, host?, prefix?, profile?, profileKey?, pingMs?, pendingTimeoutMs?, WebSocket? })` | Connects with auto-reconnect. Returns a `RoomClient` with `leave()` and `url`. |
| `RoomClient` | Transport-free session (used by `joinRoom`, the harness and bots). Fields and methods are below. |
| `getRoomCode({ param?, create?, length? })` | The `?room=` code from the URL, or a new one written into the URL with `history.replaceState`. |
| `roomFromUrl(param?)`, `setRoomInUrl(code \| null, param?)`, `shareLink(code, param?)`, `newRoomCode(length?)`, `cleanRoomCode(s)` | URL helpers. |
| `loadProfile(key?, defaults?)`, `saveProfile(key, profile)` | `{ token, name, colour, meta }` in localStorage. |
| `roomUrl(room, host?, prefix?)` | The WebSocket URL a room uses. |

### `RoomClient`

**Fields:**
- connection and identity: `status`, `error`, `seat`, `host`, `me`;
- room: `phase`, `members`, `spectators`, `paused`, `settings`, `chat`,
  `rtt`;
- game: `state`, `prev`, `tick`, `frontier`, `pending`, `snapshots`,
  `desyncs`, `rules`, `profile`;
- getters: `connected`, `spectating`.

**Methods:**

| Method | |
|---|---|
| `advance(dtSeconds) → { state, prev, alpha, events }` | Call every frame. |
| `submit(cmd) → id \| null` | Send intent. |
| `setProfile({ name?, colour?, meta? })` | |
| `say(text)` | |
| `start()`, `setSettings(partial)`, `setPaused(bool)`, `toLobby()`, `kick(seat)` | Host only. |
| `on(event, fn) → unsubscribe` | Events: `change`, `notice`, `reject`, `chat`, `snapshot`, `phase`. |
| `opened()`, `closed(willRetry)`, `receive(msg)`, `ping()` | Transport hooks, for custom transports. |

## `lobbyhop/lobby-ui`

| Export | |
|---|---|
| `mountLobby(room, { title?, subtitle?, settings?, emptySeat?, colours?, chat?, showOver?, overText?, onLeave?, param?, code?, labels?, container? }) → { el, destroy }` | The lobby overlay. |
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
| `RoomCore(game, io, options?)` | The platform-free room. Adapters call `onConnect`, `onMessage`, `onClose`, `pump`, `alarm`, `restore`, `serialize`. |
| Types `RoomIO` (`send`, `close`, `setClock`, `now`, `seed?`, `save?`, `schedule?`, `log?`), `RoomOptions`, `RoomLimits`, `RoomSave` | |
| `LockstepEngine`, `StateSyncEngine` | The sync engines (used by `RoomCore`). |

## `lobbyhop/testing`

| Export | |
|---|---|
| `createHarness(game, { clients?, seed?, latency?, stepMs?, room?, persist? })` | A room, clients and a fake network in memory ([GUIDE](GUIDE.md#test-it)). |
| `recordHashes(game, { seed, ticks, seats?, settings?, hashEvery?, input?, roundTripAt? }) → number[]` | Headless scripted lockstep run, for cross-engine checks. |

## `lobbyhop/det`

| Export | |
|---|---|
| `seedRng(seed) → Rng`, `nextU32`, `nextFloat`, `nextInt`, `nextRange`, `pick`, `shuffle`, `pickWeighted` | Seeded sfc32. `Rng` is a 4-number tuple stored in your state. |
| `sin`, `cos`, `atan2`, `wrapAngle`, `powi`, `length`, `quantise`, `PI`, `TAU` | Deterministic maths. |
| `hashString`, `stateHash` | FNV-1a. |
| `assertJsonSafe(state)` | Throws on values JSON would mangle. |
| `AUDIT_PATTERNS` | What `lobbyhop audit` looks for. |

## CLI: `npx lobbyhop`

`docs [ls|cat|find]` · `skill` · `init` · `examples [pull]` · `audit` ·
`e2e` · `determinism` · `bot`. Run `npx lobbyhop help` for the options.
