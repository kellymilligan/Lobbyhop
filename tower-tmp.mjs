import { chromium, devices } from 'playwright';
const url = 'http://localhost:8798/?room=tower' + Date.now().toString(36);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ viewport: { width: 1200, height: 760 } })).newPage();
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.lobbyhop?.room?.state && window.lobbyhop.room.seat !== null, null, { timeout: 60000 });
await p.waitForTimeout(9000);
// Find flat blocks (slabs/planks/cubes) and stack them at (-4, _, -3), one by one.
const ids = await p.evaluate(() => Object.entries(window.lobbyhop.room.state.blocks).filter(([, b]) => b.s[1] <= 0.5).slice(0, 8).map(([id, b]) => [id, b.s[1]]));
let y = 0;
for (const [id, hy] of ids) {
  y += hy;
  await p.evaluate(([id, y]) => window.lobbyhop.room.submit({ type: 'grab', id, t: [-7, y + 1.2, -7] }), [id, y]);
  await p.waitForTimeout(1600);
  await p.evaluate(([y]) => window.lobbyhop.room.submit({ type: 'drag', t: [-7, y + 0.02, -7] }), [y]);
  await p.waitForTimeout(700);
  await p.evaluate(() => window.lobbyhop.room.submit({ type: 'release' }));
  await p.waitForTimeout(1300);
  y += hy;
}
await p.waitForTimeout(2500);
await p.screenshot({ path: 'out/blocks-tower.png' });
const top = await p.evaluate((id) => window.lobbyhop.room.state.blocks[id].p, ids.at(-1)[0]);
console.log('stacked', ids.length, 'blocks; top block at', top.map((x) => x.toFixed(2)).join(','));
const m = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
await m.goto(url, { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => window.lobbyhop?.room?.state, null, { timeout: 60000 });
await m.waitForTimeout(3000);
await m.screenshot({ path: 'out/blocks-mobile.png' });
await b.close();
