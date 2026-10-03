#!/usr/bin/env node
/**
 * Headless player: joins a room over WebSocket and plays with a "brain"
 * module. Handy for testing a deployment, filling a seat, or playing your
 * own game against an agent.
 *
 *   node tools/bot.mjs <brain.ts> --host localhost:8787 --room abc123 [--name Bot] [--start] [--count 1] [--status 15]
 *
 *   --status <s>   log a status line (phase, tick, seat, inputs sent, rtt) every s seconds (default 15; 0 = off)
 *
 * The brain module exports:
 *   export { game } from './game';                     // the game definition
 *   export function decide(state, seat, room) { return [cmd, ...]; }   // called once a second
 *   export const thinkMs = 1000;                       // optional
 *
 * Behind an HTTP proxy (cloud sandboxes): Node's WebSocket ignores HTTPS_PROXY;
 * run with NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle>.
 */
import { existsSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const statusEvery = Number(opt('--status', 15)) * 1000;
let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  console.error('lobbyhop bot needs esbuild: npm i -D esbuild');
  process.exit(1);
}
const baseName = opt('--name', 'Bot');

// Bundle the brain (TypeScript, game imports) with the lobbyhop client into one module.
// Bundle into a temp dir (never into node_modules, which may be read-only), removed on exit.
const outDir = mkdtempSync(join(tmpdir(), 'lobbyhop-bot-'));
const outfile = join(outDir, 'bot.mjs');
const cleanup = () => rmSync(outDir, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
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
  // Synchronous writes: output survives being piped and killed (e.g. `timeout 60 lobbyhop bot … | tee log`).
  const say = (t) => writeSync(1, `[${stamp()}] ${name}: ${t}\n`);
  room.on('notice', (t) => say(`server: ${t}`));
  room.on('phase', (p) => say(`phase → ${p}`));
  let lastThink = 0;
  let last = performance.now();
  let started = false;
  let sent = 0;
  let lastStatus = performance.now();
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
    if (statusEvery > 0 && now - lastStatus >= statusEvery) {
      lastStatus = now;
      say(`${room.status} · ${room.phase} · tick ${room.tick} · seat ${room.seat ?? 'spectating'} · ${sent} inputs sent · ${room.pending.length} pending · rtt ${room.rtt ?? '?'} ms`);
    }
    if (!state || room.phase !== 'playing' || room.seat === null) return;
    if (now - lastThink > (brain.thinkMs ?? 1000)) {
      lastThink = now;
      for (const cmd of brain.decide(state, room.seat, room) ?? []) if (room.submit(cmd) !== null) sent++;
    }
  }, 50);
  say(`joining ${room.url}`);
}
