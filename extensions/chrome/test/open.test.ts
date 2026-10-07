import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '@switchboard/core/group';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_MS } from '../src/board.js';
import { applyPageLink, cardForPage, openUri, watchOpen } from '../src/open.js';
import { applyPills, cardsByIssue } from '../src/pills.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const ISSUE = fixture('issue.html');
const PULL = fixture('pull.html');
const COLUMN = fixture('column.html');

const ISSUE_URL = 'https://github.com/microsoft/vscode/issues/1';
const PULL_URL = 'https://github.com/microsoft/vscode/pull/200000';
const issueCard: Card = { url: 'https://github.com/Microsoft/VSCode/issues/1', playbook: 'dev:develop', group: 'working', snoozed: false, links: [] };
const linkingCard: Card = { url: 'https://github.com/microsoft/vscode/issues/199954', playbook: 'dev:review-pr', group: 'needs', snoozed: false, links: [`${PULL_URL}`] };
const zohoCard: Card = { url: 'https://desk.example.test/1', playbook: 'support:case', group: 'unstarted', snoozed: false };

const links = () =>
  [...document.querySelectorAll<HTMLAnchorElement>('a.switchboard-open')].map((link) => ({
    href: link.getAttribute('href'),
    text: link.textContent,
    after: link.previousElementSibling?.tagName,
  }));

describe('openUri', () => {
  it("encodes the ticket URL into the Switchboard extension's vscode:// URI", () => {
    expect(openUri('https://desk.example.test/t?a=1&b=2')).toBe('vscode://switchboard.switchboard/open?url=https%3A%2F%2Fdesk.example.test%2Ft%3Fa%3D1%26b%3D2');
  });
});

describe('cardForPage', () => {
  it("finds the card of an issue page, in any case and on any tab, and a pull request page's card by the ticket's links", () => {
    expect(cardForPage([zohoCard, issueCard], `${ISSUE_URL}#issuecomment-1`)).toBe(issueCard);
    expect(cardForPage([issueCard, linkingCard], `${PULL_URL}/files`)).toBe(linkingCard);
  });

  it('prefers the ticket with the URL over a ticket that links to it', () => {
    const linksIssue: Card = { ...linkingCard, links: [ISSUE_URL] };

    expect(cardForPage([linksIssue, issueCard], ISSUE_URL)).toBe(issueCard);
  });

  it('finds nothing on another page, for a URL no card has, or from a hub that sends no links', () => {
    expect(cardForPage([issueCard], 'https://github.com/microsoft/vscode')).toBeNull();
    expect(cardForPage([issueCard], 'https://github.com/microsoft/vscode/pull/1')).toBeNull();
    expect(cardForPage([zohoCard], 'https://desk.example.test/1')).toBeNull();
    const { links: _, ...older } = linkingCard;

    expect(cardForPage([older], PULL_URL)).toBeNull();
  });
});

describe('applyPageLink', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it("puts the link after an issue's title, and after a pull request's number but not in its sticky header", () => {
    document.body.innerHTML = ISSUE;
    applyPageLink(document, issueCard);
    expect(links()).toEqual([{ href: openUri(issueCard.url), text: 'Open in Switchboard', after: 'H1' }]);

    document.body.innerHTML = PULL;
    applyPageLink(document, linkingCard);
    expect(links()).toEqual([{ href: openUri(linkingCard.url), text: 'Open in Switchboard', after: 'SPAN' }]);
    expect(document.querySelector('a.switchboard-open')!.parentElement!.querySelector('h1')!.textContent).toContain('font-variation-settings');
  });

  it('replaces a link for another ticket, removes it without a card, and adds nothing to a page without a title', () => {
    document.body.innerHTML = ISSUE;
    applyPageLink(document, linkingCard);
    applyPageLink(document, issueCard);
    expect(links()).toEqual([{ href: openUri(issueCard.url), text: 'Open in Switchboard', after: 'H1' }]);

    applyPageLink(document, null);
    expect(links()).toEqual([]);

    document.body.innerHTML = '<main><h1>Repository</h1></main>';
    applyPageLink(document, issueCard);
    expect(links()).toEqual([]);
  });

  it('makes no mutation when applied again unchanged', async () => {
    document.body.innerHTML = ISSUE;
    applyPageLink(document, issueCard);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    applyPageLink(document, issueCard);
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
  });
});

describe('watchOpen', () => {
  let watch: { stop(): void } | null = null;
  let page = 'https://github.com/microsoft/vscode';
  const href = () => page;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    watch?.stop();
    watch = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
    page = 'https://github.com/microsoft/vscode';
  });

  it('reads nothing off issue and pull request pages, then reads when one opens, refreshes, and removes the link after a failed read', async () => {
    let time = 0;
    const read = vi.fn(async (): Promise<Card[] | null> => [issueCard]);

    document.body.innerHTML = ISSUE;
    watch = watchOpen(document, read, () => {}, { now: () => time, href });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).not.toHaveBeenCalled();
    expect(links()).toEqual([]);

    // GitHub opens an issue without a page load.
    page = ISSUE_URL;
    document.body.innerHTML = ISSUE;
    await vi.advanceTimersByTimeAsync(60);
    expect(read).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(1);

    // A title GitHub renders again gets its link back without another read.
    document.body.innerHTML = ISSUE;
    await vi.advanceTimersByTimeAsync(60);
    expect(links()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);

    time = REFRESH_MS;
    read.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(links()).toEqual([]);
  });

  it('opens the ticket of a clicked board pill before GitHub sees the click, and leaves other clicks alone', () => {
    const opened: string[] = [];
    const reachedGitHub = vi.fn();

    document.body.innerHTML = COLUMN;
    applyPills(document, cardsByIssue([{ url: 'https://github.com/github/roadmap/issues/1035', playbook: 'dev:review-pr', group: 'needs', snoozed: false }]));
    watch = watchOpen(document, async () => [], (uri) => opened.push(uri), { href });
    document.body.addEventListener('click', reachedGitHub);

    const pill = document.querySelector<HTMLElement>('.switchboard-pill .switchboard-namespace')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    pill.dispatchEvent(click);
    expect(opened).toEqual([openUri('https://github.com/github/roadmap/issues/1035')]);
    expect(click.defaultPrevented).toBe(true);
    expect(reachedGitHub).not.toHaveBeenCalled();

    document.querySelector<HTMLElement>('h3[id^="board-card-title-"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(opened).toHaveLength(1);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);
  });

  it('opens the ticket when Enter is pressed on the focusable pill, and ignores other keys', () => {
    const opened: string[] = [];
    const reachedGitHub = vi.fn();

    document.body.innerHTML = COLUMN;
    applyPills(document, cardsByIssue([{ url: 'https://github.com/github/roadmap/issues/1035', playbook: 'dev:review-pr', group: 'needs', snoozed: false }]));
    watch = watchOpen(document, async () => [], (uri) => opened.push(uri), { href });
    document.body.addEventListener('keydown', reachedGitHub);

    const pill = document.querySelector<HTMLElement>('.switchboard-pill')!;

    expect([pill.tabIndex, pill.getAttribute('role')]).toEqual([0, 'link']);
    pill.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(opened).toEqual([]);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);

    pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(opened).toEqual([openUri('https://github.com/github/roadmap/issues/1035')]);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);
  });
});
