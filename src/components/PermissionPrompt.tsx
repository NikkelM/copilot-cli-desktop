import type { PendingPermission, PermissionChoice } from '../../shared/protocol';
import { parsePatch } from '../lib/patch';
import { Diff } from './Diff';
import { Expiry } from './Elapsed';
import { relativise } from '../lib/paths';

interface PermissionPromptProps {
  pending: PendingPermission;
  /** Used to shorten file paths in the request summary. */
  cwd: string | null;
  onResolve: (choice: PermissionChoice) => void;
  /**
   * Allow the session to work in the offered directory, then approve this request.
   *
   * Absent when the window cannot act on it, which keeps the button from appearing where
   * pressing it would do nothing.
   */
  onAllowFolder?: (path: string) => void;
}

/**
 * Blocks on a tool call until the user decides.
 * The agent is genuinely waiting on this, so it stays visible until answered.
 */
export function PermissionPrompt({ pending, cwd, onResolve, onAllowFolder }: PermissionPromptProps) {
  const { request } = pending;
  const kind = typeof request.kind === 'string' ? request.kind : 'unknown';
  const canApproveForSession = request.canOfferSessionApproval !== false;

  // `intention` is the agent's own short explanation, for example "Create file". It says
  // what is happening but never to what, so the subject has to be shown alongside it.
  const intention = str(request, 'intention');
  const subject = subjectOf(request, kind, cwd);
  const warning = str(request, 'warning');
  // Only where the sidecar found a directory outside what the session may already work in,
  // which is the case that asks twice for one edit (#210).
  const folder = pending.offerFolder;

  return (
    <section className="permission">
      <header className="permission-header">
        <span className="permission-kind">{kind}</span>
        <span className="permission-intent">{intention ?? 'Copilot wants to run a tool'}</span>
        {subject && <span className="permission-subject">{subject}</span>}
        <Expiry at={pending.expiresAt} />
      </header>

      {kind === 'write' ? (
        <WriteDiff patch={str(request, 'diff') ?? ''} />
      ) : (
        <pre className="permission-detail">{detail(request, kind)}</pre>
      )}

      {warning && <p className="permission-warning">{warning}</p>}

      {folder && onAllowFolder && (
        /* Said rather than implied: allowing a directory also activates any skills and
           agents defined under it, so it trusts what is configured there and not only what
           is stored there. */
        <p className="permission-folder-note">
          This path is outside where the session may work, which is why it is being asked
          twice. Allowing <code>{relativise(folder, cwd)}</code> also trusts any skills and
          agents configured under it.
        </p>
      )}

      <div className="permission-actions">
        <button type="button" className="danger" onClick={() => onResolve('reject')}>
          Deny
        </button>
        {folder && onAllowFolder && (
          <button
            type="button"
            className="secondary"
            title={`Let this session work in ${folder} without asking each time`}
            onClick={() => onAllowFolder(folder)}
          >
            Always allow this folder
          </button>
        )}
        {canApproveForSession && (
          <button type="button" className="secondary" onClick={() => onResolve('approve-for-session')}>
            Allow for session
          </button>
        )}
        <button type="button" onClick={() => onResolve('approve-once')}>
          Allow once
        </button>
      </div>
    </section>
  );
}

function str(request: Record<string, unknown>, key: string): string | null {
  const value = request[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** What the request acts on: the file, command, url or tool being asked about. */
function subjectOf(request: Record<string, unknown>, kind: string, cwd: string | null): string | null {
  switch (kind) {
    case 'write': {
      const file = str(request, 'fileName');
      return file ? relativise(file, cwd) : null;
    }
    case 'read': {
      const path = str(request, 'path');
      return path ? relativise(path, cwd) : null;
    }
    case 'shell':
      return str(request, 'fullCommandText');
    case 'url':
      return str(request, 'url');
    case 'mcp':
      return [str(request, 'serverName'), str(request, 'toolName')].filter(Boolean).join(' · ') || null;
    case 'custom-tool':
      return str(request, 'toolName');
    default:
      return null;
  }
}

/** Everything not covered by a dedicated renderer. */
function detail(request: Record<string, unknown>, kind: string): string {
  switch (kind) {
    case 'shell':
      return str(request, 'fullCommandText') ?? '(no command text)';
    case 'read':
      return str(request, 'path') ?? '(no path)';
    case 'url':
      return str(request, 'url') ?? '(no url)';
    case 'custom-tool':
      return str(request, 'toolDescription') ?? '(no description)';
    case 'mcp':
      return JSON.stringify(request.args ?? {}, null, 2).slice(0, 800);
    default:
      return JSON.stringify(request, null, 2).slice(0, 800);
  }
}

/**
 * The write being asked about, drawn the way an edit is drawn everywhere else.
 *
 * This used to split the text and colour it here, which meant the one place a change is
 * shown before it happens was the one place without line numbers or a mark on the part of
 * the line that actually differs (#69).
 */
function WriteDiff({ patch }: { patch: string }) {
  const lines = parsePatch(patch);
  if (lines.length === 0) return <pre className="permission-detail">(no diff)</pre>;

  return <Diff lines={lines} />;
}
