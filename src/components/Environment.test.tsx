// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEnvironment } from '../../shared/protocol';
import { Environment } from './Environment';

const pickFolder = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => pickFolder(...args) }));

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
describe('the directories a session may reach', () => {
  beforeEach(() => {
    pickFolder.mockReset().mockResolvedValue(null);
  });

  const withDirectories = (over: Record<string, unknown> = {}) =>
    render(<Environment {...props} environment={environment()} cwd={'C:\\work\\repo'} {...over} />);

  it('names the directory the session works in', () => {
    withDirectories();

    expect(screen.getByText('Working directory')).toBeTruthy();
    expect(screen.getByText('C:\\work\\repo')).toBeTruthy();
  });

  it('lists a directory that was added', () => {
    withDirectories({ directories: ['C:\\wiki'] });

    expect(screen.getByText('C:\\wiki')).toBeTruthy();
    expect(screen.getByText('Added')).toBeTruthy();
  });

  // The panel opens on a session that was never started as readily as on a live one, and
  // there is nothing to grant a directory to until one is selected.
  it('offers no way to add one without a session', () => {
    withDirectories();

    expect(screen.queryByRole('button', { name: 'Add directory' })).toBeNull();
    expect(screen.getByText(/Open a session to give it another directory/)).toBeTruthy();
  });

  it('leaves an added directory listed but fixed without a session', () => {
    withDirectories({ directories: ['C:\\wiki'] });

    expect(screen.getByText('C:\\wiki')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('hands back the directory that was picked', async () => {
    pickFolder.mockResolvedValue('C:\\wiki');
    const onAddDirectory = vi.fn();
    withDirectories({ onAddDirectory });

    fireEvent.click(screen.getByRole('button', { name: 'Add directory' }));

    await waitFor(() => expect(onAddDirectory).toHaveBeenCalledWith('C:\\wiki'));
    expect(pickFolder).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });

  it('adds nothing when the picker is dismissed', async () => {
    const onAddDirectory = vi.fn();
    withDirectories({ onAddDirectory });

    fireEvent.click(screen.getByRole('button', { name: 'Add directory' }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(onAddDirectory).not.toHaveBeenCalled();
  });

  it('says so when the picker fails', async () => {
    pickFolder.mockRejectedValue(new Error('no picker here'));
    withDirectories({ onAddDirectory: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Add directory' }));

    await waitFor(() => expect(screen.getByText(/no picker here/)).toBeTruthy());
  });

  it('withdraws the directory whose button was pressed', () => {
    const onRemoveDirectory = vi.fn();
    withDirectories({ directories: ['C:\\wiki', 'C:\\notes'], onRemoveDirectory });

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);

    expect(onRemoveDirectory).toHaveBeenCalledWith('C:\\notes');
  });

  // Saying it is gone would be untrue: the runtime has no way to take a directory back
  // from a session that is already running.
  it('says a withdrawn directory stays reachable until the session restarts', () => {
    withDirectories({ pendingDirectories: ['C:\\wiki'] });

    expect(screen.getByText(/One directory stays/)).toBeTruthy();
  });

  it('counts several still held', () => {
    withDirectories({ pendingDirectories: ['C:\\wiki', 'C:\\notes'] });

    expect(screen.getByText(/2 directories stay/)).toBeTruthy();
  });

  it('says nothing about restarting when nothing is held', () => {
    withDirectories({ directories: ['C:\\wiki'] });

    expect(screen.queryByText(/until this session next starts/)).toBeNull();
  });
});
