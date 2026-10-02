# Deploy

You can deploy to Cloudflare or to a Node host. Both serve your built game
and its rooms from one origin, so the client needs no configuration in
production.

## Cloudflare (recommended)

Each room is a **Durable Object**: a tiny stateful server created on first
connect, placed near the first player, with its own storage.

- One Worker serves your static build and routes `/rooms/<code>` to the
  room's object.
- SQLite-backed Durable Objects are included in the **Workers Free plan**.

### First deploy

```sh
npm i lobbyhop && npm i -D wrangler
npx lobbyhop init --host cloudflare        # creates worker.ts + wrangler.jsonc
npx wrangler login                         # one-time, opens a browser
npx vite build                             # or your build; output must match assets.directory (./dist)
npx wrangler deploy                        # → https://<name>.<your-subdomain>.workers.dev
```

Add a script so builds and deploys stay together:

```json
"scripts": {
  "deploy": "vite build && wrangler deploy",
  "server": "vite build && wrangler dev --port 8787"
}
```

### Local development

- **Option A, one origin:** `npm run server` and open
  `http://localhost:8787`. This is the real Worker and Durable Objects on
  `workerd`.
- **Option B, Vite with hot reload:**
  - run `npm run server` (rooms on :8787) and `npx vite` (game on :5173)
    side by side;
  - `.env.development` sets `VITE_ROOM_HOST=localhost:8787`;
  - pass `host: import.meta.env.VITE_ROOM_HOST` to `joinRoom`. It's
    undefined in production builds, which means same origin.

### `wrangler.jsonc` explained

```jsonc
{
  "name": "my-game",                         // → my-game.<subdomain>.workers.dev
  "main": "worker.ts",
  "compatibility_date": "2025-09-01",
  "assets": {
    "directory": "./dist",                   // your built game
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/rooms/*"]         // room sockets always reach the Worker
  },
  "durable_objects": { "bindings": [{ "name": "Room", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]
}
```

- **`class_name`** must match the export in `worker.ts`:
  `export const Room = createRoomServer(game)`.
- **Migrations** are permanent. To rename or add a class, add a new tag
  (`v2`); never edit `v1` after deploying it.
- **Several games in one Worker:**
  - export a class per game and add a binding per class;
  - route each with `routeRooms(request, env.OtherRoom, { prefix: '/other' })`;
  - pass `prefix: '/other'` to `joinRoom` too.

### Custom domain

In the Cloudflare dashboard, go to Workers & Pages → your Worker → Settings
→ Domains & Routes → Add custom domain. WebSockets work on custom domains
with no extra setup.

### Costs and limits (check Cloudflare's current pricing)

- **Free plan:**
  - Durable Objects with SQLite storage are included, with daily limits on
    requests, duration and storage. A hobby game with a few concurrent rooms
    fits comfortably.
  - Each WebSocket message counts towards requests, at a discounted ratio.
- **Duration:** a room accrues duration while players are connected. The
  clock only runs while a game is in progress with someone connected.
- **Storage:** rooms save at most every `saveEveryMs` (10 s) while playing,
  plus on start, game over and lobby changes.
  - Large states are chunked into ~96 KB values.
  - Raise `saveEveryMs` for very large states.
- **Cleanup:** empty rooms delete their storage after `emptyTtlMs` (15 min)
  via a Durable Object alarm.

### Hardening for public games

- Set `origins: ['https://your.domain']` in `createRoomServer(game, { origins })`.
  Other sites then can't open sockets to your rooms.
- Room codes are 6 characters from a 31-character alphabet (about 887
  million combinations). That's unguessable for casual play. Use
  `newRoomCode(10)` for more.
- Rate limits are on by default (30 inputs per second, 32 KB messages).
  Tune `limits` if your game needs more.

## Node (Fly.io, Railway, Render, a VPS, Docker)

```sh
npm i lobbyhop ws
npx lobbyhop init --host node      # creates server.ts, Dockerfile, fly.toml
```

`server.ts`:

```ts
import { createNodeServer } from 'lobbyhop/node';
import { game } from './src/multiplayer/game';

const server = createNodeServer(game, { static: 'dist', persistDir: process.env.PERSIST_DIR });
await server.listen(); // $PORT or 8787
```

Run it locally with `npx tsx server.ts`, or bundle it: `npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=server.mjs`.

### Fly.io

```sh
fly launch --copy-config --no-deploy      # uses the generated fly.toml + Dockerfile
fly volumes create rooms --size 1         # persistent rooms across deploys
fly deploy
```

`fly.toml` keeps one machine always on (`auto_stop_machines = "off"`),
because rooms live in that process's memory.

### Railway or Render

- Point them at the repo with the Dockerfile.
- Set `PERSIST_DIR` to a mounted volume path.
- Both support WebSockets on their standard web services.

### Behind your own server (Express, Fastify)

```ts
const rooms = createNodeServer(game);           // don't listen
httpServer.on('upgrade', (req, socket, head) => {
  if (!rooms.handleUpgrade(req, socket, head)) socket.destroy();
});
```

### Scaling Node past one machine

All players in a room must reach the same process. Options:

- **One machine.** A modest VM handles hundreds of concurrent rooms for
  turn-based or lockstep games, because the traffic is tiny.
- **Shard by room code.**
  - Run N instances.
  - Have a proxy (nginx `hash $arg_room consistent`, or Fly's `fly-replay`
    header) send `/rooms/<code>` to `hash(code) % N`.
- **Or use Cloudflare,** which does this for you: one Durable Object per
  room, anywhere in the world.

## Verify a deployment

```sh
npx lobbyhop bot path/to/brain.ts --host my-game.example.workers.dev --room test1 --start
```

Then open `https://my-game.example.workers.dev/?room=test1` and play against
the bot.

## Cloud sandbox notes (for agents)

- `wrangler dev` works in sandboxes. It may print an update-check stack trace
  at startup; that's harmless.
- **Deploying needs the owner's Cloudflare account.** An agent can't run
  `wrangler login`; hand over the deploy command.
- Egress proxies may block `*.workers.dev`. Add it to the environment's
  allowed hosts to test a deployment from a sandbox.
- Node's built-in WebSocket ignores `HTTPS_PROXY`. Run bots with
  `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle>`.
- Don't kill processes by pattern (`pkill -f wrangler`). The pattern can
  match your own shell's command line. Kill the PIDs you started.
