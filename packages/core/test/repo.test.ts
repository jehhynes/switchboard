import { describe, expect, it } from 'vitest';
import { homeRepo, repoOf, repoRoots, ticketRoot } from '../src/repo.js';
import { settings } from './flowHarness.js';

function withGithub(repoRoot: string) {
  const value = settings();
  value.sources['github'] = { ...value.sources['github']!, repoRoot, options: { repo: 'Acme/Widgets' } };
  return value;
}

const ticket = (repo: string, repoRoot = '') => ({ source: 'github', repo, repoRoot });

describe('ticketRoot (PRD R16, R21)', () => {
  it("takes the ticket's own root first, as an ad-hoc or reported ticket has", () => {
    expect(ticketRoot(withGithub('D:/git/{name}'), ticket('acme/widgets-dashboard', 'D:/scratch'))).toEqual({ root: 'D:/scratch' });
  });

  it('fills {owner} and {name} from the ticket, or from the home repository when the ticket records none', () => {
    expect(ticketRoot(withGithub('D:/git/{name}'), ticket(''))).toEqual({ root: 'D:/git/widgets' });
    expect(ticketRoot(withGithub('D:/git/{name}'), ticket('acme/widgets-dashboard'))).toEqual({ root: 'D:/git/widgets-dashboard' });
    expect(ticketRoot(withGithub('D:/src/{owner}/{name}'), ticket('work-login/switchboard'))).toEqual({ root: 'D:/src/work-login/switchboard' });
  });

  it('serves only the home repository from a root without {name}, so no other repository runs in its clone', () => {
    const value = withGithub('D:/git/widgets');

    expect(ticketRoot(value, ticket(''))).toEqual({ root: 'D:/git/widgets' });
    expect(ticketRoot(value, ticket('acme/widgets'))).toEqual({ root: 'D:/git/widgets' });
    expect(ticketRoot(value, ticket('acme/widgets-dashboard'))).toEqual({ error: 'sources.github.repoRoot has no {name}, so acme/widgets-dashboard has no repo root.' });
  });

  it('refuses two stored repositories that resolve to one root, naming both, until the pattern adds {owner}', () => {
    expect(ticketRoot(withGithub('D:/git/{name}'), ticket('bob/widgets'), { github: ['bob/widgets'] })).toEqual({ error: 'bob/widgets and acme/widgets both resolve to D:/git/widgets; add {owner} to the repo root patterns.' });
    expect(ticketRoot(withGithub('D:/git/{name}'), ticket(''), { github: ['alice/project', 'bob/widgets'] })).toEqual({ error: 'acme/widgets and bob/widgets both resolve to D:/git/widgets; add {owner} to the repo root patterns.' });
    expect(ticketRoot(withGithub('D:/git/{owner}/{name}'), ticket('bob/widgets'), { github: ['bob/widgets'] })).toEqual({ root: 'D:/git/bob/widgets' });
  });

  it("refuses a repository in another source that resolves to the same root, and allows the same repository in two sources", () => {
    const value = withGithub('D:/git/widgets');
    value.sources['personal'] = { ...value.sources['github']!, repoRoot: 'D:/git/{name}', options: { repo: 'work-login/switchboard' } };

    expect(ticketRoot(value, { source: 'personal', repo: 'bob/widgets', repoRoot: '' }, { personal: ['bob/widgets'] })).toEqual({ error: 'bob/widgets and acme/widgets both resolve to D:/git/widgets; add {owner} to the repo root patterns.' });
    expect(ticketRoot(value, ticket(''), { personal: ['bob/widgets'] })).toEqual({ error: 'acme/widgets and bob/widgets both resolve to D:/git/widgets; add {owner} to the repo root patterns.' });
    expect(ticketRoot(value, { source: 'personal', repo: 'acme/widgets', repoRoot: '' }, { personal: ['acme/widgets'] })).toEqual({ root: 'D:/git/widgets' });
  });

  it('reports a missing root, and a pattern for a ticket with no repository', () => {
    expect(ticketRoot(withGithub(''), ticket(''))).toEqual({ error: 'sources.github.repoRoot is not set.' });
    expect(ticketRoot(withGithub('D:/git/{name}'), { source: 'gone', repo: '', repoRoot: '' })).toEqual({ error: 'sources.gone.repoRoot is not set.' });

    const value = settings();
    value.sources['zoho'] = { ...value.sources['zoho']!, repoRoot: 'D:/git/{name}' };
    expect(ticketRoot(value, { source: 'zoho', repo: '', repoRoot: '' })).toEqual({ error: 'sources.zoho.repoRoot names {name}, but the ticket has no repository.' });
  });

  it("reads the home repository from the source's repo setting in lowercase", () => {
    expect(homeRepo(withGithub('').sources['github'])).toBe('acme/widgets');
    expect(homeRepo(settings().sources['zoho'])).toBe('');
    expect(repoOf(withGithub(''), ticket(''))).toBe('acme/widgets');
    expect(repoOf(withGithub(''), ticket('acme/widgets-dashboard'))).toBe('acme/widgets-dashboard');
  });
});

describe('repoRoots (PRD R6, R68)', () => {
  it('lists each home root and the roots of stored repositories, never a pattern, once each', () => {
    const value = withGithub('D:/git/{name}');

    expect(repoRoots(value)).toEqual(['D:/git/widgets', 'D:/git/support']);
    expect(repoRoots(value, { github: ['acme/widgets', 'acme/widgets-dashboard'] })).toEqual(['D:/git/widgets', 'D:/git/widgets-dashboard', 'D:/git/support']);
  });

  it('leaves out a root two repositories share and a literal root for other repositories', () => {
    expect(repoRoots(withGithub('D:/git/{name}'), { github: ['bob/widgets'] })).toEqual(['D:/git/support']);
    expect(repoRoots(withGithub('D:/git/widgets'), { github: ['acme/widgets-dashboard'] })).toEqual(['D:/git/widgets', 'D:/git/support']);
  });
});
