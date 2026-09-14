// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionEnvironment } from '../../shared/protocol';
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
