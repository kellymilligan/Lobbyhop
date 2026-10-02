# CLAUDE.md

lobbyhop is an agent-first multiplayer kit for browser games. It was
extracted from Siegeline (`kellymilligan/webgpu-linetowerwars`), whose
server-clocked lockstep was proven in a live deploy, and generalised: an
authoritative state-sync model was added, plus Cloudflare and Node hosting,
a lobby UI, a test harness and agent tooling.

**Agents integrating lobbyhop elsewhere use `skills/lobbyhop/SKILL.md`.**
This file is for working on the kit itself.

## Layout

| Path | |
|---|---|
| `src/shared` | Game definition types (`game.ts`) and wire protocol (`protocol.ts`). Exported from `lobbyhop`. |
| `src/server` | `RoomCore` (lobby, seats, host, limits, persistence, hooks), plus `LockstepEngine` and `StateSyncEngine`. Platform-free. |
| `src/client` | `RoomClient` (transport-free session), `joinRoom` (reconnecting WebSocket), URL and profile helpers. |
| `src/cloudflare` | Raw Durable Object adapter (no partyserver) and Worker router. |
| `src/node` | `ws` adapter with static serving and file persistence. |
| `src/testing` | `createHarness` (fake clock, jittery ordered network) and `recordHashes`. |
| `src/det` | Seeded RNG, deterministic maths, hashing, JSON checks, audit patterns. |
| `src/lobby-ui` | Framework-free lobby overlay and status chip. |
| `examples/*` | Real games. Each has `game.ts`, `main.ts`, `index.html`, `worker.ts`, `server.ts` and `wrangler.jsonc`. They import `lobbyhop/*`, which is aliased to `src/` in this repo. |
| `tools/` | `server.mjs`, `dev-example.mjs`, `e2e.mjs`, `determinism.mjs`, `bot.mjs`. |
| `bin/lobbyhop.mjs` | CLI. |
| `templates/` | Files `lobbyhop init` scaffolds. |
| `docs/`, `skills/` | Shipped in the package and readable via `npx lobbyhop docs`. Keep them in sync with the code. |

## Commands

```sh
npm test                    # vitest: core, harness, adapters, examples (~5 s)
npm run typecheck           # src + tests + examples
npm run build               # tsc → dist/
npm run server <example> [-- --node]   # build + serve an example on :8787
npm run dev:example <example>          # Vite HMR on :5173 (rooms via npm run server)
node tools/e2e.mjs --example arena [-n 3] [--node] [--script examples/arena/e2e-actions.mjs]
node tools/determinism.mjs examples/arena/determinism.ts [--require-all]
node bin/lobbyhop.mjs help
```

## Conventions

- TypeScript, ESM, NodeNext resolution: relative imports in `src/` end in
  `.js`.
- No runtime dependencies in `src/` except the optional `ws` peer
  (`src/node`, imported lazily).
- **Behaviour changes need a harness test.** Protocol changes bump
  `PROTOCOL_VERSION` and update `docs/PROTOCOL.md`.
- **Every public API change updates `docs/API.md`, `docs/GUIDE.md` and the
  skill, if affected.** Agents rely on the docs being exact.
- Comment density: a doc comment on each export, and short "why" comments
  in tricky code.

## Verify before reporting

- Typecheck, tests and build.
- For anything touching transport, adapters or UI, run e2e on wrangler and
  on Node, and look at the screenshots.
- Lockstep engine changes: run `tools/determinism.mjs`. Firefox and WebKit
  only run in CI; say so when reporting.
- Start background servers with `setsid … & echo $! > pid`, and stop them
  with `kill -- -$(cat pid)`. A bare `npx … &` PID is npx, not the server.
  **Never kill by pattern:** `pkill -f wrangler` has killed the agent's own
  shell, because a commit message contained the word.

## How Kelly likes to work

- **Research first, then explain, then build.** Ask a few focused questions,
  each with a recommendation. Once Kelly says "proceed", build without
  further check-ins.
- **Ship something working early,** then iterate in meaningful commits. Push
  when a chunk is done. No PRs unless asked.
- **Verify before reporting:**
  - typecheck, tests and build;
  - real runs (headless e2e, screenshots where visual);
  - send screenshots with short captions.
- **Report honestly:**
  - say what was verified and what wasn't;
  - separate sandbox artefacts from real bugs;
  - flag guesses as guesses.
- **Keep summaries short:** what changed, how to try it, known gaps, next
  steps.
- **Kelly is learning multiplayer alongside the project.** Explain trade-offs
  and recommend best practice; `docs/CHOOSING.md` and `docs/ROADMAP.md` are
  where that knowledge lives.
- **Taste:**
  - frosted-glass panels, restrained type, world-anchored UI where possible;
  - TypeScript, Vite, Vitest, three.js `WebGPURenderer` with a WebGL 2
    fallback, Preact;
  - a deterministic sim kept separate from rendering.
