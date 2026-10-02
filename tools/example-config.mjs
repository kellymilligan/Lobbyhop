/**
 * Shared build config for the examples in this repo. Examples import
 * `lobbyhop/*` exactly like a real project would; here those imports are
 * aliased to the source in src/ so edits show up without a build step.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUBPATHS = ['client', 'server', 'cloudflare', 'node', 'testing', 'det', 'lobby-ui'];

export const alias = {
  ...Object.fromEntries(SUBPATHS.map((p) => [`lobbyhop/${p}`, join(root, 'src', p, 'index.ts')])),
  lobbyhop: join(root, 'src', 'index.ts'),
};

export function examples() {
  return readdirSync(join(root, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, 'examples', d.name, 'index.html')))
    .map((d) => d.name);
}

export function pickExample(name) {
  const all = examples();
  if (!name || !all.includes(name)) {
    console.error(`usage: <script> <example>   (one of: ${all.join(', ')})`);
    process.exit(1);
  }
  return name;
}

/** Vite config for one example. */
export function viteConfig(name, extra = {}) {
  return {
    root: join(root, 'examples', name),
    envDir: root,
    resolve: { alias },
    logLevel: 'info',
    build: { outDir: join(root, 'dist-examples', name), emptyOutDir: true, target: 'es2022' },
    server: { port: 5173, host: true },
    ...extra,
  };
}
