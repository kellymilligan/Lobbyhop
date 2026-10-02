/**
 * Determinism helpers for lockstep simulations.
 *
 * Everything here uses only `+ - * /`, `Math.floor`/`Math.round`/`Math.sqrt`
 * and 32-bit integer ops, which are bit-identical in every JS engine. Keep the
 * RNG state inside your game state so snapshots and replays carry it along.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG (sfc32, seeded via splitmix32)
// ---------------------------------------------------------------------------

/** RNG state: a plain tuple, so it serialises with the rest of your state. */
export type Rng = [number, number, number, number];

/** Creates RNG state from a string or number seed. */
export function seedRng(seed: number | string): Rng {
  let h = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const next = () => {
    h = (h + 0x9e3779b9) >>> 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const s: Rng = [next(), next(), next(), next()];
  for (let i = 0; i < 12; i++) nextU32(s);
  return s;
}

/** Advances the state in place and returns a uint32. */
export function nextU32(s: Rng): number {
  const [a, b, c, d] = s;
  const t = (((a + b) >>> 0) + d) >>> 0;
  s[3] = (d + 1) >>> 0;
  s[0] = b ^ (b >>> 9);
  s[1] = (c + (c << 3)) >>> 0;
  s[2] = ((c << 21) | (c >>> 11)) >>> 0;
  s[2] = (s[2] + t) >>> 0;
  return t;
}

/** Float in [0, 1). */
export function nextFloat(s: Rng): number {
  return nextU32(s) / 4294967296;
}

/** Integer in [0, n). */
export function nextInt(s: Rng, n: number): number {
  return Math.floor(nextFloat(s) * n);
}

/** Float in [min, max). */
export function nextRange(s: Rng, min: number, max: number): number {
  return min + nextFloat(s) * (max - min);
}

/** A random element of a non-empty array. */
export function pick<T>(s: Rng, items: readonly T[]): T {
  return items[nextInt(s, items.length)];
}

/** Shuffles in place (Fisher–Yates) and returns the array. */
export function shuffle<T>(s: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextInt(s, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Picks an index by integer weights. */
export function pickWeighted(s: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = nextFloat(s) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** FNV-1a over a string's UTF-16 code units. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fingerprint of a whole plain-JSON state (FNV-1a over its JSON). */
export function stateHash(state: unknown): number {
  return hashString(JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Deterministic maths
// ---------------------------------------------------------------------------
// `Math.sin/cos/atan2/pow/exp/log` are not specified bit-exactly and differ
// between V8, SpiderMonkey and JavaScriptCore. These approximations are built
// from IEEE-exact operations, so every engine agrees (accuracy ≈ 1e-6 for
// sin/cos, ≈ 1e-5 rad for atan2: plenty for gameplay).

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Wraps an angle to [-π, π]. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

/** Deterministic sine. */
export function sin(x: number): number {
  let a = wrapAngle(x);
  // Fold to [-π/2, π/2] using sin(π - a) = sin(a).
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  const a2 = a * a;
  // Taylor series to x^13 (error < 1e-9 on [-π/2, π/2]).
  return a * (1 + a2 * (-1 / 6 + a2 * (1 / 120 + a2 * (-1 / 5040 + a2 * (1 / 362880 + a2 * (-1 / 39916800 + a2 * (1 / 6227020800)))))));
}

/** Deterministic cosine. */
export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/** Deterministic atan2(y, x) in [-π, π]. */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const swap = ay > ax;
  const z = swap ? ax / ay : ay / ax; // in [0, 1]
  let r = atanUnit(z);
  if (swap) r = HALF_PI - r;
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

/** atan on [0, 1]: range-reduce around 0.5, then a short series. */
function atanUnit(z: number): number {
  // atan(z) = atan(c) + atan((z - c) / (1 + z c)) with c = 0.5 when z > 0.25.
  if (z > 0.25) {
    const t = (z - 0.5) / (1 + z * 0.5);
    return 0.4636476090008061 + atanSmall(t);
  }
  return atanSmall(z);
}

function atanSmall(t: number): number {
  // |t| ≤ 0.25: Taylor to t^15 (error < 1e-10).
  const t2 = t * t;
  return t * (1 + t2 * (-1 / 3 + t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 * (1 / 13 + t2 * (-1 / 15))))))));
}

/** Integer power by repeated multiplication (exact for any engine). */
export function powi(base: number, exp: number): number {
  let r = 1;
  let b = base;
  let e = Math.floor(exp < 0 ? -exp : exp);
  while (e > 0) {
    if (e & 1) r *= b;
    b *= b;
    e >>= 1;
  }
  return exp < 0 ? 1 / r : r;
}

/** Vector length using the IEEE-exact `Math.sqrt` (prefer over Math.hypot). */
export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Rounds to a fixed number of decimals, to keep stored state compact. */
export function quantise(x: number, step = 1 / 1024): number {
  return Math.round(x / step) * step;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Throws if `state` doesn't survive a JSON round trip unchanged (functions,
 * Maps, Sets, class instances, undefined, NaN or Infinity in state).
 */
export function assertJsonSafe(state: unknown, label = 'state'): void {
  const a = JSON.stringify(state);
  const b = JSON.stringify(JSON.parse(a));
  if (a !== b) throw new Error(`${label} is not JSON round-trip safe`);
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${label}${path} is ${v}; JSON turns it into null`);
    if (v === undefined) throw new Error(`${label}${path} is undefined; JSON drops it`);
    if (typeof v === 'function') throw new Error(`${label}${path} is a function`);
    if (v instanceof Map || v instanceof Set) throw new Error(`${label}${path} is a ${v.constructor.name}; use arrays or plain objects`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${label}${path} is a class instance; use plain objects`);
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(state, '');
}

/**
 * Patterns that usually break lockstep determinism when used in simulation
 * code. `npx lobbyhop audit <dir>` greps for these.
 */
export const AUDIT_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /Math\.random\b/, why: 'Unseeded randomness: use seedRng/nextFloat from lobbyhop/det with RNG state stored in your game state.' },
  { pattern: /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|cbrt|hypot)\b/, why: 'Transcendental maths differs between engines: use sin/cos/atan2/powi/length from lobbyhop/det.' },
  { pattern: /[\w)\]]\s*\*\*\s*[\w(]/, why: 'The ** operator is Math.pow: use powi() for integer powers or x*x.' },
  { pattern: /\b(Date\.now|new Date|performance\.now)\b/, why: 'Wall-clock time in the sim: use tick counts.' },
  { pattern: /\.sort\(\s*\)/, why: 'Default sort compares as strings and may differ for mixed data: pass an explicit, total comparator.' },
  { pattern: /for\s*\(\s*(const|let|var)\s+\w+\s+in\b/, why: 'for…in order depends on key insertion and numeric-like keys: iterate arrays or sorted keys.' },
  { pattern: /\b(window|document|navigator|localStorage|fetch|setTimeout|setInterval|requestAnimationFrame)\b/, why: 'Platform APIs in the sim: keep the sim pure.' },
  { pattern: /\bnew (Map|Set|WeakMap)\b/, why: 'Map/Set in state are not JSON-safe (fine as local temporaries with deterministic insertion order).' },
];
