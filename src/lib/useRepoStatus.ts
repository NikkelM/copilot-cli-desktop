import { useCallback, useEffect, useRef, useState } from 'react';

import { gitBranches, gitCommit, gitDiff, gitStage, gitStatus, gitSwitch, gitSync } from './sidecar';
import { messageOf } from './errors';
import type { FileDiff, MergeStrategy, RepoStatus } from '../../shared/protocol';

/**
 * A file can be in both lists at once with different contents in each, so a diff is held
 * against the side it answers for rather than against the path alone.
 */
export const diffKey = (path: string, staged: boolean) => `${staged ? 'staged' : 'unstaged'}:${path}`;

/**
 * The state of the session's repository, and the diffs the reader has opened.
 *
 * Read when the panel is opened and again when a turn records changes, rather than on a
 * timer: what changes the answer is the agent working or the reader editing, and the app
 * already knows about the first. A status walk is cheap but not free on a large repository,
 * so it does not run because something re-rendered (#42).
 *
 * Null covers both a directory outside a repository and one that could not be read, because
 * the panel does the same thing for each: says there is nothing to show. A session in a
 * plain folder is an ordinary session, not an error.
 */
export function useRepoStatus(cwd: string | null, open: boolean) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  /** What could not be done, for a reader who would otherwise see a button do nothing. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Paths with a staging operation in flight, so a row cannot be clicked twice. */
  const [busy, setBusy] = useState<string[]>([]);
  /** Whether a commit is being made, so it cannot be made twice. */
  const [committing, setCommitting] = useState(false);
  /** Which way the repository is being synced, so neither can be asked for twice. */
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  /**
   * Whether a pull stopped because the branches have both moved on and nobody has said how
   * to reconcile them. A question for the reader rather than a failure, so it is kept apart
   * from one: a failure is read and dismissed, and this one is answered.
   */
  const [diverged, setDiverged] = useState(false);
  /** The local branches, read only when the picker is opened. */
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  /** Whether a checkout is in flight, so two cannot race each other. */
  const [switching, setSwitching] = useState(false);
  /** Which directory is being shown, so a slow reply for another cannot land here. */
  const showing = useRef(cwd);
  showing.current = cwd;
  /** Diffs already asked for, so opening a row twice does not ask twice. */
  const asking = useRef(new Set<string>());
  /**
   * Which reading of the tree the held diffs describe.
   *
   * A diff answers the state the status was read in. Once the tree is read again the file
   * may have moved on, so anything held would describe something that is no longer true,
   * under a row that now means something else.
   */
  const reading = useRef(0);

  const load = useCallback(() => {
    const directory = showing.current;
    if (!directory) {
      setStatus(null);
      return;
    }

    reading.current += 1;
    const span = reading.current;
    asking.current.clear();
    setDiffs({});
    setLoading(true);

    gitStatus(directory)
      .then((found) => {
        if (showing.current === directory && span === reading.current) setStatus(found);
      })
      .catch(() => {
        if (showing.current === directory && span === reading.current) setStatus(null);
      })
      .finally(() => {
        if (showing.current === directory && span === reading.current) setLoading(false);
      });
  }, []);

  /** Fetch one file's diff, on the side the row belongs to. */
  const diff = useCallback((path: string, staged: boolean) => {    const directory = showing.current;
    const key = diffKey(path, staged);
    if (!directory || asking.current.has(key)) return;

    const span = reading.current;
    asking.current.add(key);
    gitDiff(directory, path, staged)
      .then((found) => {
        if (span !== reading.current) return;
        setDiffs((current) => ({ ...current, [key]: found }));
      })
      .catch(() => {
        // Reported as a diff that is not there rather than swallowed, or the row would say
        // it was reading for as long as it stayed open.
        if (span === reading.current) {
          setDiffs((current) => ({ ...current, [key]: { patch: null, stale: false } }));
        }
      })
      .finally(() => asking.current.delete(key));
  }, []);

  useEffect(() => {
    // Cleared rather than left behind: another repository's files under this session's name
    // would be worse than an empty panel for a moment.
    setStatus(null);
    setDiffs({});
    if (open && cwd) load();
  }, [cwd, open, load]);

  /**
   * Put a path into the index, or take it back out.
   *
   * The tree the sidecar reports afterwards is taken as the new state rather than the panel
   * assuming what staging did. Git is the authority on what happened, and a panel that drew
   * its own guess would eventually draw something that is not true.
   */
  const stage = useCallback(async (paths: string[], staged: boolean) => {
    const directory = showing.current;
    if (!directory || paths.length === 0) return;

    setBusy((current) => [...current, ...paths]);
    try {
      const found = await gitStage(directory, paths, staged);
      if (showing.current !== directory) return;

      // The file has moved between the two lists, so any diff held for it describes where
      // it used to be.
      reading.current += 1;
      asking.current.clear();
      setDiffs({});
      setStatus(found);
    } catch (error: unknown) {
      if (showing.current === directory) setFailed(messageOf(error));
    } finally {
      // Removes one occurrence of each, so a path staged twice at once is not freed early.
      setBusy((current) => {
        const left = [...current];
        for (const path of paths) {
          const at = left.indexOf(path);
          if (at >= 0) left.splice(at, 1);
        }
        return left;
      });
    }
  }, []);

  /**
   * Commit what is staged, or amend the commit at HEAD.
   *
   * The message is the reader's, passed through untouched. Git is the authority on what
   * happened afterwards, so the tree it reports is taken as the new state.
   */
  const commit = useCallback(async (message: string, amend: boolean) => {
    const directory = showing.current;
    if (!directory) return;

    setCommitting(true);
    setFailed(null);
    try {
      const found = await gitCommit(directory, message, amend);
      if (showing.current !== directory) return;

      reading.current += 1;
      asking.current.clear();
      setDiffs({});
      setStatus(found);
    } catch (error: unknown) {
      if (showing.current === directory) setFailed(messageOf(error));
    } finally {
      setCommitting(false);
    }
  }, []);

  /**
   * Send the branch to its remote, or bring the remote's work down onto it.
   *
   * Diffs survive a sync: neither direction moves anything between the index and the working
   * tree, so a diff the reader had open still describes the same change afterwards.
   */
  const sync = useCallback(async (direction: 'push' | 'pull', strategy?: MergeStrategy) => {
    const directory = showing.current;
    if (!directory) return;

    setSyncing(direction);
    setFailed(null);
    setDiverged(false);
    try {
      const found = await gitSync(directory, direction, strategy);
      if (showing.current !== directory) return;

      setStatus(found.status);
      setDiverged(found.diverged);
    } catch (error: unknown) {
      if (showing.current === directory) setFailed(messageOf(error));
    } finally {
      setSyncing(null);
    }
  }, []);

  /** Put the question away unanswered, which leaves the branch where the pull found it. */
  const dismissDiverged = useCallback(() => setDiverged(false), []);

  /**
   * The local branches, read only when the reader asks to see them.
   *
   * Not part of the status walk: most sessions never open the picker, and a repository with
   * a few hundred branches would pay for the list on every refresh.
   */
  const readBranches = useCallback(async () => {
    const directory = showing.current;
    if (!directory) return;

    try {
      const found = await gitBranches(directory);
      if (showing.current === directory) setBranches(found);
    } catch {
      // A branch list nobody can read is not worth an error line over the file list.
    }
  }, []);

  /**
   * Check one out, or make one and check it out.
   *
   * Everything on screen describes the branch being left, so the diffs go with it.
   */
  const switchTo = useCallback(async (name: string, create: boolean) => {
    const directory = showing.current;
    if (!directory) return;

    setSwitching(true);
    setFailed(null);
    try {
      const found = await gitSwitch(directory, name, create);
      if (showing.current !== directory) return;

      reading.current += 1;
      asking.current.clear();
      setDiffs({});
      setStatus(found);
      void readBranches();
    } catch (error: unknown) {
      if (showing.current === directory) setFailed(messageOf(error));
    } finally {
      setSwitching(false);
    }
  }, [readBranches]);

  return {
    status,
    loading,
    failed,
    diffs,
    diff,
    busy,
    stage,
    committing,
    commit,
    syncing,
    sync,
    diverged,
    dismissDiverged,
    branches,
    readBranches,
    switching,
    switchTo,
    refresh: load,
  };
}


