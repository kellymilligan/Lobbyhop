# Roadmap and recommendations

What's next, roughly in order. For each item: what it is, the recommended
approach, and what to think about. Read it as a plan and a primer.

## Shipped in v0.1 and v0.2

- **Two sync models:**
  - server-clocked lockstep (the proven Siegeline engine);
  - authoritative state sync (event-driven or real-time, with per-seat
    views).
- **Rooms:**
  - lobby and share links, with soft ready-up;
  - token reconnect, which makes refresh-to-rejoin work;
  - host and host transfer, settings, start, pause, back to lobby, rematch;
  - spectators, chat, kick;
  - late joiners and drop-in rooms via hooks;
  - idle-seat hooks for bot takeover.
- **Hardening:**
  - rate limits, message size limits, origin allow-list;
  - persistence (Durable Object storage, or files on Node);
  - empty-room cleanup;
  - no time-jump when a room's clock restarts.
- **Hosting:** Cloudflare Durable Objects (no dependencies), Node `ws`.
- **Tooling:**
  - in-memory jittery-network harness, N-browser e2e, cross-engine
    determinism check, headless bot client;
  - CLI with bundled docs, init scaffolding, determinism audit and examples.
- **UI:** a framework-free lobby and status chip.
- **Published** to npm as `lobbyhop`, with provenance via trusted publishing.

## Shipped in v0.3 (persistent worlds)

- **Delta state sync** (`delta: true`): JSON patches per audience, falling
  back to the full view when a patch is larger.
- **Never-expiring rooms** (`emptyTtlMs: null`), and **`migrate`** for saved
  worlds across versions.
- **Quiet saves:** unchanged state isn't rewritten.
- **Capacity:** `maxConnections` on Cloudflare; lobby-less rooms seat late
  arrivals without a `join` hook.
- **`examples/blocks`:** a persistent 3D block builder. Box3D runs in the
  Durable Object (compiled to WebAssembly) and three.js renders it. It comes
  with a deploy workflow.

## Next

### 1. Replays

- **What:** for lockstep, the seed plus every turn *is* a replay. Record
  `{ seed, settings, seats, turns[] }` and play it back in a `?replay=`
  viewer.
- **Approach:** the room appends turns to a log (stored with the save). Add a
  `ReplayClient` that feeds turns to the same `advance` loop.
- **Consider:**
  - logs grow by about 40 bytes per turn (roughly 1.4 MB per hour);
  - compress or skip empty turns;
  - state sync replays need snapshots or deltas instead.

### 2. Quick match (public matchmaking)

- **What:** a "Play now" button that drops you into an open public room, or
  makes one.
- **Approach:**
  - A single `Matchmaker` Durable Object (one global instance, or one per
    region and game) holds a queue: `{ code, players, max, createdAt }`.
  - Rooms report their open seats to it.
  - The client calls `GET /match?game=x` and gets back a room code.
  - Bots back-fill if the queue is quiet after N seconds.
- **Consider:**
  - Skill-based matching needs accounts and ratings (Elo or Glicko-2;
    OpenSkill for teams).
  - Start with first-come-first-served plus a region hint.
  - Rooms should be "public" or "private" (the default, link only).

### 3. Accounts (optional, layered on tokens)

- **What:** persistent identity across devices, display names, friends and
  stats.
- **Today:** the per-browser token in `localStorage` is a guest identity.
  That's good enough for link-sharing games, and what most casual web games
  use.
- **Recommended path:**
  - Keep guests as the default (no sign-up wall).
  - Add an `identify(request, hello)` hook on the server that verifies a
    signed token (a JWT from your auth provider, sent as a query parameter or
    cookie on the WebSocket URL) and attaches `{ userId, name }` to the seat.
  - Let a guest upgrade by signing in; the token links to the user.
- **Providers:**
  - Cloudflare Access is good for private playtests.
  - Better Auth, Auth.js or Lucia-style libraries if you want to own it.
  - Clerk, Supabase or Firebase if you want it managed.
  - Store users in Cloudflare D1 or Postgres.
- **Consider:**
  - Never trust names or ids from the client.
  - Rate-limit sign-in.
  - Accounts bring privacy duties (GDPR deletion, data export) and
    moderation work.

