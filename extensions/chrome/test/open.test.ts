import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageOpenUrl, watchPillClicks } from '../src/open.js';
import { applyPills, cardsByIssue } from '../src/pills.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');

describe('pageOpenUrl (PRD R69, R121)', () => {
  it("opens the card's work item on the web page, or the page for a pool ticket, an unknown card or an older hub", () => {
    expect(pageOpenUrl('http://127.0.0.1:47616', { workItemId: 7 })).toBe('http://127.0.0.1:47616/page/#w=7');
    expect(pageOpenUrl('https://pc.tail.ts.net', { workItemId: 42 })).toBe('https://pc.tail.ts.net/page/#w=42');
    expect(pageOpenUrl('https://pc.tail.ts.net', { workItemId: null })).toBe('https://pc.tail.ts.net/page/');
    expect(pageOpenUrl('https://pc.tail.ts.net', {})).toBe('https://pc.tail.ts.net/page/');
    expect(pageOpenUrl('https://pc.tail.ts.net', undefined)).toBe('https://pc.tail.ts.net/page/');
  });
});

describe('watchPillClicks', () => {
  let watch: { stop(): void } | null = null;

  afterEach(() => {
    watch?.stop();
    watch = null;
    document.body.innerHTML = '';
  });

  it('opens the ticket of a clicked board pill before GitHub sees the click, and leaves other clicks alone', () => {
    const opened: string[] = [];
    const reachedGitHub = vi.fn();

    document.body.innerHTML = COLUMN;
    applyPills(document, cardsByIssue([{ url: 'https://github.com/github/roadmap/issues/1035', playbook: 'dev:review-pr', group: 'blocked', snoozed: false }]));
    watch = watchPillClicks(document, (uri) => opened.push(uri));
    document.body.addEventListener('click', reachedGitHub);

    const pill = document.querySelector<HTMLElement>('.switchboard-pill .switchboard-namespace')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    pill.dispatchEvent(click);
    expect(opened).toEqual(['https://github.com/github/roadmap/issues/1035']);
    expect(click.defaultPrevented).toBe(true);
    expect(reachedGitHub).not.toHaveBeenCalled();

    document.querySelector<HTMLElement>('h3[id^="board-card-title-"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(opened).toHaveLength(1);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);
  });

  it('opens the ticket of a clicked table row pill', () => {
    const opened: string[] = [];

    document.body.innerHTML = readFileSync(join(import.meta.dirname, 'fixtures', 'table.html'), 'utf8');
    applyPills(document, cardsByIssue([{ url: 'https://github.com/github/roadmap/issues/1040', playbook: 'dev:review-pr', group: 'blocked', snoozed: false }]));
    watch = watchPillClicks(document, (uri) => opened.push(uri));
    document.querySelector('[role="rowheader"] .switchboard-pill')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(opened).toEqual(['https://github.com/github/roadmap/issues/1040']);
  });

  it('opens the ticket when Enter is pressed on the focusable pill, and ignores other keys', () => {
    const opened: string[] = [];
    const reachedGitHub = vi.fn();

    document.body.innerHTML = COLUMN;
    applyPills(document, cardsByIssue([{ url: 'https://github.com/github/roadmap/issues/1035', playbook: 'dev:review-pr', group: 'blocked', snoozed: false }]));
    watch = watchPillClicks(document, (uri) => opened.push(uri));
    document.body.addEventListener('keydown', reachedGitHub);

    const pill = document.querySelector<HTMLElement>('.switchboard-pill')!;

    expect([pill.tabIndex, pill.getAttribute('role')]).toEqual([0, 'link']);
    pill.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(opened).toEqual([]);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);

    pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(opened).toEqual(['https://github.com/github/roadmap/issues/1035']);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);
  });
});
