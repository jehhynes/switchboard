import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatPlaybook, isPlaybookName, loadPlaybooks, parsePlaybook } from '../src/playbook.js';
import type { PlaybookFields } from '../src/playbook.js';

describe('parsePlaybook', () => {
  it('reads front matter and the body, with CRLF and a BOM', () => {
    const text = '﻿---\r\ndescription: "Defect: research it"\r\nautoStart: true\r\nrequiresWorktree: true\r\npermissionMode: plan\r\nmodel: opus\r\nworkdir: repoRoot\r\nreports: worktree,  done\r\n# a comment\r\n---\r\nResearch {{ticket.sourceKey}}.\r\n';

    expect(parsePlaybook('support:defect', text)).toEqual({
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
        template: 'Research {{ticket.sourceKey}}.\n',
      },
    });
  });

  it('applies defaults', () => {
    expect(parsePlaybook('triage:github', "---\ndescription: 'Triage'\nkind: triage\n---\nClassify.")).toEqual({
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
        template: 'Classify.',
      },
    });
  });

  it('reads approvalSends beside the approval report', () => {
    const result = parsePlaybook('dev:review-pr', '---\ndescription: x\nreports: approval\napprovalSends: true\n---\nbody');

    expect('playbook' in result && [result.playbook.reports, result.playbook.approvalSends]).toEqual([['approval'], true]);
  });

  it.each([
    ['no front matter', 'Just text', 'The file must start with front matter between --- lines.'],
    ['no closing line', '---\ndescription: x\nbody', 'The front matter has no closing --- line.'],
    ['closing line with text after it', '---\ndescription: x\n---more\nbody', 'The front matter has no closing --- line.'],
    ['a line without a key', '---\ndescription: x\n- item\n---\nbody', 'Front matter line is not "key: value": - item'],
    ['a repeated key', '---\ndescription: x\ndescription: y\n---\nbody', 'Front matter repeats description.'],
    ['an unknown key', '---\ndescription: x\nauto: true\ncolor: red\n---\nbody', 'Unknown front matter: auto, color.'],
    ['no description', '---\nautoStart: true\n---\nbody', 'description is required.'],
    ['a bad kind', '---\ndescription: x\nkind: setup\n---\nbody', 'kind must be task or triage.'],
    ['a bad autoStart', '---\ndescription: x\nautoStart: yes\n---\nbody', 'autoStart must be true or false.'],
    ['a bad requiresWorktree', '---\ndescription: x\nrequiresWorktree: 1\n---\nbody', 'requiresWorktree must be true or false.'],
    ['a bad approvalSends', '---\ndescription: x\nreports: approval\napprovalSends: yes\n---\nbody', 'approvalSends must be true or false.'],
    ['approvalSends without the approval report', '---\ndescription: x\nreports: done\napprovalSends: true\n---\nbody', 'approvalSends applies only to a playbook whose reports include approval.'],
    ['a bad permissionMode', '---\ndescription: x\npermissionMode: yolo\n---\nbody', 'permissionMode must be one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.'],
    ['a bad workdir', '---\ndescription: x\nworkdir: home\n---\nbody', 'workdir must be worktree or repoRoot.'],
    ['an unknown report', '---\ndescription: x\nreports: done, stage, blocked\n---\nbody', 'reports can list done, approval, worktree, playbook, paste, not stage, blocked.'],
    ['reports on a triage playbook', '---\ndescription: x\nkind: triage\nreports: done\n---\nbody', 'reports applies only to a task playbook.'],
    ['a bad rates', '---\ndescription: x\nkind: triage\nrates: yes\n---\nbody', 'rates must be true or false.'],
    ['rates on a task playbook', '---\ndescription: x\nrates: true\n---\nbody', 'rates applies only to a triage playbook.'],
    ['an empty body', '---\ndescription: x\n---\n  \n', 'The prompt template is empty.'],
  ])('rejects %s', (_case, text, error) => {
    expect(parsePlaybook('dev:x', text)).toEqual({ error });
  });
});

