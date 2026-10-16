// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DirectoryApplications } from './DirectoryApplications';
import { customDirectoryApplications } from '../../shared/directoryApplications';

const initial = JSON.stringify([
  { id: 'custom-one', label: 'One', executable: 'C:\\one.exe', args: ['{cwd}'] },
  { id: 'custom-two', label: 'Two', executable: 'C:\\two.exe', args: ['--folder', '{cwd}'] },
]);

function Form({ pick = async () => 'C:\\new-editor.exe' }: { pick?: () => Promise<string | null> }) {
  const [value, setValue] = useState(initial);
  return <><DirectoryApplications value={value} onChange={setValue} onPickApplication={pick} /><output>{value}</output></>;
}

describe('custom directory application editor', () => {
  it('edits a single command line with quoted arguments', async () => {
    render(<Form />);
    await userEvent.clear(screen.getByLabelText('Application 2 name'));
    await userEvent.type(screen.getByLabelText('Application 2 name'), 'Second editor');
    await userEvent.clear(screen.getByLabelText('Application 2 arguments'));
    await userEvent.type(screen.getByLabelText('Application 2 arguments'), '--new-window ');
    await userEvent.paste('"{cwd}" --title "A folder"');
    const saved = customDirectoryApplications(screen.getByRole('status').textContent!);
    expect(saved[0]).toEqual(JSON.parse(initial)[0]);
    expect(saved[1]).toMatchObject({
      id: 'custom-two', label: 'Second editor', executable: 'C:\\two.exe',
      args: ['--new-window', '{cwd}', '--title', 'A folder'],
    });
    expect(screen.getByLabelText('Application 2 arguments').tagName).toBe('INPUT');
  });

  it('adds a picked executable with an editable name and arguments, and removes it', async () => {
    render(<Form />);
    await userEvent.click(screen.getByRole('button', { name: 'Add custom application' }));
    expect(screen.getByLabelText('Application 3 name')).toBeTruthy();
    expect((screen.getByLabelText('Application 3 name') as HTMLInputElement).value).toBe('new-editor');
    expect(screen.getByText('new-editor.exe', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('Application 3 executable') as HTMLInputElement).value).toBe('C:\\new-editor.exe');
    expect((screen.getByLabelText('Application 3 arguments') as HTMLInputElement).value).toBe('{cwd}');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove application' })[2]!);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual(JSON.parse(initial));
  });

  it('adds nothing when the native picker is cancelled', async () => {
    render(<Form pick={async () => null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add custom application' }));
    expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual(JSON.parse(initial));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports picker failure and allows trying again', async () => {
    const pick = vi.fn(async (): Promise<string | null> => { throw new Error('Picker unavailable'); });
    render(<Form pick={pick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add custom application' }));
    expect(screen.getByRole('alert').textContent).toBe('Picker unavailable');
    expect((screen.getByRole('button', { name: 'Add custom application' }) as HTMLButtonElement).disabled).toBe(false);
    expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual(JSON.parse(initial));
  });

  it('shows malformed stored configuration without crashing', () => {
    render(<DirectoryApplications value='[{"id":"bad"}]' onChange={() => {}} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
