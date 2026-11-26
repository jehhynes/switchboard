import { expect } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { REPORT } from './flowHarness.js';


/** The report contract offering `reports`, written out so a change to the contract shows here. */
export const CONTRACT = (id: string, reports: string[] = ['stage', 'worktree', 'done', 'approval', 'link', 'task']) => {
  const lines: Record<string, string[]> = {
    stage: [`- ${REPORT} stage ${id} <headline>, when you start a new phase of the work between tool calls: it sets the headline of your state, which the list of work items shows.`, `  - The headline states the work now running and what it acts on as an -ing phrase of at most four words with no ending punctuation, optionally after a step count, such as 2/5 fixing tests.`],
    worktree: [`- ${REPORT} worktree ${id} <path>, when you create a worktree.`],
    done: [`- ${REPORT} done ${id}, when the entire work item is done: every part of the task is complete, and this session has nothing left to do and can be retired.`],
    approval: [
      `- ${REPORT} approval ${id} --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.`,
      `  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.`,
      `  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.`,
      `  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.`,
    ],
    link: [`- ${REPORT} link ${id} --label <text> --target <url>, for each GitHub issue or pull request that tracks or delivers this work, such as one you create, but not a related, base or parent one.`],
    playbook: [`- ${REPORT} playbook ${id} <name>, when you hand the work to the skill of another playbook, such as dev:review-pr.`],
    paste: [
      `- ${REPORT} paste ${id} --label <text> --file <absolute path>, for each drafted text the operator pastes into the ticket by hand, such as --label "Customer reply".`,
      `  - The file holds only the text to paste. A later paste with the same label replaces the earlier one.`,
    ],
  };
  const finish = reports.includes('done') || reports.includes('approval') ? [] : ['', 'When the work is finished, end your turn; the operator reviews it.'];

  return [
    `Report to Switchboard with these commands:`,
    ...Object.keys(lines).filter((kind) => reports.includes(kind)).flatMap((kind) => lines[kind]!),
    `- ${REPORT} handled ${id} <ticket url> [--release <assignment key>], only when a skill directs it: register another ticket's current assignment as already handled before publishing it to the work queue; save the returned assignment key for an explicit release.`,
    ...finish,
    ``,
    `When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.`,
  ].join('\n');
};

export const QUESTION_REPORTS = ['stage', 'approval', 'link', 'task'];
/** A playbook whose session may report done. */
export const FINISH = { 'dev:finish': { description: 'Finish it', reports: ['done'], template: 'Finish {{ticket.sourceKey}}.' } };
/** A playbook whose session may report approval and done. */
export const BOTH = { 'dev:both': { description: 'Both', reports: ['done', 'approval'], template: 'Do {{ticket.sourceKey}}.' } };
export const FINISHING_REPORTS = ['stage', 'worktree', 'done', 'link', 'task'];

export function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}
