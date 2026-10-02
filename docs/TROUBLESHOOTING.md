# Troubleshooting and pitfalls

Real problems hit while building multiplayer games with this stack, and their
fixes.

## Symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| "Resynchronising with the server…" keeps appearing (lockstep) | Non-deterministic sim, or something mutating state outside `apply`/`step` | `npx lobbyhop audit src/sim`; harness test with `assertInSync()`; check for UI code writing to `room.state` |
| Clients end paused on different ticks | Pausing stopped the client sim | Don't gate `room.advance` on `paused`. The server stops issuing turns and clients drain to the frontier. lobbyhop does this; don't add your own early return. |
| "This game has been updated. Refresh the page" | Client and server builds differ (`name@version`) | Redeploy both; bump `version` on purpose when shapes change |
| Nothing happens on click, and no errors | `submit` returns null outside `playing`, for spectators, or while disconnected | Check `room.phase`, `room.seat`, `room.status` |
| Input feels laggy (lockstep) | Turn delay plus latency | Draw `room.pending` as ghosts. Lower `turnMs` (50) for action games. |
| Remote players jitter (state sync) | Drawing `state` directly | Interpolate `lerp(prev, state, alpha)` |
| "Slow down." toasts | Sending input every frame | Send on change only; throttle pointers to ~15/s; or raise `limits.inputsPerSecond` |
| Renderer shows 8 lanes for 3 players | Layout assumed max seats | Drive layout from the state's player count |
| Stale colours or caches after a rejoin | Caches keyed by the placeholder state | Reset on `room.on('snapshot')`, or key caches by content |
| WebSocket 426 from the room URL | Opened the room URL as a page | Rooms are `/rooms/<code>` WebSockets; the page is `/?room=<code>` |
| Socket never connects in dev | Client pointing at the wrong host | `.env.development` with `VITE_ROOM_HOST=localhost:8787`, and pass `host: import.meta.env.VITE_ROOM_HOST` |
| `/rooms/...` returns index.html on Cloudflare | Assets served before the Worker | `"run_worker_first": ["/rooms/*"]` in `wrangler.jsonc` |
| Room lost after deploy (Node) | No `persistDir` | Set `PERSIST_DIR` on a persistent volume |
| Room jumps forward when players return | (Fixed in lobbyhop) The clock caught up on the time nobody was connected | Update lobbyhop |

## Pitfalls already hit (and fixed in lobbyhop)

1. **Pause must not stop the client sim.** Clients drain to the frontier, or
   they rest on different ticks and the hash check is meaningless.
2. **Commands during pause** used to be dropped silently. Now they get
   `reject 'The game is paused.'`.
3. **Seat stamping on the server.** Never trust a `player` field from the
   client. lobbyhop passes `from.seat`.
4. **The host is the first to *arrive*,** not the first to open the page.
   Network timing decides, so tests must find the host (`h.host()`), not
   assume seat 0.
5. **Lobby reseating mutates seat numbers in place.** Copying member objects
   broke the link between connection and member.
6. **Catch-up limits.** A 0.25 s `dt` clamp with an 8× rate cap meant a
   1 fps client could never catch up. Now it's a 1 s clamp, up to 30×.
7. **Placeholder state behind the lobby.** Caches keyed by player count went
   stale when the snapshot replaced the placeholder. Use the `'snapshot'`
   event.
8. **Debug or "autoplay" hooks** that mutate state locally desync rooms.
   Disable them when networked.
9. **Variable seat count.** Renderer layout must be data-driven.
10. **Empty-room time jump.** When everyone left and came back, the game
    fast-forwarded about 5 s. The clock now rebases when it restarts.

## Testing in headless and cloud sandboxes

- **One browser process per player.** Software GL in one Chromium process
  starves a second page. `lobbyhop e2e` does this.
- **Use `waitUntil: 'domcontentloaded'`.** Blocked web fonts can stall
  `load`.
- **Poll, don't sleep.** At about 1 fps (SwiftShader), wait for
  `room.tick === room.frontier`.
- **Expose `window.lobbyhop = { room }`** so tests can drive and inspect the
  game.
- **Node WebSocket behind a proxy:** `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<bundle>`.
- **Out of memory** with wrangler, Vite and several Chromiums alongside
  builds: run them one after another and stop them when done.
- **Never kill by pattern** (`pkill -f wrangler`, `pgrep -f … | xargs kill`).
  The pattern can match your own shell's command line, including a commit
  message that mentions it. Keep the PIDs you start, or spawn detached and
  kill the process group.
- **Workers `Date.now()`** only advances between I/O events. That's fine with
  `setInterval`; never busy-wait.
- **`wrangler dev`** prints an update-check stack trace at startup in
  offline sandboxes. That's harmless.
