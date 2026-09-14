import { useEffect, useRef, useState } from 'react';

import type { PendingPlanApproval, PlanAction } from '../../shared/protocol';
import { Expiry } from './Elapsed';
import { Markdown } from './Markdown';

/**
 * What each way forward means, in the reader's terms rather than the runtime's ids.
 *
 * The hint matters more than the label here: the difference between `interactive` and
 * `autopilot` is how much the agent will ask before acting, which is the actual decision
 * being made and is not obvious from a name.
 */
const ACTIONS: Record<PlanAction, { label: string; hint: string }> = {
  exit_only: { label: 'Exit only', hint: 'Leave plan mode without starting the work' },
  interactive: { label: 'Build it', hint: 'Start the work and keep asking as it goes' },
  autopilot: { label: 'Build on autopilot', hint: 'Start the work and carry on without asking' },
  autopilot_fleet: {
    label: 'Build with a fleet',
    hint: 'Autopilot, splitting the work across parallel agents',
  },
};

interface PlanPromptProps {
  pending: PendingPlanApproval;
  onResolve: (approved: boolean, selectedAction?: PlanAction, feedback?: string) => void;
}

/**
 * The agent's plan, put to the reader before it acts on it.
 *
 * This is the one prompt in the app that exists to be read rather than answered quickly,
 * so the plan is rendered in full as markdown instead of being summarised into a line. The
 * agent is blocked throughout, and turning the plan down is a real answer: the feedback
 * goes back and it plans again.
 */
export function PlanPrompt({ pending, onResolve }: PlanPromptProps) {
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Opening the box is only useful with the cursor already in it.
  useEffect(() => {
    if (revising) feedbackRef.current?.focus();
  }, [revising]);

  /**
   * The recommended action first, then the rest in the order the agent sent them.
   *
   * Matching what the CLI does, and it is the runtime's own rule rather than a choice made
   * here. Only the actions the agent offered are shown: withholding the fleet option is
   * how it says the work does not split up, so putting the button back would offer
   * something it declined to.
   */
  const actions = [
    ...pending.actions.filter((action) => action === pending.recommendedAction),
    ...pending.actions.filter((action) => action !== pending.recommendedAction),
  ];

  function decline() {
    // An empty box is still a refusal; the agent is told no without being told why.
    onResolve(false, undefined, feedback.trim() || undefined);
  }

  return (
    <section className="plan" ref={containerRef} tabIndex={-1}>
      <header className="plan-header">
        <span className="plan-badge">plan</span>
        <span className="plan-summary">{pending.summary}</span>
        <Expiry at={pending.expiresAt} />
      </header>

      <div className="plan-body">
        <Markdown body={pending.planContent} />
      </div>

      {revising ? (
        <div className="plan-revise">
          <textarea
            ref={feedbackRef}
            className="plan-feedback"
            placeholder="What should it do differently?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                decline();
              }
            }}
          />
          <div className="plan-actions">
            <button type="button" className="secondary" onClick={() => setRevising(false)}>
              Back
            </button>
            <button type="button" onClick={decline}>
              Send feedback
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-actions">
          <button type="button" className="secondary" onClick={() => setRevising(true)}>
            Request changes
          </button>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === pending.recommendedAction ? undefined : 'secondary'}
              title={ACTIONS[action].hint}
              onClick={() => onResolve(true, action)}
            >
              {ACTIONS[action].label}
              {action === pending.recommendedAction && <span className="plan-recommended">recommended</span>}
            </button>
          ))}
          {/* Every offered action was unknown to this build, so the plan can only be taken
              or refused. Better than an approval that silently picks a way forward. */}
          {actions.length === 0 && (
            <button type="button" onClick={() => onResolve(true)}>
              Approve
            </button>
          )}
        </div>
      )}
    </section>
  );
}
