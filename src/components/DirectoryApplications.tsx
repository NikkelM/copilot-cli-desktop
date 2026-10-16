import { useState } from 'react';
import type { CustomDirectoryApplication } from '../../shared/directoryApplications';
import { customDirectoryApplications, formatDirectoryArguments } from '../../shared/directoryApplications';
import { messageOf } from '../lib/errors';

export function DirectoryApplications({
  value,
  onChange,
  onPickApplication,
}: {
  value: string;
  onChange: (value: string) => void;
  onPickApplication?: () => Promise<string | null>;
}) {
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  let targets: CustomDirectoryApplication[];
  try {
    targets = customDirectoryApplications(value, true);
  } catch {
    targets = [];
  }
  const put = (next: CustomDirectoryApplication[]) => onChange(JSON.stringify(next));
  async function add() {
    if (picking) return;
    setPicking(true);
    setPickError(null);
    try {
      const executable = await onPickApplication?.();
      if (!executable) return;
      const name = executable.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
      put([...targets, {
        id: `custom-${crypto.randomUUID()}`, label: name, executable, args: ['{cwd}'],
      }]);
    } catch (error) {
      setPickError(messageOf(error));
    } finally {
      setPicking(false);
    }
  }
  let problem: string | null = null;
  try {
    customDirectoryApplications(value);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  return (
    <div className="directory-applications">
      <button type="button" className="disk-action" disabled={picking || !onPickApplication} onClick={() => void add()}>
        {picking ? 'Choosing application...' : 'Add custom application'}
      </button>
      {pickError && <p role="alert" className="error">{pickError}</p>}
      {targets.length > 0 && (
        <p className="settings-note">Use double quotes for arguments containing spaces and {'{cwd}'} for the working directory.</p>
      )}
      {targets.map((target, index) => {
        const change = (patch: Partial<CustomDirectoryApplication>) =>
          put(targets.map((each, at) => at === index ? { ...each, ...patch } : each));
        return (
          <fieldset className="directory-custom" key={target.id}>
            <legend>{target.executable.split(/[\\/]/).pop() || 'Choose an executable'}</legend>
            <label>Name
              <input className="settings-text" aria-label={`Application ${index + 1} name`} value={target.label}
                onChange={(event) => change({ label: event.target.value })} />
            </label>
            <label>Executable
              <input className="settings-text" aria-label={`Application ${index + 1} executable`} value={target.executable}
                onChange={(event) => change({ executable: event.target.value })} spellCheck={false} />
            </label>
            <label>Arguments
              <input type="text" className="settings-text" aria-label={`Application ${index + 1} arguments`}
                value={target.commandLine ?? formatDirectoryArguments(target.args)} spellCheck={false}
                onChange={(event) => change({ commandLine: event.target.value })} />
            </label>
            <button type="button" className="disk-action destructive" onClick={() => put(targets.filter((_, at) => at !== index))}>
              Remove application
            </button>
          </fieldset>
        );
      })}
      {problem && <p role="alert" className="error">{problem}</p>}
    </div>
  );
}
