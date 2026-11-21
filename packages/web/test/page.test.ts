import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY, mentionOf, mentionQuery, commandQuery, shortTitle, timeline, withEarlier } from '../src/model.js';
import { answerText, answersIn, complete, parseQuestions } from '@switchboard/conversation/questions';
import { artifactUrl, newView, renderArtifactView, turnRow, renderHeader, renderList, renderMicButton, renderTimeline, renderVoice, markdownBody } from '../src/render.js';
import { renderMicButton as viewMicButton } from '@switchboard/conversation/voiceControls';
import { renderMarkdown } from '../src/markdown.js';
import { CHAT_MAX, CHAT_MIN, SENT_NOTE_MS, SIDE_MAX, SIDE_MIN, startPage } from '../src/main.js';
import type { ArtifactView, MessageView, PageGroup, PageRow, ReplyView, SessionView } from '../src/types.js';

const message = (id: string, ord: number, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at: 1_000 + ord, ord, provisional: false, withdrawn: false, origin: 'typed', text: `text ${id}`, delivery: 'sent', error: null, ...patch });
const reply = (id: string, ord: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's', at: 1_000 + ord, ord, provisional: false, kind: 'reply', answers: null, opening: `reply ${id}`, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null, ...patch });
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const artifact = (path: string, type: ArtifactView['type'], ext: string): ArtifactView => ({ path, owner: 'chat', kind: 'page', title: path, ext, type, updatedAt: 1_500 });

describe('the page model', () => {
  it('orders items by transcript place, drops not-sent messages, and starts from empty at hello', () => {
    let state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items: [message('m2', 2), message('m1', 1)], more: true, status: null, artifacts: [], unread: 2 });

    expect(state).toMatchObject({ key: 'k', connected: true, unread: 2, more: true });
    state = applyEvent(state, { type: 'message', message: message('m3', 0, { provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r1', 3) });
    expect(state.items.map((item) => item.id)).toEqual(['m2', 'm1', 'r1', 'm3']);
    state = applyEvent(state, { type: 'message', message: message('m3', 0, { delivery: 'not-sent' }) });
    expect(state.items.map((item) => item.id)).not.toContain('m3');
    state = applyEvent(state, { type: 'unread', workItemId: 1, count: 5 });
    expect(state.unread).toBe(5);
    state = applyEvent(state, { type: 'status', status: { id: 'st-x', sessionId: 'other', at: 1, markdown: 'x', fallback: false, unread: false } });
    expect(state.status).toBeNull();
    state = withEarlier(state, [message('m0', -1), message('m1', 1)], false);
    expect(state.items[0]!.id).toBe('m0');
    expect(state.more).toBe(false);
    state = applyEvent(state, { type: 'hello', scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(state).toMatchObject({ key: 'k', scope: null, items: [] });
  });

  it('shows a rewrite in place of the reply it rewrote, places artifacts by time, and waits for a reply only while the session works', () => {
    const items = [message('m1', 1), reply('r1', 2, { rewrittenBy: 'r2' }), reply('r2', 3), message('m2', 4)];
    const entries = timeline(items, [artifact('chat/a.md', 'markdown', 'md')]);

    expect(entries.map((entry) => (entry.type === 'artifact' ? entry.artifact.path : entry.item.id))).toEqual(['m1', 'r2', 'm2', 'chat/a.md']);
    expect(entries[1]).toMatchObject({ earlier: { id: 'r1' } });
    expect(awaitingReply(items, session({ state: 'running' }))).toBe(true);
    expect(awaitingReply(items, session({ state: 'idle' }))).toBe(false);
    expect(awaitingReply([...items, reply('r3', 5, { answers: 'm2' })], session({ state: 'running' }))).toBe(false);
  });

  it('writes mentions and reads the @ and / queries as the composer types', () => {
    expect(mentionOf('src/a.ts')).toBe('@src/a.ts');
    expect(mentionOf('my dir/a b.ts')).toBe('@"my dir/a b.ts"');
    expect(mentionOf('a"b')).toBeNull();
    expect(mentionQuery('see @src/he')).toEqual({ start: 4, query: 'src/he' });
    expect(mentionQuery('mail@x')).toBeNull();
    expect(commandQuery('/rev')).toBe('rev');
    expect(commandQuery('hi /rev')).toBeNull();
    expect(shortTitle('[Feedback] Make the inbox badge count only unread conversations')).toBe('Make the inbox badge count only unread');
  });
});

describe('question cards', () => {
  const text = '1. Which port?\n   - A) 8765\n   - B) 8799\n2. Which checks? Choose all that apply.\n   - A) Unit\n   - B) Live\n\n```\n3. Not a question\n   - A) x\n   - B) y\n```';

  it('reads numbered questions outside code, answers as "1A, 2B", and reads a typed answer back', () => {
    const questions = parseQuestions(text);

    expect(questions.map((question) => [question.number, question.multi, question.options.length])).toEqual([[1, false, 2], [2, true, 2]]);

    const choices = new Map([[0, { letters: ['B'], other: '' }], [1, { letters: ['A', 'B'], other: '' }]]);

    expect(complete(questions, choices)).toBe(true);
    expect(answerText(questions, choices)).toBe('1B, 2A, 2B');
    expect(answerText(questions, new Map([[0, { letters: [], other: 'use 9000, please' }]]))).toBe('1 Other: use 9000, please');
    expect(complete(questions, new Map([[0, { letters: ['A'], other: '' }]]))).toBe(false);
    expect([...answersIn('1A and 2B', questions).entries()]).toEqual([[0, { letters: ['A'], other: '' }], [1, { letters: ['B'], other: '' }]]);
    // An Other answer and the picks after it read back as they were sent.
    const mixed = new Map([[0, { letters: [], other: 'Use 9000' }], [1, { letters: ['B'], other: '' }]]);

    expect(answerText(questions, mixed)).toBe('1 Other: Use 9000, 2B');
    expect([...answersIn(answerText(questions, mixed), questions).entries()]).toEqual([[0, { letters: [], other: 'Use 9000' }], [1, { letters: ['B'], other: '' }]]);
    expect(parseQuestions('1. One\n - A) x\n - B) y\n1. Again\n - A) x\n - B) y')).toEqual([]);
    expect(parseQuestions('Pick one:\n- A) x\n- B) y')).toMatchObject([{ number: null, text: 'Pick one:' }]);
  });
});

describe('question cards in replies', () => {
  const ending = 'Before I go on:\n\n1. Port?\n   - A) 1\n   - B) 2';
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, status: null, artifacts: [] });

  it('leaves questions that end a reply out of its text, folds ones written mid-message, and tells an answer from a message that skipped them', () => {
    const host = document.createElement('div');

    host.innerHTML = renderTimeline(pageState([reply('r1', 1, { opening: ending })]), newView());
    expect(host.querySelector('li[data-id="r1"] > .body')?.textContent?.trim()).toBe('Before I go on:');
    host.innerHTML = renderTimeline(pageState([reply('r1', 1, { opening: `${ending}\n\nThen I start.` })]), newView());
    expect(host.querySelector('details.questions-fold summary')?.textContent).toBe('1 question — answer below');
    expect(host.querySelector('li[data-id="r1"] > .body')?.textContent).toContain('Then I start.');
    host.innerHTML = renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: 'Later.' })]), newView());
    expect(host.querySelector('.question-card')?.className).toBe('question-card skipped');
    expect(host.querySelector('.question-card [aria-checked="true"]')).toBeNull();
    host.innerHTML = renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B' })]), newView());
    expect(host.querySelector('.question-card')?.className).toBe('question-card answered');
    host.innerHTML = renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B', delivery: 'open' })]), newView());
    expect(host.querySelector('.question-card')?.className).toBe('question-card');
  });
});

