import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const versionScript = fileURLToPath(new URL('../../scripts/release-version.mjs', import.meta.url));
const manifestScript = fileURLToPath(new URL('../../scripts/updater-manifest.mjs', import.meta.url));
let root: string;
let bundle: string;
let output: string;
let changelog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-release-'));
  bundle = join(root, 'bundle');
  output = join(root, 'published');
  changelog = join(root, 'CHANGELOG.md');
  mkdirSync(join(bundle, 'nsis'), { recursive: true });
  mkdirSync(join(bundle, 'msi'), { recursive: true });
  writeFileSync(changelog, '# Changes\n<!--Releasenotes start-->\nReviewed release notes.\n<!--Releasenotes end-->\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function installer(kind: 'nsis' | 'msi', version = '1.2.3', product = 'Copilot CLI Desktop') {
  const filename = kind === 'nsis'
    ? `${product}_${version}_x64-setup.exe`
    : `${product}_${version}_x64_en-US.msi`;
  const path = join(bundle, kind, filename);
  writeFileSync(path, `installer ${kind} ${version}`);
  const signature = Buffer.from(`fixture signature ${kind} ${version}`).toString('base64');
  writeFileSync(`${path}.sig`, `${signature}\n`);
  return { path, filename, signature };
}

function manifest(version = '1.2.3') {
  return spawnSync(process.execPath, [
    manifestScript, '--version', version, '--repository', 'NikkelM/copilot-cli-desktop',
    '--bundle', bundle, '--output', output, '--changelog', changelog,
  ], { cwd: root, encoding: 'utf8' });
}

describe('signed updater release artifacts', () => {
  it('keeps prerelease versions and immutable versioned asset URLs in the manifest', () => {
    installer('nsis', '1.2.3-beta.42');
    installer('msi', '1.2.3-beta.42');
    const result = manifest('1.2.3-beta.42');
    expect(result.status, result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(output, 'latest.json'), 'utf8'));
    expect(metadata.version).toBe('1.2.3-beta.42');
    expect(metadata.platforms['windows-x86_64'].url).toBe(
      'https://github.com/NikkelM/copilot-cli-desktop/releases/download/v1.2.3-beta.42/Copilot-CLI-Desktop_1.2.3-beta.42_x64-setup.exe',
    );
  });

  it('publishes only the requested version, correct installer variants, signatures and an exact static manifest', () => {
    const nsis = installer('nsis');
    const msi = installer('msi');
    installer('nsis', '0.1.0');
    installer('msi', '0.1.0');
    writeFileSync(join(bundle, 'nsis', 'Other_1.2.3_arm64-setup.exe'), 'wrong architecture');
    const result = manifest();
    expect(result.status, result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(output, 'latest.json'), 'utf8'));
    expect(metadata.version).toBe('1.2.3');
    expect(Number.isNaN(Date.parse(metadata.pub_date))).toBe(false);
    expect(Object.keys(metadata.platforms).sort()).toEqual([
      'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
    ]);
    expect(metadata.platforms['windows-x86_64-nsis']).toEqual({
      signature: nsis.signature,
      url: 'https://github.com/NikkelM/copilot-cli-desktop/releases/download/v1.2.3/Copilot-CLI-Desktop_1.2.3_x64-setup.exe',
    });
    expect(metadata.platforms['windows-x86_64-msi']).toEqual({
      signature: msi.signature,
      url: 'https://github.com/NikkelM/copilot-cli-desktop/releases/download/v1.2.3/Copilot-CLI-Desktop_1.2.3_x64_en-US.msi',
    });
    expect(metadata.platforms['windows-x86_64']).toEqual(metadata.platforms['windows-x86_64-nsis']);
    expect(readdirSync(output).sort()).toEqual([
      'Copilot-CLI-Desktop_1.2.3_x64-setup.exe',
      'Copilot-CLI-Desktop_1.2.3_x64-setup.exe.sig',
      'Copilot-CLI-Desktop_1.2.3_x64_en-US.msi',
      'Copilot-CLI-Desktop_1.2.3_x64_en-US.msi.sig',
      'RELEASE_NOTES.md',
      'latest.json',
    ]);
    expect(readFileSync(join(output, nsis.filename.replace(/ /g, '-')), 'utf8')).toBe('installer nsis 1.2.3');
    expect(metadata.notes).toContain('Reviewed release notes.');
    expect(metadata.notes).not.toContain('<!--Releasenotes');
    expect(metadata.notes).toContain('https://github.com/NikkelM/copilot-cli-desktop/blob/v1.2.3/CHANGELOG.md');
  });

  it('does not produce a usable manifest when an installer signature is missing', () => {
    const nsis = installer('nsis');
    installer('msi');
    rmSync(`${nsis.path}.sig`);
    expect(manifest().status).not.toBe(0);
    expect(existsSync(join(output, 'latest.json'))).toBe(false);
  });

  it('rejects an empty installer or signature', () => {
    const nsis = installer('nsis');
    installer('msi');
    writeFileSync(nsis.path, '');
    expect(manifest().stderr).toContain('installer is empty');
    writeFileSync(nsis.path, 'installer');
    writeFileSync(`${nsis.path}.sig`, '');
    expect(manifest().stderr).toContain('invalid updater signature');
  });

  it('requires both supported installer formats and refuses ambiguous duplicates', () => {
    installer('nsis');
    expect(manifest().stderr).toContain('msi installer was not built');
    installer('msi');
    installer('nsis', '1.2.3', 'Another build');
    expect(manifest().stderr).toContain('found more than one');
  });

  it('does not silently publish missing or empty release notes', () => {
    installer('nsis');
    installer('msi');
    writeFileSync(changelog, '# No current release notes');
    expect(manifest().status).not.toBe(0);
    expect(existsSync(join(output, 'latest.json'))).toBe(false);
    writeFileSync(changelog, '<!--Releasenotes start-->\n\n<!--Releasenotes end-->');
    expect(manifest().stderr).toContain('nonempty release notes');
  });
});

