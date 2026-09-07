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

const { dependencies } = JSON.parse(readFileSync(join(root, 'sidecar', 'package.json'), 'utf8'));
const manifest = `${JSON.stringify({ name: 'copilot-cli-desktop-sidecar', private: true, type: 'module', dependencies }, null, 2)}\n`;
const manifestPath = join(staging, 'package.json');

// Declaring this directory as a bundle resource means tauri-build refuses to compile the
// crate without it - including for `tauri dev`. So this runs before the app starts too, and
// has to be cheap when nothing has changed: installing 120MB of dependencies on every launch
// would make starting the app take ten seconds for no reason.
const installed =
  existsSync(join(staging, 'node_modules')) &&
  existsSync(manifestPath) &&
  readFileSync(manifestPath, 'utf8') === manifest;

mkdirSync(staging, { recursive: true });

// The compiled tree is cheap and changes constantly, so it is always replaced. Removing it
// first because cpSync merges rather than replaces, and a file deleted from the sidecar
// would otherwise linger here and be shipped.
rmSync(join(staging, 'dist'), { recursive: true, force: true });
cpSync(compiled, join(staging, 'dist'), { recursive: true });

if (installed) {
  console.log('sidecar bundle: dependencies unchanged, refreshed the compiled tree only');
  process.exit(0);
}

writeFileSync(manifestPath, manifest);

// --omit=dev keeps the closure to what runs; --ignore-scripts because nothing here needs to
// build anything, and a postinstall in a dependency has no business running during packaging.
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: staging,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const walk = (dir) =>
  execFileSync(process.execPath, [
    '-e',
    `const {readdirSync,statSync}=require('node:fs'),{join}=require('node:path');
     const w=(d)=>readdirSync(d,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?w(join(d,e.name)):statSync(join(d,e.name)).size),0);
     process.stdout.write(String(w(${JSON.stringify(dir)})));`,
  ]).toString();

console.log(`sidecar bundle: ${(Number(walk(staging)) / 1024 / 1024).toFixed(1)} MB at ${staging}`);