describe('drawing', () => {
  // The page's state with these items, as a hello brings them.
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, status: null, artifacts: [] });

  it('puts a Today, Yesterday or dated divider before the first item and each turn on another day', () => {
    const at = (day: number, hour: number): number => new Date(2026, 10, day, hour).getTime();
    const html = renderTimeline(pageState([message('m1', 1, { at: at(17, 9) }), reply('r1', 2, { at: at(18, 1) }), message('m2', 3, { at: at(19, 9) }), message('m3', 4, { at: at(20, 9) })]), newView(), at(20, 12));
    const host = document.createElement('div');

    host.innerHTML = html;
    expect([...host.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.textContent)).toEqual(['Tue, Nov 17', 'm1', 'r1', 'Yesterday', 'm2', 'Today', 'm3']);
    expect(renderTimeline(pageState([message('m1', 1, { at: new Date(2025, 11, 31, 9).getTime() })]), newView(), at(20, 12))).toContain('>Wed, Dec 31, 2025</li>');
  });

  it("puts a message's and a reply's metadata on one line under it, the reply's copy button first and the time at the right", () => {
    const host = document.createElement('div');

    host.innerHTML = renderTimeline(pageState([message('m1', 1, { delivery: 'uncertain', error: 'Check the terminal.' }), reply('r1', 120_000, { tone: 'calm', spoken: { state: 'failed', atMs: null, saidChars: null } })]), newView());
    expect([...host.querySelector('li[data-id="m1"] > .bubble')!.children].map((child) => child.className)).toEqual(['box', 'meta']);
    expect([...host.querySelector('li[data-id="m1"] .meta')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    expect([...host.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
    expect([...host.querySelector('li[data-id="r1"] .meta-marks')!.children].map((child) => child.className)).toEqual(['copy', 'tone', 'spoken failed']);
    expect(host.querySelector('li[data-id="r1"] .meta > :last-child')?.className).toBe('stamp');
  });

  it('dims the part of an interrupted passage not heard, and says Not spoken only when speech failed', () => {
    const spoken = (state: ReplyView['spoken']['state']) => renderTimeline(pageState([reply('r1', 1, { opening: 'Fixed it. More.', speak: 'Fixed it.', spoken: { state, atMs: 7_400, saidChars: 3 } })]), newView());

    expect(spoken('interrupted')).toContain('<p class="passage">Fix<span class="unheard">ed it.</span></p>');
    expect(spoken('interrupted')).not.toContain('0:07');
    expect(spoken('failed')).toContain('<span>Not spoken</span>');
    expect(spoken('playing')).not.toContain('class="unheard"');

    for (const routine of ['playing', 'interrupted', 'stopped-moved', 'played', 'queued'] as const) {
      expect(spoken(routine)).not.toContain('class="spoken');
    }
  });

  it("keeps raw HTML out of Markdown, opens web links in a new tab and shows paths as text", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [web](https://example.com) [file](src/a.ts) [bad](javascript:alert(1))');

    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a class="path-link" title="src/a.ts"');
    expect(html).not.toContain('href="javascript');
  });

  it('says what the turn waits for: Starting or Thinking with the spinner, and the answer or permission the terminal asks for instead of Thinking', () => {
    expect(turnRow(session({ state: 'starting' }), true)).toContain('Starting…');
    expect(turnRow(session({ state: 'running' }), true)).toContain('codicon-modifier-spin');
    expect(turnRow(session({ state: 'running' }), false)).toBe('');
    expect(turnRow(session({ state: 'waiting', waitingFor: 'question' }), true)).toMatch(/codicon-question[\s\S]*Waiting for your answer/);
    expect(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), false)).toMatch(/codicon-shield[\s\S]*Waiting for permission/);
    expect(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), true)).not.toContain('Thinking');
  });

  it('opens a page or an SVG artifact in a sandboxed frame with an opaque origin, and media in the page', () => {
    const page = renderArtifactView('key', artifact('chat/p.html', 'html', 'html'));
    const svg = renderArtifactView('key', artifact('chat/p.svg', 'image', 'svg'));

    expect(page).toContain('sandbox="allow-scripts"');
    expect(page).not.toContain('allow-same-origin');
    expect(page).toContain(`src="${artifactUrl('key', 'chat/p.html')}?v=1500"`);
    expect(svg).toContain('<iframe');
    expect(renderArtifactView('key', artifact('chat/p.png', 'image', 'png'))).toContain('<img class="media"');
    expect(renderArtifactView('key', artifact('chat/v.mp4', 'video', 'mp4'))).toContain('<video');
    expect(renderArtifactView('key', artifact('chat/d.pdf', 'file', 'pdf'))).toContain('download');

    // The head: the kind as a badge, the title, Open in new window and Download; each version's file loads afresh.
    const head = document.createElement('div');

    head.innerHTML = renderArtifactView('key', { ...artifact('chat/v.mp4', 'video', 'mp4'), kind: 'demo', title: 'Demo' });
    expect(head.querySelector('.artifact-badge')!.textContent).toBe('demo');
    expect(head.querySelector('.artifact-head .artifact-title')!.textContent).toBe('Demo');
    expect(head.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('1500');
    expect(head.querySelector('video')!.getAttribute('src')).toBe('/v1/conversation/artifact/key/chat/v.mp4?v=1500');
    expect(head.querySelector('a[title="Open in new window"]')!.getAttribute('target')).toBe('_blank');
    expect(head.querySelector('a[title="Open in new window"]')!.getAttribute('href')).toBe('/v1/conversation/artifact/key/chat/v.mp4?v=1500');
    expect(head.querySelector('a[download]')!.getAttribute('href')).toBe('/v1/conversation/artifact/key/chat/v.mp4');
    // Markdown, which the page draws itself, opens as drawn rather than as its source text.
    head.innerHTML = renderArtifactView('key', artifact('chat/a.md', 'markdown', 'md'));
    expect(head.querySelector('a[title="Open in new window"]')).toBeNull();
    expect(head.querySelector('button[data-action="artifact-window"]')).not.toBeNull();
    expect(artifactUrl('k y', 'chat/a b.md')).toBe('/v1/conversation/artifact/k%20y/chat/a%20b.md');
    expect(markdownBody('---\ntitle: x\n---\n# Body')).toBe('# Body');
  });

  it("draws the dock's groups with their counts and rows as the dock's: title, mark, ticket pill and playbook, stripe and the selection", () => {
    const root = document.createElement('div');
    const groups = [
      listGroup('review', [listRow(1, { title: 'Fix <the> badge', stripe: 'turn', mark: { kind: 'review', glyph: '\u{ea70}', title: 'Review, then approve' } }), listRow(2, { dim: true, stripe: 'warning', sourceKind: 'zoho', ticket: 'zd 7', playbook: 'triage' })], { title: 'Ready for review' }),
      listGroup('progress', [listRow(3, { mark: { kind: 'running', glyph: '\u{eb19}', title: 'Running' } }), listRow(4, { stripe: 'error', mark: { kind: 'failed', glyph: '\u{ea87}', title: 'Failed' } }), listRow(9, { title: 'Side chat', host: 'support', playbook: 'conversation' })]),
      listGroup('unstarted', [], { empty: 'Nothing waits to be started.' }),
    ];

    root.innerHTML = renderList(groups, 3, new Set());

    expect([...root.querySelectorAll('.group-head')].map((head) => [head.querySelector('.group-title')!.textContent, head.querySelector('.group-count')!.textContent, head.getAttribute('aria-expanded')])).toEqual([
      ['Ready for review', '2', 'true'],
      ['progress', '3', 'true'],
      ['unstarted', '0', 'true'],
    ]);
    expect(root.querySelector('[data-group="unstarted"] .group-count')!.classList.contains('zero')).toBe(true);
    expect(root.querySelector('[data-group="unstarted"] .group-empty')!.textContent).toBe('Nothing waits to be started.');

    const first = root.querySelector<HTMLElement>('[data-work-item="1"]')!;

    expect(first.querySelector('.row-title')!.textContent).toBe('Fix <the> badge');
    expect(first.className).toBe('row stripe-turn');
    // The mark by the shared icon name, the ticket key in its source's colour, the playbook's namespace muted.
    expect(first.querySelector('.mark')!.className).toBe('codicon codicon-eye mark state-icon tone-muted');
    expect(first.querySelector('.mark')!.getAttribute('aria-label')).toBe('Review, then approve');
    expect(first.querySelector('.pill')!.className).toBe('pill ticket source-github');
    // The ticket key's icon shows only when the pill shrinks to it: GitHub's mark, or a tag for a source without one.
    expect(first.querySelector('.pill .pill-icon')!.className).toBe('codicon codicon-github pill-icon');
    expect(first.querySelector('.playbook')!.innerHTML).toBe('<span class="namespace">dev:</span>build');
    expect(root.querySelector('[data-work-item="2"]')!.className).toBe('row stripe-warning dim');
    expect(root.querySelector('[data-work-item="2"] .pill')!.className).toBe('pill ticket source-zoho');
    expect(root.querySelector('[data-work-item="2"] .pill .pill-icon')!.className).toBe('codicon codicon-tag pill-icon');
    expect(root.querySelector('[data-work-item="2"] .playbook')!.innerHTML).toBe('triage');
    // A running mark spins, muted, as the dock's does; a failed one takes the error tone.
    expect(root.querySelector('[data-work-item="3"] .mark')!.className).toBe('codicon codicon-loading mark state-icon tone-muted codicon-modifier-spin');
    expect(root.querySelector('[data-work-item="4"] .mark')!.className).toBe('codicon codicon-error mark state-icon tone-error failed');
    expect(root.querySelector('[data-work-item="3"]')!.className).toBe('row selected');
    expect(root.querySelector('[data-work-item="3"]')!.getAttribute('aria-current')).toBe('true');
    expect(root.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    // A hosted conversation shows its host in the playbook's place; no row shows an unread count.
    expect(root.querySelector('[data-work-item="9"] .playbook')!.textContent).toBe('support');
    expect(root.querySelector('[data-work-item="9"] .playbook')!.classList.contains('host')).toBe(true);
    expect(root.querySelector('.count')).toBeNull();
    // The dropdown shows none either.
    expect(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, unread: 3 }] }, session: session(), unread: 3 }, { ...newView(), picker: true })).not.toContain('class="count"');
  });

  it("draws a row's three lines from the dock row: priority, title and time; comment, playbook, ticket, links and Returned; mark and details", () => {
    const root = document.createElement('div');
    const links: PageRow['links'] = [
      { label: 'PR #19002', url: 'https://github.com/o/r/pull/19002', kind: 'pr', badge: '19002', glyph: '\u{ea64}', mentioned: false },
      { label: 'gh 18800', url: 'https://github.com/o/r/issues/18800', kind: 'issue', badge: 'gh 18800', glyph: null, mentioned: true },
    ];
    const details: PageRow['details'] = [
      { text: 'Rate limited · resumes 1:20 PM', title: 'Resets at 1:20 PM', tone: 'warning' },
      { text: 'Setup <failed>', title: null, tone: 'error' },
      { text: 'Post the reply', title: null, tone: null },
    ];
    const full = listRow(1, { priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, url: 'https://github.com/o/r/issues/1', links, returned: 2, comment: { glyph: '\u{ea6b}', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: '\u{eba2}', title: 'Rate limited' }, details });

    root.innerHTML = renderList([listGroup('progress', [full, listRow(2)])], null, new Set());

    const row = root.querySelector<HTMLElement>('[data-work-item="1"]')!;
    const [head, line2, line3] = [...row.children] as HTMLElement[];

    expect(row.children).toHaveLength(3);
    expect(head!.querySelector('.priority')!.getAttribute('title')).toBe('Priority: P1');
    expect(head!.querySelector('.row-title')!.textContent).toBe('Item 1');
    expect(head!.querySelector('.row-time')!.textContent).toBe('2h');
    expect(head!.querySelector('.row-time')!.getAttribute('title')).toBe('In queue since 11:40');
    // Line 2 in the dock's order, each pill's whole name and URL in its tooltip.
    expect([...line2!.children].map((child) => child.className)).toEqual(['codicon comment', 'playbook', 'pill ticket source-github', 'row-links', 'pill returned']);
    expect([...line2!.querySelectorAll('.row-links > .pill')].map((child) => child.className)).toEqual(['pill link pr', 'pill link issue mentioned']);
    expect(line2!.querySelector('.comment')!.getAttribute('title')).toBe('Nov 20\nWaits on Sam');
    expect(line2!.querySelector('.ticket')!.getAttribute('title')).toBe('gh 1\nhttps://github.com/o/r/issues/1');
    expect(line2!.querySelector('.pr')!.textContent).toBe('\u{ea64}19002');
    expect(line2!.querySelector('.pr')!.getAttribute('title')).toBe('PR #19002\nhttps://github.com/o/r/pull/19002');
    expect(line2!.querySelector('.issue .codicon')).toBeNull();
    expect(line2!.querySelector('.issue')!.getAttribute('title')).toBe('gh 18800, named in the ticket\nhttps://github.com/o/r/issues/18800');
    expect(line2!.querySelector('.returned .pill-text')!.textContent).toBe('2');
    // Line 3: the mark, then each detail in its tone with a muted separator between them, never before the first.
    expect(line3!.className).toBe('row-line row-details');
    expect(line3!.firstElementChild!.className).toBe('codicon codicon-watch mark state-icon tone-attention');
    expect([...line3!.querySelectorAll('.row-detail')].map((one) => [one.className, one.textContent, one.getAttribute('title')])).toEqual([
      ['row-detail warning', 'Rate limited · resumes 1:20 PM', 'Resets at 1:20 PM'],
      ['row-detail error', 'Setup <failed>', null],
      ['row-detail', 'Post the reply', null],
    ]);
    expect(line3!.querySelectorAll('.row-detail-separator')).toHaveLength(2);
    expect(line3!.children[1]!.className).toBe('row-detail warning');
    // A row with no priority, time, comment, links, Returned, mark or details draws only its title, playbook and key, and no line 3.
    const bare = root.querySelector<HTMLElement>('[data-work-item="2"]')!;

    expect(bare.children).toHaveLength(2);
    expect(bare.querySelector('.priority, .row-time, .comment, .row-links, .returned, .row-details')).toBeNull();
    expect(bare.querySelector('.ticket')!.getAttribute('title')).toBe('gh 2');
  });

  it('collapses Done by default, still showing the selected row of a collapsed group, and says when there is nothing', () => {
    const root = document.createElement('div');
    const groups = [listGroup('progress', [listRow(1)]), listGroup('done', [listRow(5), listRow(6)])];

    expect(newView().collapsed).toEqual(new Set(['done']));
    root.innerHTML = renderList(groups, 1, newView().collapsed);
    expect(root.querySelector('[data-group="done"] .group-head')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-group="done"] .codicon-chevron-right')).not.toBeNull();
    expect(root.querySelector('[data-group="done"] .group-count')!.textContent).toBe('2');
    expect(root.querySelectorAll('[data-group="done"] .row')).toHaveLength(0);
    root.innerHTML = renderList(groups, 6, newView().collapsed);
    expect([...root.querySelectorAll('[data-group="done"] .row')].map((row) => row.getAttribute('data-work-item'))).toEqual(['6']);
    expect(renderList([listGroup('progress', [])], null, new Set())).toBe('<p class="empty">No work items yet. They appear here when Switchboard starts one.</p>');
  });

  it("puts the session's state codicon inside the dropdown's button, before the title, as each option has it", () => {
    const root = document.createElement('div');

    root.innerHTML = renderHeader({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }) }, newView());
    expect([...root.querySelector('button.picker')!.children].map((child) => child.className)).toEqual(['codicon codicon-loading codicon-modifier-spin state-icon tone-muted', 'title', 'codicon codicon-chevron-down']);
    expect(root.querySelector('.header > .codicon')).toBeNull();
    // The session's provider as its mark inside the button, as on each option that names one, from the same renderer.
    root.innerHTML = renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, provider: 'codex' }] }, session: session({ provider: 'codex' }) }, { ...newView(), picker: true });
    expect(root.querySelector('.header > .provider')).toBeNull();
    expect(root.querySelector('button.picker > .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('.conversation-menu .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('button.picker')!.innerHTML).toBe(`${root.querySelector('.conversation-menu [aria-checked="true"]')!.innerHTML}<span class="codicon codicon-chevron-down" aria-hidden="true"></span>`);
    root.innerHTML = renderHeader({ ...EMPTY, connected: true, scope, session: session() }, newView());
    expect(root.querySelector('.provider')).toBeNull();
  });

  it("shows only the page's own voice state, with Talk here when the voice is elsewhere", () => {
    expect(renderVoice(null)).toBe('');
    expect(renderVoice({ enabled: true, here: false, speaking: null, speakReplies: true, error: null })).toContain('data-voice="talk-here"');
    expect(renderVoice({ enabled: true, here: true, speaking: 'r1', speakReplies: false, error: null })).toContain('data-voice="stop"');
    expect(renderVoice({ enabled: true, here: false, speaking: null, speakReplies: true, error: null })).toContain('The voice is not on this page.');
    // One renderer with the Conversation view: every mic state is drawn by the view's own button.
    expect(renderMicButton).toBe(viewMicButton);
    expect(renderMicButton({ enabled: true, here: true, mic: 'paused-by-voice', speaking: null, speakReplies: true, error: null })).toContain('data-on="true"');
    expect(renderMicButton({ enabled: true, here: true, mic: 'hearing', speaking: 'r1', speakReplies: true, error: null, halfDuplex: 'no echo cancellation' })).toContain('class="mic held"');
  });

  it('draws the spinner after the newest item while the session works on a reply, so progress written mid-turn shows above it', () => {
    const items = [message('m1', 1), reply('a1', 2, { kind: 'aside' }), reply('a2', 3, { kind: 'aside' })];
    const order = (html: string): string[] => [...html.matchAll(/<li class="([^"]+)"(?: data-id="([^"]+)")?/g)].map((match) => match[2] ?? match[1]!);
    const html = renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }), items }, newView());

    expect(order(html)).toEqual(['day', 'm1', 'a1', 'a2', 'working']);
    expect(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }), items: [...items, reply('r1', 4)] }, newView())).not.toContain('class="working"');
    expect(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items }, newView())).not.toContain('class="working"');
  });

  it('gives a time the tooltip the VS Code view gives it: date, 24-hour time and zone', () => {
    const at = Date.UTC(2026, 10, 20, 18, 30, 17);
    const html = renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items: [message('m1', at - 1_000), reply('r1', at)] }, newView());

    expect(html).toMatch(/<time class="stamp" datetime="2026-11-20T18:30:17\.000Z" title="2026-11-20 \d{2}:30:17 [^"]+">/);
  });

  it('draws a card under a reply that asks, answered by the next message', () => {
    const state = { ...EMPTY, connected: true, scope, session: session(), items: [reply('r1', 1, { opening: 'Pick:\n- A) x\n- B) y' }), message('m1', 2, { text: 'B' })] };

    expect(renderTimeline(state, newView())).toMatch(/question-card[\s\S]*aria-checked="true" data-action="pick" data-card="reply:r1" data-question="0" data-letter="B"[\s\S]*Answered/);
  });
});

