import { describe, expect, it } from 'vitest';
import { TRIAGE_VARIABLES, render, renderTaskPrompt, sessionPrompt, templateError, triagePrompt } from '../src/template.js';

describe('render', () => {
  it('replaces variables, with or without inner spaces, and does not re-scan values', () => {
    expect(render('Fix {{ticket.sourceKey}}: {{ ticket.title }}', { 'ticket.sourceKey': '15619', 'ticket.title': 'Uses {{report}}' })).toEqual({ text: 'Fix 15619: Uses {{report}}' });
  });

  it('fails on unknown variables and names each once', () => {
    expect(render('{{a}} {{b}} {{a}} {{known}}', { known: 'x' })).toEqual({ error: 'Unknown template variable: a, b.' });
  });
});

describe('renderTaskPrompt and sessionPrompt', () => {
  it('fills the session ID in the template and the appended report contract', () => {
    const task = renderTaskPrompt('Work on {{ticket.sourceKey}} as {{session.id}}.\n\n', { 'ticket.sourceKey': '7' });

    expect(task).toEqual({ text: 'Work on 7 as {{session.id}}.\n\n' });

    expect(sessionPrompt((task as { text: string }).text, 's-1', 'node "C:/h/hub.js" report')).toBe(
      [
        'Work on 7 as s-1.',
        '',
        `Report to Switchboard with these commands:`,
        `- node "C:/h/hub.js" report stage s-1 <stage>, when you start a new phase of the work.`,
        `  - The stage is one or two words, such as Reviewing or Fixing tests.`,
        `- node "C:/h/hub.js" report worktree s-1 <path>, when you create a worktree.`,
        `- node "C:/h/hub.js" report done s-1, when the work is finished.`,
        `- node "C:/h/hub.js" report blocked s-1 --reason <text>, when you cannot continue or need the operator's answer or choice, then end your turn instead of waiting.`,
        `  - The reason is one phrase of at most 10 words; the detail stays in this session.`,
        `  - A question ends with a question mark.`,
        `- node "C:/h/hub.js" report approval s-1 --prompt <prompt> --summary <text>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.`,
        `  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.`,
        `  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.`,
        `- node "C:/h/hub.js" report link s-1 --label <text> --target <url or absolute path>, for each GitHub issue or pull request you create or find for this work, and for a case file such as case.md.`,
      ].join('\n'),
    );
  });
});

describe('templateError', () => {
  it('accepts the known variables and names each unknown one once', () => {
    expect(templateError('/init-worktree {{ ticket.sourceKey }} {{session.id}} {{report}} {{triage.summary}}')).toBeNull();
    expect(templateError('{{ticket.key}} {{ticket.key}} {{issue}} {{ticket.ref}}')).toBe('Unknown template variable: ticket.key, issue.');
  });

  it('allows only {{playbooks}} in classifier instructions', () => {
    expect(templateError('{{playbooks}}', TRIAGE_VARIABLES)).toBeNull();
    expect(templateError('{{playbooks}} {{ticket.title}}', TRIAGE_VARIABLES)).toBe('Unknown template variable: ticket.title.');
    expect(templateError('{{playbooks}}')).toBe('Unknown template variable: playbooks.');
  });
});

describe('triagePrompt', () => {
  const choices = [
    { name: 'support:defect', description: 'Something is broken.' },
    { name: 'support:how-to', description: 'A usage question.' },
  ];

  it('replaces {{playbooks}} with the choices and appends nothing', () => {
    expect(triagePrompt('Pick one of:\n{{ playbooks }}\nThen rate it.\n', choices)).toEqual({ text: 'Pick one of:\n- support:defect: Something is broken.\n- support:how-to: A usage question.\nThen rate it.\n' });
  });

  it('appends the choices when the instructions have no {{playbooks}}', () => {
    expect(triagePrompt('Classify it.\n\n', choices)).toEqual({ text: 'Classify it.\n\nChoose one playbook:\n- support:defect: Something is broken.\n- support:how-to: A usage question.' });
  });

  it('fails on another variable, with or without {{playbooks}}', () => {
    expect(triagePrompt('{{playbooks}} {{ticket.title}}', choices)).toEqual({ error: 'Unknown template variable: ticket.title.' });
    expect(triagePrompt('{{ticket.title}}', choices)).toEqual({ error: 'Unknown template variable: ticket.title.' });
  });
});
