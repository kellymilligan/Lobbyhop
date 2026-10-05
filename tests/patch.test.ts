import { describe, expect, it } from 'vitest';
import { applyPatch, diff } from '../src/shared/patch.js';
import type { Json } from '../src/index.js';
import { nextFloat, nextInt, seedRng } from '../src/det/index.js';

describe('json patch', () => {
  it('round-trips, keeps the base intact, and handles nulls, arrays and deletes', () => {
    const a: Json = { keep: { deep: [1, 2] }, change: { x: 1, y: 2 }, gone: 5, n: null, arr: [1, 2, 3] };
    const b: Json = { keep: { deep: [1, 2] }, change: { x: 1, y: 3 }, n: 7, arr: [1, 2], added: { z: null } };
    const before = JSON.stringify(a);
    const ops = diff(a, b);
    expect(ops).toEqual([[['change', 'y'], 3], [['n'], 7], [['arr'], [1, 2]], [['added'], { z: null }], [['gone']]]);
    const out = applyPatch(a, ops);
    expect(out).toEqual(b);
    expect(JSON.stringify(a)).toBe(before);
    // Unchanged subtrees are shared, changed ones copied.
    expect((out as { keep: Json }).keep).toBe((a as { keep: Json }).keep);
    expect((out as { change: Json }).change).not.toBe((a as { change: Json }).change);
    expect(diff(b, b)).toEqual([]);
    expect(applyPatch(1 as Json, diff(1, { a: 1 }))).toEqual({ a: 1 });
  });

  it('fuzz: applyPatch(a, diff(a, b)) equals b', () => {
    const rng = seedRng('patch');
    const gen = (d: number): Json => {
      const r = nextInt(rng, d > 2 ? 4 : 6);
      if (r === 0) return null;
      if (r === 1) return nextFloat(rng) < 0.5;
      if (r === 2) return nextInt(rng, 5);
      if (r === 3) return `s${nextInt(rng, 3)}`;
      if (r === 4) return Array.from({ length: nextInt(rng, 3) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: nextInt(rng, 4) }, () => [`k${nextInt(rng, 5)}`, gen(d + 1)]));
    };
    for (let i = 0; i < 2000; i++) {
      const a = gen(0);
      const b = gen(0);
      expect(applyPatch(a, diff(a, b))).toEqual(b);
    }
  });
});
