#!/usr/bin/env node
/**
 * Cross-engine determinism check for lockstep games. Bundles a scenario
 * module, runs it in Node (V8) as the reference, then in Chromium, Firefox and
 * WebKit via Playwright, and compares the recorded state hashes.
 *
 *   node tools/determinism.mjs <scenario.ts> [--minutes 10] [--seeds a,b] [--require-all]
 *
 * The scenario module must set `globalThis.runScenario = (seed, minutes) => number[]`
 * (see examples/arena/determinism.ts; `recordHashes` from lobbyhop/testing does the work).
 * --require-all: fail unless every engine ran (use in CI after
 * `npx playwright install --with-deps chromium firefox webkit`).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { alias, root } from './example-config.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const entry = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!entry || !existsSync(entry)) {
  console.error('usage: node tools/determinism.mjs <scenario.ts> [--minutes 10] [--seeds a,b] [--require-all]');
  process.exit(1);
}
const requireAll = argv.includes('--require-all');
const minutes = Number(opt('--minutes', 10));
const seeds = opt('--seeds', 'det-a,det-b').split(',');

const out = await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'neutral',
  target: 'es2020',
  mainFields: ['module', 'main'],
  alias: existsSync(join(root, 'src', 'index.ts')) ? alias : {},
  logLevel: 'warning',
});
const code = out.outputFiles[0].text;

const t0 = Date.now();
const ctx = vm.createContext({ JSON, Math, Object, Array, Set, Map, Number, String, Symbol, Error, Uint8Array, crypto: globalThis.crypto });
vm.runInContext(code, ctx);
const reference = seeds.map((seed) => ctx.runScenario(seed, minutes));
console.log(`node: ${seeds.map((s, i) => `${s}: ${reference[i].length - 2} checkpoints, ${reference[i].at(-2)} ticks`).join('; ')} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.log('playwright not installed; only Node was checked');
  process.exit(requireAll ? 1 : 0);
}

let failed = false;
const ran = ['node'];
for (const name of ['chromium', 'firefox', 'webkit']) {
  let browser;
  try {
    browser = await playwright[name].launch();
  } catch (e) {
    console.log(`${name}: not available (${String(e.message).split('\n')[0].slice(0, 90)})`);
    if (requireAll) failed = true;
    continue;
  }
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>determinism</title>');
  await page.addScriptTag({ content: code });
  const t1 = Date.now();
  const results = await page.evaluate(([sd, m]) => sd.map((s) => globalThis.runScenario(s, m)), [seeds, minutes]);
  await browser.close();
  let engineOk = true;
  seeds.forEach((seed, i) => {
    const a = reference[i];
    const b = results[i];
    const at = a.findIndex((h, k) => h !== b[k]);
    if (at === -1 && a.length === b.length) return;
    engineOk = false;
    console.log(`${name}: MISMATCH in ${seed} at checkpoint ${at}`);
  });
  ran.push(name);
  if (engineOk) console.log(`${name}: identical (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  else failed = true;
}
const crossEngine = ran.includes('firefox') || ran.includes('webkit');
if (failed) console.log('DETERMINISM FAIL');
else if (crossEngine) console.log(`DETERMINISM PASS (${ran.join(', ')})`);
else console.log('DETERMINISM PASS (V8 only: Node and Chromium share an engine, so this is NOT a cross-engine result. Run with Firefox and WebKit installed, e.g. in CI with --require-all.)');
process.exit(failed ? 1 : 0);
