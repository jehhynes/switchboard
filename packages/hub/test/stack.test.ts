import { describe, expect, it } from 'vitest';
import { githubGhPath, githubRepo, pullLinkOf } from '../src/stack.js';

describe('githubRepo', () => {
  it('reads owner and name from https and ssh remotes, and nothing from others', () => {
    expect(githubRepo('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('ssh://git@github.com/acme/widgets')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(githubRepo('https://gitlab.com/acme/widgets.git')).toBeNull();
  });
});

describe('githubGhPath and pullLinkOf', () => {
  it("uses the ghPath of the GitHub source that reads the repository, else the default gh", () => {
    const sources = { work: { kind: 'github', options: { repo: 'Acme/Widgets', ghPath: '/opt/gh', logins: ['me'] } }, other: { kind: 'zoho', options: {} } } as never;

    expect(githubGhPath(sources, 'acme/widgets')).toBe('/opt/gh');
    expect(githubGhPath(sources, 'acme/else')).toBe('gh');
  });

  it("takes the newest pull request link a session reported, over one the ticket's text mentions", () => {
    const link = (target: string, reportedAt: number, mentioned: boolean) => ({ id: reportedAt, ticketId: 1, label: '', target, reportedAt, mentioned });
    const store = {
      workItem: (id: number) => (id === 7 ? { ticketId: 1 } : null),
      linksFor: () => [link('https://github.com/o/r/pull/1', 30, true), link('https://github.com/o/r/pull/2', 10, false), link('https://github.com/o/r/pull/3', 20, false), link('https://github.com/o/r/issues/4', 40, false)],
    };

    expect(pullLinkOf(store, 7)).toEqual({ owner: 'o', name: 'r', number: 3 });
    expect(pullLinkOf(store, 8)).toBeNull();
  });
});
