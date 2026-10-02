#!/usr/bin/env node
/**
 * lobbyhop CLI: docs, scaffolding and verification tools for agents and humans.
 * Run `npx lobbyhop help`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, def) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : def);
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));

const HELP = `lobbyhop ${pkg.version}: agent-first multiplayer for browser games

  lobbyhop docs                      list the bundled guides
  lobbyhop docs cat <name>           print one (e.g. GUIDE.md, CHOOSING.md, DEPLOY.md)
  lobbyhop docs find <term>          search all guides
  lobbyhop skill                     print the integration recipe (SKILL.md)

  lobbyhop init [options]            scaffold multiplayer into the current project
      --mode lockstep|statesync      sync model (default statesync; see docs CHOOSING.md)
      --host cloudflare|node|both    room hosting (default cloudflare)
      --game <path>                  game definition file (default src/multiplayer/game.ts)
      --name <name>                  worker/app name (default: package.json name)
  lobbyhop examples                  list examples
  lobbyhop examples pull <name> [dir]   copy an example into your project

  lobbyhop audit <dir|file...>       grep lockstep sim code for determinism hazards
                                     (point it at sim files only; silence a reviewed line
                                     with a trailing // lobbyhop-audit-ignore comment)
  lobbyhop e2e --url <url> [-n 2]    N-browser smoke test (see tools/e2e.mjs)
  lobbyhop determinism <scenario.ts> cross-engine determinism check (lockstep)
  lobbyhop bot <brain.ts> --host <h> --room <code>   headless player
`;

function docsDir() {
  return join(pkgRoot, 'docs');
}

function listDocs() {
  const out = [];
  for (const f of readdirSync(docsDir()).sort()) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(docsDir(), f), 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) ?? [, f])[1];
    const blurb = (text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').slice(0, 100);
    out.push({ f, title, blurb });
  }
  return out;
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function writeNew(path, text, made) {
  if (existsSync(path)) {
    console.log(`  skip   ${relative(process.cwd(), path)} (exists)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  made.push(path);
  console.log(`  create ${relative(process.cwd(), path)}`);
}

function runTool(file, args) {
  const r = spawnSync(process.execPath, [join(pkgRoot, 'tools', file), ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

switch (cmd) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;

  case '--version':
  case 'version':
    console.log(pkg.version);
    break;

  case 'docs': {
    const sub = positional[0];
    if (!sub || sub === 'ls') {
      for (const d of listDocs()) console.log(`${d.f.padEnd(20)} ${d.title}`);
      console.log(`\nRead one: npx lobbyhop docs cat GUIDE.md`);
    } else if (sub === 'cat') {
      const name = positional[1] ?? 'GUIDE.md';
      const file = [name, `${name}.md`, name.toUpperCase(), `${name.toUpperCase()}.md`].map((n) => join(docsDir(), n)).find(existsSync);
      if (!file) {
        console.error(`No doc named ${name}. Try: npx lobbyhop docs`);
        process.exit(1);
      }
      process.stdout.write(readFileSync(file, 'utf8'));
    } else if (sub === 'find' || sub === 'grep') {
      const term = positional.slice(1).join(' ').toLowerCase();
      if (!term) {
        console.error('usage: lobbyhop docs find <term>');
        process.exit(1);
      }
      for (const d of listDocs()) {
        const lines = readFileSync(join(docsDir(), d.f), 'utf8').split('\n');
        lines.forEach((l, i) => l.toLowerCase().includes(term) && console.log(`${d.f}:${i + 1}: ${l.trim().slice(0, 160)}`));
      }
    } else {
      console.error(HELP);
      process.exit(1);
    }
    break;
  }

  case 'skill':
    process.stdout.write(readFileSync(join(pkgRoot, 'skills', 'lobbyhop', 'SKILL.md'), 'utf8'));
    break;

  case 'init': {
    const mode = opt('--mode', 'statesync');
    const host = opt('--host', 'cloudflare');
    const gamePath = resolve(opt('--game', 'src/multiplayer/game.ts'));
    let name = opt('--name');
    if (!name) {
      try {
        name = JSON.parse(readFileSync('package.json', 'utf8')).name;
      } catch {
        name = basename(process.cwd());
      }
    }
    name = String(name || 'my-game')
      .toLowerCase()
      .replace(/^@[^/]+\//, '')
      .replace(/[^a-z0-9-]/g, '-');
    if (!['lockstep', 'statesync'].includes(mode) || !['cloudflare', 'node', 'both'].includes(host)) {
      console.error(HELP);
      process.exit(1);
    }
    const t = (p) => readFileSync(join(pkgRoot, 'templates', p), 'utf8');
    const rel = (from) => {
      let r = relative(dirname(from), gamePath).replace(/\\/g, '/').replace(/\.ts$/, '');
      if (!r.startsWith('.')) r = `./${r}`;
      return r;
    };
    const made = [];
    console.log(`lobbyhop init: ${mode}, hosted on ${host}`);
    writeNew(gamePath, fill(t(`game.${mode}.ts`), { NAME: name }), made);
    if (host !== 'node') {
      writeNew(resolve('worker.ts'), fill(t('cloudflare/worker.ts'), { GAME_IMPORT: rel(resolve('worker.ts')) }), made);
      writeNew(resolve('wrangler.jsonc'), fill(t('cloudflare/wrangler.jsonc'), { NAME: name }), made);
    }
    if (host !== 'cloudflare') {
      writeNew(resolve('server.ts'), fill(t('node/server.ts'), { GAME_IMPORT: rel(resolve('server.ts')), NAME: name }), made);
      writeNew(resolve('Dockerfile'), t('node/Dockerfile'), made);
      writeNew(resolve('fly.toml'), fill(t('node/fly.toml'), { NAME: name }), made);
    }
    writeNew(resolve('.env.development'), t('env.development'), made);
    // Keep local server state and build output out of git.
    const gi = resolve('.gitignore');
    const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const want = ['.wrangler', 'dist', 'out'].filter((l) => !have.split(/\r?\n/).some((x) => x.replace(/\/$/, '') === l || x === `/${l}`));
    if (want.length) {
      writeFileSync(gi, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${want.join('\n')}\n`);
      console.log(`  update .gitignore (+${want.join(', ')})`);
    }
    const deps = host === 'cloudflare' ? 'npm i -D wrangler' : host === 'node' ? 'npm i ws && npm i -D tsx esbuild' : 'npm i ws && npm i -D wrangler tsx esbuild';
    console.log(`
Next:
  1. ${deps}
  2. Write your rules in ${relative(process.cwd(), gamePath)} (npx lobbyhop docs cat GUIDE.md)
  3. In the browser:
       import { getRoomCode, joinRoom } from 'lobbyhop/client';
       import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
       const room = joinRoom(game, { room: getRoomCode()!, host: import.meta.env.VITE_ROOM_HOST });
       mountLobby(room, { title: '${name}' }); mountStatus(room);
       // each frame: const { state, alpha, events } = room.advance(dt);  input: room.submit(cmd)
  4. Run: ${host === 'node' ? 'vite build && npx tsx server.ts' : 'vite build && npx wrangler dev   (or vite + wrangler dev side by side)'}
  5. Typecheck: make sure tsconfig "include" covers ${host === 'node' ? 'server.ts' : 'worker.ts'} (it's at the project root).
  6. Deploy: npx lobbyhop docs cat DEPLOY.md
Templates to copy from: npx lobbyhop examples (tictactoe = turn-based, arena = real-time lockstep, cursors = drop-in).`);
    break;
  }

  case 'examples': {
    const exDir = join(pkgRoot, 'examples');
    const names = readdirSync(exDir).filter((n) => existsSync(join(exDir, n, 'game.ts')));
    if (positional[0] !== 'pull') {
      for (const n of names) {
        const first = readFileSync(join(exDir, n, 'game.ts'), 'utf8').match(/\/\*\*\s*\n\s*\*\s*(.+)/);
        console.log(`${n.padEnd(12)} ${first ? first[1] : ''}`);
      }
      console.log(`\nCopy one: npx lobbyhop examples pull <name> [dir]`);
      break;
    }
    const name = positional[1];
    if (!names.includes(name)) {
      console.error(`Unknown example. One of: ${names.join(', ')}`);
      process.exit(1);
    }
    const dest = resolve(positional[2] ?? name);
    if (existsSync(dest) && readdirSync(dest).length) {
      console.error(`${dest} is not empty`);
      process.exit(1);
    }
    cpSync(join(exDir, name), dest, { recursive: true });
    // Outside the lobbyhop repo, imports resolve to the installed package: drop the repo-only alias.
    const wr = join(dest, 'wrangler.jsonc');
    if (existsSync(wr)) {
      let w = readFileSync(wr, 'utf8');
      w = w.replace(/,?\s*\/\/ Only needed inside the lobbyhop repo[\s\S]*?"alias":\s*\{[\s\S]*?\}/, '');
      w = w.replace(/"\.\.\/\.\.\/dist-examples\/[\w-]+"/, '"./dist"').replace('../../node_modules/wrangler', 'node_modules/wrangler');
      writeFileSync(wr, w);
    }
    console.log(`Copied ${name} to ${relative(process.cwd(), dest) || '.'}.
In that folder: \`npx vite build --outDir dist\`, then \`npx wrangler dev\` (or \`npx tsx server.ts\`).
Open http://localhost:8787 in two windows.`);
    break;
  }

  case 'audit': {
    const targets = (positional.length ? positional : ['src']).map((p) => resolve(p));
    let patterns;
    try {
      ({ AUDIT_PATTERNS: patterns } = await import(pathToFileURL(join(pkgRoot, 'dist', 'det', 'index.js')).href));
    } catch {
      console.error('lobbyhop is not built (dist/ missing). Run `npm run build` in the package.');
      process.exit(1);
    }
    const files = [];
    const walk = (p) => {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const f of readdirSync(p)) if (f !== 'node_modules' && !f.startsWith('.')) walk(join(p, f));
      } else if (/\.(ts|tsx|js|mjs|jsx)$/.test(p) && !/\.(test|spec)\./.test(p)) files.push(p);
    };
    for (const t of targets) walk(t);
    let hits = 0;
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\/?\*)/.test(line) || line.includes('lobbyhop-audit-ignore')) return;
          for (const { pattern, why } of patterns) {
            if (pattern.test(line)) {
              hits++;
              console.log(`${relative(process.cwd(), f)}:${i + 1}: ${line.trim().slice(0, 100)}\n    → ${why}`);
            }
          }
        });
    }
    console.log(hits ? `\n${hits} potential determinism hazard(s) in ${files.length} files. Review each; not every hit is a bug (e.g. Math.random in rendering is fine).` : `No hazards found in ${files.length} files.`);
    process.exit(hits ? 1 : 0);
  }

  case 'e2e':
    runTool('e2e.mjs', rest);
    break;
  case 'determinism':
    runTool('determinism.mjs', rest);
    break;
  case 'bot':
    runTool('bot.mjs', rest);
    break;

  default:
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
}
