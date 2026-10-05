# Blocks: a persistent shared world

100 blocks start in a pile inside an invisible container. Anyone who opens
the page can carry, turn and stack them, and the world stays exactly as the
last visitor left it, forever.

- **Physics:** [Box3D](https://github.com/erincatto/box3d), compiled to
  WebAssembly. It runs only on the server, inside the Durable Object.
- **Rendering:** three.js `WebGPURenderer`, falling back to WebGL 2.
- **Sync:** lobbyhop state sync with `delta: true`. Only moving blocks travel,
  and a resting world sends nothing.
- **Persistence:** `emptyTtlMs: null` keeps the room forever. It saves every
  2 s while people are building, and restores exactly after deploys,
  restarts and eviction.

## Run it

```sh
npm run server blocks            # from the lobbyhop repo: build + wrangler dev → http://localhost:8787
npm run server blocks -- --node  # or the Node adapter (saves to .rooms/)
```

Everyone joins the room `world`. Add `?room=test` for a private sandbox.

## Files

| | |
|---|---|
| `game.ts` | The world: state, commands (grab, drag, turn, release, aim), physics step, view. Shared by page and server. |
| `main.ts`, `index.html` | three.js scene, interpolation, ghost dragging with auto-lift, other visitors' cursors. |
| `worker.ts`, `wrangler.jsonc` | Cloudflare: injects the wasm, `emptyTtlMs: null`, `saveEveryMs: 2000`. |
| `server.ts` | The same world on Node. |
| `physics/boxworld.c` | A flat C API over Box3D (create boxes, step, read transforms, drag). |
| `physics/build.sh` | Rebuilds `box3d.wasm` from a pinned Box3D commit (needs the Emscripten SDK). |
| `physics/box3d.wasm` | Prebuilt, so you don't need Emscripten to run the example. |
| `physics/box3d.ts` | TypeScript wrapper. The compiled module is injected (Workers import `.wasm`; Node reads bytes). |

## Deploy

- **From your machine:** `npx wrangler login`, then `npm run deploy:blocks`.
- **Automatically:** `.github/workflows/deploy-blocks.yml` deploys on pushes
  to `main` once the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  secrets are set. See docs/DEPLOY.md.
