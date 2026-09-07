// Assemble everything the sidecar needs to run from an installed copy of the app.
//
// The app is a Tauri shell that starts a Node process. In development that process is the
// compiled tree in `sidecar/dist` with the repository's own `node_modules` beside it; in an
// installed copy neither exists, so both have to be carried in the bundle.
//
// Production dependencies only, and installed fresh rather than copied from the repository's
// hoisted tree: the root `node_modules` is 407MB of build tooling around 120MB that actually
// ships, and picking the ones that matter out of a hoisted tree by hand is how a missing
// transitive dependency reaches a release.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, 'src-tauri', 'sidecar-bundle');
const compiled = join(root, 'sidecar', 'dist');

if (!existsSync(compiled)) {
  console.error('sidecar/dist is missing - run `npm run build:sidecar` first');
  process.exit(1);
}

// Rebuilt from nothing each time. A stale file left behind here would be shipped, and the
// bundle is the one place where that would not show up until someone installed it.
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

cpSync(compiled, join(staging, 'dist'), { recursive: true });

const { dependencies } = JSON.parse(readFileSync(join(root, 'sidecar', 'package.json'), 'utf8'));
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify({ name: 'copilot-cli-desktop-sidecar', private: true, type: 'module', dependencies }, null, 2)}\n`,
);

// --omit=dev keeps the closure to what runs; --ignore-scripts because nothing here needs to
// build anything, and a postinstall in a dependency has no business running during packaging.
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: staging,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const size = execFileSync(process.execPath, [
  '-e',
  `const {readdirSync,statSync}=require('node:fs'),{join}=require('node:path');
   const walk=(d)=>readdirSync(d,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?walk(join(d,e.name)):statSync(join(d,e.name)).size),0);
   process.stdout.write(String(walk(${JSON.stringify(staging)})));`,
]).toString();

console.log(`sidecar bundle: ${(Number(size) / 1024 / 1024).toFixed(1)} MB at ${staging}`);
