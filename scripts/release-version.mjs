import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export function releaseVersion(value) {
  const matched = typeof value === 'string'
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(value)
    : null;
  if (!matched) {
    throw new Error('Use Major.Minor.Patch or Major.Minor.Patch-beta.N without a leading v or leading zeroes');
  }
  const [major, minor, patch] = matched.slice(1, 4).map(Number);
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error('Windows installers require major and minor at most 255, and patch at most 65535');
  }
  if (matched[4] && Number(matched[4]) >= 65535) {
    throw new Error('Prerelease build numbers must be between 1 and 65534 for Windows installers');
  }
  return value;
}

export function setReleaseVersion(root, value) {
  const version = releaseVersion(value);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== version) throw new Error('Run npm version with --no-git-tag-version before setting the native version');
  const configurationPath = join(root, 'src-tauri', 'tauri.conf.json');
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  configuration.version = version;
  const [base, prerelease] = version.split('-beta.');
  configuration.bundle ??= {};
  configuration.bundle.windows ??= {};
  configuration.bundle.windows.wix ??= {};
  configuration.bundle.windows.wix.version = `${base}.${prerelease ?? '65535'}`;
  const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
  const cargo = readFileSync(cargoPath, 'utf8');
  const start = cargo.search(/^\[package\]\s*$/m);
  if (start < 0) throw new Error('Cargo package section was not found');
  const remaining = cargo.slice(start);
  const end = remaining.indexOf('\n[');
  const section = end < 0 ? remaining : remaining.slice(0, end);
  if (!/^version\s*=\s*"[^"]+"/m.test(section)) throw new Error('Cargo package version was not found');
  const updatedSection = section.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  const updated = cargo.slice(0, start) + updatedSection + remaining.slice(section.length);
  writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`);
  writeFileSync(cargoPath, updated);
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        set: { type: 'boolean', default: false },
        prerelease: { type: 'boolean', default: false },
        build: { type: 'string' },
      },
    });
    let version = releaseVersion(positionals[0]);
    if (values.prerelease) {
      if (version.includes('-')) throw new Error('Enter the base version when assigning an automatic prerelease number');
      version = releaseVersion(`${version}-beta.${values.build ?? ''}`);
    } else if (values.build) {
      throw new Error('--build requires --prerelease');
    }
    if (values.set) setReleaseVersion(process.cwd(), version);
    console.log(version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
