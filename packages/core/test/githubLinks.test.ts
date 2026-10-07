import { describe, expect, it } from 'vitest';
import { githubLinks } from '../src/githubLinks.js';

describe('githubLinks', () => {
  it('returns each distinct issue and pull request in order of first appearance, across texts', () => {
    expect(
      githubLinks([
        'See https://github.com/acme/widgets/pull/7/files and https://github.com/Acme/Widgets/issues/12#issuecomment-3.',
        '<a href="https://github.com/acme/widgets/issues/12">https://github.com/acme/widgets/pull/7</a> https://github.com/other/repo.js/issues/12',
      ]),
    ).toEqual([
      { label: 'Pull request #7', target: 'https://github.com/acme/widgets/pull/7' },
      { label: 'Issue #12', target: 'https://github.com/acme/widgets/issues/12' },
      { label: 'Issue #12', target: 'https://github.com/other/repo.js/issues/12' },
    ]);
  });

  it('ignores other URLs and malformed numbers', () => {
    expect(
      githubLinks([
        'https://www.example.com/issues/1 http://github.com/o/r/issues/2 https://github.com/o/r/blob/master/issues/3 https://github.com/orgs/o/projects/4',
        'https://github.com/o/r/issues/new https://github.com/o/r/pull/5abc https://gist.github.com/o/r/issues/6 https://github.com/o/r/issues/',
      ]),
    ).toEqual([]);
    expect(githubLinks([])).toEqual([]);
  });
});
