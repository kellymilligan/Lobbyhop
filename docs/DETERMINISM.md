# Determinism (lockstep only)

Lockstep works because every machine computes the **same game, bit for bit**,
from the same seed and commands. If one client's maths differs in the 15th
decimal place, the games drift apart.

- lobbyhop detects a desync (state hashes every ~5 s) and repairs it with a
  snapshot.
- A sim that keeps desyncing will stutter, so get it right up front.

State-sync games can ignore this page.

## The contract

A lockstep simulation (`create`, `apply`, `step`, and anything they call)
must follow these rules.

1. **Be pure.**
   - No DOM, `window`, `document`, `localStorage` or `fetch`.
   - No `Date` or `performance.now()`: count ticks instead.
   - No renderer, audio or network calls.
2. **Draw all randomness from a seeded PRNG stored in the state.** Use
   `seedRng(seed)` and `nextFloat`/`nextInt`/`pick`/`shuffle` from
   `lobbyhop/det`. The renderer may use `Math.random` for cosmetics.
3. **Use no transcendental maths.**
   - `Math.sin/cos/tan/atan2/exp/log/pow/hypot/cbrt` and `**` are not
     specified bit-exactly, and differ between V8 (Chrome, Node, workerd),
     SpiderMonkey (Firefox) and JavaScriptCore (Safari).
   - `+ - * /`, `Math.sqrt`, `Math.floor/ceil/round/trunc/abs/min/max/sign`
     and integer ops are exact everywhere.
   - Use `sin`, `cos`, `atan2`, `powi`, `length` from `lobbyhop/det`, lookup
     tables, or fixed point.
4. **Iterate in a defined order.**
   - Don't use `for…in` over objects whose keys come from different sources.
   - Avoid `Set`/`Map` iteration where insertion order could differ.
   - Don't use `Array.prototype.sort()` without a comparator, or with one
     that isn't total (ties must be broken, e.g. by id).
5. **Keep state as plain JSON,** so snapshots round-trip exactly.
   - Use numbers, strings, booleans, null, arrays and plain objects.
   - No `undefined`, `NaN`, `Infinity`, classes, Maps, Sets, Dates or
     functions.
   - Check with `assertJsonSafe(state)`.
6. **Keep bots inside the simulation,** driven by its RNG. They cost no
   bandwidth and stay in sync.
7. **Change state only through `apply` and `step`.** The UI never mutates
   state: no "autoplay my seat" hooks or debug cheats while networked.
8. **Don't depend on the tick counter from outside.** The engine counts ticks
   for you. If the sim needs the tick, keep your own `state.tick` and
   increment it in `step`.

## Audit

```sh
npx lobbyhop audit src/sim            # folders or files; point it at sim code, not the renderer
```

This greps for the usual suspects: `Math.random`, transcendental `Math.*`,
`**`, `Date`, `performance`, `.sort()` with no comparator, `for…in`, platform
APIs, `new Map/Set`. Review every hit. Some are fine: a `Set` used as a local
temporary, or `Math.random` in rendering code that sits in the same folder.

- Silence a reviewed line with a trailing `// lobbyhop-audit-ignore: reason`
  comment.
- The command exits 1 while hits remain, so `npm run audit` can gate CI.
- `lobbyhop determinism` labels a run that only reached Node and Chromium as
  "V8 only". Both share an engine, so only Firefox and WebKit (in CI) prove
  cross-engine determinism.

## Verify

1. **Harness test (every commit).** Run 3 clients with random commands over a
   jittery network for a few minutes, then `assertInSync()`. It catches most
   logic-level non-determinism: order-dependent code, state mutated outside
   `apply`, JSON-unsafe values.
2. **JSON round trip.** `recordHashes` passes the state through
   `JSON.parse(JSON.stringify())` halfway, as a reconnect does. Any value
   that doesn't survive shows up as a hash change.
3. **Cross-engine check (CI).** Bundle a scripted game and run it in Node,
   Chromium, Firefox and WebKit, comparing hashes at every checkpoint:

   ```ts
   // src/multiplayer/determinism.ts
   import { recordHashes } from 'lobbyhop/testing';
   import { nextInt } from 'lobbyhop/det';
   import { game } from './game';

   export function runScenario(seed: string, minutes: number) {
     return recordHashes(game, {
       seed,
       seats: 2,                       // humans in seats 0 and 1, exactly as a room seats them
       ticks: minutes * 60 * game.tickRate,
       input: (t, rng) => (t % 15 ? [] : [[0, { type: 'move', dx: nextInt(rng, 3) - 1, dy: 0 }]]),
     });
   }
   (globalThis as any).runScenario = runScenario;
   ```

   ```sh
   npx playwright install --with-deps chromium firefox webkit
   npx lobbyhop determinism src/multiplayer/determinism.ts --require-all
   ```

## Common traps

| Trap | Fix |
|---|---|
| `Math.atan2` for facing or aiming | `atan2` from `lobbyhop/det` |
| `Math.pow(x, 2)` or `x ** 2` | `x * x`, or `powi(x, n)` |
| `Math.hypot(dx, dy)` | `Math.sqrt(dx*dx + dy*dy)` or `length(dx, dy)` |
| Easing with `Math.exp` or `Math.sin` in the sim | Polynomial easing, or keep easing in the renderer |
| Sorting units by distance with ties | Break ties: `(a, b) => a.d - b.d \|\| a.id - b.id` |
| A cache keyed by player count went stale after a snapshot | Key caches by content, or reset them on `room.on('snapshot')` |
| Float accumulation over long games | Fine, because it's deterministic. Use `quantise()` only to keep state small. |
| `toFixed`, `toLocaleString` and `Intl` in the sim | Keep string formatting in the UI |
| `structuredClone` of state | Fine, but JSON is the contract: avoid types JSON can't hold |
| Physics engines | Most aren't cross-engine deterministic. Use fixed point or a deterministic WASM build, or switch to state sync. |
