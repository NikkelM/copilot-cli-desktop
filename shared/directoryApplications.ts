export interface DirectoryApplication {
  id: string;
  label: string;
}

export interface CustomDirectoryApplication extends DirectoryApplication {
  executable: string;
  args: string[];
  commandLine?: string;
}

/** Split quoted arguments without interpreting shell operators or expanding variables */
export function parseDirectoryArguments(line: string): string[] {
  const args: string[] = [];
  let value = '';
  let quoted = false;
  let started = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === '\\') {
      let end = at;
      while (line[end] === '\\') end++;
      const count = end - at;
      if (line[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quoted = !quoted;
        at = end;
      } else {
        value += '\\'.repeat(count);
        at = end - 1;
      }
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quoted) throw new Error('Arguments contain an unclosed double quote');
  if (started) args.push(value);
  return args;
}

export function formatDirectoryArguments(args: readonly string[]): string {
  return args.map((arg) => {
    if (arg && !/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }).join(' ');
}

export function customDirectoryApplications(value: string, draft = false): CustomDirectoryApplication[] {
  const parsed: unknown = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) throw new Error('Custom applications must be a list');
  const ids = new Set<string>();
  return parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' ||
        !('id' in entry) || typeof entry.id !== 'string' || !entry.id.startsWith('custom-') ||
        !('label' in entry) || typeof entry.label !== 'string' || (!draft && !entry.label.trim()) ||
        !('executable' in entry) || typeof entry.executable !== 'string' || (!draft && !entry.executable.trim()) ||
        !('args' in entry) || !Array.isArray(entry.args) || !entry.args.every((arg: unknown) => typeof arg === 'string')) {
      throw new Error('Each custom application needs a name, executable, and argument list');
    }
    if (ids.has(entry.id)) throw new Error('Custom application ids must be unique');
    ids.add(entry.id);
    if (entry.executable.includes('\0') || entry.args.some((arg: string) => arg.includes('\0'))) {
      throw new Error('Application paths and arguments cannot contain null characters');
    }
    if ('commandLine' in entry && typeof entry.commandLine !== 'string') {
      throw new Error('Application arguments must be text');
    }
    const commandLine = 'commandLine' in entry ? entry.commandLine as string : undefined;
    if (commandLine?.includes('\0')) throw new Error('Arguments cannot contain null characters');
    const args = commandLine !== undefined && !draft ? parseDirectoryArguments(commandLine) : entry.args;
    return {
      id: entry.id,
      label: draft ? entry.label : entry.label.trim(),
      executable: draft ? entry.executable : entry.executable.trim(),
      args,
      ...(commandLine !== undefined ? { commandLine } : {}),
    };
  });
}

/** Substitute only inside argument values, never through a shell or a command string */
export function directoryArguments(args: readonly string[], cwd: string): string[] {
  return args.map((arg) => arg.split('{cwd}').join(cwd));
}
