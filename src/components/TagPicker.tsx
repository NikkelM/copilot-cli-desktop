import { useEffect, useMemo, useRef, useState } from 'react';

import { normalise } from '../lib/useTags';
import type { WikiTag } from '../lib/useWikiTags';

/**
 * How many words from the wiki to offer at once.
 *
 * Roughly three rows of the dialog, which is what it is for: enough to be worth reading past
 * the first few, and short of the 889 of them here.
 *
 * A fixed number rather than however many fit. A row's height is six values spread across
 * three rules - the pill's border and padding, the button's padding, its font size and line
 * height, and the gap between rows - and `--font-lg` moves with the text-size setting.
 * Clipping to a height calculated from all that would restate every one of them, and go
 * wrong the moment any of them changed.
 */
const WIKI_SUGGESTIONS = 10;

/**
 * What is true about a session right now, as a list to tick and a box to add to.
 *
 * A dialog rather than a submenu on the right-click menu. Tags are many to a session and are
 * changed in handfuls - one on, two off, a new one - and a menu that closes on every choice
 * would mean reopening it for each (#123).
 *
 * Tags already in use are offered, because a list where half the sessions read `needs-review`
 * and the other half `needs review` is worth less than either spelling alone.
 */
export function TagPicker({
  title,
  held,
  known,
  wikiTags = [],
  onToggle,
  onRetire,
  onDismiss,
  onClose,
}: {
  /** The session being tagged, so the dialog says what it is about. */
  title: string;
  held: readonly string[];
  /** Every tag in use anywhere, commonest first. */
  known: readonly string[];
  /**
   * The words the wiki is already written in, for the ones no session uses yet (#35).
   *
   * Offered only while a tag is being typed. Tagging a session in the wiki's own words is
   * what lets the two find each other; tagging it in different words matches nothing.
   */
  wikiTags?: readonly WikiTag[];
  onToggle: (tag: string) => void;
  /** Takes a tag off every session. Nothing else removes a name once it stops being used. */
  onRetire: (tag: string) => void;
  /**
   * Stop offering a word the wiki uses (#35).
   *
   * Nothing is done to the wiki, which is somebody else's file: this only says the app
   * should stop suggesting it. Absent leaves the suggestions with no way to be refused.
   */
  onDismiss?: (tag: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement>(null);

  /**
   * The order the chips are drawn in, taken once when the dialog opens.
   *
   * What is true reads before what could be, but only at the moment of asking. Recomputing it
   * as tags are ticked would move each one to the front as it was chosen, so the next one
   * someone reached for would have moved somewhere else under the pointer - and tags are
   * changed in handfuls, which is the whole reason this is a dialog.
   */
  const [order, setOrder] = useState<string[]>(() => [
    ...held,
    ...known.filter((tag) => !held.includes(tag)),
  ]);

  // A tag invented while the dialog is open joins the end rather than displacing anything.
  useEffect(() => {
    const drawn = new Set(order);
    const added = [...new Set([...held, ...known])].filter((tag) => !drawn.has(tag));
    if (added.length > 0) setOrder((current) => [...current, ...added]);
  }, [held, known, order]);

  useEffect(() => field.current?.focus(), []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const add = () => {
    const tag = normalise(draft);
    // Adding one already on the session would take it off, which is not what typing a name
    // into a box called "add" means.
    if (tag && !held.includes(tag)) onToggle(tag);
    setDraft('');
  };

  /**
   * What is offered, narrowed by whatever is being typed.
   *
   * The box that adds a tag also finds one, which is how most tag inputs behave and is the
   * only version that needs no second control and no threshold: it is as useful at three
   * tags as at three hundred. Typing a name that exists finds it; typing one that does not
   * leaves an empty list and the Add button, which is exactly the choice being made.
   *
   * The order is the one taken when the dialog opened, so ticking a tag does not move it out
   * from under the pointer - but a name that has gone since is dropped rather than held in
   * place, or retiring one would leave it on screen until the dialog was opened again.
   */
  const needle = normalise(draft);
  const offered = order
    .filter((tag) => known.includes(tag) || held.includes(tag))
    .filter((tag) => !needle || tag.includes(needle));

  /**
   * Words the wiki uses that the sessions do not, narrowed to whatever is being typed.
   *
   * Offered at rest as well as while typing, commonest first, so the words a wiki is mostly
   * written in are visible to somebody who does not know to look for them - which is the
   * whole problem. Capped: there are 889 of these against a handful of session tags, and a
   * list that long is a wall rather than a suggestion.
   */
  const fromWiki = useMemo(
    () =>
      wikiTags
        .filter(({ tag }) => !needle || tag.includes(needle))
        .filter(({ tag }) => !known.includes(tag) && !held.includes(tag))
        .slice(0, WIKI_SUGGESTIONS),
    [needle, wikiTags, known, held],
  );

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm tag-picker"
        role="dialog"
        aria-modal="true"
        aria-label={`Tags for ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">Tags</h2>
        <p className="confirm-body">{title}</p>

        <form
          className="tag-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            ref={field}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Find or add a tag"
            aria-label="Find or add a tag"
            spellCheck={false}
          />
          {/* Refused for one the session already has: the pill in the list below is marked
              and is what takes it off, and a button that silently did nothing would be the
              only thing here that does. */}
          <button
            type="submit"
            disabled={needle === '' || held.includes(needle)}
            title={held.includes(needle) ? `This session already has ${needle}` : undefined}
          >
            Add
          </button>
        </form>

        {offered.length > 0 && (
          <ul className="tag-list">
            {offered.map((tag) => (
              <li key={tag}>
                {/* The pill is a container rather than a control: it holds two, and one
                    cannot be nested in the other. */}
                <span className={held.includes(tag) ? 'tag on' : 'tag'}>
                  <button
                    type="button"
                    className="tag-name"
                    aria-pressed={held.includes(tag)}
                    onClick={() => onToggle(tag)}
                  >
                    {tag}
                  </button>
                  {/* Retiring a name reaches past this session, which is the one thing here
                      that does, so it is its own target rather than a second meaning for the
                      name beside it. */}
                  <button
                    type="button"
                    className="tag-retire"
                    aria-label={`Remove ${tag} from every session`}
                    title={`Remove ${tag} from every session`}
                    onClick={() => onRetire(tag)}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* The words the wiki is already written in, under the ones the sessions use.

            Tagging a session in the wiki's own words is what makes the two find each other -
            a session tagged `ireland` and a page tagged `dublin` were about the same thing
            here and never met - and the page count is what says whether a word is one of
            them (#35). */}
        {fromWiki.length > 0 && (
          <>
            <p className="tag-from-wiki-label">From your wiki</p>
            <ul className="tag-list">
              {fromWiki.map(({ tag, pages }) => (
                <li key={tag}>
                  {/* Built as a tag in use is: a pill holding two controls, because it has
                      the same two things to offer - take it, or stop being shown it. */}
                  <span className="tag tag-from-wiki">
                    <button
                      type="button"
                      className="tag-name"
                      onClick={() => onToggle(tag)}
                      title={`Used on ${pages} ${pages === 1 ? 'page' : 'pages'} in your wiki`}
                    >
                      {tag}
                      <span className="tag-count">{pages}</span>
                    </button>
                    {/* Nothing is done to the wiki, which is somebody else's file. This only
                        says to stop offering the word here. */}
                    <button
                      type="button"
                      className="tag-retire"
                      aria-label={`Stop suggesting ${tag}`}
                      title={`Stop suggesting ${tag}`}
                      onClick={() => onDismiss?.(tag)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