### 4. Anti-cheat (layered)

What's already true:

- **Seat stamping:** clients can't act for others.
- **Server validation:** every command goes through `apply` on the server.
- **Rate limits and message size limits.**
- **State sync** only reveals what `view()` allows.

Next layers, cheapest first:

1. **Plausibility checks in `apply`:**
   - speed caps, cooldowns, range checks;
   - this is your game's job, and the single best defence.
2. **Hidden information means state sync.** Lockstep clients have the whole
   state, so maphacks are always possible there.
3. **Server-side input logs** for review and replays (see Replays).
4. **Reputation:**
   - kick and ban per room (shipped);
   - per-account bans once accounts exist;
   - turn on a Cloudflare WAF or rate-limit rule on `/rooms/*`.
5. **Client integrity checks (obfuscation, tamper detection)** have low
   value in browsers. Spend the effort on 1 and 2.

### 5. Hibernation for idle rooms (Cloudflare cost)

- **What:** use the Durable Object WebSocket Hibernation API, so lobbies and
  turn-based rooms with connected but idle players stop accruing duration.
- **Approach:**
  - `ctx.acceptWebSocket()`;
  - restore `RoomCore` from storage on wake (persistence already exists);
  - keep the interval clock only while a real-time game is running.
- **Consider:** a lockstep game in progress needs the clock, so it can't
  hibernate. The gain is in lobbies and turn-based play.

### 6. Chat moderation and emotes

- Chat exists and is rate-limited. Add:
  - a profanity filter hook (`filterChat(text) → text | null`);
  - quick emotes (a reserved command type that skips the sim);
  - a mute-player option in the UI.

### 7. Voice (and video)

- **Approach:** WebRTC for media, with lobbyhop rooms as the signalling
  channel (add `signal` messages relayed peer to peer).
  - **2–4 players:** a peer-to-peer mesh is fine. Add a TURN server for
    restrictive networks: Cloudflare's TURN service, or coturn.
  - **More players:** use an SFU such as Cloudflare Realtime (formerly
    Calls), LiveKit or mediasoup.
- **Consider:**
  - push-to-talk by default;
  - the browser permission prompt;
  - echo cancellation (on by default with `getUserMedia`);
  - moderation and reporting;
  - recording consent.

### 8. Client-side prediction and reconciliation (state sync)

- **What:** apply your own input locally the moment you press it, then
  correct when the server's state arrives. It makes movement feel instant.
- **Approach:**
  - opt-in `predict: true`;
  - the client keeps unacknowledged inputs (`room.pending` already does);
  - on each server state, re-apply pending inputs on top of it with the
    game's `apply` and `step`;
  - the server tags states with the last processed input id per seat (`ack`
    already does).
- **Consider:**
  - needs a view that contains your own entity;
  - prediction only covers *your* actions, so others are still interpolated;
  - this is the standard approach for co-op action and most .io games.

### 9. Rollback (fighting games, competitive action)

- **What:** GGPO-style. Every client predicts all inputs ("they're still
  holding left"), and when real input arrives late, rewinds and re-simulates.
- **Approach:**
  - builds on lockstep's determinism;
  - add per-tick input frames, a state ring buffer (snapshot per tick, or
    cheap cloning), and input delay of 0–2 frames;
  - the server can stay an authoritative relay.
- **Consider:**
  - re-simulating N ticks per frame must fit in your frame budget;
  - snapshots must be cheap (typed arrays help);
  - it's a big step, so do it only when a game needs it.

### 10. Retrofit Siegeline onto lobbyhop

This proves the kit against the game it came from. Expect:
- the game definition wraps `createGame`, `applyCommand` and `step`, with the
  `player` field coming from `from.seat`;
- `idle` hands seats to the bot brain;
- the Siegeline lobby is replaced by `mountLobby` with a frosted-glass theme;
- e2e uses its existing scripts.

## Smaller items

- An `identify` hook for custom auth, and `meta` validation per game.
- Room passwords (an optional `?key=`).
- Per-room max connections and spectator caps in options.
- Binary encoding (MessagePack) behind a flag, for high-rate games.
- A React and Preact hooks package (`useRoom(room)`). It's tiny, because
  `RoomClient` is already observable.
