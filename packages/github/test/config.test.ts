import { describe, expect, it } from 'vitest';
import { clip } from '../src/clip.js';
import { parseGithubConfig } from '../src/config.js';
import { ghArgs, ghError, spawnGh } from '../src/gh.js';

const VALID = { repo: 'acme/widgets', logins: ['work-login'], project: { owner: 'acme', number: 3 }, assignedStatuses: ['⚒️ Dev'] };

describe('parseGithubConfig', () => {
  it('applies defaults', () => {
    expect(parseGithubConfig(VALID)).toEqual({
      config: {
        ghPath: 'gh',
        repo: 'acme/widgets',
        logins: ['work-login'],
        project: { owner: 'acme', number: 3, statusField: 'Status' },
        assignedStatuses: ['⚒️ Dev'],
        branchPattern: /^(\d+)-/,
        maxPages: 5,
      },
    });
  });

  it.each([
    [{ color: 'red' }, 'sources.github.color is not a setting.'],
    [{ repo: '' }, 'sources.github.repo must be set to owner/name.'],
    [{ logins: [] }, 'sources.github.logins must list at least one login.'],
    [{ logins: [''] }, 'sources.github.logins must list at least one login.'],
    [{ project: { owner: 'acme' } }, 'sources.github.project must give owner and number.'],
    [{ assignedStatuses: 'Dev' }, 'sources.github.assignedStatuses must list at least one status.'],
    [{ ghPath: '' }, 'sources.github.ghPath must be a path.'],
    [{ maxPages: 0 }, 'sources.github.maxPages must be a whole number of at least 1.'],
    [{ branchPattern: '(' }, 'sources.github.branchPattern is not a valid regular expression.'],
  ])('rejects %j', (patch, error) => {
    expect(parseGithubConfig({ ...VALID, ...patch })).toEqual({ error });
  });

  it('refuses until the operator sets the required values', () => {
    expect(parseGithubConfig({})).toEqual({ error: 'sources.github.repo must be set to owner/name.' });
  });
});

describe('clip', () => {
  it('trims short text and keeps it whole', () => {
    expect(clip('  short  ', 10)).toBe('short');
    expect(clip(null, 10)).toBe('');
  });

  it('keeps both ends at word boundaries and counts what it left out', () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const clipped = clip(text, 60);

    expect(clipped).toBe('w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10\n[…333 characters omitted…]\nw94 w95 w96 w97 w98 w99');
  });
});

describe('ghError', () => {
  it('names a missing gh, a sign-in failure and a timeout, and otherwise passes stderr through', () => {
    expect(ghError('C:/gh.exe', 'ENOENT', false, '')).toBe('The GitHub CLI was not found at C:/gh.exe. Install it or set sources.github.ghPath.');
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
    expect(await spawnGh('D:/no/such/gh.exe')('query', {})).toEqual({ error: 'The GitHub CLI was not found at D:/no/such/gh.exe. Install it or set sources.github.ghPath.' });
  });

  it("passes gh's error output through", async () => {
    // Node stands in for gh and fails on the unknown script "api".
    expect(await spawnGh(process.execPath)('query', {})).toEqual({ error: expect.stringMatching(/Cannot find module .*api/) });
  });
});