class FakeSource {
  static last: FakeSource | null = null;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ type, ...(data as object) }) });
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe('the page', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;

  beforeEach(() => {
    posts = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));


  it('redraws by changing only what differs, keeping the focus on a list row and the conversation at its end until the operator scrolls away', () => {
    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;
    const sized = (height: number) => {
      Object.defineProperty(panel, 'scrollHeight', { value: height, configurable: true });
      Object.defineProperty(panel, 'clientHeight', { value: 100, configurable: true });
    };
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' })])];

    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });

    const row = root.querySelector<HTMLElement>('.row')!;

    row.focus();
    sized(300);
    source.emit('reply', { reply: reply('r2', 2) });
    expect(root.querySelector('.row')).toBe(row);
    expect(document.activeElement).toBe(row);
    expect(panel.scrollTop).toBe(300);
    // Scrolled up by the operator, the conversation stays where it is.
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    sized(500);
    source.emit('reply', { reply: reply('r3', 3) });
    expect(panel.scrollTop).toBe(50);
    page.close();
  });

  it('keeps the composer on every tab, says Sent after a send from the Status tab, and shows an ended session\'s reason above the composer', async () => {
    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    expect(composer.hidden).toBe(false);

    const input = composer.querySelector('textarea')!;

    input.value = 'From the status';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    await flush();
    expect(posts.some((post) => post.url.endsWith('/send') && post.body['text'] === 'From the status')).toBe(true);
    expect(root.querySelector('.tab.selected')?.getAttribute('data-tab')).toBe('status');
    expect(composer.querySelector<HTMLElement>('.composer-sent')!.hidden).toBe(false);
    expect(SENT_NOTE_MS).toBe(4_000);

    source.emit('session', { session: session({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' }) });
    expect(root.querySelector('#note .session-note-text')?.textContent).toBe('The session has ended. Resume continues it.');
    expect(input.placeholder).toBe('Resume the session to send a message.');
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(root.querySelector('#panel .notice')).toBeNull();

    // Resume runs the hub's resume for the session shown; a refusal shows over the composer.
    posts = [];
    root.querySelector<HTMLElement>('#note [data-action="resume"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('#note [data-action="resume"]')!.disabled).toBe(true);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/resume'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's' });
    expect(root.querySelector<HTMLButtonElement>('#note [data-action="resume"]')!.disabled).toBe(false);

    // A background session the page cannot talk to has only its reason.
    source.emit('session', { session: session({ state: 'ended', conversation: 'none', reason: 'Open it in Claude to talk to it.' }) });
    expect(root.querySelector('#note .session-note-text')?.textContent).toBe('Open it in Claude to talk to it.');
    expect(root.querySelector('#note [data-action="resume"]')).toBeNull();
    page.close();
  });

  it('lists the persona roster under the header, keeps it open over stream events, and pins the one picked', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova' }, { id: 'iris', name: 'Iris' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: false } })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.persona')!.click();
    expect(root.querySelector('.persona-menu')?.textContent).toBe('Loading…');
    await flush();
    await flush();
    source.emit('reply', { reply: reply('r1', 1) });
    expect([...root.querySelectorAll('.persona-menu .menu-row')].map((one) => one.textContent)).toEqual(['Nova', 'Iris', 'Clear pin']);
    root.querySelector<HTMLElement>('.persona-menu button[data-persona="iris"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'iris' });
    expect(root.querySelector('.persona-menu')).toBeNull();
    page.close();
  });

  it('shows a plain persona button for a session with none that can take a pin, and pins from its roster', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: false })], items: [], more: false, status: null, artifacts: [] });
    expect(root.querySelector('button.persona')).toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });

    const button = root.querySelector<HTMLElement>('button.persona')!;

    expect(button.title).toBe('No persona. Click to choose one.');
    expect(button.getAttribute('aria-label')).toBe('No persona. Click to choose one.');
    expect(button.querySelector('.codicon-person')).not.toBeNull();
    button.click();
    await flush();
    await flush();
    expect([...root.querySelectorAll('.persona-menu .menu-row')].map((one) => [one.textContent, one.getAttribute('aria-checked')])).toEqual([['Nova', 'false']]);
    root.querySelector<HTMLElement>('.persona-menu button[data-persona="nova"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'nova' });
    page.close();
  });

  it('brings the conversation back where the operator left it after the Status tab', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });

    const panel = root.querySelector<HTMLElement>('#panel')!;

    Object.defineProperties(panel, { scrollHeight: { value: 500, configurable: true }, clientHeight: { value: 100, configurable: true } });
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(panel.scrollTop).toBe(50);
    // And after an artifact opened from its row.
    source.emit('artifact', { artifact: { path: 'chat/a.md', owner: 'chat', kind: 'plan', title: 'Plan', ext: 'md', type: 'markdown', updatedAt: 1_500 } });
    root.querySelector<HTMLElement>('#panel [data-action="artifact"]')!.click();
    expect(root.querySelector('.tab.selected')?.getAttribute('data-tab')).toBe('artifacts');
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(panel.scrollTop).toBe(50);
    page.close();
  });

  it('keeps each voice control its own button, so a focused Stop never turns into Talk here', () => {
    const { page, source } = start();
    const voice = { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null, recognizer: null };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [], voice });

    const stop = root.querySelector<HTMLElement>('[data-voice="stop"]')!;

    stop.focus();
    source.emit('voice', { voice: { ...voice, here: false, speaking: null } });
    expect(stop.isConnected).toBe(false);
    expect(root.querySelector('[data-voice="talk-here"]')).not.toBe(stop);
    page.close();
  });

  it('keeps the focus on a voice control over an unrelated stream event, and opens one header menu at a time', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'p', name: 'P', pinned: false, tonePending: false } })], items: [], more: false, status: null, artifacts: [], voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null } });

    const control = root.querySelector<HTMLElement>('.voice-controls button')!;

    control.focus();
    source.emit('unread', { workItemId: 1, count: 1 });
    expect(document.activeElement).toBe(control);
    root.querySelector<HTMLElement>('button.persona')!.click();
    root.querySelector<HTMLElement>('button.picker')!.click();
    expect(root.querySelectorAll('.conversation-menu')).toHaveLength(1);
    expect(root.querySelector('.persona-menu')).toBeNull();
    page.close();
  });

  it('closes the conversation dropdown on a press outside the header and on Escape', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.picker')!.click();
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    root.querySelector('.conversation-menu')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    root.querySelector('.timeline')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.conversation-menu')).toBeNull();
    root.querySelector<HTMLElement>('button.picker')!.click();
    root.querySelector<HTMLElement>('button.picker')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.conversation-menu')).toBeNull();
    page.close();
  });

  it('opens its page stream, selects the work item its address names, and reports its focus', async () => {
    const { page, source } = start();

    expect(source.url).toBe('/v1/conversation/events?page=1');
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    await flush();
    expect(posts.map((post) => [post.url, post.body['window']])).toEqual(expect.arrayContaining([['/v1/conversation/page-focus', 'pk'], ['/v1/conversation/select', 'pk']]));
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(1);
    expect(root.querySelector('#list')!.textContent).toContain('Fix it');
    page.close();
    expect(source.closed).toBe(true);
  });

  it('shows the list as its own view on a narrow screen until a row is opened, and Back returns to it on the selected row', async () => {
    history.replaceState(null, '', '#');

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(location.hash).toBe('#w=1');
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(false);

    const back = root.querySelector<HTMLElement>('.back-bar button.back')!;

    expect(back.getAttribute('aria-label')).toBe('Back to the work items');
    back.click();
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    // The selection stays while the list shows; opening another row leaves the list.
    expect(root.querySelector('[data-work-item="1"]')!.classList.contains('selected')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    page.close();
  });

  it('shows a refused first select over the list, which a phone shows again, and clears it on the next select', async () => {
    history.replaceState(null, '', '#');

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') ? 404 : 200, ok: !url.endsWith('/select'), json: async () => (url.endsWith('/select') ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });

    FakeSource.last!.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    await flush();
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(root.querySelector('#list .list-error')?.textContent).toBe('That work item is gone.');
    expect(location.hash).toBe('');
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.querySelector('#list .list-error')).toBeNull();
    page.close();
  });

  it('opens and collapses a group from its header, keeping the focus on the header', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)]), listGroup('done', [listRow(5)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const done = root.querySelector<HTMLElement>('[data-group="done"] .group-head')!;

    expect(root.querySelector('[data-work-item="5"]')).toBeNull();
    done.focus();
    done.click();
    expect(root.querySelector('[data-work-item="5"]')).not.toBeNull();
    expect(done.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(done);
    root.querySelector<HTMLElement>('[data-group="progress"] .group-head')!.click();
    // The selected row stays in its collapsed group.
    expect([...root.querySelectorAll('[data-group="progress"] .row')].map((row) => row.getAttribute('data-work-item'))).toEqual(['1']);
    done.click();
    expect(root.querySelector('[data-work-item="5"]')).toBeNull();
    page.close();
  });

  it('sends the composer\'s text to the session it shows, with its scope generation and launch, and keeps a draft per work item', async () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const input = root.querySelector('textarea')!;

    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('Message Fix it…');
    input.value = 'hello there';
    input.dispatchEvent(new Event('input'));
    expect(JSON.parse(localStorage.getItem('switchboard.drafts')!)).toEqual({ 1: 'hello there' });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    const sent = posts.find((post) => post.url.endsWith('/send'));

    expect(sent?.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', text: 'hello there' });
    await flush();
    expect(input.value).toBe('');
    expect(localStorage.getItem('switchboard.drafts')).toBe('{}');
    page.close();
  });

  it("shows dictation's live words dimmed after the box's text and the hub's draft in it, never over text typed after it (architecture.md § Dictation)", () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const input = root.querySelector('textarea')!;
    const live = root.querySelector<HTMLElement>('.live-words')!;

    expect(live.hidden).toBe(true);
    source.emit('words', { messageId: 'u1', text: 'fix the' });
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('fix the');
    // With an empty box they start the line, with no space before them.
    expect(live.dataset['lead']).toBe('');
    source.emit('draft', { text: 'fix the', sessionId: 's' });
    source.emit('words', { messageId: 'u1', text: 'login' });
    // Then they continue the draft's line, after a space, in the layer under the box.
    expect(root.querySelector('.live-mirror')!.contains(live)).toBe(true);
    expect(root.querySelector('.mirror-text')!.textContent).toBe('fix the');
    expect(live.dataset['lead']).toBe(' ');
    source.emit('draft', { text: 'fix the login', sessionId: 's' });
    source.emit('words', { messageId: 'u1', text: '' });
    expect(live.hidden).toBe(true);
    expect(input.value).toBe('fix the login');
    source.emit('draft', { text: 'fix the login flow', sessionId: 's' });
    expect(input.value).toBe('fix the login flow');
    // Another session's draft, and one that would replace typed text, leave the box alone.
    source.emit('draft', { text: 'elsewhere', sessionId: 'other' });
    expect(input.value).toBe('fix the login flow');
    input.value = 'my own words';
    source.emit('draft', { text: 'fix the login flow now', sessionId: 's' });
    expect(input.value).toBe('my own words');
    page.close();
  });

  it("fills the box with a draft that came while a message was being sent once the send answered, keeps each conversation's draft baseline, and clears live words on a switch", async () => {
    const { page, source } = start();
    const helloOn = (workItemId: number, sessionId: string) =>
      source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId, sessionId }, sessions: [session({ id: sessionId })], items: [], more: false, status: null, artifacts: [] });

    helloOn(1, 's');

    const input = root.querySelector('textarea')!;
    const live = root.querySelector<HTMLElement>('.live-words')!;

    input.value = 'typed first';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // Dictation goes on while the typed message is being sent.
    source.emit('draft', { text: 'spoken next', sessionId: 's' });
    expect(input.value).toBe('typed first');
    await flush();
    await flush();
    expect(input.value).toBe('spoken next');

    // A, then B, then A again: A's draft still follows the hub, since nothing was typed over it.
    source.emit('words', { messageId: 'u1', text: 'half heard' });
    helloOn(2, 's2');
    expect(live.hidden).toBe(true);
    source.emit('draft', { text: 'for two', sessionId: 's2' });
    expect(input.value).toBe('for two');
    helloOn(1, 's');
    expect(input.value).toBe('spoken next');
    source.emit('draft', { text: 'spoken next and more', sessionId: 's' });
    expect(input.value).toBe('spoken next and more');
    page.close();
  });

  it('disables the composer with the reason for a session it cannot talk to', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ conversation: 'read-only', state: 'idle', reason: 'The session is unobserved: sessions.installHooks is off.' })], items: [], more: false, status: null, artifacts: [] });

    const input = root.querySelector('textarea')!;

    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('The session is unobserved: sessions.installHooks is off.');
    page.close();
  });
});

