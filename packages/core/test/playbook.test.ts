import { describe, expect, it } from 'vitest';
import { isPlaybookName, parsePlaybook, parsePlaybooks } from '../src/playbook.js';

describe('parsePlaybook', () => {
  it('reads every key', () => {
    const entry = {
      description: 'Defect: research it',
      autoStart: true,
      requiresWorktree: true,
      permissionMode: 'plan',
      model: 'opus',
      workdir: 'repoRoot',
      reports: ['worktree', 'done'],
      returnOf: ['support:how-to'],
      template: 'Research {{ticket.sourceKey}}.\n',
    };

    expect(parsePlaybook('support:defect', entry)).toEqual({
      playbook: {
        name: 'support:defect',
        description: 'Defect: research it',
        kind: 'task',
        autoStart: true,
        requiresWorktree: true,
        permissionMode: 'plan',
        model: 'opus',
        workdir: 'repoRoot',
        reports: ['done', 'worktree'],
        approvalSends: false,
        rates: false,
        returnOf: ['support:how-to'],
        template: 'Research {{ticket.sourceKey}}.\n',
      },
    });
  });

  it('applies defaults, and reads null as unset', () => {
    expect(parsePlaybook('triage:github', { description: 'Triage', kind: 'triage', model: null, permissionMode: null, template: 'Classify.' })).toEqual({
      playbook: {
        name: 'triage:github',
        description: 'Triage',
        kind: 'triage',
        autoStart: false,
        requiresWorktree: false,
        permissionMode: null,
        model: null,
        workdir: 'worktree',
        reports: [],
        approvalSends: false,
        rates: false,
        returnOf: [],
        template: 'Classify.',
      },
    });
  });

  it('reads an empty model as unset', () => {
    const result = parsePlaybook('dev:x', { description: 'x', model: '', template: 'body' });

    expect('playbook' in result && result.playbook.model).toBeNull();
  });

  it('reads approvalSends beside the approval report, and rates on a triage playbook', () => {
    const sends = parsePlaybook('dev:review-pr', { description: 'x', reports: ['approval'], approvalSends: true, template: 'body' });
    const rates = parsePlaybook('triage:zoho', { description: 'x', kind: 'triage', rates: true, template: 'body' });

    expect('playbook' in sends && [sends.playbook.reports, sends.playbook.approvalSends]).toEqual([['approval'], true]);
    expect('playbook' in rates && rates.playbook.rates).toBe(true);
  });

  it('reads returnOf as distinct playbook names', () => {
    const result = parsePlaybook('dev:qa-failure', { description: 'x', returnOf: ['dev:qa-question', 'dev:develop', 'dev:qa-question'], template: 'body' });

    expect('playbook' in result && result.playbook.returnOf).toEqual(['dev:qa-question', 'dev:develop']);
  });

  it.each([
    ['a bad name', 'Dev:x', { description: 'x', template: 'body' }, 'Namespace and name must be lowercase letters, digits and hyphens.'],
    ['a name without a namespace', 'triage', { description: 'x', template: 'body' }, 'Namespace and name must be lowercase letters, digits and hyphens.'],
    ['an entry that is not an object', 'dev:x', 'body', 'A playbook must be an object.'],
    ['an array entry', 'dev:x', [], 'A playbook must be an object.'],
    ['unknown keys', 'dev:x', { description: 'x', auto: true, color: 'red', template: 'body' }, 'Unknown keys: auto, color.'],
    ['no description', 'dev:x', { template: 'body' }, 'description is required.'],
    ['an empty description', 'dev:x', { description: '', template: 'body' }, 'description is required.'],
    ['a two-line description', 'dev:x', { description: 'a\nb', template: 'body' }, 'description must be one line.'],
    ['a description that is not a string', 'dev:x', { description: 3, template: 'body' }, 'description must be a string.'],
    ['a bad kind', 'dev:x', { description: 'x', kind: 'setup', template: 'body' }, 'kind must be task or triage.'],
    ['a string autoStart', 'dev:x', { description: 'x', autoStart: 'true', template: 'body' }, 'autoStart must be true or false.'],
    ['a numeric requiresWorktree', 'dev:x', { description: 'x', requiresWorktree: 1, template: 'body' }, 'requiresWorktree must be true or false.'],
    ['a bad approvalSends', 'dev:x', { description: 'x', reports: ['approval'], approvalSends: 'yes', template: 'body' }, 'approvalSends must be true or false.'],
    ['approvalSends without the approval report', 'dev:x', { description: 'x', reports: ['done'], approvalSends: true, template: 'body' }, 'approvalSends applies only to a playbook whose reports include approval.'],
    ['a bad permissionMode', 'dev:x', { description: 'x', permissionMode: 'yolo', template: 'body' }, 'permissionMode must be one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.'],
    ['a bad workdir', 'dev:x', { description: 'x', workdir: 'home', template: 'body' }, 'workdir must be worktree or repoRoot.'],
    ['reports as a comma-separated string', 'dev:x', { description: 'x', reports: 'done, approval', template: 'body' }, 'reports must be a list of strings.'],
    ['a report that is not a string', 'dev:x', { description: 'x', reports: ['done', 1], template: 'body' }, 'reports must be a list of strings.'],
    ['an unknown report', 'dev:x', { description: 'x', reports: ['done', 'stage', 'blocked'], template: 'body' }, 'reports can list done, approval, worktree, playbook, paste, not stage, blocked.'],
    ['reports on a triage playbook', 'dev:x', { description: 'x', kind: 'triage', reports: ['done'], template: 'body' }, 'reports applies only to a task playbook.'],
    ['a bad rates', 'dev:x', { description: 'x', kind: 'triage', rates: 'yes', template: 'body' }, 'rates must be true or false.'],
    ['rates on a task playbook', 'dev:x', { description: 'x', rates: true, template: 'body' }, 'rates applies only to a triage playbook.'],
    ['returnOf as a string', 'dev:x', { description: 'x', returnOf: 'dev:y', template: 'body' }, 'returnOf must be a list of strings.'],
    ['a returnOf entry that is not a playbook name', 'dev:x', { description: 'x', returnOf: ['dev:ok', 'review'], template: 'body' }, 'returnOf must list other playbook names, not review.'],
    ['a returnOf entry naming the playbook itself', 'dev:x', { description: 'x', returnOf: ['dev:x'], template: 'body' }, 'returnOf must list other playbook names, not dev:x.'],
    ['returnOf on a triage playbook', 'dev:x', { description: 'x', kind: 'triage', returnOf: ['dev:y'], template: 'body' }, 'returnOf applies only to a task playbook.'],
    ['no template', 'dev:x', { description: 'x' }, 'The prompt template is empty.'],
    ['a blank template', 'dev:x', { description: 'x', template: '  \n' }, 'The prompt template is empty.'],
    ['a template that is not a string', 'dev:x', { description: 'x', template: ['a'] }, 'template must be a string.'],
  ])('refuses %s', (_case, name, entry, error) => {
    expect(parsePlaybook(name, entry)).toEqual({ error });
  });
});

