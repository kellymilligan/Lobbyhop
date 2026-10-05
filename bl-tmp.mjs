import { chromium } from 'playwright';
const url = 'http://localhost:8798/?room=shot' + Date.now().toString(36);
const launch = async () => (await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] })).newContext({ viewport: { width: 1100, height: 700 } });
const errs = [];
const open = async (ctx, name) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(name + ': ' + e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(name + ' console: ' + m.text().slice(0, 200))); await p.goto(url, { waitUntil: 'domcontentloaded' }); return p; };
const a = await open(await launch(), 'A');
await a.waitForFunction(() => window.lobbyhop?.room?.state && Object.keys(window.lobbyhop.room.state.blocks).length === 100, null, { timeout: 60000 });
console.log('A backend', await a.evaluate(() => window.lobbyhop.backend), 'seat', await a.evaluate(() => window.lobbyhop.room.seat));
const b = await open(await launch(), 'B');
await b.waitForFunction(() => window.lobbyhop?.room?.state && window.lobbyhop.room.seat !== null, null, { timeout: 60000 });
await a.waitForTimeout(8000); // let the pile settle
await a.screenshot({ path: 'out/blocks-pile.png' });
// B carries block 5 up high via the API (same commands the pointer sends), A watches.
await b.evaluate(() => { const r = window.lobbyhop.room; r.submit({ type: 'grab', id: '5', t: [3, 4, 3] }); r.submit({ type: 'aim', p: [3, 4, 3] }); });
await a.waitForTimeout(2500);
await a.screenshot({ path: 'out/blocks-carry.png' });
const pos = await a.evaluate(() => window.lobbyhop.room.state.blocks['5'].p);
console.log('block 5 seen by A at', pos.map((x) => x.toFixed(2)).join(','), 'held:', JSON.stringify(await a.evaluate(() => window.lobbyhop.room.state.holds)));
await b.evaluate(() => window.lobbyhop.room.submit({ type: 'release' }));
// A drags whatever block is under the mouse with the real pointer.
const pt = await a.evaluate(() => { const m = window.lobbyhop.meshes.get('12'); const v = m.position.clone().project(window.lobbyhop.camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight }; });
await a.mouse.move(pt.x, pt.y); await a.mouse.down();
await a.waitForTimeout(400);
const grabbed = await a.evaluate(() => window.lobbyhop.room.state.holds[String(window.lobbyhop.room.seat)]);
const start = await a.evaluate((id) => window.lobbyhop.room.state.blocks[id].p, grabbed);
for (let i = 1; i <= 15; i++) { await a.mouse.move(pt.x - i * 14, pt.y - i * 3); await a.waitForTimeout(60); }
await a.waitForTimeout(900);
await a.screenshot({ path: 'out/blocks-drag.png' });
await a.mouse.up();
await a.waitForTimeout(3000);
const end = await a.evaluate((id) => window.lobbyhop.room.state.blocks[id].p, grabbed);
console.log('mouse grabbed block', grabbed, 'from', start.map((x) => x.toFixed(1)).join(','), 'to', end.map((x) => x.toFixed(1)).join(','));
const same = await Promise.all([a, b].map((p) => p.evaluate(() => JSON.stringify(window.lobbyhop.room.state.blocks))));
console.log('A/B block views identical:', same[0] === same[1]);
console.log('errors:', errs.length ? errs : 'none');
process.exit(0);