describe('attaching files from the composer', () => {
  type Call = { url: string; body: unknown; type: string | undefined };
  let calls: Call[];
  let waiting: Array<(status: number, body: unknown) => void>;
  let root: HTMLElement;

  beforeEach(() => {
    calls = [];
    waiting = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const start = () => {
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body, type: (init?.headers as Record<string, string> | undefined)?.['Content-Type'] });

      // An upload answers when the test says, or fails when its chip is removed.
      if (url.startsWith('/v1/conversation/upload')) {
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          waiting.push((status, body) => resolve({ status, ok: status === 200, json: async () => body } as unknown as Response));
        });
      }

      return Promise.resolve({ status: 200, ok: true, json: async () => ({ message: { id: 'm1' } }) } as unknown as Response);
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    return { page, source };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const uploads = () => calls.filter((call) => call.url.startsWith('/v1/conversation/upload'));
  const chipNames = () => [...root.querySelectorAll('.attachment')].map((chip) => [chip.querySelector('.attachment-name')?.textContent, chip.querySelector('.codicon')?.className]);
  const pick = (files: File[]) => {
    const picker = root.querySelector<HTMLInputElement>('input.attach-input')!;

    Object.defineProperty(picker, 'files', { value: files, configurable: true });
    picker.dispatchEvent(new Event('change'));
  };
  /** A paste or drop event carrying files, as a browser builds one. */
  const carrying = (type: 'paste' | 'drop' | 'dragover', field: 'clipboardData' | 'dataTransfer', files: File[], types = ['Files']) => {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.defineProperty(event, field, { value: { files, types, dropEffect: 'none' } });
    return event;
  };

  it('puts + left of /, sends picked files to the hub as chips, and sends their paths as mentions after the text once all have arrived', async () => {
    const { page } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;
    const send = composer.querySelector<HTMLButtonElement>('button.send')!;

    expect([...composer.querySelectorAll('.composer-controls > button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Attach files', 'Show slash commands']);

    const opened = vi.spyOn(composer.querySelector<HTMLInputElement>('input.attach-input')!, 'click').mockImplementation(() => {});

    composer.querySelector<HTMLButtonElement>('button.attach')!.click();
    expect(opened).toHaveBeenCalledTimes(1);

    const notes = new File(['hello'], 'notes one.txt', { type: 'text/plain' });
    const picture = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' });

    pick([notes, picture]);
    expect(uploads().map((call) => [call.url, call.body, call.type])).toEqual([
      ['/v1/conversation/upload?window=pk&scopeGen=3&name=notes%20one.txt', notes, 'text/plain'],
      ['/v1/conversation/upload?window=pk&scopeGen=3&name=shot.png', picture, 'image/png'],
    ]);
    expect(chipNames()).toEqual([['notes one.txt', 'codicon codicon-loading codicon-modifier-spin'], ['shot.png', 'codicon codicon-loading codicon-modifier-spin']]);
    input.value = 'Look at these';
    input.dispatchEvent(new Event('input'));
    // Nothing goes while a file is still on its way.
    expect(send.disabled).toBe(true);

    waiting[0]!(200, { path: 'C:\\Temp\\switchboard-pasted\\attached-1-notes_one.txt', image: false });
    waiting[1]!(200, { path: 'C:\\Temp\\switchboard-pasted\\pasted-1.png', image: true });
    await flush();
    expect(chipNames()).toEqual([['notes one.txt', 'codicon codicon-file'], ['shot.png', 'codicon codicon-file-media']]);
    expect(send.disabled).toBe(false);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    await flush();
    expect(calls.find((call) => call.url.endsWith('/send'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', text: 'Look at these @"C:/Temp/switchboard-pasted/attached-1-notes_one.txt" @"C:/Temp/switchboard-pasted/pasted-1.png"' });
    expect(chipNames()).toEqual([]);
    expect(root.querySelector<HTMLElement>('.attachments')!.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem('switchboard.attachments') ?? '{}')).toEqual({});

    // Files alone make a message.
    pick([notes]);
    waiting[2]!(200, { path: 'C:\\Temp\\a.txt', image: false });
    await flush();
    expect(input.value).toBe('');
    expect(send.disabled).toBe(false);
    send.click();
    await flush();
    expect(calls.filter((call) => call.url.endsWith('/send')).at(-1)?.body).toMatchObject({ text: '@"C:/Temp/a.txt"' });
    page.close();
  });

  it("removes a chip and ends its upload, refuses a file too large or empty without sending it, says the hub's refusal, and keeps chips per work item over a reload", async () => {
    const first = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const error = () => (composer.querySelector<HTMLElement>('.composer-error')!.hidden ? null : composer.querySelector('.composer-error-text')!.textContent);

    pick([new File(['a'], 'a.txt')]);
    expect(uploads()[0]!.type).toBe('application/octet-stream');
    root.querySelector<HTMLButtonElement>('.attachment-remove')!.click();
    expect(chipNames()).toEqual([]);
    await flush();
    // The upload ended with its chip, so its late answer adds nothing.
    waiting[0]!(200, { path: 'C:\\Temp\\a.txt', image: false });
    await flush();
    expect(chipNames()).toEqual([]);
    expect(error()).toBeNull();

    const big = new File(['x'], 'big.bin');

    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    pick([big, new File([], 'empty.txt')]);
    expect(error()).toBe('big.bin is larger than 10 MB. empty.txt is empty.');
    expect(uploads()).toHaveLength(1);

    pick([new File(['no'], 'fake.png', { type: 'image/png' })]);
    waiting[1]!(400, { error: 'fake.png is not a PNG, JPEG, GIF or WebP image.' });
    await flush();
    expect(chipNames()).toEqual([]);
    expect(error()).toBe('fake.png is not a PNG, JPEG, GIF or WebP image.');

    pick(Array.from({ length: 11 }, (_, index) => new File(['c'], `c${index}.txt`)));
    expect(uploads()).toHaveLength(12);
    expect(error()).toBe('A message takes at most 10 files.');
    waiting.slice(2).forEach((answer, index) => answer(200, { path: `C:\\Temp\\c${index}.txt`, image: false }));
    await flush();
    expect(chipNames()).toHaveLength(10);
    first.page.close();

    // A reload shows the work item's chips again; another work item has none.
    const second = start();

    expect(chipNames().map(([name]) => name)).toEqual(Array.from({ length: 10 }, (_, index) => `c${index}.txt`));
    second.source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId: 2, scopeGen: 4 }, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    expect(chipNames()).toEqual([]);
    second.page.close();
  });

  it('attaches files pasted without text and dropped from the computer, and none for a session the page cannot talk to', async () => {
    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;
    const file = new File(['p'], 'image.png', { type: 'image/png' });
    const pasted = carrying('paste', 'clipboardData', [file]);

    input.dispatchEvent(pasted);
    expect(pasted.defaultPrevented).toBe(true);
    expect(uploads()).toHaveLength(1);

    // Text copied with a picture, as from a web page, pastes as text.
    const withText = carrying('paste', 'clipboardData', [file], ['text/plain', 'text/html', 'Files']);

    input.dispatchEvent(withText);
    expect(withText.defaultPrevented).toBe(false);
    expect(uploads()).toHaveLength(1);

    const over = carrying('dragover', 'dataTransfer', []);

    root.querySelector('#panel')!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(composer.classList.contains('drop-target')).toBe(true);

    const dropped = carrying('drop', 'dataTransfer', [new File(['d'], 'report.pdf', { type: 'application/pdf' })]);

    root.querySelector('#panel')!.dispatchEvent(dropped);
    expect(dropped.defaultPrevented).toBe(true);
    expect(composer.classList.contains('drop-target')).toBe(false);
    expect(uploads().map((call) => call.url)).toEqual(['/v1/conversation/upload?window=pk&scopeGen=3&name=image.png', '/v1/conversation/upload?window=pk&scopeGen=3&name=report.pdf']);

    // A session the page cannot talk to takes no file, and a drop still does not open the file in the tab.
    source.emit('session', { session: session({ conversation: 'read-only', reason: 'The session is unobserved: sessions.installHooks is off.' }) });
    expect(composer.querySelector<HTMLButtonElement>('button.attach')!.disabled).toBe(true);

    const refused = carrying('drop', 'dataTransfer', [file]);

    root.querySelector('#panel')!.dispatchEvent(refused);
    expect(refused.defaultPrevented).toBe(true);
    expect(uploads()).toHaveLength(2);
    // Text dragged within the page is no file drop.
    const text = carrying('drop', 'dataTransfer', [], ['text/plain']);

    root.querySelector('#panel')!.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    page.close();
  });
});

describe('the page in use', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;
  let answers: Record<string, { status: number; body: unknown; text?: string; wait?: Promise<void> }>;

  beforeEach(() => {
    posts = [];
    answers = {};
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.includes(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => answer.text ?? '' } as unknown as Response;
    });
    const mermaid = vi.fn(async () => false);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadMermaid: mermaid });

    return { page, source: FakeSource.last!, mermaid };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) =>
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side', host: 'w' })])], scope: { ...scope, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Side', primary: false }] }, sessions: [session()], items: [message('m1', 1), reply('r1', 2, { unread: true, opening: '1. Port?\n   - A) 1\n   - B) 2', answers: 'm1' })], more: true, status: { id: 'st-r1', sessionId: 's', at: 5_000, markdown: '**Working** on it\n\n```mermaid\ngraph TD; A-->B;\n```', fallback: false, unread: true }, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')], unread: 1, voice: { enabled: true, here: false, speaking: null, speakReplies: true, error: null }, ...patch });

  it('switches tabs, opens artifacts in the page, and draws a Markdown artifact with its pictures from its own folder', async () => {
    const { page, source, mermaid } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '---\ntitle: Plan\n---\n# Plan\n\n![pic](plan/pic.png) ![up](../x.png)' };
    hello(source);
    click('[data-tab="status"]');
    expect(root.querySelector('#panel')!.innerHTML).toContain('status-tab');
    expect(mermaid).toHaveBeenCalled();
    click('[data-tab="artifacts"]');
    expect(root.querySelectorAll('.artifact-list button')).toHaveLength(2);
    click('[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector('.artifact-doc')!.innerHTML;

    expect(doc).toContain('<h1>Plan</h1>');
    expect(doc).toContain('src="/v1/conversation/artifact/pk/chat/plan/pic.png"');
    expect(doc).not.toContain('x.png');
    click('[data-action="close-artifact"]');
    click('[data-path="chat/p.html"]');
    expect(root.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    click('[data-tab="conversation"]');
    expect(root.querySelector('#composer')!.hasAttribute('hidden')).toBe(false);
    page.close();
  });

  it("shrinks line 2's pills to their icons when a row is too narrow, after a redraw of the list, and whole again when it widens", async () => {
    const { page, source } = start();
    let line = 150;
    const width = (element: HTMLElement): number => (element.classList.contains('row-line') ? line : element.classList.contains('pill') ? 80 : element.classList.contains('comment') ? 16 : 0);

    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return width(this);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return width(this);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('playbook') ? 100 : 0;
    });
    hello(source, { groups: [listGroup('progress', [listRow(1, { links: [{ kind: 'pr', badge: '#12', label: 'Pull request 12', url: 'https://x/12', glyph: '\u{ea64}', mentioned: false }] })])] });
    await flush();

    const pills = (): string[] => [...root.querySelectorAll('[data-work-item="1"] .pill')].map((one) => one.className.replace(/^pill /, ''));

    // 100 px playbook + two 80 px pills + 2 gaps is 272: both pills shrink, the playbook gives way to 60 px.
    expect(pills()).toEqual(['ticket source-github compact', 'link pr compact']);
    expect(root.querySelector('[data-work-item="1"] .pill.ticket')!.getAttribute('title')).toBe('gh 1');
    line = 400;
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Renamed', links: [{ kind: 'pr', badge: '#12', label: 'Pull request 12', url: 'https://x/12', glyph: '\u{ea64}', mentioned: false }] })])] });
    await flush();
    expect(pills()).toEqual(['ticket source-github', 'link pr']);
    page.close();
  });

  it("resizes the work items from their sash by dragging and the arrow keys, within limits, keeps the width, and resets it on a double-click", () => {
    localStorage.setItem('switchboard.sideWidth', '300');

    const { page } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.side-sash')!;
    const width = (): string => root.style.getPropertyValue('--side-width');

    // The kept width is set before the list is drawn, so the page does not jump.
    expect(width()).toBe('300px');
    expect(sash.getAttribute('role')).toBe('separator');
    expect(sash.getAttribute('aria-valuenow')).toBe('300');
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(width()) || 300 }) as DOMRect);

    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(true);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    expect(width()).toBe('420px');
    // Kept only when the drag ends.
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 5_000, bubbles: true }));
    expect(width()).toBe(`${SIDE_MAX}px`);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    // A move after the drag ended changes nothing.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);

    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 16}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 80}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 64}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MAX));
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(width()).toBe(`${SIDE_MAX}px`);

    // On a narrow page, which holds the list at half its width, the keys step from the width drawn, not the one set.
    Object.defineProperty(side, 'clientWidth', { configurable: true, get: () => Math.min(parseFloat(width()), 384) });
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(width()).toBe('368px');
    expect(sash.getAttribute('aria-valuenow')).toBe('368');
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(sash.getAttribute('aria-valuenow')).toBe('384');

    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(width()).toBe('');
    expect(sash.hasAttribute('aria-valuenow')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBeNull();
    page.close();
  });

  it("keeps the conversation's width set on its sash beside the Status and Artifacts column, and forgets it on a double-click", () => {
    localStorage.setItem('switchboard.chatWidth', '700');

    const { page } = start();
    const main = root.querySelector<HTMLElement>('.main')!;
    const sash = root.querySelector<HTMLElement>('.chat-sash')!;
    const width = (): string => root.style.getPropertyValue('--chat-width');

    expect(width()).toBe('700px');
    expect(root.style.getPropertyValue('--side-width')).toBe('');
    // The sash sits between the conversation and the column, and sets the conversation's width, not the column's.
    expect(sash.previousElementSibling).toBe(main);
    expect(sash.nextElementSibling!.id).toBe('detail');
    vi.spyOn(main, 'getBoundingClientRect').mockImplementation(() => ({ left: 300, width: parseFloat(width()) || 940 }) as DOMRect);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 1_000, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 1_200, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(width()).toBe('900px');
    expect(localStorage.getItem('switchboard.chatWidth')).toBe('900');
    expect(localStorage.getItem('switchboard.sideWidth')).toBeNull();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(width()).toBe(`${CHAT_MIN}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(width()).toBe(`${CHAT_MIN + 64}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.chatWidth')).toBe(String(CHAT_MAX));
    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(width()).toBe('');
    expect(localStorage.getItem('switchboard.chatWidth')).toBeNull();
    page.close();
  });

  it("draws a Markdown artifact's links as claude-collab does, redraws a new version in place, and opens it as drawn in a new window", async () => {
    const { page, source } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan\n\n[page](p.html) [notes](plan/notes.txt) [up](../x.md) [web](https://example.com/a)\n\n| a | b |\n|---|---|\n| 1 | 2 |' };
    hello(source);
    click('[data-tab="artifacts"]');
    click('[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;

    expect(root.querySelector('.artifact-badge')!.textContent).toBe('page');
    expect(doc.querySelector('table td')!.textContent).toBe('1');
    // Another artifact opens in place; another file of the folder in a new tab; a target outside the folder stays text.
    expect(doc.querySelector('a[data-path="chat/p.html"]')!.getAttribute('data-action')).toBe('artifact');
    expect(doc.querySelector('a[href$="plan/notes.txt"]')!.getAttribute('target')).toBe('_blank');
    expect(doc.querySelector('a.path-link')!.textContent).toBe('up');
    expect(doc.querySelector('a[href="https://example.com/a"]')!.getAttribute('target')).toBe('_blank');

    // A new version is fetched again and keeps the reader's place.
    doc.scrollTop = 40;
    const fetches = posts.filter((post) => post.url.includes('/artifact/')).length;

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v2\n\n![pic](plan/pic.png) [page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 2_000 } });
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(fetches + 1);
    expect(root.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('2000');
    expect(root.querySelector('.artifact-doc h1')!.textContent).toBe('Plan v2');
    expect(root.querySelector<HTMLElement>('.artifact-doc')!.scrollTop).toBe(40);

    // The same version is not fetched again on a redraw.
    source.emit('unread', { unread: 0 });
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(fetches + 1);

    // Open in new window: the drawn document, without copy buttons, as a page of its own.
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    let blob: Blob | null = null;

    Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => ((blob = value), 'blob:x')), revokeObjectURL: vi.fn() });
    click('[data-action="artifact-window"]');
    expect(opened).toHaveBeenCalledWith('blob:x', '_blank', 'noopener');

    const html = await blob!.text();

    expect(html).toContain('<h1>Plan v2</h1>');
    expect(html).toContain('class="artifact-window"');
    expect(html).toContain('/page/page.css');
    expect(html).not.toContain('data-action="close-artifact"');
    // Its pictures and links name the hub in full, since a blob: document has no base for the page's paths.
    expect(html).toContain(`src="${location.origin}/v1/conversation/artifact/pk/chat/plan/pic.png"`);
    expect(html).toContain(`href="${location.origin}/v1/conversation/artifact/pk/chat/p.html"`);
    expect(html).not.toContain('data-action="artifact"');

    // A link to another artifact opens it in place.
    answers['/artifact/'] = { status: 200, body: {}, text: '[page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 3_000 } });
    await flush();
    await flush();
    click('.artifact-doc a[data-path="chat/p.html"]');
    expect(root.querySelector('iframe')!.getAttribute('src')).toBe('/v1/conversation/artifact/pk/chat/p.html?v=1500');
    page.close();
  });

  it('counts the Blocked on you rows in the page title, and drops the count when none is left', () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('blocked', [listRow(1), listRow(4)]), listGroup('review', [listRow(5)])] });
    expect(document.title).toBe('(2) Switchboard');
    source.emit('list', { groups: [listGroup('blocked', []), listGroup('review', [listRow(5)])] });
    expect(document.title).toBe('Switchboard');
    page.close();
  });

  it("runs the selected work item's row actions from the header: the main button, Stop and Delete after their question, Snooze with a choice, and Copy", async () => {
    const { page, source } = start();
    const actions = [
      { label: 'Approve', action: 'approve', confirm: null },
      { label: 'Stop', action: 'stop', confirm: { question: 'Stop gh 1?', detail: 'It stops.', action: 'Stop' } },
      { label: 'Mark done', action: 'mark-done', confirm: null },
      { label: 'Snooze…', action: 'snooze', confirm: null },
      { label: 'Delete', action: 'delete', confirm: { question: 'Delete gh 1?', detail: 'Gone.', action: 'Delete' } },
    ];
    const clipboard = vi.fn(async () => undefined);

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelector('.header .row-main')!.textContent).toBe('Approve');
    click('.header .row-main');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, action: 'approve' });

    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Approve', 'Stop', 'Mark done', 'Snooze…', 'Copy Reply', 'Delete']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(3);
    click('.actions-menu [data-row-action="stop"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Stop gh 1?');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(root.querySelector('.sheet')).toBeNull();
    expect(posts).toEqual([]);

    click('button.actions');
    click('.actions-menu [data-row-action="delete"]');
    answers['/row-action'] = { status: 409, body: { error: 'The work item no longer offers this.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ action: 'delete', workItemId: 1 });
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The work item no longer offers this.');
    expect(root.querySelector('.sheet')).toBeNull();

    answers['/row-action'] = { status: 200, body: { done: true } };
    posts = [];
    click('button.actions');
    click('.actions-menu [data-row-action="snooze"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Fix it');
    const second = root.querySelectorAll<HTMLInputElement>('.sheet input[name="snooze"]')[1]!;
    const note = root.querySelector<HTMLTextAreaElement>('.snooze-comment')!;

    second.checked = true;
    second.dispatchEvent(new Event('change', { bubbles: true }));
    note.value = 'after the release';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    // A stream event redraws the page; the choice and the comment stay.
    source.emit('list', { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelectorAll<HTMLInputElement>('.sheet input[name="snooze"]')[1]!.checked).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('.snooze-comment')!.value).toBe('after the release');
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ action: 'snooze', until: expect.any(Number), comment: 'after the release' });

    answers['/row-paste'] = { status: 200, body: { text: 'Dear Ana' } };
    click('button.actions');
    click('.actions-menu [data-action="row-paste"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-paste'))?.body).toMatchObject({ workItemId: 1, label: 'Reply' });
    expect(clipboard).toHaveBeenCalledWith('Dear Ana');

    // The menu belongs to the work item it was opened on.
    click('button.actions');
    click('#list [data-work-item="1"]');
    expect(root.querySelector('.actions-menu')).toBeNull();
    page.close();
  });

  it("shows a Claude session's permission prompt from its screen while it waits, and presses the option clicked for that prompt", async () => {
    const { page, source } = start();
    const prompt = { id: 'p1', lines: [' Bash command', ' echo hi', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'], options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No', selected: false }], next: false };

    answers['/prompt-key'] = { status: 200, body: { done: true } };
    answers['/prompt'] = { status: 200, body: { prompt } };
    hello(source, { sessions: [session({ state: 'waiting', waitingFor: 'permission' })] });
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/prompt'))?.body).toMatchObject({ sessionId: 's', scopeGen: 3 });
    expect(root.querySelector('.prompt-screen')!.textContent).toContain('Do you want to proceed?');
    expect([...root.querySelectorAll('.prompt-card [data-action="prompt-key"]')].map((button) => button.textContent)).toEqual(['1 Yes', '2 No', 'Cancel (Esc)']);
    expect(root.querySelector('.working-detail')!.textContent).toBe('Claude asks in its terminal; answer it below.');

    click('.prompt-card [data-prompt-key="2"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/prompt-key'))?.body).toMatchObject({ sessionId: 's', launch: 'L', prompt: 'p1', key: '2' });

    // Once the session works again the card goes.
    source.emit('session', { session: session({ state: 'running' }) });
    await flush();
    expect(root.querySelector('.prompt-card')).toBeNull();
    page.close();
  });

  it("starts a new conversation in the shown conversation's folder from the dropdown, asking for the provider only when there is a choice", async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    answers['/page-conversation'] = { status: 200, body: { workItemId: 9, folder: 'D:/w' } };
    hello(source);
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    expect([...root.querySelectorAll('.conversation-menu .menu-row')].map((row) => row.textContent)).toEqual(['CodexDefault', 'Claude']);
    click('[data-action="new-provider"][data-provider="claude"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/page-conversation'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, provider: 'claude' });
    expect(posts.find((post) => post.url.endsWith('/page-conversation'))?.body).not.toHaveProperty('folder');
    expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body['workItemId']).toBe(9);
    expect(root.querySelector('.conversation-menu')).toBeNull();

    // A selection while the conversation is being made keeps the page where the operator went.
    let release: () => void = () => {};

    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['claude'] } };
    answers['/page-conversation'] = { status: 200, body: { workItemId: 11, folder: 'D:/w' }, wait: new Promise<void>((resolve) => void (release = resolve)) };
    posts = [];
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    await flush();
    expect(posts.some((post) => post.url.endsWith('/page-conversation'))).toBe(true);
    click('#list [data-work-item="2"]');
    release();
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).not.toContain(11);
    delete answers['/page-conversation'].wait;
    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    answers['/page-conversation'] = { status: 200, body: { workItemId: 9, folder: 'D:/w' } };
    click('#list [data-work-item="1"]');
    await flush();

    // A selection while the providers load drops the choice, so nothing starts in the other conversation's folder.
    posts = [];
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    click('#list [data-work-item="2"]');
    await flush();
    await flush();
    expect(root.querySelector('.conversation-menu')).toBeNull();
    expect(posts.some((post) => post.url.endsWith('/page-conversation'))).toBe(false);

    // One provider installed: no menu.
    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['codex'] } };
    answers['/page-conversation'] = { status: 409, body: { error: 'New sessions need Code Mode (sessions.codeMode).' } };
    posts = [];
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/page-conversation'))?.body).toMatchObject({ provider: 'codex' });
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('New sessions need Code Mode (sessions.codeMode).');
    page.close();
  });

  it('puts Status and Artifacts in a column beside the conversation on a wide screen, with their own switch, and keeps the tabs otherwise', async () => {
    const listeners: Array<() => void> = [];
    const query = { matches: true, addEventListener: (_type: string, listener: () => void) => listeners.push(listener) };

    vi.stubGlobal('matchMedia', vi.fn(() => query));

    const { page, source } = start();

    hello(source);
    expect(root.querySelector('#head .tabs')).toBeNull();
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    expect(root.querySelector('#detail .status-tab')).not.toBeNull();
    click('#detail [data-side="artifacts"]');
    expect(root.querySelectorAll('#detail .artifact-list button')).toHaveLength(2);
    // An artifact row in the conversation opens in the column, and the conversation stays.
    click('#panel [data-action="artifact"][data-path="chat/p.html"]');
    expect(root.querySelector('#detail iframe')).not.toBeNull();
    expect(root.querySelector('#panel .timeline')).not.toBeNull();

    // Either side column hides from the header or the keyboard, and the choice is kept; with the right one hidden the tabs come back.
    click('[data-action="toggle-list"]');
    expect(root.classList.contains('list-hidden')).toBe(true);
    expect(root.querySelector('[data-action="toggle-list"]')!.getAttribute('aria-pressed')).toBe('false');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true }));
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.layout')!)).toEqual({ list: false, detail: false });
    click('[data-action="toggle-detail"]');
    // Not while typing in the composer.
    root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    expect(root.classList.contains('list-hidden')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    expect(root.classList.contains('list-hidden')).toBe(false);
    expect(root.classList.contains('wide')).toBe(true);

    query.matches = false;
    listeners.forEach((listener) => listener());
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    expect(root.querySelector('[data-action="toggle-detail"]')).toBeNull();
    expect(root.querySelector('#detail .detail-body')!.innerHTML).toBe('');
    vi.unstubAllGlobals();
    page.close();
  });

  it('answers a card with Submit as an ordinary message, and shows a refusal on the card', async () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: '1. Port?\n   - A) 1\n   - B) 2' })] });
    click('[data-action="pick"][data-letter="B"]');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    answers['/send'] = { status: 409, body: { error: 'The session has ended.' } };
    click('[data-action="answer"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ text: '1B', sessionId: 's', launch: 'L', scopeGen: 3 });
    expect(root.querySelector('.question-error')!.textContent).toBe('The session has ended.');

    const other = root.querySelector<HTMLInputElement>('.question-other')!;

    other.value = 'port 3';
    other.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('.question-submit')!.disabled).toBe(false);
    page.close();
  });

  it('opens the dropdown, selects another conversation, pages back, and folds a focused reply', async () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' })] });
    expect(root.querySelector('#panel')!.textContent).toContain('Short.');
    click('[data-action="more"]');
    expect(root.querySelector('#panel')!.textContent).toContain('Whole reply.');
    click('[data-action="picker"]');
    expect([...root.querySelectorAll('.conversation-menu .menu-row')].map((row) => row.textContent)).toEqual(['Fix it', 'Side', 'New conversation…']);
    click('.conversation-menu [data-work-item="2"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(2);
    expect(location.hash).toBe('#w=2');
    answers['/history'] = { status: 200, body: { items: [message('m0', 0)], more: false } };
    click('[data-action="earlier"]');
    await flush();
    await flush();
    expect(page.state().items[0]!.id).toBe('m0');
    page.close();
  });

  it('lists files after @ and commands after /, inserts the choice, and walks earlier messages with Up', async () => {
    const { page, source } = start();

    hello(source);

    const input = root.querySelector('textarea')!;

    answers['/files'] = { status: 200, body: { files: [{ path: 'src/my file.ts', dir: false }] } };
    input.value = 'see @my';
    input.setSelectionRange(7, 7);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(posts.some((post) => post.url === '/v1/conversation/files?window=pk&q=my')).toBe(true);
    expect(root.querySelector('.composer-menu')!.textContent).toContain('src/my file.ts');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(input.value).toBe('see @"src/my file.ts" ');

    answers['/commands'] = { status: 200, body: { commands: [{ name: 'review', description: 'Review it' }, { name: 'clear', description: '' }] } };
    input.value = '/re';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(root.querySelector('.composer-menu')!.textContent).toContain('/review');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(input.value).toBe('/review ');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ text: '/review ', command: true });

    input.value = '';
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('text m1');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.value).toBe('');
    page.close();
  });

  it('puts back a message a stopped hub left unsent, only that, with why, and drives the voice from its buttons', async () => {
    const { page, source } = start();

    hello(source);
    // A message a stopped hub left, which every page showing the session takes back.
    source.emit('message', { message: message('m9', 9, { delivery: 'not-sent', error: 'The holder did not answer.', text: 'lost words' }), giveBack: true });
    // One this page did not send stays out of its composer.
    source.emit('message', { message: message('m8', 8, { delivery: 'not-sent', error: 'x', text: 'not mine' }) });
    expect(root.querySelector('textarea')!.value).toBe('lost words');
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The holder did not answer.');
    // While the voice is elsewhere, one Talk here takes the cluster's place; here, Stop and Speak replies.
    expect(root.querySelector('[data-voice="speak-replies"]')).toBeNull();
    click('[data-voice="talk-here"]');
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null } });
    expect(root.querySelector('.composer-footer > .voice-controls ~ .send')).not.toBeNull();
    expect(root.querySelector('.composer-controls .voice-controls')).toBeNull();
    click('[data-voice="speak-replies"]');
    await flush();
    expect(posts.filter((post) => /talk-here|speak-replies/.test(post.url)).map((post) => post.body['on'] ?? 'talk')).toEqual(['talk', false]);
    click('[data-voice="stop"]');
    await flush();
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(true);

    // The mic is the Conversation view's own button, and drives the computer's voice process as the view does.
    expect(root.querySelector('.composer-mic')!.innerHTML).toBe(renderMicButton({ enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null }));
    click('.composer-mic [data-voice="mic"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/mic'))?.body).toMatchObject({ on: true, scopeGen: 3 });
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'paused-other-app', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic')!.getAttribute('title')).toContain('another app is using the microphone');
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic.listening')).not.toBeNull();

    // Focusing the box and leaving it tell the hub, for the focus rule of dictation.
    const box = root.querySelector('textarea')!;

    box.focus();
    box.blur();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body['focused'])).toEqual([true, false]);
    page.close();
  });

  it('marks an unread reply seen once it has shown for a second on a focused page', async () => {
    vi.useFakeTimers();

    let now = 10_000;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => now });

    hello(FakeSource.last!);
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.find((post) => post.url.endsWith('/seen'))?.body).toMatchObject({ sessionId: 's', ids: ['r1'], scopeGen: 3 });
    page.close();
  });

  it('says the link is no longer valid when the hub refuses its cookie', async () => {
    const { page, source } = start();

    answers['/v1/page/list'] = { status: 401, body: {} };
    source.emit('error', {});
    await flush();
    await flush();
    expect(root.querySelector('#list')!.textContent).toContain('no longer valid');
    page.close();
  });
});

