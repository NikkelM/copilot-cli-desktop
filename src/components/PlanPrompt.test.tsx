// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PendingPlanApproval } from '../../shared/protocol';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const { PlanPrompt } = await import('./PlanPrompt');

const plan: PendingPlanApproval = {
  sessionId: 's1',
  requestId: 'plan-1',
  summary: 'Rewrite the parser',
  planContent: '# Plan\n\n1. Read the grammar\n2. Rewrite it',
  actions: ['exit_only', 'interactive', 'autopilot'],
  recommendedAction: 'interactive',
  expiresAt: '2026-01-01T00:05:00.000Z',
};

function show(overrides: Partial<PendingPlanApproval> = {}) {
  const onResolve = vi.fn();
  const rendered = render(<PlanPrompt pending={{ ...plan, ...overrides }} onResolve={onResolve} />);
  return { ...rendered, onResolve, user: userEvent.setup() };
}

const actionButtons = () =>
  screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => label !== 'Request changes');

describe('PlanPrompt', () => {
  // The plan is the point: a summary alone is what the reader is trying to get behind.
  it('renders the plan itself, not just its summary', () => {
    const { container } = show();

    expect(container.querySelector('h1')?.textContent).toBe('Plan');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  /** The runtime's own rule, so the reader sees the same ordering the CLI shows. */
  it('puts the recommended action first and says that it is', () => {
    show();

    const [first, ...rest] = actionButtons();
    expect(first).toContain('Build it');
    expect(first).toContain('recommended');
    expect(rest.some((label) => label.includes('recommended'))).toBe(false);
  });

  it('keeps the agent\u2019s own order behind the recommendation', () => {
    show({ actions: ['exit_only', 'interactive', 'autopilot'], recommendedAction: 'autopilot' });

    expect(actionButtons().map((label) => label.replace('recommended', ''))).toEqual([
      'Build on autopilot',
      'Exit only',
      'Build it',
    ]);
  });

  /**
   * Withholding the fleet option is how the agent says the work does not split up, so the
   * button must not appear on its own.
   */
  it('offers only the ways forward the agent put up', () => {
    show({ actions: ['exit_only', 'interactive'] });

    expect(actionButtons().some((label) => label.includes('fleet'))).toBe(false);
  });

  it('approves with the action that was clicked', async () => {
    const { onResolve, user } = show();

    await user.click(screen.getByTitle(/carry on without asking/));

    expect(onResolve).toHaveBeenCalledWith(true, 'autopilot');
  });

  // Turning a plan down is how it gets redirected, so the reason has to reach the agent.
  it('sends feedback back with a refusal', async () => {
    const { onResolve, user } = show();

    await user.click(screen.getByText('Request changes'));
    await user.type(screen.getByPlaceholderText(/differently/), 'Keep the old grammar');
    await user.click(screen.getByText('Send feedback'));

    expect(onResolve).toHaveBeenCalledWith(false, undefined, 'Keep the old grammar');
  });

  it('still refuses when no reason was given', async () => {
    const { onResolve, user } = show();

    await user.click(screen.getByText('Request changes'));
    await user.click(screen.getByText('Send feedback'));

    expect(onResolve).toHaveBeenCalledWith(false, undefined, undefined);
  });

  // Going back to the plan must not answer it, which a stray submit would.
  it('leaves the plan unanswered when the reader backs out of the feedback box', async () => {
    const { onResolve, user } = show();

    await user.click(screen.getByText('Request changes'));
    await user.click(screen.getByText('Back'));

    expect(onResolve).not.toHaveBeenCalled();
    expect(actionButtons().length).toBeGreaterThan(0);
  });

  /** Nothing offered was recognisable, so the plan can still be taken or refused. */
  it('falls back to a plain approval when it can draw none of the actions', async () => {
    const { onResolve, user } = show({ actions: [], recommendedAction: 'interactive' });

    await user.click(screen.getByText('Approve'));

    expect(onResolve).toHaveBeenCalledWith(true);
  });
});
