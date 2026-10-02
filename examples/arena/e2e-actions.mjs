/**
 * Arena-specific actions for tools/e2e.mjs:
 *   node tools/e2e.mjs --example arena --script examples/arena/e2e-actions.mjs
 * Holds direction keys long enough to roam, and drops walls next to yourself.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PATHS = [['d', 's'], ['a', 'w'], ['s', 'a'], ['w', 'd']];

export async function act(page, i, round) {
  const keys = PATHS[(i + Math.floor(round / 4)) % PATHS.length];
  for (const k of keys) await page.keyboard.down(k);
  await wait(500);
  for (const k of keys) await page.keyboard.up(k);
  if (round % 2 === 0) {
    // Click a cell beside our runner: walls must be placed nearby.
    const pt = await page.evaluate(() => {
      const r = window.lobbyhop.room;
      const me = r.state?.players[r.seat];
      const c = document.querySelector('canvas');
      if (!me || !c) return null;
      const k = c.getBoundingClientRect().width / c.width;
      const scale = Math.min(c.width / 42, c.height / 26);
      const ox = (c.width - 40 * scale) / 2;
      const oy = (c.height - 24 * scale) / 2;
      return { x: (ox + (Math.floor(me.x) + 2.5) * scale) * k, y: (oy + (Math.floor(me.y) + 0.5) * scale) * k };
    });
    if (pt) await page.mouse.click(pt.x, pt.y);
  }
}
