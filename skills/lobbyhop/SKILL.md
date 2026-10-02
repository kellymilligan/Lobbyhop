---
name: lobbyhop
description: >-
  Add online multiplayer (share-a-link rooms, lobby, reconnect, lockstep or
  state sync) to a browser game or interactive experience with the lobbyhop
  package, hosted on Cloudflare Durable Objects or Node. Use when asked to make
  a web game multiplayer, add rooms or a lobby, sync players, or deploy a game
  server.
---

# Add multiplayer with lobbyhop

lobbyhop is built to be operated by agents. Follow these steps in order. The
docs ship inside the package: `npx lobbyhop docs ls`, `npx lobbyhop docs cat
<name>`, `npx lobbyhop docs find <term>`. They are authoritative for the
installed version, so read them rather than guessing APIs.

## 0. Install and orient

```sh
npm i lobbyhop                       # not yet on npm? npm i github:kellymilligan/lobbyhop
npx lobbyhop docs cat GUIDE.md       # read once, fully
```

Explore the target project first:
- What renders: WebGPU, WebGL, Canvas2D or DOM?
- Where does game state live, and how does input change it?
- Is there a fixed-tick simulation?
- Is there a build step (Vite or otherwise)?

## 1. Choose the sync model (ask the user if it's unclear)

Read `npx lobbyhop docs cat CHOOSING.md`.

| Choose | When |
|---|---|
| **State sync** (`defineStateSync`) | The default. Turn-based, party, card and board games, co-op, shared spaces, anything with hidden information, or when the sim isn't deterministic. |
| **Lockstep** (`defineLockstep`) | Many moving units (RTS, tower defence, sims) and a sim that is, or can be made, deterministic. The project already has `createGame` / `applyCommand` / `step` style code. |
| **Neither yet** | Competitive twitch PvP (shooters, fighters). Tell the user: prediction and rollback are on the roadmap; offer state sync with client-authoritative movement as a stopgap. |

Then choose hosting: Cloudflare (the default; free tier; one Durable Object
per room) or Node (an existing server, Fly, Railway, a VPS).

## 2. Lockstep only: audit determinism

```sh
npx lobbyhop audit <sim dir>
```

Fix each real hit (`npx lobbyhop docs cat DETERMINISM.md`):
- **Randomness:** `seedRng`/`nextFloat` with RNG state stored in the game
  state.
- **Maths:** `sin`/`cos`/`atan2`/`powi` from `lobbyhop/det`.
- **Clocks:** no `Date` or `performance.now()`; count ticks.
- **Sorting:** pass explicit total comparators.
- **State:** plain JSON only.

## 3. Write the game definition

Scaffold with:

```sh
npx lobbyhop init --mode <lockstep|statesync> --host <cloudflare|node|both> --game src/multiplayer/game.ts
```

It creates the definition, `worker.ts` + `wrangler.jsonc` (or `server.ts`),
and `.env.development`. It never overwrites existing files.

Fill in `src/multiplayer/game.ts`:
- **`name`**, and **`version`** (bump it on shape changes).
- **`tickRate`** (or spread a preset).
- **`seats`**: `{ min, max, palette? }`.
- **`settings`**: `{ defaults, validate }`, for host options such as bots or
  length.
- **`create({ seed, seats, settings })`**: state keyed by `seat`; bots fill
  seats without humans if the game has them.
