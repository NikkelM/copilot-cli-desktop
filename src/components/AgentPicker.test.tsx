// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentPicker } from './AgentPicker';
import type { AgentSummary } from '../../shared/protocol';

const agents: AgentSummary[] = [
  {
    id: 'deep-audit',
    name: 'deep-audit',
    displayName: 'Deep Audit',
    description: 'Audits a project deeply',
    source: 'user',
    userInvocable: true,
  },
  {
    id: 'planner',
    name: 'planner',
    displayName: 'Planner',
    description: 'Plans work',
    source: 'project-planning',
    model: 'gpt-5.4',
    userInvocable: true,
  },
];

const picker = (props: Partial<Parameters<typeof AgentPicker>[0]> = {}) => {
  const onChoose = vi.fn();
  const onOpen = vi.fn();
  render(<AgentPicker current={null} agents={agents} failed={null} onOpen={onOpen} onChoose={onChoose} {...props} />);
  return { onChoose, onOpen };
};

const control = () => screen.getAllByRole('button')[0];
const openMenu = async () => {
  await userEvent.click(control());
  await screen.findByRole('option', { name: /Deep Audit/ });
};

describe('AgentPicker', () => {
  describe('what it shows closed', () => {
    it('names the agent a session is on', () => {
      picker({ current: { name: 'deep-audit', displayName: 'Deep Audit' } });

      expect(control().textContent).toContain('Deep Audit');
    });

    it('says a session with no agent runs on the default', () => {
      picker();

      expect(control().textContent).toContain('Default');
    });

    /** A name shown before the log is read may be contradicted by the log a moment later. */
    it('names nothing while the log is still being read', () => {
      picker({ current: undefined });

      expect(screen.getByLabelText('Reading which agent this session uses')).toBeTruthy();
      expect(control().textContent).not.toContain('Default');
    });
  });

  describe('opening', () => {
    it('asks for the agents only when opened', async () => {
      const { onOpen } = picker({ agents: null });
      expect(onOpen).not.toHaveBeenCalled();

      await userEvent.click(control());

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('says it is working while the list is on its way', async () => {
      picker({ agents: null });

      await userEvent.click(control());

      expect(screen.getByText(/Starting the runtime/)).toBeTruthy();
    });

    it('says why the list could not be fetched', async () => {
      picker({ agents: null, failed: 'no runtime' });

      await userEvent.click(control());

      expect(screen.getByText('no runtime')).toBeTruthy();
    });

    /** An empty list and a broken one look the same without being told apart. */
    it('says where agents would come from when there are none', async () => {
      picker({ agents: [] });

      await userEvent.click(control());

      expect(screen.getByText(/No custom agents found/)).toBeTruthy();
    });

    it('closes again when the control is pressed a second time', async () => {
      picker();
      await openMenu();

      await userEvent.click(control());

      expect(screen.queryByRole('option', { name: /Deep Audit/ })).toBeNull();
    });

    it('closes on Escape', async () => {
      picker();
      await openMenu();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('option', { name: /Deep Audit/ })).toBeNull();
    });
  });

  describe('the list', () => {
    it('groups agents by where they came from', async () => {
      picker();
      await openMenu();

      const heads = screen.getAllByText(/^(user|project-planning)$/).map((node) => node.textContent);
      expect(heads).toEqual(['user', 'project-planning']);
    });

    /**
     * The reader's own agents are the ones they can change, so they come first whatever
     * order they were discovered in.
     */
    it('puts the reader\u2019s own agents first however they arrived', async () => {
      picker({ agents: [agents[1], agents[0]] });
      await openMenu();

      const heads = screen.getAllByText(/^(user|project-planning)$/).map((node) => node.textContent);
      expect(heads).toEqual(['user', 'project-planning']);
    });

    it('describes each agent, so two of them can be told apart', async () => {
      picker();
      await openMenu();

      expect(screen.getByText('Audits a project deeply')).toBeTruthy();
    });

    /** An agent that pins a model overrides the model picker, so it has to say so. */
    it('names the model an agent pins itself to', async () => {
      picker();
      await openMenu();

      expect(screen.getByText('gpt-5.4')).toBeTruthy();
    });

    it('marks the agent in use as chosen', async () => {
      picker({ current: { name: 'planner', displayName: 'Planner' } });
      await openMenu();

      expect(screen.getByRole('option', { name: /Planner/ }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('option', { name: /Deep Audit/ }).getAttribute('aria-selected')).toBe('false');
    });

    it('marks the default as chosen when no agent is set', async () => {
      picker();
      await openMenu();

      expect(screen.getByRole('option', { name: /Default/ }).getAttribute('aria-selected')).toBe('true');
    });

    /** Offered even before the list arrives: it is the way back from a choice. */
    it('offers the default while the list is still on its way', async () => {
      picker({ agents: null });

      await userEvent.click(control());

      expect(screen.getByRole('option', { name: /Default/ })).toBeTruthy();
    });
  });

  describe('choosing', () => {
    it('reports the agent that was picked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Deep Audit/ }));

      expect(onChoose).toHaveBeenCalledWith(agents[0]);
    });

    it('reports nothing at all for the default, which is the absence of a choice', async () => {
      const { onChoose } = picker({ current: { name: 'deep-audit', displayName: 'Deep Audit' } });
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Default/ }));

      expect(onChoose).toHaveBeenCalledWith(null);
    });

    it('closes once something has been picked', async () => {
      picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Deep Audit/ }));

      expect(screen.queryByRole('option', { name: /Deep Audit/ })).toBeNull();
    });
  });
});
