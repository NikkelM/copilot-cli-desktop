// Assemble everything the sidecar needs to run from an installed copy of the app.
//
// The app is a Tauri shell that starts a Node process. In development that process is the
// compiled tree in `sidecar/dist` with the repository's own `node_modules` beside it; in an
// installed copy neither exists, so both have to be carried in the bundle.
//
// The dependencies are taken from the tree the repository is running and testing against,
// rather than installed fresh here. Installing fresh resolved carets at packaging time, so
// a release could ship a different `@github/copilot-sdk` closure than anything anyone had
// run - decided by what happened to be published the moment the release job ran. For an app
// whose whole job is to talk to that SDK, that is the dependency most worth pinning.
//
// Copying is also offline and quick, which takes a network round trip out of the release.
// The closure is asked for rather than guessed: `npm ls` names every package that actually
// runs, so a transitive dependency cannot be left behind by hand-picking out of a hoisted
// tree - which was the reason this installed fresh in the first place.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, 'src-tauri', 'sidecar-bundle');
const compiled = join(root, 'sidecar', 'dist');

if (!existsSync(compiled)) {
  console.error('sidecar/dist is missing - run `npm run build:sidecar` first');
  process.exit(1);
}

/**
 * Every package the sidecar needs at runtime, as absolute paths.
 *
 * Asked of npm from inside the workspace, so it is the production closure of the sidecar
 * alone and not of the root project's build tooling. Platform-specific optional packages -
 * the SDK's native binary and koffi's - are included when they are installed, which on a
 * per-platform release job is the right ones for the artifact being built.
 */
function closure() {
  let listed;
  try {
    // Through a shell on Windows because npm is a `.cmd` there and Node refuses to spawn one
    // any other way. That is what the warning about unescaped arguments is for; every
    // argument here is a fixed literal, so there is nothing to escape.
    listed = execFileSync('npm', ['ls', '-a', '--omit=dev', '--parseable'], {
      cwd: join(root, 'sidecar'),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  } catch (error) {
    console.error('could not read the sidecar dependency tree - run `npm install` first');
    console.error(error.stdout || error.message);
    process.exit(1);
  }

  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path !== root)
    // The workspace links to itself through `node_modules`, and the compiled tree is copied
    // separately below. Following that link would nest the whole repository in the bundle.
    .filter((path) => existsSync(path) && !lstatSync(path).isSymbolicLink());
}

const packages = closure();
if (!packages.length) {
  console.error('the sidecar dependency tree came back empty - run `npm install` first');
  process.exit(1);
}

const versionOf = (path) => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version;

// What is in the bundle, so an unchanged tree can be left alone. Declaring this directory as
// a bundle resource means tauri-build refuses to compile the crate without it - including
// for `tauri dev` - so this runs before the app starts too, and copying 120MB on every
// launch would make starting the app take ten seconds for no reason.
const stamp = `${JSON.stringify(
  packages.map((path) => [relative(root, path).split(sep).join('/'), versionOf(path)]).sort(),
  null,
  2,
)}\n`;
const stampPath = join(staging, 'bundled-packages.json');

const current =
  existsSync(join(staging, 'node_modules')) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8') === stamp;

mkdirSync(staging, { recursive: true });

// The compiled tree is cheap and changes constantly, so it is always replaced. Removing it
// first because cpSync merges rather than replaces, and a file deleted from the sidecar
// would otherwise linger here and be shipped.
rmSync(join(staging, 'dist'), { recursive: true, force: true });
cpSync(compiled, join(staging, 'dist'), { recursive: true });

// The dev channel is a loopback socket that accepts prompts for any session, switched on by
// an environment variable. Nothing in a shipped app sets it, but a guard that anything able
// to set a variable on this process can lift is not much of one, so the module is left out
// of the bundle rather than shipped and told not to listen. `index.ts` imports it on demand
// and carries on without it, so its absence is expected rather than a broken build.
rmSync(join(staging, 'dist', 'sidecar', 'src', 'devChannel.js'), { force: true });

// Exact versions, and only the direct dependencies: this describes what was copied rather
// than deciding it, and a range here would invite someone to reinstall it into something
// else. Nothing reads it at runtime - Node resolves from `node_modules` beside it - so it
// is here to say what the bundle contains.
const direct = JSON.parse(readFileSync(join(root, 'sidecar', 'package.json'), 'utf8')).dependencies ?? {};
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'copilot-cli-desktop-sidecar',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        Object.keys(direct).map((name) => [name, versionOf(join(root, 'node_modules', ...name.split('/')))]),
      ),
    },
    null,
    2,
  )}\n`,
);

if (current) {
  console.log('sidecar bundle: dependencies unchanged, refreshed the compiled tree only');
  process.exit(0);
}

// Replaced wholesale rather than merged, so a package dropped from the closure does not
// linger here and ship. Paths keep their position under `node_modules`, so two versions of
// one package stay nested where npm put them instead of colliding at the top.
rmSync(join(staging, 'node_modules'), { recursive: true, force: true });
for (const path of packages) {
  const destination = join(staging, relative(root, path));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(path, destination, { recursive: true });
}

writeFileSync(stampPath, stamp);

const walk = (dir) =>
  execFileSync(process.execPath, [
    '-e',
    `const {readdirSync,statSync}=require('node:fs'),{join}=require('node:path');
     const w=(d)=>readdirSync(d,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?w(join(d,e.name)):statSync(join(d,e.name)).size),0);
     process.stdout.write(String(w(${JSON.stringify(dir)})));`,
  ]).toString();

console.log(
  `sidecar bundle: ${packages.length} packages, ${(Number(walk(staging)) / 1024 / 1024).toFixed(1)} MB at ${staging}`,
);
