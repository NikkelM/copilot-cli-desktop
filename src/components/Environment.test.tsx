// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSummary, HookSummary, SessionEnvironment } from '../../shared/protocol';
import { Environment } from './Environment';

const source = (over: Partial<SessionEnvironment['instructions'][number]> = {}) => ({
  id: 'home-copilot',
  label: 'Home copilot-instructions.md',
  sourcePath: 'C:\\Users\\x\\.copilot\\copilot-instructions.md',
  content: '# Rules\n\nBe brief.',
  type: 'home' as const,
  location: 'user' as const,
  ...over,
});

const environment = (over: Partial<SessionEnvironment> = {}): SessionEnvironment => ({
  instructions: [source()],
  plugins: [{ name: 'project-planning', marketplace: 'awesome-copilot', version: '1.0.0', enabled: true }],
  extensions: [],
  skills: [],
  skillErrors: [],
  mcpServers: [],
  agents: [],
  hooks: [],
  hookErrors: [],
  extensionMode: 'load_and_augment',
  ...over,
});

const props = {
  environment: null as SessionEnvironment | null,
  loading: false,
  failed: null as string | null,
  onReload: () => {},
  onClose: () => {},
};

describe('Environment', () => {
  it('says it is reading before the answer arrives', () => {
    render(<Environment {...props} loading />);
    expect(screen.getByText(/Reading what this session would load/)).toBeTruthy();
  });

  it('reports a failure rather than an empty panel', () => {
    render(<Environment {...props} failed="no runtime" />);
    expect(screen.getByText('no runtime')).toBeTruthy();
  });

  it('counts the instruction sources in force', () => {
    render(
      <Environment
        {...props}
        environment={environment({ instructions: [source(), source({ id: 'repo', location: 'repository' })] })}
      />,
    );
    expect(screen.getByText('2 instruction sources')).toBeTruthy();
  });

  it('says where each source came from', () => {
    render(<Environment {...props} environment={environment({ instructions: [source({ location: 'plugin' })] })} />);
    expect(screen.getByText('Plugin')).toBeTruthy();
  });

  /**
   * Only the home file's path comes back absolute. A project's is relative to its repository
   * root, which is not always the session's directory, so shortening it against the cwd would
   * mangle it. The label is the name the runtime means to be read.
   */
  it('names a source by its label rather than its path', () => {
    render(<Environment {...props} environment={environment()} />);

    expect(screen.getByText('Home copilot-instructions.md')).toBeTruthy();
    expect(screen.queryByText('C:\\Users\\x\\.copilot\\copilot-instructions.md')).toBeNull();
  });

  /**
   * The whole question this panel answers is which files are in force, and an empty answer
   * is a real one worth stating rather than leaving as a blank space that looks broken.
   */
  it('explains an empty instruction list rather than showing nothing', () => {
    render(<Environment {...props} environment={environment({ instructions: [] })} />);
    expect(screen.getByText(/No instruction files apply here/)).toBeTruthy();
  });

  it('keeps a source shut until it is opened', () => {
    render(<Environment {...props} environment={environment()} />);
    expect(screen.queryByText('Be brief.')).toBeNull();

    fireEvent.click(screen.getByTitle('C:\\Users\\x\\.copilot\\copilot-instructions.md'));

    expect(screen.getByText('Be brief.')).toBeTruthy();
  });

  /** Instructions are markdown, and reading them as source is not what anyone is here for. */
  it('renders the contents as markdown', () => {
    const { container } = render(<Environment {...props} environment={environment()} />);
    fireEvent.click(screen.getByTitle('C:\\Users\\x\\.copilot\\copilot-instructions.md'));

    expect(container.querySelector('.environment-content h1')?.textContent).toBe('Rules');
  });

  /** A file that is quietly empty explains a session ignoring rules someone thinks it has. */
  it('shows how much each source adds without opening it', () => {
    render(
      <Environment
        {...props}
        environment={environment({ instructions: [source(), source({ id: 'blank', content: '   ' })] })}
      />,
    );
    expect(screen.getByText('3 lines')).toBeTruthy();
    expect(screen.getByText('empty')).toBeTruthy();
  });

  it('names a plugin with its marketplace and version', () => {
    render(<Environment {...props} environment={environment()} />);
    expect(screen.getByText('project-planning')).toBeTruthy();
    expect(screen.getByText('awesome-copilot')).toBeTruthy();
    expect(screen.getByText('1.0.0')).toBeTruthy();
  });

  /** A plugin turned off is still installed, and its absence would look like a missing install. */
  it('keeps a disabled plugin listed, marked off', () => {
    render(
      <Environment
        {...props}
        environment={environment({ plugins: [{ name: 'dormant', marketplace: 'local', enabled: false }] })}
      />,
    );
    expect(screen.getByText('dormant')).toBeTruthy();
    expect(screen.getByText('off')).toBeTruthy();
  });

  /**
   * An empty extension list means "none installed" under one mode and "none would load" under
   * another, and the difference is what someone is trying to work out.
   */
  it('says what the extension mode means for the list under it', () => {
    render(<Environment {...props} environment={environment({ extensionMode: 'disabled' })} />);
    expect(screen.getByText(/switched off/)).toBeTruthy();
  });

  it('names the plugin an extension arrived with', () => {
    render(
      <Environment
        {...props}
        environment={environment({
          extensions: [
            { id: 'e1', name: 'thing', path: 'C:\\x\\thing.js', source: 'plugin', enabled: true, plugin: 'bundle' },
          ],
        })}
      />,
    );
    expect(screen.getByText('thing')).toBeTruthy();
    expect(screen.getByText('bundle')).toBeTruthy();
  });

  it('rereads on request, since these are files being edited', () => {
    const onReload = vi.fn();
    render(<Environment {...props} environment={environment()} onReload={onReload} />);

    fireEvent.click(screen.getByText('Reread'));

    expect(onReload).toHaveBeenCalled();
  });

  it('closes on escape', () => {
    const onClose = vi.fn();
    render(<Environment {...props} environment={environment()} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});

describe('skills a session would load', () => {
  /** The dot beside the one skill in the fixture. Plugins carry dots of their own, so the
      section has to be found first rather than taking the first dot on the panel. */
  const skillDot = (container: HTMLElement) => {
    const heading = [...container.querySelectorAll('.environment-heading')].find((h) => h.textContent === 'Skills');
    return heading?.parentElement?.querySelector('.environment-dot') ?? null;
  };

  const skill = (over: Partial<SessionEnvironment['skills'][number]> = {}) => ({
    name: 'agent-creator',
    commandName: 'agent-creator',
    description: 'Build a custom agent',
    source: 'personal-copilot',
    userInvocable: true,
    enabled: true,
    path: 'C:\\Users\\x\\.copilot\\skills\\agent-creator\\SKILL.md',
    ...over,
  });

  const withSkills = (over: Partial<SessionEnvironment['skills'][number]>[] = [{}]) =>
    environment({ skills: over.map(skill) });

  it('names a skill as it would be typed', () => {
    render(<Environment {...props} environment={withSkills()} />);

    expect(screen.getByText('/agent-creator')).toBeTruthy();
  });

  it('falls back to the name for a skill with no command', () => {
    render(<Environment {...props} environment={withSkills([{ name: 'quiet', commandName: undefined }])} />);

    expect(screen.getByText('quiet')).toBeTruthy();
  });

  it('says where a skill came from', () => {
    render(<Environment {...props} environment={withSkills([{ source: 'plugin' }])} />);

    expect(screen.getByText('Plugin')).toBeTruthy();
  });

  // Not a closed set, so an unfamiliar one is shown as the runtime named it rather than hidden.
  it('shows a source it does not recognise', () => {
    render(<Environment {...props} environment={withSkills([{ source: 'something-new' }])} />);

    expect(screen.getByText('something-new')).toBeTruthy();
  });

  it('offers no switch without a session to switch it for', () => {
    render(<Environment {...props} environment={withSkills()} />);

    expect(screen.queryByRole('button', { name: /On|Off/ })).toBeNull();
    expect(screen.getByText(/Open a session to switch any of these off/)).toBeTruthy();
  });

  it('switches a skill off for this session', () => {
    const onToggleSkill = vi.fn();
    render(<Environment {...props} environment={withSkills()} onToggleSkill={onToggleSkill} />);

    fireEvent.click(screen.getByRole('button', { name: 'On' }));

    expect(onToggleSkill).toHaveBeenCalledWith('agent-creator', false);
  });

  it('switches one back on', () => {
    const onToggleSkill = vi.fn();
    render(
      <Environment
        {...props}
        environment={withSkills()}
        disabledSkills={['agent-creator']}
        onToggleSkill={onToggleSkill}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    expect(onToggleSkill).toHaveBeenCalledWith('agent-creator', true);
  });

  it('shows a switched-off skill as off', () => {
    render(<Environment {...props} environment={withSkills()} disabledSkills={['agent-creator']} onToggleSkill={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('false');
  });

  // The dot is the only mark a reader takes in at a glance, so it has to follow the choice
  // rather than only the runtime's answer.
  it('dims the dot for a skill this session has switched off', () => {
    const { container } = render(
      <Environment {...props} environment={withSkills()} disabledSkills={['agent-creator']} onToggleSkill={vi.fn()} />,
    );

    expect(skillDot(container)?.className).toBe('environment-dot off');
  });

  it('lights the dot for a skill this session is still loading', () => {
    const { container } = render(<Environment {...props} environment={withSkills()} onToggleSkill={vi.fn()} />);

    expect(skillDot(container)?.className).toBe('environment-dot on');
  });

  // A choice made here cannot overrule the runtime turning it off for everything.
  it('offers no switch for a skill the runtime has off everywhere', () => {
    render(<Environment {...props} environment={withSkills([{ enabled: false }])} onToggleSkill={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /^(On|Off)$/ })).toBeNull();
    expect(screen.getByText('off everywhere')).toBeTruthy();
  });

  it('says when there are none', () => {
    render(<Environment {...props} environment={environment({ skills: [] })} />);

    expect(screen.getByText('No skills found for this directory.')).toBeTruthy();
  });
});

describe('skills that would not load', () => {
  const errorsIn = (container: HTMLElement) =>
    [...container.querySelectorAll('.environment-errors .environment-meta')].map((n) => n.textContent);

  it('reports a skill the runtime could not read', () => {
    const { container } = render(
      <Environment
        environment={environment({ skillErrors: ['pdf: SKILL.md has no description'] })}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
      />,
    );

    expect(errorsIn(container)).toEqual(['pdf: SKILL.md has no description']);
  });

  // A broken skill is the reason to look, so it has to show even when nothing else loaded.
  it('reports failures even when no skill loaded at all', () => {
    const { container } = render(
      <Environment
        environment={environment({ skills: [], skillErrors: ['pdf: unreadable'] })}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
      />,
    );

    expect(errorsIn(container)).toEqual(['pdf: unreadable']);
  });

  it('says nothing when every skill loaded', () => {
    const { container } = render(
      <Environment
        environment={environment({ skillErrors: [] })}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
      />,
    );

    expect(container.querySelector('.environment-errors')).toBeNull();
  });
});
/**
 * MCP servers belong here because the CLI's own /env lists them, and because which servers
 * a directory would load is answerable without running anything (#24).
 */
describe('Environment, MCP servers', () => {
  const shown = (over = {}) =>
    render(
      <Environment
        environment={environment(over)}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
      />,
    );

  it('says when there are none, rather than leaving the section out', () => {
    shown({ mcpServers: [] });
    expect(screen.getByText('No MCP servers configured.')).toBeTruthy();
  });

  it('names each server and how it is reached', () => {
    shown({ mcpServers: [{ name: 'context7', type: 'http', source: 'user', enabled: true, editable: true }] });

    expect(screen.getByText('context7')).toBeTruthy();
    expect(screen.getByText('http')).toBeTruthy();
  });

  /** A disabled server is still configured, so it is listed and marked rather than hidden. */
  it('marks one that is switched off', () => {
    const { container } = shown({
      mcpServers: [{ name: 'context7', type: 'http', source: 'user', enabled: false, editable: true }],
    });

    expect(screen.getByText('off')).toBeTruthy();
    expect(container.querySelector('.environment-dot.off')).toBeTruthy();
  });

  it('does not mark one that is on', () => {
    const { container } = shown({
      mcpServers: [{ name: 'context7', type: 'http', source: 'user', enabled: true, editable: true }],
    });

    expect(container.querySelector('.environment-dot.on')).toBeTruthy();
    expect(screen.queryByText('off')).toBeNull();
  });

  // Where it came from is where it would have to be changed, and a plugin's server cannot
  // be edited where the reader's own can.
  it('names the plugin that provided one rather than just calling it a plugin', () => {
    shown({
      mcpServers: [
        { name: 'from-a-plugin', type: 'stdio', source: 'plugin', sourcePlugin: 'mcp-provider', enabled: true },
      ],
    });

    expect(screen.getByText('mcp-provider')).toBeTruthy();
    expect(screen.queryByText('plugin')).toBeNull();
  });

  it('falls back to the source when no plugin provided it', () => {
    shown({ mcpServers: [{ name: 'context7', type: 'http', source: 'user', enabled: true, editable: true }] });

    expect(screen.getByText('user')).toBeTruthy();
  });
});

describe('Environment, switching an MCP server', () => {
  const server = (over = {}) => ({
    name: 'context7',
    type: 'http',
    source: 'user',
    enabled: true,
    editable: true,
    ...over,
  });

  const shown = (over = {}, onToggleMcp?: (name: string, enabled: boolean) => void) =>
    render(
      <Environment
        environment={environment({ mcpServers: [server(over)] })}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
        onToggleMcp={onToggleMcp}
      />,
    );

  it('turns one off that is on', () => {
    const onToggleMcp = vi.fn();
    shown({}, onToggleMcp);

    fireEvent.click(screen.getByTitle(/Stop starting context7/));
    expect(onToggleMcp).toHaveBeenCalledWith('context7', false);
  });

  it('turns one back on', () => {
    const onToggleMcp = vi.fn();
    shown({ enabled: false }, onToggleMcp);

    fireEvent.click(screen.getByTitle(/Start context7 in new sessions again/));
    expect(onToggleMcp).toHaveBeenCalledWith('context7', true);
  });

  it('says which state it is in', () => {
    const { rerender } = shown({}, vi.fn());
    expect(screen.getByTitle(/context7/).getAttribute('aria-pressed')).toBe('true');

    rerender(
      <Environment
        environment={environment({ mcpServers: [server({ enabled: false })] })}
        loading={false}
        failed={null}
        onReload={() => {}}
        onClose={() => {}}
        onToggleMcp={vi.fn()}
      />,
    );
    expect(screen.getByTitle(/context7/).getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * The scope is not the skills toggle's. This writes the reader's own configuration, so it
   * decides what every new session starts with and changes nothing already connected.
   */
  it('says the change applies to new sessions rather than running ones', () => {
    shown({}, vi.fn());

    expect(screen.getByText(/Applies to new sessions only/)).toBeTruthy();
  });

  it('offers no control when the caller cannot write the configuration', () => {
    shown({ enabled: false }, undefined);

    expect(screen.queryByTitle(/context7/)).toBeNull();
    expect(screen.getByText('off')).toBeTruthy();
  });
});

/**
 * Custom agents and hooks, which the CLI's own /env lists and this panel did not (#165).
 */
describe('Environment, custom agents', () => {
  const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    id: 'deep-audit',
    name: 'deep-audit',
    displayName: 'Deep Audit',
    description: 'Audits things',
    source: 'user',
    path: 'C:\\Users\\x\\.copilot\\agents\\deep-audit.agent.md',
    userInvocable: true,
    ...over,
  });

  const withAgents = (agents: AgentSummary[]) =>
    render(<Environment {...props} environment={environment({ agents })} />);

  it('lists them by the name they are shown under', () => {
    withAgents([agent()]);

    expect(screen.getByText('Deep Audit')).toBeTruthy();
    expect(screen.getByText('Audits things')).toBeTruthy();
  });

  it('says where one came from', () => {
    withAgents([agent({ source: 'project' })]);

    expect(screen.getByText('This project')).toBeTruthy();
  });

  /** Unrecognised sources are shown as the runtime named them rather than hidden. */
  it('passes on a source it has no words for', () => {
    withAgents([agent({ source: 'somewhere-new' })]);

    expect(screen.getByText('somewhere-new')).toBeTruthy();
  });

  /** They still load, and another agent can still delegate to one, so they are listed. */
  it('marks the ones a reader cannot choose', () => {
    withAgents([agent({ id: 'spawned', name: 'spawned', displayName: 'Spawned', userInvocable: false })]);

    expect(screen.getByText('delegated only')).toBeTruthy();
  });

  it('says nothing is there rather than showing an empty heading', () => {
    withAgents([]);

    expect(screen.getByText('No custom agents found for this directory.')).toBeTruthy();
  });
});

describe('Environment, hooks', () => {
  const hook = (over: Partial<HookSummary> = {}): HookSummary => ({
    id: 'hook:abc',
    event: 'preToolUse',
    origin: 'user',
    source: 'C:\\Users\\x\\.copilot\\hooks\\sounds.json',
    enabled: true,
    ...over,
  });

  const withHooks = (hooks: HookSummary[], hookErrors: string[] = []) =>
    render(<Environment {...props} environment={environment({ hooks, hookErrors })} />);

  /**
   * The runtime identifies a hook by a hash and carries no name for one, so when it fires
   * and the file it lives in are all there is to show.
   */
  it('names one by when it fires', () => {
    withHooks([hook()]);

    expect(screen.getByText('preToolUse')).toBeTruthy();
  });

  it('shows the file it lives in, without the directories nobody is reading', () => {
    withHooks([hook()]);

    expect(screen.getByText('sounds.json')).toBeTruthy();
  });

  it('keeps the whole path where it can be pointed at', () => {
    withHooks([hook()]);

    expect(screen.getByTitle('C:\\Users\\x\\.copilot\\hooks\\sounds.json')).toBeTruthy();
  });

  it('says where one came from', () => {
    withHooks([hook({ origin: 'repository' })]);

    expect(screen.getByText('This repository')).toBeTruthy();
  });

  it('marks one that will not fire', () => {
    withHooks([hook({ enabled: false })]);

    expect(screen.getByText('off')).toBeTruthy();
  });

  it('survives a hook the runtime did not attribute to a file', () => {
    withHooks([hook({ source: undefined })]);

    expect(screen.getByText('preToolUse')).toBeTruthy();
  });

  it('says nothing is there rather than showing an empty heading', () => {
    withHooks([]);

    expect(screen.getByText('No hooks found for this directory.')).toBeTruthy();
  });

  /** A hook whose source failed to load is absent, which reads as never having been written. */
  it('reports what could not be loaded', () => {
    withHooks([], ['sounds.json is not valid JSON']);

    expect(screen.getByText('sounds.json is not valid JSON')).toBeTruthy();
  });
});
/**
 * Writing MCP servers down, where the list of them already is. All of it sessionless: the
 * config is a file rather than anything a conversation holds (#24).
 */
describe('Environment, editing MCP servers', () => {
  const server = (over = {}) => ({
    name: 'context7',
    type: 'http',
    source: 'user',
    enabled: true,
    editable: true,
    url: 'https://c7/mcp',
    ...over,
  });

  const shown = (servers = [server()], over: Partial<Parameters<typeof Environment>[0]> = {}) =>
    render(
      <Environment
        {...props}
        environment={environment({ mcpServers: servers as never })}
        onSaveMcp={() => {}}
        onRemoveMcp={() => {}}
        {...over}
      />,
    );

  it('says what an http server is reached at', () => {
    shown();

    expect(screen.getByText('https://c7/mcp')).toBeTruthy();
  });

  it('says what a command server runs, arguments and all', () => {
    shown([server({ url: undefined, command: 'npx', args: ['-y', 'pkg'] })]);

    expect(screen.getByText('npx -y pkg')).toBeTruthy();
  });

  /** A plugin's server is in the plugin's file, so editing it here would write a copy. */
  it('offers no editing for a server a plugin brought', () => {
    shown([server({ editable: false, sourcePlugin: 'awesome-copilot' })]);

    expect(screen.queryByRole('button', { name: /Change how/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take context7 out/ })).toBeNull();
  });

  it('removes one when asked', async () => {
    const onRemoveMcp = vi.fn();
    shown([server()], { onRemoveMcp });

    await userEvent.click(screen.getByRole('button', { name: /Take context7 out/ }));

    expect(onRemoveMcp).toHaveBeenCalledWith('context7');
  });

  it('leaves the list read-only when nothing can be written', () => {
    render(<Environment {...props} environment={environment({ mcpServers: [server()] as never })} />);

    expect(screen.queryByRole('button', { name: 'Add a server' })).toBeNull();
  });

  describe('the form', () => {
    const openAdd = async () => userEvent.click(screen.getByRole('button', { name: 'Add a server' }));

    it('writes a new http server down', async () => {
      const onSaveMcp = vi.fn();
      shown([server()], { onSaveMcp });
      await openAdd();

      await userEvent.type(screen.getByLabelText('Name'), 'newone');
      await userEvent.type(screen.getByLabelText('URL'), 'https://new/mcp');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(onSaveMcp).toHaveBeenCalledWith('newone', { transport: 'http', url: 'https://new/mcp' });
    });

    it('writes a command server, splitting the arguments as a shell would', async () => {
      const onSaveMcp = vi.fn();
      shown([server()], { onSaveMcp });
      await openAdd();

      await userEvent.type(screen.getByLabelText('Name'), 'local');
      await userEvent.click(screen.getByRole('button', { name: 'Command' }));
      await userEvent.type(screen.getByLabelText('Command'), 'npx');
      await userEvent.type(screen.getByLabelText('Arguments'), '-y  pkg');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(onSaveMcp).toHaveBeenCalledWith('local', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
      });
    });

    /** The name is the key the config is written under, so a new one must not take another. */
    it('refuses a name that is already configured', async () => {
      const onSaveMcp = vi.fn();
      shown([server()], { onSaveMcp });
      await openAdd();

      await userEvent.type(screen.getByLabelText('Name'), 'context7');

      expect(screen.getByText(/already configured/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('will not save without somewhere to reach the server', async () => {
      shown([server()], { onSaveMcp: vi.fn() });
      await openAdd();

      await userEvent.type(screen.getByLabelText('Name'), 'newone');

      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('opens on what an existing server already is', async () => {
      shown([server()], { onSaveMcp: vi.fn() });

      await userEvent.click(screen.getByRole('button', { name: /Change how/ }));

      expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://c7/mcp');
    });

    /** Renaming would add a second server rather than rename the first. */
    it('will not let an existing server be renamed', async () => {
      shown([server()], { onSaveMcp: vi.fn() });

      await userEvent.click(screen.getByRole('button', { name: /Change how/ }));

      expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    });

    it('puts the form away without saving when cancelled', async () => {
      const onSaveMcp = vi.fn();
      shown([server()], { onSaveMcp });
      await openAdd();

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(onSaveMcp).not.toHaveBeenCalled();
    });

    it('puts the form away once it is saved', async () => {
      shown([server()], { onSaveMcp: vi.fn() });
      await openAdd();

      await userEvent.type(screen.getByLabelText('Name'), 'newone');
      await userEvent.type(screen.getByLabelText('URL'), 'https://new/mcp');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByLabelText('URL')).toBeNull();
    });

    /** Nothing configured is still somewhere to add one from. */
    it('offers to add a server when there are none at all', () => {
      shown([]);

      expect(screen.getByRole('button', { name: 'Add a server' })).toBeTruthy();
    });
  });
});