# lobbyhop

**Agent-first multiplayer for browser games and experiences.** Share a link,
play together.

You write your game's rules as one small definition. lobbyhop provides:
- **Rooms:** lobby, share link, refresh-to-rejoin, host controls,
  spectators, chat.
- **Sync:** lockstep or authoritative state sync.
- **Hosting:** Cloudflare Durable Objects or Node.
- **Tests:** in-memory network harness, N-browser e2e, cross-engine
  determinism check.

The renderer is yours: WebGPU, WebGL, Canvas2D or DOM.

> **Using an AI coding agent?** Paste this:
>
> *Add online multiplayer to this game with lobbyhop
> (https://github.com/kellymilligan/lobbyhop). Follow its skill at
> `skills/lobbyhop/SKILL.md`.*

```ts
// game.ts: shared by browser and server
import { defineStateSync, ok, reject, presets } from 'lobbyhop';

export const game = defineStateSync<{ board: (string | null)[]; turn: number }, { cell: number }>({
  name: 'tictactoe',
  ...presets.turnBased,
  seats: { min: 2, max: 2 },
  create: () => ({ board: Array(9).fill(null), turn: 0 }),
  apply(s, cmd, from) {
    if (s.turn % 2 !== from.seat) return reject('Not your turn.');
    if (s.board[cmd.cell]) return reject('Taken.');
    s.board[cmd.cell] = from.seat ? 'O' : 'X';
    s.turn++;
    return ok();
  },
});
```

```ts
// main.ts: the browser
import { getRoomCode, joinRoom } from 'lobbyhop/client';
import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';

const room = joinRoom(game, { room: getRoomCode()! });  // ?room=k3m9xq is the share link
mountLobby(room, { title: 'Tic-tac-toe' });
mountStatus(room);
room.on('change', () => render(room.state));
cell.onclick = () => room.submit({ cell: i });
```

```ts
// worker.ts: Cloudflare (one Durable Object per room, plus your static build)
import { createRoomServer, createWorker } from 'lobbyhop/cloudflare';
export const Room = createRoomServer(game);
export default createWorker();
```

```sh
npx vite build && npx wrangler dev    # http://localhost:8787
```

## Why lobbyhop

- **Two proven sync models, one API:**
  - **lockstep:** only commands travel, so thousands of units cost nothing
    on the wire. For RTS, tower defence and sims.
  - **state sync:** the server is the only authority, and each player sees
    only their `view`. For turn-based, party, card, co-op and shared spaces.
  - Not sure which? [docs/CHOOSING.md](docs/CHOOSING.md) explains them in
    plain terms.
- **Rooms that just work:**
  - URL room codes; refresh rejoins your seat;
  - host transfer, settings, pause, rematch;
  - late joiners, spectators, bot takeover for idle seats;
  - chat and kick;
  - rooms persist across deploys.
- **Safe by default:**
  - the server stamps every command with the sender's seat and validates it;
  - rate limits, message size limits, origin allow-list.
- **Zero-dependency client and Cloudflare adapter.** `ws` is the only
  optional peer dependency (Node hosting).
- **Agent-first:**
  - docs ship in the package (`npx lobbyhop docs`);
  - `npx lobbyhop init` scaffolds;
  - `npx lobbyhop audit` finds determinism hazards;
  - `npx lobbyhop e2e` proves it in real browsers;
  - a skill file walks an agent through the whole integration.

## Docs

| | |
|---|---|
| [GUIDE.md](docs/GUIDE.md) | Concepts, game definition, client, hosting, testing, retrofitting |
| [CHOOSING.md](docs/CHOOSING.md) | Lockstep vs state sync, genres, tick rates, latency |
| [DETERMINISM.md](docs/DETERMINISM.md) | The lockstep contract, audit and cross-engine checks |
| [DEPLOY.md](docs/DEPLOY.md) | Cloudflare, Fly, Railway, Render, Docker, scaling, costs |
| [API.md](docs/API.md) | Every export |
| [PROTOCOL.md](docs/PROTOCOL.md) | Wire messages and semantics |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms and fixes, pitfalls already hit |
| [ROADMAP.md](docs/ROADMAP.md) | Replays, matchmaking, accounts, anti-cheat, voice, prediction, rollback |
| [skills/lobbyhop/SKILL.md](skills/lobbyhop/SKILL.md) | The step-by-step integration recipe for agents |

## Examples

| | |
|---|---|
| [`counter`](examples/counter) | The smallest complete game: lockstep, about 30 lines of rules |
| [`arena`](examples/arena) | Real-time lockstep on Canvas2D: interpolation, ghost walls, bots, idle takeover |
| [`tictactoe`](examples/tictactoe) | Turn-based state sync with optimistic moves and spectators |
| [`cursors`](examples/cursors) | Lobby-less real-time state sync: drop in, drop out |

```sh
git clone https://github.com/kellymilligan/lobbyhop && cd lobbyhop && npm install
npm run server arena            # build + wrangler dev → http://localhost:8787
npm run server arena -- --node  # or the Node adapter
```

Open the link in two windows (or send it to a friend on your network).

## Install

```sh
npm i lobbyhop                                  # once published
npm i github:kellymilligan/lobbyhop             # until then (builds on install)
```

To use it without a dependency, copy `src/` into your project. It's plain
TypeScript with no runtime dependencies.

## Status

v0.1. The core was extracted from a shipped multiplayer game (Siegeline, a
Line Tower Wars homage) and generalised. Every release is checked by:
- 47 tests (`npm test`);
- real-browser e2e on both Cloudflare (workerd) and Node;
- cross-engine determinism in CI.

See [ROADMAP.md](docs/ROADMAP.md) for what's next.

MIT licensed.
