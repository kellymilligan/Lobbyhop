# Choosing a sync model

Multiplayer is about one question: **how do several computers agree on what
happened, when messages take 20–300 ms to arrive?** There are a few classic
answers. lobbyhop ships two of them and leaves room for the others.

## The short answer

| Your game | Model | Preset | Why |
|---|---|---|---|
| Board, card, word, trivia, turn-based strategy | State sync | `presets.turnBased` | Nothing happens between moves. The server holds the truth and can keep hands and roles secret. |
| Party games, social deduction, drawing and guessing | State sync | `presets.casual` (10 Hz) | Timers and phases, light real-time, hidden info. |
| Co-op, .io-style, shared canvases, virtual spaces, "rich experiences" | State sync | `presets.realtime` (20 Hz), often `lobby: false` | Smooth enough with interpolation, and no determinism burden. |
| RTS, tower defence, colony and factory sims, lots of units | Lockstep | `presets.strategy` (30 Hz sim, 100 ms turns) | Thousands of units cost nothing on the wire. Only commands travel. |
| Faster lockstep action (top-down arena, twin-stick vs AI) | Lockstep | `presets.action` (60 Hz, 50 ms turns) | Lower input delay at more messages per second. |
| Shooters, fighting games, racing, platformers with PvP contact | *Prediction or rollback* | Not yet ([ROADMAP.md](ROADMAP.md)) | These need instant local response. See below for what to do today. |

**Action games, rule of thumb:** would a skilled player be upset if their
shot or dodge landed 100–200 ms after the key press?
- **No** (casual, vs-AI, co-op, tanks, slow projectiles): lockstep (try
  `turnMs: 50`) or state sync both work.
- **Yes** (aim duels, fighting games): you need prediction or rollback (see
  below).

Presets are only starting points; mix `tickRate` and `turnMs` freely.

If you're unsure, **start with state sync.** It's more forgiving: no
determinism rules, and cheating is harder. Move to lockstep when your state
is too big to send many times a second.

## The two models

### Lockstep (server-clocked)

```
you ──cmd──►┐                         ┌──turn {at, upTo, cmds}──► you
them ──cmd──►├─ room: runs the same sim ├──turn ──────────────────► them
```

- Every client runs the **same deterministic simulation**. Only commands
  travel.
- Every `turnMs` the room:
  1. stamps queued commands with their senders' seats;
  2. validates them against its own copy of the game;
  3. broadcasts them as a "turn" saying "apply these at tick N; you may
     simulate up to tick M".
- Clients never run past M, called the frontier. They sit about 3 ticks
  behind it as a buffer against jitter.
- Every few seconds clients send a hash of their state. On a mismatch the
  server sends a fresh snapshot (self-healing).

| Pros | Cons |
|---|---|
| **Bandwidth doesn't grow with the game.** 2 units or 20,000, a turn is the same few bytes. | **Determinism is mandatory.** Same inputs must give bit-identical results in Chrome, Firefox and Safari ([DETERMINISM.md](DETERMINISM.md)). |
| Replays are free: the seed plus the command log. | **Input delay** of about `turnMs/2 + latency` before your action takes effect. Hide it with ghosts (`room.pending`). |
| Server validation: the room rejects impossible commands. | **No hidden information.** Every client has the full state, so a cheater can read it (a "maphack"). |
| A slow client only delays itself. The server owns the clock, so nobody waits for the slowest player (classic peer-to-peer lockstep stalls everyone). | Joining mid-game needs a full snapshot, which is fine up to a few hundred KB of state. |

### State sync (authoritative server)

```
you ──cmd──►┐                         ┌──state (your view)──► you
them ──cmd──►├─ room: runs the only sim ├──state (their view)─► them
```

- Only the server runs the game. It applies commands as they arrive.
- Each player is sent their **view** of the state:
  - event-driven games get it immediately on change;
  - real-time games get it at `sendRate`.
- Only changed views are sent.

| Pros | Cons |
|---|---|
| **No determinism needed.** Use any maths, `Math.random`, anything. | Bandwidth grows with state size × send rate × players. Keep views small. |
| **Hidden information works**, because `view(state, seat)` decides what each player sees. | Remote movement arrives in steps; interpolate between `prev` and `state`. That renders about one send interval behind. |
| **Cheating is much harder.** Clients only send intent, and only see what they're allowed to. | Your own actions show after a round trip. Use `room.pending` for optimistic UI. |
| Turn-based rooms cost almost nothing: no clock, no work until someone moves. | |

