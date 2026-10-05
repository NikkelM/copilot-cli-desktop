/**
 * The fields a page declares about itself, shown as what they are.
 *
 * Read here rather than in the sidecar, which hands the block over as written: what the
 * fields mean is a question about this wiki's conventions, and a page whose frontmatter
 * cannot be made sense of should still be readable.
 *
 * A deliberately small reading of YAML - `key: value` and `- item` lists, which is all the
 * schema uses. Anything else is shown as the line it was written as rather than guessed at.
 *
 * Its own file rather than the browser's, because the column that reads a page beside a
 * session needs it too and the browser imports that column's body (#35).
 */
export function readFrontmatter(source: string): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [];

  for (const line of source.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && fields.length > 0) {
      const last = fields[fields.length - 1]!;
      last.value = last.value ? `${last.value}, ${item[1]!.trim()}` : item[1]!.trim();
      continue;
    }

    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields.push({ key: field[1]!, value: field[2]!.trim().replace(/^["']|["']$/g, '') });
  }

  return fields.filter((field) => field.value !== '');
}
