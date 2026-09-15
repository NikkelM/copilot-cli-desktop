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
  /** Skills this session has switched off. Empty when the panel is open on no session. */
  disabledSkills?: string[];
  /** Absent when there is no session to switch anything for, which leaves the list readable but fixed. */
  onToggleSkill?: (name: string, enabled: boolean) => void;
  /**
   * Turn an MCP server on or off for new sessions.
   *
   * Unlike the skills toggle this needs no session, since the disabled list is the reader's
   * own configuration. Optional all the same, so a caller that cannot write it renders the
   * list as a fixed one rather than offering a control that would fail.
   */
  onToggleMcp?: (name: string, enabled: boolean) => void;
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
export function Environment({
  environment,
  loading,
  failed,
  onReload,
  onClose,
  disabledSkills = [],
  onToggleSkill,
  onToggleMcp,
}: EnvironmentProps) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const instructions = environment?.instructions ?? [];
  const plugins = environment?.plugins ?? [];
  const extensions = environment?.extensions ?? [];
  const skills = environment?.skills ?? [];
  const mcpServers = environment?.mcpServers ?? [];
  const skillErrors = environment?.skillErrors ?? [];
  const off = new Set(disabledSkills);

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
            <h3 className="environment-heading">MCP servers</h3>
            {mcpServers.length === 0 ? (
              <p className="changes-note">No MCP servers configured.</p>
            ) : (
              <>
                {/* Not the same scope as the skills below, which are switched off for one
                    session. This is the reader's own configuration, so it decides what
                    every new session starts with - and changes nothing already running. */}
                <p className="changes-note">
                  Switching one off applies to new sessions. Anything already running keeps its connections.
                </p>
                <ul className="environment-list">
                  {mcpServers.map((server) => (
                    <li key={server.name} className="environment-item">
                      <span className={server.enabled ? 'environment-dot on' : 'environment-dot off'} aria-hidden />
                      <span className="environment-name">{server.name}</span>
                      {server.type && <span className="environment-meta">{server.type}</span>}
                      {/* Where it came from is where it would have to be changed, and a
                          plugin's server cannot be edited where the reader's own can. */}
                      <span className="environment-meta">{server.sourcePlugin ?? server.source}</span>
                      {onToggleMcp ? (
                        <button
                          type="button"
                          className={server.enabled ? 'environment-toggle' : 'environment-toggle off'}
                          onClick={() => onToggleMcp(server.name, !server.enabled)}
                          aria-pressed={server.enabled}
                          title={
                            server.enabled
                              ? `Stop starting ${server.name} in new sessions`
                              : `Start ${server.name} in new sessions again`
                          }
                        >
                          {server.enabled ? 'On' : 'Off'}
                        </button>
                      ) : (
                        !server.enabled && <span className="environment-off">off</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="environment-section">
            <h3 className="environment-heading">Skills</h3>
            {skills.length === 0 ? (
              <p className="changes-note">No skills found for this directory.</p>
            ) : (
              <>
                {!onToggleSkill && (
                  <p className="changes-note">Open a session to switch any of these off for it.</p>
                )}
                <ul className="environment-list">
                  {skills.map((skill) => {
                    const switchedOff = off.has(skill.name);
                    return (
                      <li key={skill.name} className="environment-item">
                        <span
                          className={skill.enabled && !switchedOff ? 'environment-dot on' : 'environment-dot off'}
                          aria-hidden
                        />
                        <span className="environment-name" title={skill.path}>
                          {skill.commandName ? `/${skill.commandName}` : skill.name}
                        </span>
                        <span className="environment-meta environment-description" title={skill.description}>
                          {skill.description}
                        </span>
                        <span className="environment-meta">{SKILL_SOURCE[skill.source] ?? skill.source}</span>
                        {/* The runtime's own answer, which a choice made here cannot overrule. */}
                        {!skill.enabled ? (
                          <span className="environment-off" title="Switched off for every session">
                            off everywhere
                          </span>
                        ) : onToggleSkill ? (
                          <button
                            type="button"
                            className={switchedOff ? 'environment-toggle off' : 'environment-toggle'}
                            onClick={() => onToggleSkill(skill.name, switchedOff)}
                            aria-pressed={!switchedOff}
                            title={
                              switchedOff
                                ? `Load ${skill.name} in this session again`
                                : `Stop loading ${skill.name} in this session`
                            }
                          >
                            {switchedOff ? 'Off' : 'On'}
                          </button>
                        ) : (
                          switchedOff && <span className="environment-off">off here</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {/* A skill that could not be read is simply absent from the list above, which
                reads as never having been installed. Saying so is the only way to tell the
                difference between a skill that is missing and one that is broken. */}
            {skillErrors.length > 0 && (
              <ul className="environment-list environment-errors">
                {skillErrors.map((message) => (
                  <li key={message} className="environment-item">
                    <span className="environment-dot off" aria-hidden />
                    <span className="environment-meta">{message}</span>
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

/**
 * Where a skill came from, in the words someone would use to go and find it.
 *
 * Not a closed set - the runtime is explicit that unknown values should be tolerated - so
 * anything unrecognised is shown as the runtime named it rather than hidden.
 */
const SKILL_SOURCE: Record<string, string> = {
  project: 'This project',
  inherited: 'A parent directory',
  'personal-copilot': 'Yours',
  'personal-agents': 'Yours',
  custom: 'A configured directory',
  plugin: 'Plugin',
  builtin: 'Built in',
  remote: 'Your organisation',
  sdk: 'This app',
};

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
