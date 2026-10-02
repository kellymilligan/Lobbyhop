#!/usr/bin/env node
/**
 * Builds an example and serves it together with its rooms on one origin.
 *
 *   npm run server counter            # Cloudflare: wrangler dev (Durable Objects, local)
 *   npm run server counter -- --node  # Node: the `ws` adapter, no wrangler needed
 *   options: --port 8787  --no-build
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { alias, pickExample, root, viteConfig } from './example-config.mjs';

const args = process.argv.slice(2);
const name = pickExample(args.find((a) => !a.startsWith('--')));
const node = args.includes('--node');
const port = Number(args[args.indexOf('--port') + 1]) || 8787;

if (!args.includes('--no-build')) await viteBuild(viteConfig(name, { mode: 'production', logLevel: 'warn' }));
const dir = join(root, 'examples', name);

if (node) {
  // Bundle the example's server.ts (TypeScript) to plain JS, then run it.
  const outfile = join(root, 'dist-examples', `${name}-server.mjs`);
  await esbuild({ entryPoints: [join(dir, 'server.ts')], bundle: true, platform: 'node', format: 'esm', outfile, alias, external: ['ws'], logLevel: 'warning' });
  const child = spawn(process.execPath, [outfile], { stdio: 'inherit', env: { ...process.env, PORT: String(port), STATIC_DIR: join(root, 'dist-examples', name) } });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const child = spawn('npx', ['wrangler', 'dev', '-c', join(dir, 'wrangler.jsonc'), '--port', String(port), '--ip', '0.0.0.0'], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
}
