import { describe, expect, it } from 'vitest';
import { TRIAGE_VARIABLES, render, renderTaskPrompt, sessionContract, sessionPrompt, templateError, triagePrompt } from '../src/template.js';

describe('render', () => {
  it('replaces variables, with or without inner spaces, and does not re-scan values', () => {
    expect(render('Fix {{ticket.sourceKey}}: {{ ticket.title }}', { 'ticket.sourceKey': '15619', 'ticket.title': 'Uses {{report}}' })).toEqual({ text: 'Fix 15619: Uses {{report}}' });
  });

  it('fails on unknown variables and names each once', () => {
    expect(render('{{a}} {{b}} {{a}} {{known}}', { known: 'x' })).toEqual({ error: 'Unknown template variable: a, b.' });
  });
});

describe('renderTaskPrompt, sessionPrompt and sessionContract', () => {
  it('fills the session ID in the template and in the report contract, which is not part of the prompt', () => {
    const task = renderTaskPrompt('Work on {{ticket.sourceKey}} as {{session.id}}.\n\n', { 'ticket.sourceKey': '7' });

    expect(task).toEqual({ text: 'Work on 7 as {{session.id}}.\n\n' });
    expect(sessionPrompt((task as { text: string }).text, 's-1')).toBe('Work on 7 as s-1.');

    expect(sessionContract('s-1', 'node "C:/h/hub.js" report', ['link', 'approval', 'done', 'worktree', 'stage'], 'claude')).toBe(
      [
        `Report to Switchboard with these commands:`,
        `- node "C:/h/hub.js" report stage s-1 <stage>, when you start a new phase of the work.`,
        `  - The stage states the work now running and what it acts on as an -ing phrase of at most four words with no ending punctuation, optionally after a step count, such as 2/5 fixing tests.`,
        `- node "C:/h/hub.js" report worktree s-1 <path>, when you create a worktree.`,
        `- node "C:/h/hub.js" report done s-1, when the work is finished.`,
        `- node "C:/h/hub.js" report approval s-1 --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.`,
        `  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.`,
        `  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.`,
        `  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.`,
        `- node "C:/h/hub.js" report link s-1 --label <text> --target <url>, for each GitHub issue or pull request that tracks or delivers this work, such as one you create, but not a related, base or parent one.`,
        ``,
        `When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.`,
      ].join('\n'),
    );
  });

  it('lists only the offered reports, and tells a session with neither done nor approval to end its turn', () => {
    expect(sessionContract('s-2', 'R', ['stage', 'link'], 'claude')).toBe(
      [
        'Report to Switchboard with these commands:',
        '- R stage s-2 <stage>, when you start a new phase of the work.',
        '  - The stage states the work now running and what it acts on as an -ing phrase of at most four words with no ending punctuation, optionally after a step count, such as 2/5 fixing tests.',
        '- R link s-2 --label <text> --target <url>, for each GitHub issue or pull request that tracks or delivers this work, such as one you create, but not a related, base or parent one.',
        '',
        'When the work is finished, end your turn; the operator reviews it.',
        '',
        "When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.",
      ].join('\n'),
    );

    const approval = sessionContract('s-3', 'R', ['stage', 'approval', 'link'], 'claude');

    expect(approval).toContain('- R approval s-3 --prompt');
    expect(approval).not.toContain(' done ');
    expect(approval).not.toContain('worktree');
    expect(approval).not.toContain('end your turn; the operator reviews it');
  });

  it('offers a Codex session the question report in place of AskUserQuestion, because its background run cannot wait on the operator (mechanics M31)', () => {
    const codex = sessionContract('s-5', 'R', ['stage', 'done', 'question'], 'codex');

    expect(codex).toContain("- R question s-5 --text <question>, when you need the operator's answer or choice, or cannot continue without them; write the question and its choices as your final message too, then end your turn.");
    expect(codex.endsWith('Ask the operator only with the question report. Do not write a file for a question.')).toBe(true);
    expect(codex).not.toContain('AskUserQuestion');
    expect(sessionContract('s-5', 'R', ['stage', 'done'], 'claude')).not.toContain('question s-5');
  });

  it('does not list the task report a session may send, so only the operator starts one (PRD R68)', () => {
    expect(sessionContract('s-4', 'R', ['stage', 'link', 'task'], 'claude')).toBe(sessionContract('s-4', 'R', ['stage', 'link'], 'claude'));
  });
});

describe('templateError', () => {
  it('accepts the known variables and names each unknown one once', () => {
    expect(templateError('/init-worktree {{ ticket.sourceKey }} {{session.id}} {{report}}')).toBeNull();
    expect(templateError('{{triage.summary}}')).toBe('Unknown template variable: triage.summary.');
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
    { name: 'support:defect', description: 'Something is broken.', focus: null },
    { name: 'support:how-to', description: 'A usage question.', focus: null },
  ];

  it('replaces {{playbooks}} with the choices and appends nothing', () => {
    expect(triagePrompt('Pick one of:\n{{ playbooks }}\nThen rate it.\n', choices)).toEqual({ text: 'Pick one of:\n- support:defect: Something is broken.\n- support:how-to: A usage question.\nThen rate it.\n' });
  });

  it('appends the choices when the instructions have no {{playbooks}}', () => {
    expect(triagePrompt('Classify it.\n\n', choices)).toEqual({ text: 'Classify it.\n\nChoose one playbook:\n- support:defect: Something is broken.\n- support:how-to: A usage question.' });
  });

  it('names the page of a playbook that sets one', () => {
    const paged = [
      { name: 'dev:review-pr', description: 'Review a pull request.', focus: 'pr' as const },
      { name: 'dev:qa-failure', description: 'Fix a QA failure.', focus: 'ticket' as const },
    ];

    expect(triagePrompt('{{playbooks}}', paged)).toEqual({ text: '- dev:review-pr: Review a pull request. (page: pull request)\n- dev:qa-failure: Fix a QA failure. (page: ticket)' });
  });

  it('fails on another variable, with or without {{playbooks}}', () => {
    expect(triagePrompt('{{playbooks}} {{ticket.title}}', choices)).toEqual({ error: 'Unknown template variable: ticket.title.' });
    expect(triagePrompt('{{ticket.title}}', choices)).toEqual({ error: 'Unknown template variable: ticket.title.' });
  });
});
