import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUri, watchPillClicks } from '../src/open.js';
import { applyPills, cardsByIssue } from '../src/pills.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');

describe('openUri', () => {
  it("encodes the ticket URL into the Switchboard extension's vscode:// URI", () => {
    expect(openUri('https://desk.example.test/t?a=1&b=2')).toBe('vscode://switchboard.switchboard/open?url=https%3A%2F%2Fdesk.example.test%2Ft%3Fa%3D1%26b%3D2');
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
    expect(opened).toEqual([openUri('https://github.com/github/roadmap/issues/1035')]);
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

    expect(opened).toEqual([openUri('https://github.com/github/roadmap/issues/1040')]);
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
    expect(opened).toEqual([openUri('https://github.com/github/roadmap/issues/1035')]);
    expect(reachedGitHub).toHaveBeenCalledTimes(1);
  });
});
