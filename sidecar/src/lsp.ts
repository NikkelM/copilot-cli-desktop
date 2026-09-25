/**
 * The language servers a session would be offered.
 *
 * Read from the config files rather than from a session, unlike everything else the
 * environment panel shows. The SDK's only LSP method is `lsp.initialize`, which loads a
 * configuration rather than reporting one - so there is nothing to ask. What there is
 * instead is a pair of files with a documented shape, which the CLI's own `/lsp show` reads
 * the same way (#165).
 *
 * Sessionless like the rest of discovery, and cheaper: two small files rather than a round
 * trip.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LspSummary } from '../../shared/protocol.js';
import { copilotHome } from './paths.js';

/** One server as the config writes it, narrowed to the fields worth showing. */
interface Configured {
  command?: unknown;
  fileExtensions?: unknown;
  disabled?: unknown;
}

/** Where the servers are written down. The reader's own, then the project's. */
export function lspConfigFiles(cwd?: string): { path: string; source: string }[] {
  return [
    { path: join(copilotHome, 'lsp.json'), source: 'user' },
    ...(cwd ? [{ path: join(cwd, '.github', 'lsp.json'), source: 'project' }] : []),
  ];
}

/** One config file's servers, or nothing at all for one that is missing or unreadable. */
async function serversIn(path: string): Promise<Record<string, Configured>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // No file is the usual case: language servers are configured explicitly, and most
    // readers never configure one.
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const servers = (parsed as { lspServers?: unknown } | null)?.lspServers;
    return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
      ? (servers as Record<string, Configured>)
      : {};
  } catch {
    // A config this app cannot parse is not this app's to repair, and a panel without the
    // section beats an error about a file the reader may not know they have.
    return {};
  }
}

/**
 * The language servers configured for a directory.
 *
 * The project's own override the reader's where both name a server, which is the order the
 * CLI resolves them in and the same rule the MCP config follows.
 */
export async function lspServers(cwd?: string): Promise<LspSummary[]> {
  const files = lspConfigFiles(cwd);
  const found = await Promise.all(files.map(async (file) => ({ ...file, servers: await serversIn(file.path) })));

  const byName = new Map<string, LspSummary>();
  for (const file of found) {
    for (const [name, server] of Object.entries(file.servers)) {
      byName.set(name, {
        name,
        ...(typeof server.command === 'string' ? { command: server.command } : {}),
        // The keys are the extensions; the values are the language each maps to, which is
        // the runtime's business rather than anything to read.
        extensions:
          typeof server.fileExtensions === 'object' && server.fileExtensions !== null
            ? Object.keys(server.fileExtensions)
            : [],
        source: file.source,
        // Only the exact stored true switches one off, so nothing unexpected can hide one.
        enabled: server.disabled !== true,
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