- **`apply(state, cmd, from)`**:
  - validate *everything* (it's untrusted client input) and mutate;
  - return `ok(events)` or `reject('reason')`;
  - use `from.seat`, never a player field in the command.
- **`step(state)`** for real-time games.
- **`view(state, seat)`** (state sync) to hide secrets.
- **`isOver(state)`**.
- **`hooks`**: `idle` to hand a disconnected seat to a bot; `join` for late
  joiners or `lobby: false` drop-in rooms. Reject `from.system`-only
  commands from clients.

If the project already has a sim, **wrap it; don't rewrite it.** Call the
existing functions from `create`, `apply` and `step`.

## 4. Add a harness test

Add this before touching the UI:

```ts
import { createHarness } from 'lobbyhop/testing';
import { game } from '../src/multiplayer/game';

test('players stay in sync', () => {
  const h = createHarness(game, { clients: 3 });
  h.run(600);
  h.startGame();
  h.run(60_000, (t) => {
    if (t % 250 === 0) for (const c of h.clients) c.submit(randomCommand(h.rng, c.state, c.seat));
  });
  h.freeze();
  h.assertInSync();
});
```

Also test:
- a reconnect (`h.disconnect(i)`, `h.reconnect(i)`);
- the rejection paths you care about.

For lockstep, add a cross-engine scenario as well (copy
`examples/arena/determinism.ts`, run `npx lobbyhop determinism <file>`).

## 5. Wire up the client

```ts
import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';

const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });
mountLobby(room, { title: 'My Game', settings: [/* toggle | number | select fields matching settings keys */] });
mountStatus(room);
(window as any).lobbyhop = { room };   // for e2e tests and debugging
```

### The game loop

Replace local stepping with `room.advance(dt)`:

```ts
const { state, prev, alpha, events } = room.advance(dtSeconds);
```

- Render `state`, interpolating with `alpha`.
  - Lockstep: keep `px, py` in state and draw `lerp(px, x, alpha)`.
  - State sync: draw `lerp(prev.x, state.x, alpha)`.
- Play `events` (sounds, effects).
- `state` is null in the lobby.

### Input

- Route all state-changing input through `room.submit(cmd)`.
- Send **intent, on change only**: a held key is one command when it
  changes. Never send every frame.
- Draw `room.pending` as optimistic ghosts.

### Remove single-player affordances when networked

- speed controls;
- autosave and resume;
- debug or autoplay hooks that mutate state;
- "new game" buttons that bypass the room.

### Presentation

- Names and colours come from `room.members`.
- Lay out by the state's player count, not the max.
- Reset caches on `room.on('snapshot')`.

Keep a single-player mode if the game had one. A common pattern: no
`?room=` in the URL means local play, and a "Multiplayer" button calls
`getRoomCode()` and reloads.

## 6. Run it

**Cloudflare:** add scripts:

```json
"server": "vite build && wrangler dev --port 8787",
"deploy": "vite build && wrangler deploy"
```

Then `npm run server` and open `http://localhost:8787/?room=test`. For hot
reload, also run `npx vite`; `.env.development` points the socket at :8787.

**Node:** build, then `npx tsx server.ts` (it serves `dist/` and rooms on
:8787).

## 7. Verify (don't skip)

1. Typecheck, unit tests and the harness test.
2. Real browsers: `npx lobbyhop e2e --url http://localhost:8787/ -n 2`. Two
   Chromium processes join through the lobby, play, pause, and compare
   tick and hash (lockstep). Pass `--script actions.mjs` to drive real input
   (see `examples/arena/e2e-actions.mjs`). Look at the screenshots in
   `out/e2e`.
3. Lockstep: `npx lobbyhop determinism <scenario>`. In CI, use
   `--require-all` with Firefox and WebKit installed.
4. Optional: `npx lobbyhop bot <brain.ts> --host localhost:8787 --room test --start`
   to play against a headless client.

Report honestly:
- what you verified, and how;
- what you couldn't verify (for example, Firefox and WebKit locally);
- sandbox artefacts, kept separate from real bugs.

## 8. Deploy (needs the user's account)

Read `npx lobbyhop docs cat DEPLOY.md`.
- **Cloudflare:** `npx wrangler login` (the user does this; agents can't),
  then `npm run deploy`.
- **Node:** the Dockerfile and fly.toml from `init`.

Hand over the exact commands. Suggest `origins: ['https://their.domain']` for
public games.

## Pitfalls (each was hit in a real game)

- **Never gate `room.advance` on `paused`.** The server stops turns and
  clients drain to the same tick.
- **Find the host in tests** (`h.host()`). Don't assume seat 0: arrival order
  decides.
- **Debug or autoplay hooks that mutate local state desync lockstep rooms.**
- **Caches keyed by the pre-game placeholder state go stale.** Use the
  `'snapshot'` event.
- **Don't kill processes by pattern.** `pkill -f wrangler` can match your own
  shell. Kill the PIDs you started.
- **Use one browser process per player** in headless e2e, with
  `waitUntil: 'domcontentloaded'`.
- **Node's WebSocket behind a proxy** needs
  `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<bundle>`.

More: `npx lobbyhop docs cat TROUBLESHOOTING.md`. API:
`npx lobbyhop docs cat API.md`. Examples: `npx lobbyhop examples`, and
`npx lobbyhop examples pull arena`.
