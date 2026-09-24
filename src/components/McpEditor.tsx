import { useState } from 'react';

import type { McpServerConfig, McpServerSummary } from '../../shared/protocol';

/**
 * Writing down where an MCP server is and how to reach it.
 *
 * Two shapes, because the runtime takes two: a URL to call, or a command to run. Everything
 * else its config accepts - filters, timeouts, telemetry policy - is left alone rather than
 * given a control here, and a server saved from this form keeps whatever it already had of
 * them (#24).
 *
 * Costs no session either way. The config is the reader's own file, which is what lets this
 * sit beside a list that is also free to read.
 */
export function McpEditor({
  server,
  taken,
  onSave,
  onCancel,
}: {
  /** The server being changed, or nothing when one is being added. */
  server?: McpServerSummary;
  /** Names already in use, so a new server cannot quietly replace one. */
  taken: readonly string[];
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  // A server with a command is one the runtime runs; anything else it calls.
  const [transport, setTransport] = useState<'http' | 'stdio'>(server?.command ? 'stdio' : 'http');
  const [url, setUrl] = useState(server?.url ?? '');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join(' '));

  const named = name.trim();
  // Only when adding: the name is the key the config is written under, so changing it would
  // leave the old one behind rather than rename it.
  const clashes = !server && taken.includes(named);
  const ready = named !== '' && !clashes && (transport === 'http' ? url.trim() !== '' : command.trim() !== '');

  const save = () => {
    if (!ready) return;
    onSave(
      named,
      transport === 'http'
        ? { transport: 'http', url: url.trim() }
        : {
            transport: 'stdio',
            command: command.trim(),
            // Split on whitespace, as a shell would. An argument with a space in it is rare
            // enough, and hard enough to write in one line, that a reader wanting one is
            // better served editing the file.
            args: args.trim() === '' ? [] : args.trim().split(/\s+/),
          },
    );
  };

  return (
    <form
      className="mcp-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="mcp-field">
        <span className="mcp-label">Name</span>
        <input
          className="settings-text"
          value={name}
          // The key the server is written under. Changing it would add a second server
          // rather than rename the first, so an existing one keeps the name it has.
          disabled={server !== undefined}
          spellCheck={false}
          autoFocus={server === undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {clashes && <p className="mcp-warning">A server called {named} is already configured.</p>}

      <span className="mcp-field">
        <span className="mcp-label">Reached by</span>
        <span className="cli-choice">
          {(['http', 'stdio'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className={transport === choice ? 'model-option chosen' : 'model-option'}
              aria-pressed={transport === choice}
              onClick={() => setTransport(choice)}
            >
              {choice === 'http' ? 'URL' : 'Command'}
            </button>
          ))}
        </span>
      </span>

      {transport === 'http' ? (
        <label className="mcp-field">
          <span className="mcp-label">URL</span>
          <input
            className="settings-text"
            value={url}
            spellCheck={false}
            placeholder="https://example.com/mcp"
            autoFocus={server !== undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
      ) : (
        <>
          <label className="mcp-field">
            <span className="mcp-label">Command</span>
            <input
              className="settings-text"
              value={command}
              spellCheck={false}
              placeholder="npx"
              autoFocus={server !== undefined}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className="mcp-field">
            <span className="mcp-label">Arguments</span>
            <input
              className="settings-text"
              value={args}
              spellCheck={false}
              placeholder="-y @upstash/context7-mcp"
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
        </>
      )}

      <div className="mcp-actions">
        <button type="button" className="settings-reset" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="settings-reset" disabled={!ready}>
          Save
        </button>
      </div>
    </form>
  );
}