describe('the page against late answers', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;
  let pending: Array<{ url: string; resolve: (answer: { status: number; body: unknown }) => void }>;

  beforeEach(() => {
    posts = [];
    pending = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
  });

  const start = (held: RegExp) => {
    const fetch = vi.fn((url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const reply = (answer: { status: number; body: unknown }) => ({ status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' }) as unknown as Response;

      return held.test(url) ? new Promise<Response>((resolve) => pending.push({ url, resolve: (answer) => resolve(reply(answer)) })) : Promise.resolve(reply({ status: 200, body: {} }));
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const scopeOf = (workItemId: number, scopeGen: number, sessionId: string) => ({ ...scope, workItemId, scopeGen, sessionId, conversations: [1, 2].map((id) => ({ ...scope.conversations[0]!, workItemId: id, title: `W${id}`, sessionId: `s${id}` })) });
  const helloFor = (source: FakeSource, workItemId: number, scopeGen: number, items: unknown[] = []) => source.emit('hello', { key: 'pk', groups: [], scope: scopeOf(workItemId, scopeGen, `s${workItemId}`), sessions: [session({ id: `s${workItemId}` })], items, more: true, status: null, artifacts: [] });
  const type = (text: string) => {
    const input = root.querySelector('textarea')!;

    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  };

  it('keeps a message refused before its send answered, and puts one refused after the page moved on back in its own draft', async () => {
    const { page, source } = start(/send/);

    helloFor(source, 1, 3);
    type('first words');
    source.emit('message', { message: message('m1', 9, { workItemId: 1, delivery: 'not-sent', error: 'The holder did not answer.', text: 'first words' }) });
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm1' } } });
    await flush();
    expect(root.querySelector('textarea')!.value).toBe('first words');
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The holder did not answer.');

    type('second words');
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm2' } } });
    await flush();
    expect(root.querySelector('textarea')!.value).toBe('');
    helloFor(source, 2, 4);
    source.emit('message', { message: message('m2', 10, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: 'second words' }) });
    expect(root.querySelector('textarea')!.value).toBe('');
    helloFor(source, 1, 5);
    expect(root.querySelector('textarea')!.value).toBe('second words');
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The session ended.');
    page.close();
  });

  it("drops another conversation's history that answers after the page moved on", async () => {
    const { page, source } = start(/history/);

    helloFor(source, 1, 3, [message('a1', 1, { workItemId: 1 })]);
    root.querySelector<HTMLElement>('[data-action="earlier"]')!.click();
    helloFor(source, 2, 4, [message('b1', 1, { workItemId: 2 })]);
    pending.shift()!.resolve({ status: 200, body: { items: [message('a0', 0, { workItemId: 1 })], more: false } });
    await flush();
    expect(page.state().items.map((item) => item.id)).toEqual(['b1']);
    page.close();
  });

  it('ends on the work item clicked last, whatever order the selects answer in', async () => {
    const { page, source } = start(/select/);

    helloFor(source, 1, 3);
    root.querySelector<HTMLElement>('[data-action="picker"]')!.click();
    root.querySelector<HTMLElement>('.conversation-menu [data-work-item="2"]')!.click();
    root.querySelector<HTMLElement>('[data-action="picker"]')!.click();
    root.querySelector<HTMLElement>('.conversation-menu [data-work-item="1"]')!.click();
    expect(pending).toHaveLength(1);
    source.emit('scope', { scope: scopeOf(2, 4, 's2') });
    helloFor(source, 2, 4);
    pending.shift()!.resolve({ status: 200, body: { scopeGen: 4 } });
    await flush();
    expect(pending.map((one) => one.url)).toEqual(['/v1/conversation/select']);
    expect(posts.at(-1)!.body['workItemId']).toBe(1);
    expect(location.hash).toBe('#w=1');
    page.close();
  });

  it("unlocks a card whose answer was refused after the hub took it", async () => {
    const { page, source } = start(/send/);

    helloFor(source, 1, 3, [reply('r1', 1, { opening: 'Pick:\n- A) x\n- B) y' })]);
    root.querySelector<HTMLElement>('[data-action="pick"][data-letter="A"]')!.click();
    root.querySelector<HTMLElement>('[data-action="answer"]')!.click();
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    source.emit('message', { message: message('m5', 9, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: 'A' }) });
    expect(root.querySelector('.question-error')!.textContent).toBe('The session ended.');
    expect(root.querySelector<HTMLButtonElement>('.question-submit')!.disabled).toBe(false);
    expect(root.querySelector('textarea')!.value).toBe('');
    page.close();
  });

  it("answers a Codex session's permission and questions with the answer command", async () => {
    const { page, source } = start(/never/);
    const requests = [
      { id: 'q1', title: 'Codex asks', kind: 'question', questions: [{ id: 'port', question: 'Port?', options: ['8765', '8799'] }, { id: 'key', question: 'Key?', options: [], secret: true }], decisions: [] },
      { id: 'p1', title: 'Run npm test?', kind: 'permission', questions: [], decisions: ['accept', 'decline'] },
      { id: 'u1', title: 'Something else', kind: 'unsupported', questions: [], decisions: [] },
    ];

    source.emit('hello', { key: 'pk', groups: [], scope: scopeOf(1, 3, 's1'), sessions: [session({ id: 's1', provider: 'codex', state: 'waiting', waitingFor: 'question', requests } as never)], items: [], more: false, status: null, artifacts: [] });
    expect(root.querySelector('#panel')!.textContent).toContain('Answer it in the terminal.');
    expect(root.querySelector<HTMLInputElement>('.request-field[data-field="q1:key"]')!.type).toBe('password');
    root.querySelector<HTMLElement>('[data-action="request-decision"][data-decision="accept"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/answer'))?.body).toMatchObject({ sessionId: 's1', requestId: 'p1', answer: 'accept', scopeGen: 3 });

    root.querySelector<HTMLElement>('[data-action="request-option"][data-value="8799"]')!.click();
    root.querySelector<HTMLElement>('[data-action="request-answer"]')!.click();
    await flush();
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('Answer "Key?" first.');

    const secret = root.querySelector<HTMLInputElement>('.request-field[data-field="q1:key"]')!;

    secret.value = 'abc';
    secret.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-action="request-answer"]')!.click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/answer')).at(-1)?.body).toMatchObject({ requestId: 'q1', answer: { port: '8799', key: 'abc' } });
    page.close();
  });
});

