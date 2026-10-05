import { chromium } from 'playwright';
const [mode] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader'] });
const p = await (await b.newContext({ viewport: { width: 800, height: 500 } })).newPage();
await p.goto('http://localhost:8798/?room=persisttest', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.lobbyhop?.room?.state && window.lobbyhop.room.seat !== null, null, { timeout: 60000 });
if (mode === 'build') {
  await p.waitForTimeout(6000);
  // Carry block 9 to a corner and set it down there.
  await p.evaluate(() => window.lobbyhop.room.submit({ type: 'grab', id: '9', t: [-6, 1, -6] }));
  await p.waitForTimeout(2500);
  await p.evaluate(() => window.lobbyhop.room.submit({ type: 'release' }));
  await p.waitForTimeout(5000); // settle + at least one save (saveEveryMs 2 s)
}
await p.waitForTimeout(1500);
const s = await p.evaluate(() => window.lobbyhop.room.state.blocks);
console.log(mode, 'block 9 at', s['9'].p.map((x) => x.toFixed(3)).join(','), '| fingerprint', JSON.stringify(s).length, JSON.stringify(s).split('').reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261));
await b.close();
