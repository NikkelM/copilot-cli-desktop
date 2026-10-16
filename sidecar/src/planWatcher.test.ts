import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const { watch, existsSync } = vi.hoisted(() => ({ watch: vi.fn(), existsSync: vi.fn(() => false) }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), watch, existsSync,
}));
import { createPlanWatcher } from './plans.js';

beforeEach(() => {
  watch.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { close: vi.fn() }));
});

it('reports watcher errors and closes the failed watcher', () => {
  const changed = vi.fn();
  const plans = createPlanWatcher(changed);
  plans.watch('s1');
  const watcher = watch.mock.results[0].value;
  watcher.emit('error', new Error('filesystem unavailable'));
  expect(watcher.close).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledExactlyOnceWith('s1', 'Plan updates could not be watched: filesystem unavailable');
});

it('ignores queued events and errors from a replaced watcher without closing the current one', () => {
  const changed = vi.fn();
  const plans = createPlanWatcher(changed);
  plans.watch('s1');
  const oldWatcher = watch.mock.results[0].value;
  const oldEvent = watch.mock.calls[0][1];
  plans.watch('s2');
  oldEvent('change', 'plan.md');
  oldWatcher.emit('error', new Error('late error'));
  expect(changed).not.toHaveBeenCalled();
  expect(watch.mock.results[1].value.close).not.toHaveBeenCalled();
  plans.close();
});

it('reports filename-less directory events and matches the plan filename case-insensitively', () => {
  const changed = vi.fn();
  const plans = createPlanWatcher(changed);
  plans.watch('s1');
  const event = watch.mock.calls[0][1];
  event('change', 'events.jsonl');
  expect(changed).not.toHaveBeenCalled();
  event('rename', null);
  event('rename', 'PLAN.MD');
  expect(changed.mock.calls).toEqual([['s1'], ['s1']]);
  plans.close();
});
