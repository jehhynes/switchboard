import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGithubConfig } from '../src/config.js';
import { ghArgs, ghError, spawnGh } from '../src/gh.js';

const VALID = { repo: 'acme/widgets', logins: ['work-login'], project: { owner: 'acme', number: 3 }, assignedStatuses: ['⚒️ Dev'] };

describe('parseGithubConfig', () => {
  it('applies defaults', () => {
    expect(parseGithubConfig(VALID)).toEqual({
      config: {
        ghPath: 'gh',
        repo: 'acme/widgets',
        labels: {},
        logins: ['work-login'],
        requireAssignee: true,
        waitForBlockers: false,
        includeClosed: false,
        project: { owner: 'acme', number: 3, statusField: 'Status' },
        assignedStatuses: ['⚒️ Dev'],
        branchPattern: /^(\d+)-/,
        maxPages: 5,
        rolesFile: null,
      },
    });
  });

  it('reads the home repository and labels in lowercase, and refuses a label key or value it cannot use (PRD R27, R44)', () => {
    expect(parseGithubConfig({ ...VALID, repo: 'Acme/Widgets', labels: { 'Acme/Widgets-Dashboard': 'dash' } })).toMatchObject({ config: { repo: 'acme/widgets', labels: { 'acme/widgets-dashboard': 'dash' } } });
    expect(parseGithubConfig({ ...VALID, labels: ['dash'] })).toEqual({ error: 'sources.github.labels must map owner/name to a label.' });
    expect(parseGithubConfig({ ...VALID, labels: { dashboard: 'dash' } })).toEqual({ error: 'sources.github.labels.dashboard: the key must be owner/name.' });
    expect(parseGithubConfig({ ...VALID, labels: { 'acme/widgets-dashboard': 'Dash Board' } })).toEqual({ error: 'sources.github.labels.acme/widgets-dashboard must be lowercase letters, digits and hyphens.' });
  });

  it('keeps requireAssignee off', () => {
    expect(parseGithubConfig({ ...VALID, requireAssignee: false })).toMatchObject({ config: { requireAssignee: false } });
  });

  it('keeps waitForBlockers on', () => {
    expect(parseGithubConfig({ ...VALID, waitForBlockers: true })).toMatchObject({ config: { waitForBlockers: true } });
  });

  it('keeps includeClosed on', () => {
    expect(parseGithubConfig({ ...VALID, includeClosed: true })).toMatchObject({ config: { includeClosed: true } });
  });

  it('keeps a roles file that is absolute or starts with ~', () => {
    expect(parseGithubConfig({ ...VALID, rolesFile: ' ~/.claude/skills/sb-handoff/roster.json ' })).toMatchObject({ config: { rolesFile: '~/.claude/skills/sb-handoff/roster.json' } });
    expect(parseGithubConfig({ ...VALID, rolesFile: resolve('/roles.json') })).toMatchObject({ config: { rolesFile: resolve('/roles.json') } });
    expect(parseGithubConfig({ ...VALID, rolesFile: '' })).toMatchObject({ config: { rolesFile: null } });
  });

  it.each([
    [{ color: 'red' }, 'sources.github.color is not a setting.'],
    [{ repo: '' }, 'sources.github.repo must be set to owner/name.'],
    [{ logins: [] }, 'sources.github.logins must list at least one login.'],
    [{ logins: [''] }, 'sources.github.logins must list at least one login.'],
    [{ requireAssignee: 'no' }, 'sources.github.requireAssignee must be true or false.'],
    [{ waitForBlockers: 'yes' }, 'sources.github.waitForBlockers must be true or false.'],
    [{ includeClosed: 1 }, 'sources.github.includeClosed must be true or false.'],
    [{ project: { owner: 'acme' } }, 'sources.github.project must give owner and number.'],
    [{ assignedStatuses: 'Dev' }, 'sources.github.assignedStatuses must list at least one status.'],
    [{ ghPath: '' }, 'sources.github.ghPath must be a path.'],
    [{ maxPages: 0 }, 'sources.github.maxPages must be a whole number of at least 1.'],
    [{ branchPattern: '(' }, 'sources.github.branchPattern is not a valid regular expression.'],
    [{ rolesFile: 'roles.json' }, 'sources.github.rolesFile must be an absolute path or start with ~.'],
    [{ rolesFile: 3 }, 'sources.github.rolesFile must be an absolute path or start with ~.'],
  ])('rejects %j', (patch, error) => {
    expect(parseGithubConfig({ ...VALID, ...patch })).toEqual({ error });
  });

  it('refuses until the operator sets the required values', () => {
    expect(parseGithubConfig({})).toEqual({ error: 'sources.github.repo must be set to owner/name.' });
  });
});

describe('parseGithubConfig for a named source', () => {
  it('names the source in its errors (PRD R3)', () => {
    expect(parseGithubConfig({ repo: 'nope' }, 'widgets-dashboard')).toEqual({ error: 'sources.widgets-dashboard.repo must be set to owner/name.' });
  });
});

describe('ghError', () => {
  it('names a missing gh, a sign-in failure and a timeout, and otherwise passes stderr through', () => {
    expect(ghError('C:/gh.exe', 'ENOENT', false, '')).toBe('The GitHub CLI was not found at C:/gh.exe. Install it or set ghPath in the source\'s settings.');
    expect(ghError('gh', 4, false, 'To get started with GitHub CLI, please run:  gh auth login')).toBe('The GitHub CLI is not signed in. Run gh auth login.');
    expect(ghError('gh', null, true, '')).toBe('GitHub did not answer within 30 seconds.');
    expect(ghError('gh', 1, false, ' gh: Could not resolve to an Issue \n')).toBe('gh: Could not resolve to an Issue');
    expect(ghError('gh', 1, false, '')).toBe('gh exited with code 1.');
  });
});

describe('ghArgs', () => {
  it('passes strings with -f and numbers with -F', () => {
    expect(ghArgs('query{x}', { owner: 'acme', number: 19504 })).toEqual(['api', 'graphql', '-f', 'query=query{x}', '-f', 'owner=acme', '-F', 'number=19504']);
  });
});

describe('spawnGh', () => {
  it('reports a missing executable', async () => {
    expect(await spawnGh('D:/no/such/gh.exe')('query', {})).toEqual({ error: 'The GitHub CLI was not found at D:/no/such/gh.exe. Install it or set ghPath in the source\'s settings.' });
  });

  it("passes gh's error output through", async () => {
    // Node stands in for gh and fails on the unknown script "api".
    expect(await spawnGh(process.execPath)('query', {})).toEqual({ error: expect.stringMatching(/Cannot find module .*api/) });
  });
});
