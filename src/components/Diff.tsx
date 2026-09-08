import type { PatchLine } from '../lib/patch';

/**
 * A change, with the line numbers that say where in the file to look.
 *
 * Shared by the tool calls in the transcript and the session's own list of changes, which
 * show the same thing from two directions: one turn's edit, and everything a session did to
 * a file. They should never drift apart in how they draw it.
 */
export function Diff({ lines }: { lines: PatchLine[] }) {
  return (
    <div className="tool-diff">
      <table>
        <tbody>
          {lines.map((line, index) =>
            line.kind === 'skip' ? (
              <tr key={index} className="skip">
                <td className="gutter" colSpan={3}>
                  {line.hidden ? `${line.hidden} unchanged lines` : ''}
                </td>
              </tr>
            ) : (
              <tr key={index} className={line.kind}>
                <td className="gutter">{line.before ?? ''}</td>
                <td className="gutter">{line.after ?? ''}</td>
                <td className="mark">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
                <td className="code">
                  {/* Marked in two tones: the line is changed, and within it this is the
                      part that changed. Colouring the whole line only says something
                      happened somewhere in it. */}
                  {line.segments
                    ? line.segments.map((segment, at) =>
                        segment.changed ? (
                          <mark key={at}>{segment.text}</mark>
                        ) : (
                          <span key={at}>{segment.text}</span>
                        ),
                      )
                    : line.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
