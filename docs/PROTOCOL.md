# Protocol

Each player has one WebSocket, carrying JSON text frames. It's the same on
Cloudflare and Node. Types live in `src/shared/protocol.ts`, exported from
`lobbyhop`. You only need this page to write a non-JS client or a new host
adapter.

- **URL:** `ws(s)://<host>/rooms/<code>`.
- **Codes:** 3–32 characters from `[a-z0-9-]`, lowercased.
- `PROTOCOL_VERSION = 1`.

## Client → server

| Message | When |
|---|---|
| `{ t: 'hello', v, game, token, name, colour, meta? }` | The first message on every (re)connect. `game` is `"<name>@<version>"` from the definition. `token` is the browser's secret (8–64 characters); it reclaims a seat. |
| `{ t: 'profile', name?, colour?, meta? }` | Lobby (or any time in `lobby: false` rooms). Colours outside the palette, or taken, are replaced. |
| `{ t: 'settings', settings }` | Host, lobby only. Validated by `settings.validate`. |
| `{ t: 'start' }` | Host. From `lobby`, or from `over` (rematch with connected players). |
| `{ t: 'pause', paused }` | Host, while playing. |
| `{ t: 'toLobby' }` | Host. Ends the game. |
| `{ t: 'kick', seat }` | Host. Bans that token from the room. |
| `{ t: 'input', cmd, id }` | While playing and seated. `id` is a client-chosen integer, echoed back so the sender can match pending input. |
| `{ t: 'hash', tick, hash }` | Lockstep: every `hashEvery` ticks. |
| `{ t: 'chat', text }` | Up to 280 characters. Rate-limited. |
| `{ t: 'ping', id }` | RTT probe. |

## Server → client

| Message | Meaning |
|---|---|
| `{ t: 'welcome', seat, host }` | Your seat (`null` means spectating) and host status. Re-sent whenever either changes. |
| `{ t: 'room', phase, members, spectators, paused, settings, chat? }` | The room's public state, sent on every lobby change. `chat` (history) only goes to a newcomer. |
| `{ t: 'snapshot', tick, state }` | Full state on start, join, rejoin and desync repair. Lockstep: the whole state. State sync: your view. Replace local state with it. |
| `{ t: 'turn', at, upTo, cmds }` | Lockstep. Apply `cmds` (in order) when your tick equals `at`, before stepping; then you may simulate up to `upTo`. Each cmd is `{ s: seat, c: command, i?: id, y?: 1 }` (`y` marks server-issued commands). |
| `{ t: 'state', tick, state, events?, ack? }` | State sync. Your current view, the events since the last update, and the ids of your inputs now reflected in it. |
| `{ t: 'reject', id?, reason }` | An input (or action) was refused. |
| `{ t: 'desync', tick }` | Lockstep. Your hash at `tick` didn't match; a snapshot follows. |
| `{ t: 'chat', line: { seat, name, text, at } }` | A chat line. |
| `{ t: 'pong', id }` | Reply to a ping. |
| `{ t: 'notice', text }` | Informational. |
| `{ t: 'error', code, reason }` | Fatal. The socket closes. Codes: `version`, `game`, `full`, `started`, `kicked`, `replaced`, `invalid`. Clients should stop reconnecting. |

## Lockstep turn semantics

- **The server, every `turnMs`:**
  1. computes `target = tickBase + elapsed × tickRate` (catch-up capped at
     5 s);
  2. applies queued commands at `at = tick`, stamping seats and rejecting
     failures;
  3. steps to `target` (or until the game is over);
  4. broadcasts `turn { at, upTo: tick, cmds }`.
- **Clients:**
  - apply the same `cmds`, in the same order, at the same tick, then step;
  - never step past the latest `upTo`;
  - pace themselves about 3 ticks behind it: 0.85× speed when close, up to
    30× when far behind, with `dt` clamped to 1 s.
- **Pause** stops turns. Clients drain to the frontier and rest on the same
  tick.
- **Desync repair:** clients hash at `tick % hashEvery === 0`. The server
  keeps its last 20 hashes and replies to a mismatch with `desync` plus
  `snapshot`.
- **Ordering:** a WebSocket delivers in order, so a turn whose `at` has
  already passed is impossible; if one ever arrives, it's skipped and the
  next hash check repairs the client.

## State sync semantics

- **Inputs** are applied on arrival. On success they're acked inside the next
  `state` for that connection, and events are queued. On failure the sender
  gets `reject` immediately.
- **Event-driven** games (`tickRate: 0`) flush after every change.
- **Real-time** games step at `tickRate` and flush at `sendRate`.
- **Only changed views are sent** to each connection: the JSON is compared
  with the last one sent to that connection.

## Bandwidth (rough)

- **Lockstep:**
  - Downstream: `1000 / turnMs` turns per second, mostly `{"t":"turn","at":N,"upTo":M,"cmds":[]}` (~40 bytes), plus one snapshot on join.
  - Upstream: a few bytes per command.
- **State sync:** view size × updates per second × players. A 2 KB view at
  20 Hz for 8 players is about 320 KB/s out of the room. Keep views small,
  or send less often.