describe('loadPlaybooks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-playbooks-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(path: string, text: string): void {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  it('names playbooks by namespace and file, and leaves out invalid ones with their errors', () => {
    file('support/defect.md', '---\ndescription: Defect\n---\nResearch.');
    file('dev/qa-failure.md', '---\ndescription: QA failed\nautoStart: true\n---\n/address-feedback');
    file('dev/broken.md', 'no front matter');
    file('dev/Upper.md', '---\ndescription: x\n---\nbody');
    file('dev/notes.txt', 'ignored');
    file('loose.md', 'ignored: not in a namespace');

    const { playbooks, errors } = loadPlaybooks(dir);

    expect([...playbooks.keys()]).toEqual(['dev:qa-failure', 'support:defect']);
    expect(playbooks.get('dev:qa-failure')?.autoStart).toBe(true);
    expect(errors).toEqual([
      { file: 'dev/Upper.md', error: 'Namespace and name must be lowercase letters, digits and hyphens.' },
      { file: 'dev/broken.md', error: 'The file must start with front matter between --- lines.' },
    ]);
  });

  it('treats a missing directory as empty', () => {
    expect(loadPlaybooks(join(dir, 'missing'))).toEqual({ playbooks: new Map(), errors: [] });
  });

  it('throws when the directory cannot be read for another reason', () => {
    file('file.md', 'x');

    expect(() => loadPlaybooks(join(dir, 'file.md'))).toThrow(/ENOTDIR/);
  });
});

describe('formatPlaybook', () => {
  const task: PlaybookFields = {
    description: 'Review a pull request',
    kind: 'task',
    autoStart: true,
    requiresWorktree: false,
    permissionMode: null,
    model: null,
    workdir: 'worktree',
    reports: [],
    approvalSends: false,
    rates: false,
    template: '/review-pr {{ticket.sourceKey}}\n',
  };

  it('writes only the non-default keys, keeping a task playbook\'s autoStart and requiresWorktree', () => {
    expect(formatPlaybook(task)).toEqual({ text: '---\ndescription: Review a pull request\nautoStart: true\nrequiresWorktree: false\n---\n/review-pr {{ticket.sourceKey}}\n' });
    expect(formatPlaybook({ ...task, reports: ['approval'], approvalSends: true })).toEqual({
      text: '---\ndescription: Review a pull request\nautoStart: true\nrequiresWorktree: false\nreports: approval\napprovalSends: true\n---\n/review-pr {{ticket.sourceKey}}\n',
    });
    expect(formatPlaybook({ ...task, reports: ['approval'] })).toEqual({ text: '---\ndescription: Review a pull request\nautoStart: true\nrequiresWorktree: false\nreports: approval\n---\n/review-pr {{ticket.sourceKey}}\n' });
    expect(formatPlaybook({ ...task, kind: 'triage', autoStart: false, reports: ['done'], template: 'Classify.' })).toEqual({ text: '---\ndescription: Review a pull request\nkind: triage\n---\nClassify.\n' });
    expect(formatPlaybook({ ...task, rates: true })).toEqual({ text: '---\ndescription: Review a pull request\nautoStart: true\nrequiresWorktree: false\n---\n/review-pr {{ticket.sourceKey}}\n' });
  });

  it.each<[string, Partial<PlaybookFields>]>([
    ['every key set', { workdir: 'repoRoot', permissionMode: 'plan', model: 'opus', requiresWorktree: true, reports: ['done', 'approval', 'worktree'] }],
    ['a description with a colon and quotes', { description: '"Defect": research it' }],
    ['a description with outer spaces', { description: ' padded ' }],
    ['a quoted model', { model: "'x'" }],
    ['a triage playbook that starts automatically', { kind: 'triage', autoStart: true }],
    ['a triage playbook that rates', { kind: 'triage', autoStart: false, rates: true }],
  ])('reads back the same fields with %s', (_case, patch) => {
    const playbook = { ...task, ...patch };
    const formatted = formatPlaybook(playbook);

    expect(formatted).toHaveProperty('text');
    expect(parsePlaybook('dev:x', (formatted as { text: string }).text)).toEqual({ playbook: { name: 'dev:x', ...playbook } });
  });

  it('adds a final newline and turns CRLF into LF', () => {
    expect(formatPlaybook({ ...task, template: 'a\r\nb' })).toEqual({ text: '---\ndescription: Review a pull request\nautoStart: true\nrequiresWorktree: false\n---\na\nb\n' });
  });

  it('refuses a description or model of more than one line', () => {
    expect(formatPlaybook({ ...task, description: 'a\nb' })).toEqual({ error: 'description must be one line.' });
    expect(formatPlaybook({ ...task, model: 'a\r\nb' })).toEqual({ error: 'model must be one line.' });
  });
});

describe('isPlaybookName', () => {
  it('takes namespace:name in lowercase letters, digits and hyphens', () => {
    expect(['dev:develop', 'support:how-to', '1:2'].map(isPlaybookName)).toEqual([true, true, true]);
    expect(['dev', 'dev:', ':x', 'Dev:x', 'dev:x:y', 'dev:-x', '../x:y', 'dev:x.md'].map(isPlaybookName)).toEqual([false, false, false, false, false, false, false, false]);
  });
});
