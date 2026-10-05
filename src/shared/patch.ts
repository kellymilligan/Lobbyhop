/**
 * JSON deltas for state sync (`delta: true`). A patch is a list of operations
 * on plain-JSON values:
 *
 *   [path, value]   set the value at `path` (an array of object keys)
 *   [path]          delete the key at `path`
 *
 * Plain objects are diffed key by key; arrays and primitives are replaced
 * whole when they differ. So keep big collections as objects keyed by id
 * (`bodies: { "17": {...} }`) rather than arrays, and only changed entries
 * travel. Unlike JSON Merge Patch, `null` values are safe.
 */
import type { Json } from './game.js';

export type PatchOp = [path: string[], value: Json] | [path: string[]];
export type Patch = PatchOp[];

type Obj = { [key: string]: Json };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep equality for plain JSON values. */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!(k in b) || !jsonEqual((a as Obj)[k], (b as Obj)[k])) return false;
  return true;
}

/** The operations that turn `prev` into `next` (empty when equal). */
export function diff(prev: Json, next: Json): Patch {
  const ops: Patch = [];
  walk(prev, next, [], ops);
  return ops;
}

function walk(prev: Json, next: Json, path: string[], ops: Patch) {
  if (isObj(prev) && isObj(next)) {
    for (const k of Object.keys(next)) {
      const p = prev[k];
      const n = next[k];
      if (!(k in prev)) ops.push([[...path, k], n]);
      else if (p !== n && !jsonEqual(p, n)) {
        if (isObj(p) && isObj(n)) walk(p, n, [...path, k], ops);
        else ops.push([[...path, k], n]);
      }
    }
    for (const k of Object.keys(prev)) if (!(k in next)) ops.push([[...path, k]]);
    return;
  }
  if (!jsonEqual(prev, next)) ops.push([path, next]);
}

/**
 * Applies a patch without mutating `base`: objects along each changed path
 * are copied (structural sharing), so the previous state stays intact for
 * interpolation.
 */
export function applyPatch<T>(base: T, patch: Patch): T {
  let root = base as unknown as Json;
  const fresh = new WeakSet<object>();
  const own = (o: Obj): Obj => {
    if (fresh.has(o)) return o;
    const c = { ...o };
    fresh.add(c);
    return c;
  };
  for (const op of patch) {
    const path = op[0];
    if (path.length === 0) {
      if (op.length === 2) root = op[1];
      continue;
    }
    if (!isObj(root)) root = {};
    root = own(root as Obj);
    let node = root as Obj;
    for (let i = 0; i < path.length - 1; i++) {
      const child = node[path[i]];
      const next = isObj(child) ? own(child) : {};
      if (!isObj(child)) fresh.add(next);
      node[path[i]] = next;
      node = next;
    }
    const key = path[path.length - 1];
    if (op.length === 2) node[key] = op[1];
    else delete node[key];
  }
  return root as unknown as T;
}

/** A deep copy of a JSON value. */
export const cloneJson = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
