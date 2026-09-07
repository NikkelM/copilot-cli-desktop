// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

describe('CopyButton', () => {
  it('copies what it was given', async () => {
    render(<CopyButton text={'const x = 1;\nconst y = 2;'} what="code" />);

    await userEvent.click(screen.getByRole('button'));

    expect(writeText).toHaveBeenCalledWith('const x = 1;\nconst y = 2;');
  });

  // The clipboard says nothing of its own, so a button that copies silently is one nobody
  // trusts: they press it twice and go and check.
  it('says that it copied', async () => {
    render(<CopyButton text="something" what="code" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('says so when it could not', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyButton text="something" what="code" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Failed')).toBeTruthy();
  });

  it('names what it copies, for anyone not looking at it', () => {
    render(<CopyButton text="something" what="reply" />);

    expect(screen.getByRole('button', { name: 'Copy reply' })).toBeTruthy();
  });
});
