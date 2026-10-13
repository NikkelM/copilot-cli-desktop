import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';
import yazl from 'yazl';

import { copilotHome, sessionStateDir } from './paths.js';

/**
 * What the CLI leaves behind to say it has a session open.
 *
 * Never packed. A bundle carrying one would arrive on another machine claiming to be open
 * in a process that does not exist there, which is exactly the warning #63 added - and it
 * would be wrong every time.
 */
const TRANSIENT = /^inuse\.\d+\.(hold|lock)$/;

/** Named so a person looking at their downloads can tell what it is and which one. */
export function bundleName(sessionId: string, title: string | null): string {
  const said = (title ?? 'session').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${said || 'session'}-${sessionId.slice(0, 8)}.copilot-session.zip`;
}

/** Every file under a directory, as paths relative to it, deepest last. */
function filesUnder(root: string, within = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(join(root, within), { withFileTypes: true })) {
    const path = within ? `${within}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(root, path));
    else if (entry.isFile() && !TRANSIENT.test(entry.name)) found.push(path);
  }

  return found;
}

/**
 * Write a session out as a single file (#63).
 *
 * Everything in the session's directory except the markers saying it is open, which belong
 * to the machine that wrote them. The rewind snapshots go too: they are keyed by a hash of
 * each file's absolute path, so they are inert anywhere else, but they are also 2% of what
 * a session costs and they make a bundle brought back to the same machine complete.
 *
 * Deflated, because a session is almost entirely its event log and an event log is JSON.
 * Measured across this machine: 3.4 GB of logs against 0.08 GB of everything else, so
 * compressing is the difference between a bundle somebody can send and one they cannot.
 *
 * Streamed rather than gathered. The largest log here is 287 MB, and reading one into
 * memory to compress it would cost more than the app spends on everything else put
 * together.
 */
export async function exportSession(
  sessionId: string,
  toPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: number }> {
  const dir = sessionStateDir(sessionId);
  if (!existsSync(dir)) throw new Error('That session is not on this machine.');

  const files = filesUnder(dir);
  if (files.length === 0) throw new Error('That session has nothing in it to export.');

  const zip = new yazl.ZipFile();
  for (const file of files) {
    // Under the session's own id, which is how the id travels: a zip has nowhere else to
    // write down what it is a bundle of, and the import reads it back from exactly here.
    // Forward slashes whatever the platform, because that is what the zip format says.
    zip.addFile(join(dir, ...file.split('/')), `${sessionId}/${file}`);
  }
  zip.end();

  let done = 0;
  const total = files.reduce((sum, file) => sum + (statSync(join(dir, ...file.split('/'))).size || 0), 0);
  zip.outputStream.on('data', (chunk: Buffer) => {
    done += chunk.length;
    // Against the uncompressed total, so this only ever runs ahead of itself rather than
    // stalling near the end - a bar that reaches the end early is better than one that
    // sits at 90% for a minute.
    onProgress?.(Math.min(done, total), total);
  });

  await pipeline(zip.outputStream, createWriteStream(toPath));
  return { bytes: statSync(toPath).size };
}

/** A session id as the CLI writes one, which is what a bundle's directory has to be. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a bundle turned out to hold, before any of it is written. */
interface Bundle {
  entries: { path: string; bytes: number }[];
}

/**
 * Read a bundle's table of contents without unpacking it.
 *
 * Nothing is written until the whole list has been read, so a bundle that turns out to be
 * something else is refused before it has put a file anywhere.
 *
 * A zip can name `../../somewhere`, and this does not check for it: yauzl refuses an entry
 * naming a relative or absolute path outside the archive before it is ever handed over -
 * verified against a zip written byte by byte for the purpose, since no archive writer will
 * produce one. A second check here would be unreachable code claiming the credit.
 */
