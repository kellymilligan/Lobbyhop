#!/usr/bin/env node
/**
 * Vite dev server (HMR) for an example. Rooms are served separately by
 * `npm run server <example>` on :8787 (see .env.development).
 *
 *   npm run dev:example counter
 */
import { createServer } from 'vite';
import { pickExample, viteConfig } from './example-config.mjs';

const name = pickExample(process.argv[2]);
const server = await createServer(viteConfig(name, { mode: 'development' }));
await server.listen();
server.printUrls();
console.log(`\n  Rooms: run \`npm run server ${name}\` in another terminal (wrangler on :8787).\n`);
