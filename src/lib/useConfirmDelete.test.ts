// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConfirmDelete } from './useConfirmDelete';

const KEY = 'copilot-desktop.confirmDelete';

beforeEach(() => localStorage.clear());

describe('whether deleting asks first', () => {
  it('asks on a fresh install', () => {
    expect(renderHook(() => useConfirmDelete()).result.current.confirms).toBe(true);
  });

  it('stops asking once told to', () => {
    const { result } = renderHook(() => useConfirmDelete());

    act(() => result.current.stopAsking());

    expect(result.current.confirms).toBe(false);
  });

  it('is still not asking on the next start', () => {
    const first = renderHook(() => useConfirmDelete());
    act(() => first.result.current.stopAsking());

    expect(renderHook(() => useConfirmDelete()).result.current.confirms).toBe(false);
  });

  it('asks again when the stored answer is something it does not recognise', () => {
    // Anything but the exact stored no leaves the question in place: skipping it is the
    // answer that cannot be taken back.
    localStorage.setItem(KEY, 'null');

    expect(renderHook(() => useConfirmDelete()).result.current.confirms).toBe(true);
  });
});
