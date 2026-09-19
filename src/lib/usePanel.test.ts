// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { usePanel } from './usePanel';

describe('which panel is open', () => {
  it('starts with none', () => {
    const { result } = renderHook(() => usePanel('s1'));

    expect(result.current.open).toBeNull();
  });

  it('opens one', () => {
    const { result } = renderHook(() => usePanel('s1'));

    act(() => result.current.show('changes'));

    expect(result.current.open).toBe('changes');
  });

  it('closes it', () => {
    const { result } = renderHook(() => usePanel('s1'));
    act(() => result.current.show('changes'));

    act(() => result.current.hide());

    expect(result.current.open).toBeNull();
  });

  /**
   * The bug this replaced. Opening the repository closed the other two, but opening either
   * of those left the repository where it was, so `/git` then the Changes button showed
   * both - which the app has always meant to be impossible, since they are tall enough that
   * two of them push the transcript off the screen.
   */
  it.each([
    ['changes', 'environment'],
    ['changes', 'repository'],
    ['environment', 'changes'],
    ['environment', 'repository'],
    ['repository', 'changes'],
    ['repository', 'environment'],
  ] as const)('shows %s instead of %s rather than as well as it', (wanted, alreadyOpen) => {
    const { result } = renderHook(() => usePanel('s1'));
    act(() => result.current.show(alreadyOpen));

    act(() => result.current.show(wanted));

    expect(result.current.open).toBe(wanted);
  });

  describe('moving to another session', () => {
    it('closes whatever was open, since it described the session that was', () => {
      const { result, rerender } = renderHook(({ id }) => usePanel(id), { initialProps: { id: 's1' } });
      act(() => result.current.show('changes'));

      rerender({ id: 's2' });

      expect(result.current.open).toBeNull();
    });

    it.each(['changes', 'environment', 'repository'] as const)('closes %s too', (panel) => {
      // One rule rather than one effect per panel: the panel added last is exactly the one
      // somebody would forget to write an effect for.
      const { result, rerender } = renderHook(({ id }) => usePanel(id), { initialProps: { id: 's1' } });
      act(() => result.current.show(panel));

      rerender({ id: 's2' });

      expect(result.current.open).toBeNull();
    });

    it('leaves it alone when the session has not changed', () => {
      const { result, rerender } = renderHook(({ id }) => usePanel(id), { initialProps: { id: 's1' } });
      act(() => result.current.show('changes'));

      rerender({ id: 's1' });

      expect(result.current.open).toBe('changes');
    });
  });
});
