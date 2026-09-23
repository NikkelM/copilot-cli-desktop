/**
 * The open session's tags, in its header.
 *
 * The sidebar already draws them, but only while it is there and only on the row someone
 * happens to be looking at. This says what is true about the session being read, which is
 * also the session most likely to want a tag changing.
 *
 * Pressing one opens the picker rather than filtering. Filtering from here would mean
 * narrowing a list that may not be on screen, and the reason to look at a tag while reading
 * a session is usually to change it (#123).
 */
export function HeaderTags({ tags, onEdit }: { tags: readonly string[]; onEdit: () => void }) {
  return (
    <button
      type="button"
      className="header-tags"
      onClick={onEdit}
      title={tags.length > 0 ? 'Edit tags' : 'Tag this session'}
    >
      {tags.length > 0 ? (
        tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))
      ) : (
        // Something to press when there is nothing to show, or tagging would be reachable
        // only from a right-click, which is not a thing anyone finds by looking.
        <span className="header-tags-empty">Add tags</span>
      )}
    </button>
  );
}