## Tick rate, send rate, turn length

- **`tickRate`:** how often the simulation advances.
  - Lockstep: 20–30 Hz is plenty for strategy; 60 Hz for snappy movement.
    Higher means more CPU and less headroom for slow devices to catch up.
  - State sync: 0 for turn-based; 10–30 for real-time.
- **`turnMs` (lockstep):** how often the server releases commands.
  - Lower means less input delay but more messages.
  - 100 ms (10 per second) is the proven default; 50 ms for action.
  - Each turn is tiny, so even 20 per second is fine.
- **`sendRate` (state sync):** views per second.
  - 10–20 suits most things; 30 is the cap.
  - Only changes are sent, so a quiet room sends little.

### Input delay you can expect

| | Lockstep (100 ms turns) | State sync |
|---|---|---|
| Same city (20 ms latency) | ~80–120 ms | ~40 ms |
| Same continent (60 ms) | ~120–170 ms | ~120 ms |
| Across the world (200 ms) | ~250–350 ms | ~400 ms |

Cloudflare places a room near whoever created it, so players far from that
spot see more latency. **Ghosts make it feel instant** in both models.

## Things to consider

- **Hidden information means state sync.** Cards in hand, fog of war and
  secret roles can't be hidden in lockstep, because every client has the
  state.
- **Many moving things means lockstep.** If your state is megabytes (big
  maps, thousands of units), sending it 10 times a second isn't viable.
- **Physics engines:**
  - Most (Rapier, Box2D, cannon) are deterministic only within one build, one
    engine and the same float behaviour. Lockstep across browsers needs care:
    fixed-point, or the same WASM build everywhere.
  - Rapier publishes `-deterministic` WASM packages
    (`@dimforge/rapier2d-deterministic`, `@dimforge/rapier3d-deterministic`)
    built for cross-platform determinism. They're the best bet if you need
    lockstep physics; verify with `lobbyhop determinism`.
  - Otherwise use state sync, with the server running physics.
- **Mobile and background tabs:**
  - Browsers throttle hidden tabs.
  - Lockstep clients sprint up to 30× to catch up when the tab returns;
    state sync clients just take the latest view.
  - Neither stalls anyone else.
- **Join in progress:**
  - Lockstep sends a full snapshot to a late joiner. Keep state compact
    (tens to hundreds of KB).
  - State sync sends the current view.
- **Persistence:** rooms save to storage (Durable Objects, or `persistDir` on
  Node), so deploys and restarts don't lose games. Saves are throttled
  (`saveEveryMs`).

## Twitchy games today

lobbyhop doesn't do client-side prediction or rollback yet
([ROADMAP.md](ROADMAP.md)). For a fast action game right now:

- **Co-op or PvE action:**
  - use state sync at 20–30 Hz;
  - move your own character locally and send its position as intent
    (`{ type: 'pos', x, y }`), with the server clamping it to plausible
    speed;
  - interpolate others.
  - This is "client authority with sanity checks". It's simple and good
    enough when cheating doesn't matter.
- **Competitive PvP shooters or fighters:** these need prediction with server
  reconciliation, or rollback (GGPO-style). Both are significant work. If you
  need them, look at dedicated engines (Colyseus, Netcode for GameObjects,
  GGPO ports) or follow the roadmap.

## Glossary

| Term | Meaning |
|---|---|
| **Latency / RTT** | Time for a message to arrive (one way), or to arrive and come back (round trip). `room.rtt` shows RTT. |
| **Jitter** | Variation in latency. Buffers (lockstep's 3-tick lag, state sync's interpolation) absorb it. |
| **Authority** | Whose word is final. In lobbyhop it's always the server: it validates every command. |
| **Determinism** | Same inputs give the same outputs, bit for bit, on every machine. |
| **Desync** | Clients disagree. Lockstep detects it by hashing and repairs it by snapshot. |
| **Interpolation** | Drawing between two known states to hide that updates arrive in steps. |
| **Prediction** | Showing the result of your input before the server confirms it, then correcting. Ghosts (`room.pending`) are the light version. |
| **Rollback** | Predict everything, and when late input arrives, rewind and re-simulate. It's how fighting games feel instant. |
