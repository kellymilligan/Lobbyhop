#!/usr/bin/env node
/** Builds an example's page into dist-examples/<name> (used by deploy workflows). */
import { build } from 'vite';
import { pickExample, viteConfig } from './example-config.mjs';

const name = pickExample(process.argv[2]);
await build(viteConfig(name, { mode: 'production', logLevel: 'warn' }));
console.log(`built dist-examples/${name}`);
