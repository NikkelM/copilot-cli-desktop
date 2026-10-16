import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releaseVersion } from './release-version.mjs';

function installersIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return installersIn(path);
    return entry.isFile() && (entry.name.endsWith('-setup.exe') || entry.name.endsWith('.msi')) ? [path] : [];
  });
}

export function createUpdaterArtifacts({ version, repository, bundle, output, changelog }) {
  releaseVersion(version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const installers = installersIn(bundle);
  const found = new Map();
  for (const path of installers) {
    const originalName = basename(path);
    if (!originalName.includes(`_${version}_`) || !originalName.includes('_x64')) continue;
    const kind = path.endsWith('.msi') ? 'msi' : 'nsis';
    if (found.has(kind)) throw new Error(`Expected one ${kind} installer, found more than one`);
    if (statSync(path).size === 0) throw new Error(`The installer is empty: ${path}`);
    const signaturePath = `${path}.sig`;
    const signature = readFileSync(signaturePath, 'utf8').trim();
    if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error(`Missing or invalid updater signature: ${signaturePath}`);
    const name = originalName.replace(/[^A-Za-z0-9._-]/g, '-');
    found.set(kind, { path, signaturePath, signature, name });
  }
  for (const kind of ['nsis', 'msi']) {
    if (!found.has(kind)) throw new Error(`The signed ${kind} installer was not built`);
  }
  const source = readFileSync(changelog, 'utf8');
  const section = /<!--Releasenotes start-->([\s\S]*?)<!--Releasenotes end-->/.exec(source)?.[1];
  if (!section?.trim()) throw new Error('CHANGELOG.md must contain nonempty release notes between the release-note markers');
  const tag = `v${version}`;
  const notes = `${section.trim()}\n\n**[Full changelog](https://github.com/${repository}/blob/${tag}/CHANGELOG.md)**\n`;
  const platforms = {};
  for (const [kind, artifact] of found) {
    platforms[`windows-x86_64-${kind}`] = {
      signature: artifact.signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(artifact.name)}`,
    };
  }
  platforms['windows-x86_64'] = platforms['windows-x86_64-nsis'];
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
  mkdirSync(output, { recursive: true });
  const paths = [];
  for (const artifact of found.values()) {
    const installer = join(output, artifact.name);
    const signature = `${installer}.sig`;
    copyFileSync(artifact.path, installer);
    copyFileSync(artifact.signaturePath, signature);
    paths.push(installer, signature);
  }
  const manifestPath = join(output, 'latest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, 'RELEASE_NOTES.md'), notes);
  paths.push(manifestPath);
  return { manifest, paths };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        version: { type: 'string' }, repository: { type: 'string' },
        bundle: { type: 'string' }, output: { type: 'string' }, changelog: { type: 'string' },
      },
    });
    for (const key of ['version', 'repository', 'bundle', 'output', 'changelog']) {
      if (!values[key]) throw new Error(`--${key} is required`);
    }
    const result = createUpdaterArtifacts({
      version: values.version, repository: values.repository,
      bundle: resolve(values.bundle), output: resolve(values.output), changelog: resolve(values.changelog),
    });
    console.log(result.paths.join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
