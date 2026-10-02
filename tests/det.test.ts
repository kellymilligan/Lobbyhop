import { describe, expect, it } from 'vitest';
import { assertJsonSafe, atan2, cos, nextFloat, nextInt, powi, seedRng, shuffle, sin, stateHash, wrapAngle } from '../src/det/index.js';
import { cleanRoomCode, newRoomCode } from '../src/client/profile.js';
import { roomUrl } from '../src/client/socket.js';

describe('det maths', () => {
  it('sin/cos track Math within 1e-6 over a wide range', () => {
    let worst = 0;
    for (let x = -50; x <= 50; x += 0.0137) {
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('atan2 tracks Math within 1e-6 in every quadrant', () => {
    let worst = 0;
    for (let a = -3.2; a <= 3.2; a += 0.01) {
      for (const r of [0.001, 1, 1000]) {
        const y = Math.sin(a) * r;
        const x = Math.cos(a) * r;
        worst = Math.max(worst, Math.abs(wrapAngle(atan2(y, x) - Math.atan2(y, x))));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(atan2(0, 0)).toBe(0);
  });

  it('powi is exact for integer powers', () => {
    expect(powi(2, 10)).toBe(1024);
    expect(powi(3, 0)).toBe(1);
    expect(powi(2, -2)).toBe(0.25);
    expect(powi(1.5, 3)).toBe(1.5 * 1.5 * 1.5);
  });
});

describe('det rng', () => {
  it('is reproducible and well spread', () => {
    const a = seedRng('x');
    const b = seedRng('x');
    const xs = Array.from({ length: 1000 }, () => nextFloat(a));
    expect(xs).toEqual(Array.from({ length: 1000 }, () => nextFloat(b)));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.05);
    const r = seedRng(1);
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[nextInt(r, 3)]++;
    expect(Math.min(...counts)).toBeGreaterThan(900);
    expect(shuffle(seedRng('s'), [1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('survives a JSON round trip mid-stream', () => {
    const a = seedRng('y');
    nextFloat(a);
    const b = JSON.parse(JSON.stringify(a));
    expect(nextFloat(a)).toBe(nextFloat(b));
  });
});

describe('det checks', () => {
  it('assertJsonSafe catches state that JSON would mangle', () => {
    expect(() => assertJsonSafe({ a: [1, 2, { b: 'c' }] })).not.toThrow();
    expect(() => assertJsonSafe({ a: NaN })).toThrow(/NaN/);
    expect(() => assertJsonSafe({ a: undefined })).toThrow(/undefined/);
    expect(() => assertJsonSafe({ m: new Map() })).toThrow(/Map/);
    expect(() => assertJsonSafe({ d: new Date() })).toThrow();
  });

  it('stateHash is order-sensitive and stable', () => {
    expect(stateHash({ a: 1, b: 2 })).toBe(stateHash({ a: 1, b: 2 }));
    expect(stateHash({ a: 1, b: 2 })).not.toBe(stateHash({ b: 2, a: 1 }));
  });
});

describe('room codes and urls', () => {
  it('generates clean codes', () => {
    const c = newRoomCode();
    expect(c).toMatch(/^[a-z2-9]{6}$/);
    expect(cleanRoomCode(' AbC-12!')).toBe('abc-12');
    expect(cleanRoomCode('a')).toBeNull();
  });

  it('builds socket urls for local and deployed hosts', () => {
    expect(roomUrl('abc', 'localhost:8787')).toBe('ws://localhost:8787/rooms/abc');
    expect(roomUrl('abc', 'game.example.com')).toBe('wss://game.example.com/rooms/abc');
    expect(roomUrl('abc', 'http://10.0.0.5:3000/', '/r')).toBe('ws://10.0.0.5:3000/r/abc');
    expect(roomUrl('abc', 'https://x.workers.dev')).toBe('wss://x.workers.dev/rooms/abc');
  });
});
