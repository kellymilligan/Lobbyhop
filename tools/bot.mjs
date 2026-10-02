#!/usr/bin/env node
/**
 * Headless player: joins a room over WebSocket and plays with a "brain"
 * module. Handy for testing a deployment, filling a seat, or playing your
 * own game against an agent.
 *
 *   node tools/bot.mjs <brain.ts> --host localhost:8787 --room abc123 [--name Bot] [--start] [--count 1]
 *
 * The brain module exports:
 *   export { game } from './game';                     // the game definition
 *   export function decide(state, seat, room) { return [cmd, ...]; }   // called once a second
 *   export const thinkMs = 1000;                       // optional
 *
 * Behind an HTTP proxy (cloud sandboxes): Node's WebSocket ignores HTTPS_PROXY;
 * run with NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle>.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { alias, root } from './example-config.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const brainPath = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const host = opt('--host');
const roomCode = opt('--room');
if (!brainPath || !host || !roomCode) {
  console.error('usage: node tools/bot.mjs <brain.ts> --host <host> --room <code> [--name Bot] [--start] [--count 1]');
  process.exit(1);
}
const count = Number(opt('--count', 1));
const baseName = opt('--name', 'Bot');

// Bundle the brain (TypeScript, game imports) with the lobbyhop client into one module.
const outDir = join(root, 'dist-examples');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `bot-${Date.now()}.mjs`);
const entry = `export * from ${JSON.stringify(resolve(brainPath))}; export { joinRoom } from 'lobbyhop/client';`;
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: existsSync(join(root, 'src', 'index.ts')) ? alias : {},
  logLevel: 'warning',
});
const brain = await import(pathToFileURL(outfile).href);

const stamp = () => new Date().toISOString().slice(11, 19);
for (let n = 0; n < count; n++) {
  const name = count > 1 ? `${baseName} ${n + 1}` : baseName;
  const room = brain.joinRoom(brain.game, { room: roomCode, host, profile: { token: `bot-${name}-${roomCode}`.padEnd(12, '-'), name, colour: '' } });
  const say = (t) => console.log(`[${stamp()}] ${name}: ${t}`);
  room.on('notice', (t) => say(`server: ${t}`));
  room.on('phase', (p) => say(`phase → ${p}`));
  let lastThink = 0;
  let last = performance.now();
  let started = false;
  const timer = setInterval(() => {
    if (room.error) {
      say(`error: ${room.error.reason}`);
      clearInterval(timer);
      return;
    }
    if (argv.includes('--start') && room.host && room.phase === 'lobby' && !started && room.connected) {
      started = true;
      setTimeout(() => room.start(), 1500);
    }
    const now = performance.now();
    const { state } = room.advance((now - last) / 1000);
    last = now;
    if (!state || room.phase !== 'playing' || room.seat === null) return;
    if (now - lastThink > (brain.thinkMs ?? 1000)) {
      lastThink = now;
      for (const cmd of brain.decide(state, room.seat, room) ?? []) room.submit(cmd);
    }
  }, 50);
  say(`joining ${room.url}`);
}