describe('release version stamping', () => {
  it('assigns a unique prerelease version from the workflow build number', () => {
    for (const build of ['41', '42', '65534']) {
      const result = spawnSync(process.execPath, [
        versionScript, '1.2.3', '--prerelease', '--build', build,
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`1.2.3-beta.${build}`);
    }
  });

  it.each(['0', '01', '65535', '-1', 'text'])('rejects invalid numeric beta build %s', (build) => {
    const result = spawnSync(process.execPath, [
      versionScript, '1.2.3', '--prerelease', '--build', build,
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  });

  it('maps named beta versions to numeric MSI versions without changing their public app version', () => {
    const version = '1.2.3-beta.42';
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
      version: '0.1.0', bundle: { windows: { nsis: { installMode: 'currentUser' } } },
    }));
    writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "desktop"\nversion = "0.1.0"\n');
    const result = spawnSync(process.execPath, [versionScript, version, '--set'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const configuration = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(configuration.version).toBe(version);
    expect(configuration.bundle.windows.wix.version).toBe('1.2.3.42');
    expect(configuration.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')).toContain(`version = "${version}"`);
  });

  it.each(['0.1.0', '1.2.3', '255.255.65535'])('accepts a valid Windows release version %s', (version) => {
    const result = spawnSync(process.execPath, [versionScript, version], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it.each(['v1.2.3', '01.2.3', '1.2', '1.2.3-beta', '256.0.0', '1.256.0', '1.2.65536', '1.2.3; echo unexpected'])(
    'rejects unsupported or unsafe version %s before building', (version) => {
      expect(spawnSync(process.execPath, [versionScript, version], { encoding: 'utf8' }).status).not.toBe(0);
    },
  );

  it('updates only the native package version and configuration, preserving dependencies and public keys', () => {
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
      version: '0.1.0', plugins: { updater: { pubkey: 'keep-public-key' } },
    }));
    writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "desktop"\nversion = "0.1.0"\n\n[dependencies.example]\nversion = "9"\n');
    const result = spawnSync(process.execPath, [versionScript, '1.2.3', '--set'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))).toEqual({
      version: '1.2.3', plugins: { updater: { pubkey: 'keep-public-key' } },
      bundle: { windows: { wix: { version: '1.2.3.65535' } } },
    });
    expect(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')).toBe(
      '[package]\nname = "desktop"\nversion = "1.2.3"\n\n[dependencies.example]\nversion = "9"\n',
    );
  });
});
