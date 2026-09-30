// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PermissionPrompt } from './PermissionPrompt';
import type { PendingPermission } from '../../shared/protocol';

function asked(request: Record<string, unknown>, cwd: string | null = null) {
  const onResolve = vi.fn();
  const pending: PendingPermission = {
    sessionId: 's1',
    requestId: 'r1',
    request,
    // Far enough out that the countdown cannot reach zero mid-test.
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  render(<PermissionPrompt pending={pending} cwd={cwd} onResolve={onResolve} />);
  return { onResolve, user: userEvent.setup() };
}

const detail = () => document.querySelector('.permission-detail')!.textContent;
const subject = () => document.querySelector('.permission-subject')?.textContent ?? null;

describe('answering a blocked tool call', () => {
  it('offers all three answers', async () => {
    const { onResolve, user } = asked({ kind: 'shell', fullCommandText: 'ls' });

    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    await user.click(screen.getByRole('button', { name: 'Allow for session' }));
    await user.click(screen.getByRole('button', { name: 'Deny' }));

    expect(onResolve.mock.calls.map(([choice]) => choice)).toEqual(['approve-once', 'approve-for-session', 'reject']);
  });

  /**
   * Some requests may not be approved for a whole session - a URL fetch, for instance.
   * Offering the button anyway would be offering an answer the runtime will not take.
   */
  it('hides the session-wide answer when the request refuses it', () => {
    asked({ kind: 'url', url: 'https://example.com', canOfferSessionApproval: false });

    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  });

  it('offers it when the request says nothing either way', () => {
    asked({ kind: 'shell', fullCommandText: 'ls' });

    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeTruthy();
  });
});

describe('saying what is being asked for', () => {
  /** The agent's own wording says what is happening but never to what. */
  it('shows the intention alongside the thing it acts on', () => {
    asked({ kind: 'shell', intention: 'Run a command', fullCommandText: 'git push --force' });

    expect(screen.getByText('Run a command')).toBeTruthy();
    expect(subject()).toBe('git push --force');
  });

  it('says something rather than nothing when the agent explains itself badly', () => {
    asked({ kind: 'shell', intention: '   ', fullCommandText: 'ls' });

    expect(screen.getByText('Copilot wants to run a tool')).toBeTruthy();
  });

  it('names the kind, so an unfamiliar request is still identifiable', () => {
    asked({ kind: 'mcp', serverName: 'github', toolName: 'create_issue' });

    expect(screen.getByText('mcp')).toBeTruthy();
    expect(subject()).toBe('github \u00b7 create_issue');
  });

  it('falls back to a named kind when the request has none', () => {
    asked({ intention: 'Do something' });

    expect(screen.getByText('unknown')).toBeTruthy();
  });

  it('shortens a path under the working directory, since the rest is the same for every row', () => {
    asked({ kind: 'read', path: 'C:\\work\\repo\\src\\App.tsx' }, 'C:\\work\\repo');

    expect(subject()).toBe('src/App.tsx');
  });

  it('carries the agent\u2019s warning, which is the reason to read the rest', () => {
    asked({ kind: 'shell', fullCommandText: 'rm -rf /', warning: 'This deletes everything' });

    expect(screen.getByText('This deletes everything')).toBeTruthy();
  });

  it('says nothing where there is no warning, rather than an empty line', () => {
    asked({ kind: 'shell', fullCommandText: 'ls' });

    expect(document.querySelector('.permission-warning')).toBeNull();
  });
});

describe('showing the detail of each kind of request', () => {
  it('shows a shell command in full, however long the header had to cut it', () => {
    asked({ kind: 'shell', fullCommandText: 'git log --oneline --graph --decorate --all' });

    expect(detail()).toBe('git log --oneline --graph --decorate --all');
  });

  it('shows a read as the path it was asked for, not the shortened one', () => {
    asked({ kind: 'read', path: 'C:\\work\\repo\\src\\App.tsx' }, 'C:\\work\\repo');

    expect(detail()).toBe('C:\\work\\repo\\src\\App.tsx');
  });

  it('shows a url', () => {
    asked({ kind: 'url', url: 'https://example.com/thing' });

    expect(detail()).toBe('https://example.com/thing');
  });

  it('describes a custom tool rather than repeating its name', () => {
    asked({ kind: 'custom-tool', toolName: 'deploy', toolDescription: 'Ships the current branch' });

    expect(subject()).toBe('deploy');
    expect(detail()).toBe('Ships the current branch');
  });

  it('shows an mcp call\u2019s arguments, which are the part worth reading', () => {
    asked({ kind: 'mcp', serverName: 'github', toolName: 'create_issue', args: { title: 'A bug' } });

    expect(detail()).toContain('"title": "A bug"');
  });

  it('falls back to the whole request for a kind with no renderer of its own', () => {
    asked({ kind: 'something-new', oddField: 'odd value' });

    expect(detail()).toContain('"oddField": "odd value"');
  });

  it('says so rather than showing an empty box when the field is missing', () => {
    asked({ kind: 'shell' });

    expect(detail()).toBe('(no command text)');
    expect(subject()).toBeNull();
  });
});

describe('showing a write as a diff', () => {
  const diff = [
    'diff --git a/file.ts b/file.ts',
    'index 1234567..89abcde 100644',
    '--- a/file.ts',
    '+++ b/file.ts',
    '@@ -1,2 +1,2 @@',
    '-const old = 1;',
    '+const now = 2;',
    ' const same = 3;',
  ].join('\n');

  const rows = () => Array.from(document.querySelectorAll('.tool-diff tr'));

  it('strips the git plumbing, which carries no meaning for someone deciding', () => {
    asked({ kind: 'write', fileName: 'C:\\work\\repo\\file.ts', diff }, 'C:\\work\\repo');

    const text = document.querySelector('.tool-diff')!.textContent!;
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('index 1234567');
    expect(text).not.toContain('--- a/file.ts');
  });

  it('marks the added, removed and unchanged lines apart from each other', () => {
    asked({ kind: 'write', fileName: 'file.ts', diff }, null);

    expect(rows().map((row) => row.className)).toEqual(['removed', 'added', 'context']);
  });

  /** The reason for sharing the renderer: where to look, not merely that something moved. */
  it('numbers the lines on the side they exist, like every other diff in the app', () => {
    asked({ kind: 'write', fileName: 'file.ts', diff }, null);

    const gutters = rows().map((row) =>
      Array.from(row.querySelectorAll('.gutter')).map((cell) => cell.textContent),
    );
    expect(gutters).toEqual([
      ['1', ''],
      ['', '1'],
      ['2', '2'],
    ]);
  });

  it('marks the part of the line that actually changed', () => {
    asked({ kind: 'write', fileName: 'file.ts', diff }, null);

    expect(Array.from(document.querySelectorAll('.tool-diff mark')).map((m) => m.textContent)).toContain('now = 2');
  });

  it('names the file it would write, shortened against the working directory', () => {
    asked({ kind: 'write', fileName: 'C:\\work\\repo\\src\\App.tsx', diff }, 'C:\\work\\repo');

    expect(subject()).toBe('src/App.tsx');
  });

  it('says there is no diff rather than showing an empty box', () => {
    asked({ kind: 'write', fileName: 'file.ts' });

    expect(detail()).toBe('(no diff)');
  });

  /** A rename or a mode change is all plumbing, so there is no change to draw. */
  it('says the same when every line was plumbing', () => {
    asked({ kind: 'write', fileName: 'file.ts', diff: 'diff --git a/a b/b\nrename from a\nrename to b\n' });

    expect(detail()).toBe('(no diff)');
  });
});

/**
 * Offering to allow the directory, where the double ask is noticed (#210).
 *
 * Tool permission and path verification are separate gates, so a path outside the session's
 * allowed directories is asked about twice. The prompt is where somebody is standing when
 * they notice, and it already carries the path.
 */
describe('allowing the folder a write is outside of', () => {
  const asking = (over: Partial<PendingPermission> = {}): PendingPermission => ({
    sessionId: 's1',
    requestId: 'r1',
    request: { kind: 'write', intention: 'Create file', fileName: 'C:\\Users\\me\\Downloads\\a.txt', diff: '' },
    expiresAt: null,
    ...over,
  });

  const button = () => screen.queryByRole('button', { name: /always allow this folder/i });

  it('offers nothing when there is no folder worth offering', () => {
    render(<PermissionPrompt pending={asking()} cwd={null} onResolve={() => {}} onAllowFolder={() => {}} />);

    expect(button()).toBeNull();
  });

  it('offers the folder the sidecar named', () => {
    render(
      <PermissionPrompt
        pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })}
        cwd={null}
        onResolve={() => {}}
        onAllowFolder={() => {}}
      />,
    );

    expect(button()).toBeTruthy();
  });

  // Pressing it would do nothing, so it is not there to press.
  it('offers nothing when the window cannot act on it', () => {
    render(
      <PermissionPrompt pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })} cwd={null} onResolve={() => {}} />,
    );

    expect(button()).toBeNull();
  });

  it('hands back the folder that was offered', async () => {
    const onAllowFolder = vi.fn();
    render(
      <PermissionPrompt
        pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })}
        cwd={null}
        onResolve={() => {}}
        onAllowFolder={onAllowFolder}
      />,
    );

    await userEvent.click(button()!);

    expect(onAllowFolder).toHaveBeenCalledWith('C:\\Users\\me\\Downloads');
  });

  /**
   * Allowing a directory also activates skills and agents defined under it, so it hands
   * over more than access. Saying so is the difference between a choice and a surprise.
   */
  it('says that allowing it trusts what is configured there', () => {
    render(
      <PermissionPrompt
        pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })}
        cwd={null}
        onResolve={() => {}}
        onAllowFolder={() => {}}
      />,
    );

    expect(screen.getByText(/trusts any skills and agents/)).toBeTruthy();
  });

  it('says why it is being asked twice', () => {
    render(
      <PermissionPrompt
        pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })}
        cwd={null}
        onResolve={() => {}}
        onAllowFolder={() => {}}
      />,
    );

    expect(screen.getByText(/asked\s+twice/)).toBeTruthy();
  });

  // The ordinary answers are still the ordinary answers.
  it('leaves the other choices alone', () => {
    render(
      <PermissionPrompt
        pending={asking({ offerFolder: 'C:\\Users\\me\\Downloads' })}
        cwd={null}
        onResolve={() => {}}
        onAllowFolder={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});

/**
 * Which agent is asking, when it is not the session's own (#229).
 *
 * The request names a tool call and nothing else, so without this a prompt raised by a
 * subagent delegated to twenty minutes ago looks exactly like one from the agent being
 * talked to - and approving a write is a decision about trust.
 */
describe('saying who is asking', () => {
  const asker = () => document.querySelector('.permission-asker')?.textContent ?? null;

  const askedBy = (by: PendingPermission['askedBy']) => {
    render(
      <PermissionPrompt
        pending={{
          sessionId: 's1',
          requestId: 'r1',
          request: { kind: 'shell', fullCommandText: 'ls' },
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          ...(by ? { askedBy: by } : {}),
        }}
        cwd={null}
        onResolve={vi.fn()}
      />,
    );
  };

  it('says nothing where the session asked for itself', () => {
    askedBy(undefined);

    expect(asker()).toBeNull();
  });

  it('names the subagent that asked', () => {
    askedBy({ agentId: 'agent-1', name: 'explore' });

    expect(asker()).toBe('Asked by explore, a subagent this session delegated to.');
  });

  /** A run attached to part-way through has the call but never saw the agent being named. */
  it('still says a subagent asked when it has no name for it', () => {
    askedBy({ agentId: 'agent-1' });

    expect(asker()).toBe('Asked by a subagent this session delegated to.');
  });

  it('draws the name as its own thing rather than as part of the sentence', () => {
    askedBy({ agentId: 'agent-1', name: 'code-review' });

    expect(document.querySelector('.permission-asker strong')?.textContent).toBe('code-review');
  });

  /** The agent id is the runtime's own handle and says nothing to a reader. */
  it('keeps the runtime handle for the agent out of it', () => {
    askedBy({ agentId: 'toolu_01T2EYeJ8kphRaM2nZNKDQYN', name: 'explore' });

    expect(asker()).not.toContain('toolu_');
  });
});
