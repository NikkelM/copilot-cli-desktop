import { useEffect, useState } from 'react';

import type {
  ExtensionSummary,
  InstructionSource,
  McpServerConfig,
  McpServerState,
  McpServerSummary,
  SessionEnvironment,
} from '../../shared/protocol';
import { Markdown } from './Markdown';
import { McpEditor } from './McpEditor';

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
  /** Write a server down, or change one. Absent leaves the list read-only. */
  onSaveMcp?: (name: string, config: McpServerConfig) => void;
  onRemoveMcp?: (name: string) => void;
  /**
   * What each server is actually doing, for a session that is loaded. Absent for a cold
   * one: nothing is resumed to find out.
   */
  mcpState?: McpServerState[] | null;
  /** Begin signing in to a server waiting for it. Offered only where one is. */
  onLoginMcp?: (name: string) => void;
  /**
   * Which server's form is showing, when the caller is holding that rather than this.
   * An empty string means one being added; null means no form at all.
   */
  editingMcp?: string | null;
  onEditMcp?: (name: string | null) => void;
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
  disabled: 'Extensions are switched off.',
  load_only: 'Extensions load without adding to the model context.',
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
  onSaveMcp,
  onRemoveMcp,
  mcpState = null,
  onLoginMcp,
  editingMcp = null,
  onEditMcp,
}: EnvironmentProps) {
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Which server is being written down: its name, or an empty string for one being added.
   * Null when the form is not up at all.
   *
   * Held by the caller where there is one, so `/mcp add` can open the panel with the form
   * already showing rather than leaving the reader to press the button themselves.
   */
  const [ownEditing, setOwnEditing] = useState<string | null>(null);
  const editing = onEditMcp ? editingMcp : ownEditing;
  const setEditing = onEditMcp ?? setOwnEditing;

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
  const agents = environment?.agents ?? [];
  const hooks = environment?.hooks ?? [];
  const skillErrors = environment?.skillErrors ?? [];
  const hookErrors = environment?.hookErrors ?? [];
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
                No instruction files apply here.
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
                    <span>{plugin.name}</span>
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
            {mcpServers.length === 0 && editing === null ? (
              <p className="changes-note">No MCP servers configured.</p>
            ) : (
              <>
                {/* Not the same scope as the skills below, which are switched off for one
                    session. This is the reader's own configuration, so it decides what
                    every new session starts with - and changes nothing already running. */}
                {mcpServers.length > 0 && <p className="changes-note">Applies to new sessions only.</p>}
                <ul className="environment-list">
                  {mcpServers.map((server) => {
                    const live = mcpState?.find((state) => state.name === server.name);
                    return (
                      <li key={server.name} className="environment-item mcp-row">
                        <span
                          className={server.enabled ? 'environment-dot on' : 'environment-dot off'}
                          aria-hidden
                        />
                        <span>{server.name}</span>
                        {server.type && <span className="environment-meta">{server.type}</span>}
                        {/* What it actually is, which is the thing a reader came to check and
                            the only part the list could not say before (#24). */}
                        <span className="environment-meta environment-description" title={reach(server)}>
                          {reach(server)}
                        </span>
                        {/* Where it came from is where it would have to be changed, and a
                            plugin's server cannot be edited where the reader's own can. */}
                        <span className="environment-meta">{server.sourcePlugin ?? server.source}</span>
                        {/* What happened when the session tried it, which only a loaded
                            session can say. Absent rather than guessed at for a cold one. */}
                        {live && (
                          <span className={`mcp-status mcp-status-${live.status}`} title={live.error}>
                            {STATUS[live.status] ?? live.status}
                          </span>
                        )}
                        {live?.status === 'needs-auth' && onLoginMcp && (
                          <button
                            type="button"
                            className="mcp-action"
                            onClick={() => onLoginMcp(server.name)}
                            aria-label={`Sign in to ${server.name}`}
                          >
                            Sign in
                          </button>
                        )}
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
                        {/* Only the reader's own. Editing a plugin's server here would write a
                            copy into their file rather than change the plugin's. */}
                        {server.editable && onSaveMcp && (
                          <button
                            type="button"
                            className="mcp-action"
                            onClick={() => setEditing(server.name)}
                            // Named for the server it belongs to: a list of them would
                            // otherwise be a column of buttons all called Edit.
                            aria-label={`Change how ${server.name} is reached`}
                          >
                            Edit
                          </button>
                        )}
                        {server.editable && onRemoveMcp && (
                          <button
                            type="button"
                            className="mcp-action destructive"
                            onClick={() => onRemoveMcp(server.name)}
                            aria-label={`Take ${server.name} out of your configuration`}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {onSaveMcp &&
              (editing === null ? (
                <button type="button" className="mcp-action mcp-add" onClick={() => setEditing('')}>
                  Add a server
                </button>
              ) : (
                <McpEditor
                  server={mcpServers.find((server) => server.name === editing)}
                  // A name that matches nothing is one being written down under it, which
                  // is what `/mcp add <name>` means and what the CLI does with it.
                  initialName={editing}
                  taken={mcpServers.map((server) => server.name)}
                  onCancel={() => setEditing(null)}
                  onSave={(name, config) => {
                    setEditing(null);
                    onSaveMcp(name, config);
                  }}
                />
              ))}
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
                        <span title={skill.path}>
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
            <h3 className="environment-heading">Custom agents</h3>
            {agents.length === 0 ? (
              <p className="changes-note">No custom agents found for this directory.</p>
            ) : (
              <ul className="environment-list">
                {agents.map((agent) => (
                  <li key={agent.id} className="environment-item">
                    <span className="environment-dot on" aria-hidden />
                    <span title={agent.path}>{agent.displayName}</span>
                    <span className="environment-meta environment-description" title={agent.description}>
                      {agent.description}
                    </span>
                    <span className="environment-meta">{AGENT_SOURCE[agent.source] ?? agent.source}</span>
                    {/* The ones a reader cannot choose, which are here because they still
                        load and can still be delegated to by another agent. */}
                    {!agent.userInvocable && (
                      <span className="environment-off" title="Only another agent can delegate to this one">
                        delegated only
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="environment-section">
            <h3 className="environment-heading">Hooks</h3>
            {hooks.length === 0 ? (
              <p className="changes-note">No hooks found for this directory.</p>
            ) : (
              <ul className="environment-list">
                {/* Named by when they fire and the file they live in: the runtime identifies
                    a hook by a hash, and carries no name or description for one. The file is
                    also the only place it can be changed. */}
                {hooks.map((hook) => (
                  <li key={hook.id} className="environment-item">
                    <span className={hook.enabled ? 'environment-dot on' : 'environment-dot off'} aria-hidden />
                    <span>{hook.event}</span>
                    <span className="environment-meta environment-description" title={hook.source}>
                      {hook.source ? fileName(hook.source) : ''}
                    </span>
                    <span className="environment-meta">{HOOK_ORIGIN[hook.origin] ?? hook.origin}</span>
                    {!hook.enabled && <span className="environment-off">off</span>}
                  </li>
                ))}
              </ul>
            )}
            {hookErrors.length > 0 && (
              <ul className="environment-list environment-errors">
                {hookErrors.map((message) => (
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
                    <span>{extension.name}</span>
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

/** Where a custom agent came from, in the same words the skills above use. */
const AGENT_SOURCE: Record<string, string> = {
  user: 'Yours',
  project: 'This project',
  inherited: 'A parent directory',
  remote: 'Your organisation',
  plugin: 'Plugin',
  builtin: 'Built in',
};

/** Where a hook came from, which is also where it would have to be turned off. */const HOOK_ORIGIN: Record<string, string> = {
  user: 'Yours',
  repository: 'This repository',
  plugin: 'Plugin',
  policy: 'Your organisation',
};

/** The file a hook was written in, without the directories nobody is reading. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * What a server actually is, which is the thing a reader came to check.
 *
 * Empty for one this app cannot see the config of - a plugin's, or a server the config
 * could not be read for. Saying nothing beats guessing at it.
 */
function reach(server: McpServerSummary): string {
  if (server.url) return server.url;
  if (server.command) return [server.command, ...(server.args ?? [])].join(' ');
  return '';
}

/**
 * What a server is doing, in words rather than in the runtime's own.
 *
 * Not a closed set - anything unrecognised is shown as the runtime named it, which is the
 * same rule the sources above follow.
 */
const STATUS: Record<string, string> = {
  connected: 'connected',
  pending: 'connecting',
  failed: 'failed',
  'needs-auth': 'needs sign-in',
  disabled: 'disabled',
  stopped: 'stopped',
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