describe('parsePlaybooks', () => {
  it('reads each entry sorted by name, and leaves out invalid ones with their errors', () => {
    const { playbooks, errors } = parsePlaybooks({
      'support:defect': { description: 'Defect', template: 'Research.' },
      'dev:qa-failure': { description: 'QA failed', autoStart: true, template: '/address-feedback' },
      'dev:broken': { description: 'x' },
      'dev:Upper': { description: 'x', template: 'body' },
    });

    expect([...playbooks.keys()]).toEqual(['dev:qa-failure', 'support:defect']);
    expect(playbooks.get('dev:qa-failure')?.autoStart).toBe(true);
    expect(errors).toEqual([
      { name: 'dev:Upper', error: 'Namespace and name must be lowercase letters, digits and hyphens.' },
      { name: 'dev:broken', error: 'The prompt template is empty.' },
    ]);
  });

  it('treats a missing playbooks key as none', () => {
    expect(parsePlaybooks(undefined)).toEqual({ playbooks: new Map(), errors: [] });
  });
});

describe('isPlaybookName', () => {
  it('takes namespace:name in lowercase letters, digits and hyphens', () => {
    expect(['dev:develop', 'support:how-to', '1:2'].map(isPlaybookName)).toEqual([true, true, true]);
    expect(['dev', 'dev:', ':x', 'Dev:x', 'dev:x:y', 'dev:-x', '../x:y', 'dev:x.md'].map(isPlaybookName)).toEqual([false, false, false, false, false, false, false, false]);
  });
});
