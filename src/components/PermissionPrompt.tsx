import type { PendingPermission, PermissionChoice } from '../../shared/protocol';

interface PermissionPromptProps {
  pending: PendingPermission;
  onResolve: (choice: PermissionChoice) => void;
}

/**
 * Blocks on a tool call until the user decides.
 * The agent is genuinely waiting on this, so it stays visible until answered.
 */
export function PermissionPrompt({ pending, onResolve }: PermissionPromptProps) {
  const { request } = pending;
  const kind = typeof request.kind === 'string' ? request.kind : 'unknown';
  const intention = typeof request.intention === 'string' ? request.intention : null;
  const canApproveForSession = request.canOfferSessionApproval !== false;

  return (
    <section className="permission">
      <header className="permission-header">
        <span className="permission-kind">{kind}</span>
        <span>{intention ?? 'Copilot wants to run a tool'}</span>
      </header>

      <pre className="permission-detail">{detail(request, kind)}</pre>

      {typeof request.warning === 'string' && <p className="permission-warning">{request.warning}</p>}

      <div className="permission-actions">
        <button type="button" className="danger" onClick={() => onResolve('reject')}>
          Deny
        </button>
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

/** Pull the most informative field for each request kind. */
function detail(request: Record<string, unknown>, kind: string): string {
  const pick = (key: string): string | null => {
    const value = request[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };

  switch (kind) {
    case 'shell':
      return pick('fullCommandText') ?? '(no command text)';
    case 'write':
      return pick('diff') ?? pick('fileName') ?? '(no diff)';
    case 'read':
      return pick('path') ?? '(no path)';
    case 'url':
      return pick('url') ?? '(no url)';
    case 'mcp':
      return `${pick('serverName') ?? '?'} · ${pick('toolName') ?? '?'}`;
    case 'custom-tool':
      return `${pick('toolName') ?? '?'}\n${pick('toolDescription') ?? ''}`.trim();
    default:
      return JSON.stringify(request, null, 2).slice(0, 800);
  }
}