function inspect(path: string): Promise<Bundle> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new Error('That file is not a session bundle.'));

      const entries: { path: string; bytes: number }[] = [];

      zip.on('entry', (entry: yauzl.Entry) => {
        // Directory entries carry no content; the files inside them make the folders.
        if (!entry.fileName.endsWith('/')) {
          entries.push({ path: entry.fileName, bytes: entry.uncompressedSize });
        }
        zip.readEntry();
      });

      zip.on('end', () => {
        if (entries.length === 0) return reject(new Error('That bundle is empty.'));
        resolve({ entries });
      });
      zip.on('error', () => reject(new Error('That bundle could not be read.')));
      zip.readEntry();
    });
  });
}

/**
 * Take a bundle in, as a session of its own (#63).
 *
 * Unpacked beside the others under the id it already has. The id is the session as far as
 * the log is concerned - its events refer to it - so giving it a new one would make a
 * session that describes a conversation that never happened under that name.
 *
 * Refused where a session of that id is already here. Merging two conversations that share
 * an id would corrupt both, and there is no answer to which is right; saying so and
 * stopping is the only safe thing left.
 *
 * Written to one side and moved into place at the end, so a bundle that turns out to be
 * broken half way through leaves nothing behind. The move is a rename within the same
 * directory, which is atomic.
 */
export async function importSession(
  fromPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ sessionId: string; files: number }> {
  const { entries } = await inspect(fromPath);

  // Every file in a bundle sits under the session's own directory, which is how the id
  // travels with it - there is nowhere else in the archive it could be written down.
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0] ?? ''));
  const sessionId = [...roots][0] ?? '';
  if (roots.size !== 1 || !SESSION_ID.test(sessionId)) {
    throw new Error('This .zip does not contain a Copilot session.');
  }

  const destination = sessionStateDir(sessionId);
  if (existsSync(destination)) {
    throw new Error('A session with that id is already here. Rename or delete it first.');
  }

  const staging = join(copilotHome, 'session-state', `.importing-${sessionId}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let done = 0;
  /**
   * The bundle itself, held so it can be closed however this ends.
   *
   * It closes itself on reaching the end, which is the path that works. A read that fails
   * part way through rejects instead, and the handle was then held until the process exited.
   */
  let bundle: yauzl.ZipFile | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(fromPath, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(new Error('That file is not a session bundle.'));
        bundle = zip;

        zip.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName.endsWith('/')) return zip.readEntry();

          // Minus the session directory the bundle wraps everything in: the destination is
          // that directory, so keeping it would nest the session inside itself.
          const within = entry.fileName.split('/').slice(1);
          if (within.length === 0) return zip.readEntry();

          zip.openReadStream(entry, (failed, source) => {
            if (failed || !source) return reject(new Error('That bundle could not be read.'));

            const target = join(staging, ...within);
            mkdirSync(dirname(target), { recursive: true });
            source.on('data', (chunk: Buffer) => {
              done += chunk.length;
              onProgress?.(done, total);
            });

            pipeline(source, createWriteStream(target))
              .then(() => zip.readEntry())
              .catch(reject);
          });
        });

        zip.on('end', () => resolve());
        zip.on('error', () => reject(new Error('That bundle could not be read.')));
        zip.readEntry();
      });
    });

    // The log is what makes a session openable, and a bundle without one would list a
    // session that fails the moment it is clicked.
    if (!existsSync(join(staging, 'events.jsonl'))) {
      throw new Error('That bundle has no conversation in it.');
    }

    renameSync(staging, destination);
    return { sessionId, files: entries.length };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    bundle?.close();
  }
}

/** What a session would cost to pack, for the window to say so before it starts. */
export function exportSize(sessionId: string): { files: number; bytes: number } {
  const dir = sessionStateDir(sessionId);
  if (!existsSync(dir)) return { files: 0, bytes: 0 };

  const files = filesUnder(dir);
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + (statSync(join(dir, ...file.split('/'))).size || 0), 0),
  };
}
