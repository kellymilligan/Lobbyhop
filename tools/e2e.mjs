#!/usr/bin/env node
/**
 * N-browser multiplayer smoke test. Each player is its own headless Chromium
 * process (software rendering in one process starves a second page). Players
 * join one room through the real lobby UI, the host starts, everyone plays,
 * then (lockstep) the host pauses and every client must come to rest on the
 * same tick with the same state hash.
 *
 *   node tools/e2e.mjs --example arena                 # builds + serves with wrangler, 2 players
 *   node tools/e2e.mjs --example arena --node -n 3     # Node server instead, 3 players
 *   node tools/e2e.mjs --url http://localhost:8787/ -n 2 --script my-actions.mjs
 *
 * Options:
 *   --example <name>   build and serve examples/<name> (stopped afterwards)
 *   --node             serve with the Node adapter instead of wrangler
 *   --url <url>        an already running game (any lobbyhop app exposing window.lobbyhop.room)
 *   -n <players>       number of browsers (default 2)
 *   --seconds <s>      how long to play (default 12)
 *   --script <file>    module exporting `async act(page, playerIndex, round)`, called for every
 *                      player each round (~200 ms apart). playerIndex follows arrival order, so
 *                      0 is the host; read seat/turn/state from `window.lobbyhop.room` inside
 *                      page.evaluate. Default: random WASD presses and clicks.
 *   --out <dir>        screenshots (default out/e2e)
 *
 * The page must expose `window.lobbyhop = { room }` (every example does).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const example = opt('--example');
const players = Number(opt('-n', 2));
const seconds = Number(opt('--seconds', 12));
const out = resolve(opt('--out', 'out/e2e'));
const port = Number(opt('--port', 8790));
let url = opt('--url');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const stop = () => {
  // Kill only the process group we started (never pattern-match: it can hit your own shell).
  if (server && !server.killed) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

if (example) {
  const args = ['tools/server.mjs', example, '--port', String(port)];
  if (argv.includes('--node')) args.push('--node');
  server = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  url = `http://localhost:${port}/`;
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > end || server.exitCode !== null) {
      console.error(log.slice(-3000));
      throw new Error('server did not start');
    }
    await wait(500);
  }
  console.log(`serving ${example} at ${url}${argv.includes('--node') ? ' (node)' : ' (wrangler)'}`);
}
if (!url) {
  console.error('give --example <name> or --url <url>');
  process.exit(1);
}

const { chromium } = await import('playwright');
let act = async (page, i, round) => {
  const keys = ['w', 'a', 's', 'd'];
  const k = keys[(i * 7 + round * 3) % 4];
  await page.keyboard.down(k);
  await wait(150);
  await page.keyboard.up(k);
  if (round % 3 === i % 3) {
    const vp = page.viewportSize();
    await page.mouse.click(vp.width / 2 + ((round * 37) % 200) - 100, vp.height / 2 + ((round * 53) % 160) - 80);
  }
};
const scriptPath = opt('--script');
if (scriptPath) act = (await import(pathToFileURL(resolve(scriptPath)).href)).act;

const room = `e2e${Date.now().toString(36).slice(-5)}`;
const pageUrl = `${url}${url.includes('?') ? '&' : '?'}room=${room}`;
const browsers = [];
const errors = [];

async function player(i) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  browsers.push(browser);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  page.on('pageerror', (e) => errors.push(`[p${i}] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CERT|net::/.test(m.text()) && errors.push(`[p${i} console] ${m.text().slice(0, 200)}`));
  // domcontentloaded: blocked web fonts can stall 'load' in sandboxes.
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.lobbyhop?.room?.connected, null, { timeout: 30_000 });
  return page;
}

const pages = [];
for (let i = 0; i < players; i++) {
  pages.push(await player(i));
  // Arrive in order, so the first browser is host.
  await pages[i].waitForFunction((n) => window.lobbyhop.room.members.length + window.lobbyhop.room.spectators >= n || window.lobbyhop.room.phase !== 'lobby', i + 1, { timeout: 15_000 });
}
const room0 = (p) => p.evaluate(() => ({ phase: window.lobbyhop.room.phase, seat: window.lobbyhop.room.seat, host: window.lobbyhop.room.host, members: window.lobbyhop.room.members.length, mode: window.lobbyhop.room.game.mode }));
const info = await room0(pages[0]);
console.log(`room ${room}: ${info.members} members, mode ${info.mode}, phase ${info.phase}`);

if (info.phase === 'lobby') {
  // Use the real lobby UI: rename, pick a colour, start.
  for (const [i, p] of pages.entries()) {
    const name = p.locator('.lh-panel input[type=text]:not([readonly])').first();
    if (await name.count()) {
      await name.fill(`Player ${i + 1}`);
      await name.press('Enter');
    }
    const swatch = p.locator('.lh-swatch:not(:disabled)').nth(1);
    if (i > 0 && (await swatch.count())) await swatch.click();
  }
  let hostPage = null;
  for (const p of pages) if ((await room0(p)).host) hostPage = p;
  if (!hostPage) throw new Error('no host');
  // Ready-up: every guest but the last says ready, so the host sees the "start anyway?" check.
  const guests = pages.filter((p) => p !== hostPage);
  for (const p of guests.slice(0, -1)) {
    const ready = p.locator('.lh-actions button[aria-pressed]');
    if (await ready.count()) await ready.click();
  }
  await wait(800);
  await hostPage.screenshot({ path: join(out, 'lobby.png') });
  if (guests.length) await guests[0].screenshot({ path: join(out, 'lobby-guest.png') });
  await hostPage.click('.lh-panel .lh-primary');
  const confirm = hostPage.locator('.lh-confirm .lh-primary');
  if (await confirm.count()) {
    await hostPage.screenshot({ path: join(out, 'lobby-confirm.png') });
    console.log('host confirmed "start anyway" (not everyone was ready)');
    await confirm.click();
  }
}
for (const p of pages) await p.waitForFunction(() => window.lobbyhop.room.phase !== 'lobby' && window.lobbyhop.room.state, null, { timeout: 20_000 });
console.log('playing');

const end = Date.now() + seconds * 1000;
for (let round = 0; Date.now() < end; round++) {
  await Promise.all(pages.map((p, i) => act(p, i, round).catch((e) => errors.push(`[p${i} act] ${e.message}`))));
  await wait(200);
}
for (const [i, p] of pages.entries()) await p.screenshot({ path: join(out, `player${i + 1}.png`) });

let ok = errors.length === 0;
if (info.mode === 'lockstep') {
  const hostPage = (await Promise.all(pages.map(async (p) => ((await room0(p)).host ? p : null)))).find(Boolean);
  const over = await hostPage.evaluate(() => window.lobbyhop.room.phase === 'over');
  if (!over) await hostPage.evaluate(() => window.lobbyhop.room.setPaused(true));
  // The server stops issuing turns; wait for every client to drain to the frontier.
  for (const p of pages) {
    await p.waitForFunction(() => {
      const r = window.lobbyhop.room;
      return (r.paused || r.phase === 'over') && r.tick === r.frontier;
    }, null, { timeout: 60_000 });
  }
  await wait(1000);
  const prints = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        const r = window.lobbyhop.room;
        const s = JSON.stringify(r.state);
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return { tick: r.tick, hash: h >>> 0, desyncs: r.desyncs, rtt: r.rtt };
      }),
    ),
  );
  prints.forEach((f, i) => console.log(`player ${i + 1}: tick ${f.tick} hash ${f.hash} desyncs ${f.desyncs} rtt ${f.rtt}ms`));
  const same = prints.every((f) => f.tick === prints[0].tick && f.hash === prints[0].hash);
  const desynced = prints.some((f) => f.desyncs > 0);
  console.log(same ? 'IN SYNC' : 'MISMATCH');
  if (desynced) console.log('DESYNCS: a client drifted and was repaired by snapshot; the sim is not deterministic (see DETERMINISM.md)');
  if (over) console.log('note: the game ended before the time was up, so less was exercised (raise the target or lower --seconds)');
  ok &&= same && !desynced;
} else {
  // State sync: once traffic settles, every client should hold the server's latest view.
  // Without a per-seat `view`, all views are identical, so compare them directly.
  await wait(1500);
  const views = await Promise.all(
    pages.map((p) => p.evaluate(() => ({ tick: window.lobbyhop.room.tick, json: JSON.stringify(window.lobbyhop.room.state), perSeat: !!window.lobbyhop.room.game.view, realtime: window.lobbyhop.room.game.tickRate > 0 }))),
  );
  console.log(`state sync ticks: ${views.map((v) => v.tick).join(', ')}`);
  if (views[0].perSeat) console.log('per-seat views (game.view): not compared across players');
  else if (views[0].realtime) console.log('real-time state sync: views change continuously; not compared (use the harness for exact checks)');
  else {
    const same = views.every((v) => v.json === views[0].json);
    console.log(same ? 'VIEWS MATCH' : 'VIEWS DIFFER');
    ok &&= same;
  }
}
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
console.log(`screenshots in ${out}`);
for (const b of browsers) await b.close();
stop();
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
