// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { usePanel } from './usePanel';

const mounted = (id = 's1') => renderHook(({ session }) => usePanel(session), { initialProps: { session: id } });

describe('which panels are open', () => {
  it('starts with none', () => {
    const { result } = mounted();

    expect(result.current.open).toEqual([]);
  });

  it('opens one', () => {
    const { result } = mounted();

    act(() => result.current.show('changes'));

    expect(result.current.open).toEqual(['changes']);
  });

  it('says which are showing', () => {
    const { result } = mounted();

    act(() => result.current.show('changes'));

    expect(result.current.showing('changes')).toBe(true);
    expect(result.current.showing('todos')).toBe(false);
  });

  it('closes the one it is told to', () => {
    const { result } = mounted();
    act(() => result.current.show('changes'));

    act(() => result.current.hide('changes'));

    expect(result.current.open).toEqual([]);
  });

  it('closes them all when told none', () => {
    const { result } = mounted();
    act(() => result.current.show('changes'));
    act(() => result.current.show('todos'));

    act(() => result.current.hide());

    expect(result.current.open).toEqual([]);
  });

  /**
   * What the agent says it is doing and what it has actually changed are the same question
   * asked twice, and checking one against the other meant closing one to see the other.
   */
  describe('the two that describe the work', () => {
    it('shows changes and todos together', () => {
      const { result } = mounted();

      act(() => result.current.show('changes'));
      act(() => result.current.show('todos'));

      expect(result.current.open).toEqual(['changes', 'todos']);
    });

    /** The newest is drawn last, which puts it nearest the composer. */
    it('puts the one opened last at the bottom', () => {
      const { result } = mounted();

      act(() => result.current.show('todos'));
      act(() => result.current.show('changes'));

      expect(result.current.open).toEqual(['todos', 'changes']);
    });

    // Asking for it again is asking to look at it, which is not what leaving it where it
    // was would do.
    it('moves one already open to the bottom rather than doing nothing', () => {
      const { result } = mounted();
      act(() => result.current.show('changes'));
      act(() => result.current.show('todos'));

      act(() => result.current.show('changes'));

      expect(result.current.open).toEqual(['todos', 'changes']);
    });

    it('closes one without closing the other', () => {
      const { result } = mounted();
      act(() => result.current.show('changes'));
      act(() => result.current.show('todos'));

      act(() => result.current.hide('changes'));

      expect(result.current.open).toEqual(['todos']);
    });
  });

  /**
   * `repository` stages and commits and `environment` turns things on and off. They are
   * places to act rather than things to read, they are much taller, and stacking that kind
   * is what pushed the transcript off the screen in the first place (#87).
   */
  describe('the two that are places to act', () => {
    it.each([
      ['repository', 'environment'],
      ['environment', 'repository'],
      ['repository', 'changes'],
      ['environment', 'todos'],
    ] as const)('shows %s instead of %s rather than as well as it', (wanted, alreadyOpen) => {
      const { result } = mounted();
      act(() => result.current.show(alreadyOpen));

      act(() => result.current.show(wanted));

      expect(result.current.open).toEqual([wanted]);
    });

    it('takes the whole space, closing both of the others', () => {
      const { result } = mounted();
      act(() => result.current.show('changes'));
      act(() => result.current.show('todos'));

      act(() => result.current.show('repository'));

      expect(result.current.open).toEqual(['repository']);
    });

    it.each(['changes', 'todos'] as const)('is closed by opening %s', (wanted) => {
      const { result } = mounted();
      act(() => result.current.show('environment'));

      act(() => result.current.show(wanted));

      expect(result.current.open).toEqual([wanted]);
    });
  });

  describe('moving to another session', () => {
    it('closes whatever was open, since it described the session that was', () => {
      const { result, rerender } = mounted();
      act(() => result.current.show('changes'));

      rerender({ session: 's2' });

      expect(result.current.open).toEqual([]);
    });

    it.each(['changes', 'environment', 'repository', 'todos'] as const)('closes %s too', (panel) => {
      // One rule rather than one effect per panel: the panel added last is exactly the one
      // somebody would forget to write an effect for.
      const { result, rerender } = mounted();
      act(() => result.current.show(panel));

      rerender({ session: 's2' });

      expect(result.current.open).toEqual([]);
    });

    it('closes a pair as readily as one', () => {
      const { result, rerender } = mounted();
      act(() => result.current.show('changes'));
      act(() => result.current.show('todos'));

      rerender({ session: 's2' });

      expect(result.current.open).toEqual([]);
    });

    it('leaves them alone when the session has not changed', () => {
      const { result, rerender } = mounted();
      act(() => result.current.show('changes'));

      rerender({ session: 's1' });

      expect(result.current.open).toEqual(['changes']);
    });
  });
});
