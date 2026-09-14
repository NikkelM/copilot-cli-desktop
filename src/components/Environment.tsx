import { useEffect, useState } from 'react';

import type { ExtensionSummary, InstructionSource, SessionEnvironment } from '../../shared/protocol';
import { Markdown } from './Markdown';

interface EnvironmentProps {
  environment: SessionEnvironment | null;
  loading: boolean;
  failed: string | null;
  /** Read it again, for after editing one of the files listed. */
  onReload: () => void;
  onClose: () => void;
}

/** Where a source came from, in the words someone would use to go and find it. */
const SCOPE: Record<InstructionSource['location'], string> = {
  user: 'Yours',
  repository: 'Repository',
  'working-directory': 'This directory',
  plugin: 'Plugin',
};

/**
 * What the mode means for the list under it.
 *
 * An empty list says something different in each: under `disabled` it means nothing would
 * load whatever is installed, and under the others it means nothing is installed.
 */
const MODE: Record<SessionEnvironment['extensionMode'], string> = {
  disabled: 'Extensions are switched off, so none of these load.',
  load_only: 'Extensions load, but do not add to the model context.',
  load_and_augment: 'Extensions load and add to the model context.',
};

/**
 * Everything a session in this directory would load before it hears a word.
 *
 * Instructions, plugins and extensions decide how a session behaves and are the first
 * suspect when it behaves oddly, yet they live in files scattered across the home
 * directory, the repository and each plugin. Answering "is my instruction file actually in
 * force" by hand means knowing every place to look.
 *
 * The CLI answers a fuller version of this with `/env`, which also covers MCP servers,
 * skills, agents, hooks and LSPs. That command is left alone and still runs here: this is
 * the reading that costs no session, shows the contents rather than only the paths, and
 * answers for a session that has never been opened.
 *
 * Read fresh each time it opens rather than remembered, since the reason to open it is
 * usually that one of these files has just been edited.
 */
export function Environment({ environment, loading, failed, onReload, onClose }: EnvironmentProps) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const instructions = environment?.instructions ?? [];
  const plugins = environment?.plugins ?? [];
  const extensions = environment?.extensions ?? [];

  return (
    <div className="environment">
      <div className="changes-head">
        <span className="changes-title">
          {environment
            ? `${instructions.length} instruction ${instructions.length === 1 ? 'source' : 'sources'}`
            : 'Environment'}
        </span>
        <div className="changes-actions">
          <button type="button" className="changes-action" onClick={onReload} disabled={loading}>
            {loading ? 'Reading' : 'Reread'}
          </button>
          <button type="button" className="changes-close" onClick={onClose} aria-label="Close environment">
            ✕
          </button>
        </div>
      </div>

      {failed && <p className="error">{failed}</p>}
      {loading && !environment && <p className="changes-note">Reading what this session would load.</p>}

      {environment && (
        <div className="environment-body">
          <section className="environment-section">
            <h3 className="environment-heading">Instructions</h3>
            {instructions.length === 0 ? (
              <p className="changes-note">
                No instruction files apply here. A session in this directory starts with nothing but its own defaults.
              </p>
            ) : (
              <ul className="environment-list">
                {instructions.map((source) => (
                  <li key={source.id}>
                    <button
                      type="button"
                      className={open === source.id ? 'changes-row open' : 'changes-row'}
                      onClick={() => setOpen(open === source.id ? null : source.id)}
                      aria-expanded={open === source.id}
                      title={source.sourcePath}
                    >
                      <span className="environment-scope">{SCOPE[source.location]}</span>
                      <span className="changes-path">{source.label}</span>
                      <span className="environment-size">{size(source.content)}</span>
                    </button>
                    {open === source.id && (
                      <div className="environment-content">
                        <Markdown body={source.content} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="environment-section">
            <h3 className="environment-heading">Plugins</h3>
            {plugins.length === 0 ? (
              <p className="changes-note">No plugins installed.</p>
            ) : (
              <ul className="environment-list">
                {plugins.map((plugin) => (
                  <li key={`${plugin.marketplace}/${plugin.name}`} className="environment-item">
                    <span className={plugin.enabled ? 'environment-dot on' : 'environment-dot off'} aria-hidden />
                    <span className="environment-name">{plugin.name}</span>
                    <span className="environment-meta">{plugin.marketplace}</span>
                    {plugin.version && <span className="environment-meta">{plugin.version}</span>}
                    {!plugin.enabled && <span className="environment-off">off</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="environment-section">
            <h3 className="environment-heading">Extensions</h3>
            <p className="changes-note">{MODE[environment.extensionMode]}</p>
            {extensions.length > 0 && (
              <ul className="environment-list">
                {extensions.map((extension) => (
                  <li key={extension.id} className="environment-item">
                    <span className={extension.enabled ? 'environment-dot on' : 'environment-dot off'} aria-hidden />
                    <span className="environment-name">{extension.name}</span>
                    <span className="environment-meta">{source(extension)}</span>
                    {!extension.enabled && <span className="environment-off">off</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** Which plugin an extension arrived with, since that is what turning it off would mean. */
function source(extension: ExtensionSummary): string {
  return extension.plugin ?? (extension.source === 'user' ? 'yours' : extension.source);
}

/**
 * Roughly how much a source adds, so a file that is quietly empty is visible without
 * opening it. Rounded, because the interesting distinction is "a line" against "pages".
 */
function size(content: string): string {
  const lines = content.trim() === '' ? 0 : content.trim().split('\n').length;
  return lines === 0 ? 'empty' : `${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
