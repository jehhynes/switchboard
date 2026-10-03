import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlaybooks, parsePlaybook } from '../src/playbook.js';

describe('parsePlaybook', () => {
  it('reads front matter and the body, with CRLF and a BOM', () => {
    const text = '﻿---\r\ndescription: "Defect: research it"\r\nautoStart: true\r\nrequiresWorktree: true\r\npermissionMode: plan\r\nmodel: opus\r\nworkdir: repoRoot\r\n# a comment\r\n---\r\nResearch {{ticket.sourceKey}}.\r\n';

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
        template: 'Classify.',
      },
    });
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
    ['a bad permissionMode', '---\ndescription: x\npermissionMode: yolo\n---\nbody', 'permissionMode must be one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.'],
    ['a bad workdir', '---\ndescription: x\nworkdir: home\n---\nbody', 'workdir must be worktree or repoRoot.'],
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