describe("the list's CSS", () => {
  const css = readFileSync(join(__dirname, '../src/page.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The declarations of every rule with a selector the test picks. */
  const declarationsOf = (pick: (selector: string) => boolean): string[] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors!.split(',').some((selector) => pick(selector.trim()))).map(([, , body]) => body!.trim());

  it('marks the selected row with only the selection colours, as the dock does, leaving the focus ring to a keyboard focus', () => {
    const selected = declarationsOf((selector) => selector === '.row.selected');

    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('background: var(--vscode-list-activeSelectionBackground)');
    expect(selected[0]).not.toMatch(/box-shadow|outline|border/);
    expect(declarationsOf((selector) => selector === 'button:focus-visible')).toEqual([expect.stringContaining('outline: 1px solid var(--vscode-focusBorder)')]);
  });

  it('caps the conversation on a wide screen and gives the Status and Artifacts column the rest of the width, with no cap of its own', () => {
    expect(declarationsOf((selector) => selector === '#root.wide > .main')).toEqual(['flex: 0 1 var(--chat-width, 940px);']);
    // With the column hidden the conversation keeps that width, centred.
    expect(declarationsOf((selector) => selector === '.timeline')).toEqual([expect.stringContaining('max-width: calc(var(--chat-width, 940px) - 40px)')]);
    expect(declarationsOf((selector) => selector === '#composer').join(' ')).toContain('max-width: var(--chat-width, 940px)');
    const detail = declarationsOf((selector) => selector.startsWith('#root.wide > .detail') || selector === '.detail' || selector.startsWith('.detail .'));

    expect(detail.join(' ')).toContain('flex: 1 1 320px');
    expect(detail.join(' ')).not.toMatch(/(?<![-\w])width:|clamp\(|max-width: (?!none)/);
    expect(declarationsOf((selector) => ['.detail .status-tab', '.detail .artifact-list', '.detail .artifact-doc'].includes(selector))).toEqual(['max-width: none;']);
  });
});
