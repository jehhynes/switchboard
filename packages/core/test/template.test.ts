import { describe, expect, it } from 'vitest';
import { render, renderTaskPrompt, sessionPrompt, templateError } from '../src/template.js';

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
        'Switchboard session s-1 tracks this work. Report progress with these commands:',
        '- node "C:/h/hub.js" report stage s-1 <stage>',
        '- node "C:/h/hub.js" report worktree s-1 <path>, when you create a worktree',
        '- node "C:/h/hub.js" report done s-1 [--summary <text>], when the work is finished',
        '- node "C:/h/hub.js" report blocked s-1 --reason <text>, when you cannot continue',
        '- node "C:/h/hub.js" report approval s-1 --prompt <prompt> [--summary <text>], when the work is ready but posting or publishing it needs the operator\'s approval',
        '- node "C:/h/hub.js" report link s-1 --label <text> --target <url or absolute path>, for each GitHub issue or pull request you create or find for this work, and for a case file such as case.md',
        'When you need the operator for a question or a choice, report blocked with the question and end your turn instead of waiting. When the work is ready but posting or publishing it needs approval, report approval with the prompt that would do it, such as /review-pr pr:123 publish, and end your turn.',
      ].join('\n'),
    );
  });
});

describe('templateError', () => {
  it('accepts the known variables and names each unknown one once', () => {
    expect(templateError('/init-worktree {{ ticket.sourceKey }} {{session.id}} {{report}} {{triage.summary}}')).toBeNull();
    expect(templateError('{{ticket.key}} {{ticket.key}} {{issue}} {{ticket.ref}}')).toBe('Unknown template variable: ticket.key, issue.');
  });
});
