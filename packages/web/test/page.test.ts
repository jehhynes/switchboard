import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY, mentionOf, mentionQuery, commandQuery, timeline, withEarlier } from '../src/model.js';
import { answerText, answersIn, complete, parseQuestions } from '@switchboard/conversation/questions';
import { artifactUrl, BROWSER_MIN_WIDTH, browserNote, paneLink, paneStatus, collapsedGroups, newView, renderMicButton, renderVoice, markdownBody } from '../src/render.js';
import { renderArtifactView } from '../src/side.js';
import { renderTimeline, turnRow } from '../src/timeline.js';
import { renderHeader } from '../src/header.js';
import { renderList } from '../src/list.js';
import { html } from './html.js';
import { renderMicButton as viewMicButton } from '@switchboard/conversation/voiceControls';
import { renderMarkdown } from '../src/markdown.js';
import { CHAT_MAX, CHAT_MIN, DRAWER_HIDE_MS, DRAWER_REVEAL_MS, loadMermaid, PANE_SHOW_DELAY_MS, PIN_SNAP, SENT_NOTE_MS, SHOW_MARKER_MS, SIDE_COLLAPSE, SIDE_MAX, SIDE_MIN, startPage, SWIPE_OPEN } from '../src/main.js';
import { DETAIL_MIN } from '../src/layout.js';
import type { ArtifactView, MessageView, PageGroup, PageRow, ReplyView, SessionView } from '@switchboard/protocol';

const message = (id: string, ord: number, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at: 1_000 + ord, ord, provisional: false, withdrawn: false, origin: 'typed', text: `text ${id}`, delivery: 'sent', error: null, ...patch });
const reply = (id: string, ord: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's', at: 1_000 + ord, ord, provisional: false, kind: 'reply', answers: null, opening: `reply ${id}`, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null, ...patch });
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, ticketId: null, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const artifact = (path: string, type: ArtifactView['type'], ext: string): ArtifactView => ({ path, owner: 'chat', kind: 'page', title: path, ext, type, updatedAt: 1_500 });
/** Sets the page's width and tells the page, as a window resize does. */
const resizeTo = (width: number): void => {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
};

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

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending })]), newView()));
    expect(host.querySelector('li[data-id="r1"] > .body')?.textContent?.trim()).toBe('Before I go on:');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: `${ending}\n\nThen I start.` })]), newView()));
    expect(host.querySelector('details.questions-fold summary')?.textContent).toBe('1 question — answer below');
    expect(host.querySelector('li[data-id="r1"] > .body')?.textContent).toContain('Then I start.');
    // Questions before a spoken passage fold too, with the whole reply shown, rather than leaving the text.
    const view = newView();

    view.open.add('more:r1');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: `${ending}\n\nThen I start.`, speak: 'Then I start.' })]), view));
    expect(host.querySelector('details.questions-fold summary')?.textContent).toBe('1 question — answer below');
    expect(host.querySelector('li[data-id="r1"] .speech-bubble')?.textContent?.trim()).toBe('Then I start.');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: 'Later.' })]), newView()));
    expect(host.querySelector('.question-card')?.className).toBe('question-card skipped');
    expect(host.querySelector('.question-card [aria-checked="true"]')).toBeNull();
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B' })]), newView()));
    expect(host.querySelector('.question-card')?.className).toBe('question-card answered');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B', delivery: 'open' })]), newView()));
    expect(host.querySelector('.question-card')?.className).toBe('question-card');
  });

  it('leaves a card answerable under a provisional message queued before the reply, and answered by one queued after it', () => {
    const host = document.createElement('div');
    // A notice an earlier run left queued shows after the transcript's items, dated days before the reply.
    const stale = message('m0', 1, { text: '2 background agents were stopped by the user: "A".', provisional: true, delivery: null });

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 5, { opening: ending }), stale]), newView()));
    expect(host.querySelector('.question-card')?.className).toBe('question-card');
    expect(host.querySelector<HTMLButtonElement>('.question-option')?.disabled).toBe(false);
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 5, { opening: ending }), message('m1', 6, { text: '1B', provisional: true, delivery: null })]), newView()));
    expect(host.querySelector('.question-card')?.className).toBe('question-card answered');
  });

  it('draws each option letter and its period in a column of their own and centres the mark on the first line', () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending })]), newView()));
    const options = [...host.querySelectorAll('.question-option')];

    expect(options.map((one) => one.textContent)).toEqual(['A. 1', 'B. 2']);
    // A wrapped line starts under the text, not under the letter.
    expect(options.map((one) => [...one.children].map((child) => child.className))).toEqual(Array(2).fill(['question-mark radio', 'question-letter', 'question-option-text']));
    const css = readFileSync(join(__dirname, '../src/page.css'), 'utf8');

    expect(css).toMatch(/\.question-option \.question-letter \{ flex: none; min-width: 1\.4em; \}/);
    expect(css).toMatch(/\.question-option-text \{ flex: 1;/);
    expect(css).toMatch(/\.question-mark \{[^}]*height: 16px; margin-top: 2px; margin-top: calc\(\(1lh - 16px\) \/ 2\);/);
  });
});

describe('drawing', () => {
  // The page's state with these items, as a hello brings them.
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, status: null, artifacts: [] });

  it('puts a Today, Yesterday or dated divider before the first item and each turn on another day', () => {
    const at = (day: number, hour: number): number => new Date(2026, 10, day, hour).getTime();
    const markup = html(renderTimeline(pageState([message('m1', 1, { at: at(17, 9) }), reply('r1', 2, { at: at(18, 1) }), message('m2', 3, { at: at(19, 9) }), message('m3', 4, { at: at(20, 9) })]), newView(), at(20, 12)));
    const host = document.createElement('div');

    host.innerHTML = markup;
    expect([...host.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.textContent)).toEqual(['Tue, Nov 17', 'm1', 'r1', 'Yesterday', 'm2', 'Today', 'm3']);
    expect(html(renderTimeline(pageState([message('m1', 1, { at: new Date(2025, 11, 31, 9).getTime() })]), newView(), at(20, 12)))).toContain('>Wed, Dec 31, 2025</li>');
  });

  it('shows the time only on the first item after a day\'s divider, and the optional marks and every time only with message details on', () => {
    const at = (hour: number, minute = 0): number => new Date(2026, 10, 20, hour, minute).getTime();
    const items = [
      message('m1', 1, { at: at(9), origin: 'voice', pieces: [{ text: 'hello there', score: 0.91, f0: 140, dropped: false }] }),
      reply('r1', 2, { at: at(9, 5), tone: 'calm' }),
      message('m2', 3, { at: at(10), delivery: 'uncertain', error: 'Check the terminal.' }),
      message('m3', 4, { at: at(11) }),
    ];
    const host = document.createElement('div');
    const stamps = (): string[] => [...host.querySelectorAll('.timeline > li[data-id]')].map((li) => `${li.getAttribute('data-id')}:${li.querySelector('.stamp')?.textContent ?? '-'}`);

    host.innerHTML = html(renderTimeline(pageState(items), newView(), at(12)));
    expect(stamps()).toEqual(['m1:9:00 AM', 'r1:-', 'm2:-', 'm3:-']);
    // Off: no Dictated or tone, but the copy button and the error mark stay, and the time is the line's or the bubble's tooltip.
    expect(host.querySelector('.voice-mark')).toBeNull();
    expect(host.querySelector('.tone')).toBeNull();
    expect(host.querySelector('li[data-id="r1"] .copy')).not.toBeNull();
    expect(host.querySelector('li[data-id="m2"] .delivery.uncertain')).not.toBeNull();
    expect(host.querySelector('li[data-id="r1"] .meta')!.getAttribute('title')).toMatch(/^2026-11-20 09:05:00 /);
    expect(host.querySelector('li[data-id="m3"] .meta')).toBeNull();
    expect(host.querySelector('li[data-id="m3"] .bubble')!.getAttribute('title')).toMatch(/^2026-11-20 11:00:00 /);

    host.innerHTML = html(renderTimeline(pageState(items), { ...newView(), details: true }, at(12)));
    expect(stamps()).toEqual(['m1:9:00 AM', 'r1:9:05 AM', 'm2:10:00 AM', 'm3:11:00 AM']);
    expect(host.querySelector('li[data-id="m1"] .voice-mark')!.textContent).toBe('dictated');
    expect(host.querySelector('li[data-id="m1"] .voice-mark')!.getAttribute('title')).toBe('Dictated in 1 piece:\nhello there · match 0.91 · 140 Hz');
    expect(host.querySelector('li[data-id="r1"] .tone')!.textContent).toBe('calm');
    expect(host.querySelector('li[data-id="r1"] .meta')!.hasAttribute('title')).toBe(false);
  });

  it("puts a message's and a reply's metadata on one line under it, the reply's copy button first and the time at the right", () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderTimeline(pageState([message('m1', 1, { delivery: 'uncertain', error: 'Check the terminal.' }), reply('r1', 120_000, { tone: 'calm', spoken: { state: 'failed', atMs: null, saidChars: null } })]), { ...newView(), details: true }));
    expect([...host.querySelector('li[data-id="m1"] > .bubble')!.children].map((child) => child.className)).toEqual(['box', 'meta']);
    expect([...host.querySelector('li[data-id="m1"] .meta')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    expect([...host.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
    expect([...host.querySelector('li[data-id="r1"] .meta-marks')!.children].map((child) => child.className)).toEqual(['copy', 'tone', 'spoken failed']);
    expect(host.querySelector('li[data-id="r1"] .meta > :last-child')?.className).toBe('stamp');
  });

  it('dims the part of an interrupted passage not heard, and says Not spoken only when speech failed, with message details on', () => {
    const spoken = (state: ReplyView['spoken']['state'], details = true) => html(renderTimeline(pageState([reply('r1', 1, { opening: 'Fixed it. More.', speak: 'Fixed it.', spoken: { state, atMs: 7_400, saidChars: 3 } })]), { ...newView(), details }));

    expect(spoken('interrupted')).toContain('<div class="speech-bubble"><p class="passage">Fix<span class="unheard">ed it.</span></p></div>');
    expect(spoken('interrupted')).not.toContain('0:07');
    expect(spoken('failed')).toContain('<span>Not spoken</span>');
    // Not spoken is a message detail, as in the Conversation view; the dimmed part of an interrupted passage is not.
    expect(spoken('failed', false)).not.toContain('class="spoken');
    expect(spoken('interrupted', false)).toContain('<span class="unheard">ed it.</span>');
    expect(spoken('playing')).not.toContain('class="unheard"');

    for (const routine of ['playing', 'interrupted', 'stopped-moved', 'played', 'queued'] as const) {
      expect(spoken(routine)).not.toContain('class="spoken');
    }
  });

  it('draws a passage as a bubble on the left, once, in its place when the whole reply shows, and a reply that is all passage as only its bubble', () => {
    const host = document.createElement('div');
    const items = [reply('r1', 1, { opening: 'Before.\n\nFixed it.\n\n- one', speak: 'Fixed it.' }), reply('r2', 2, { opening: 'Same.', speak: 'Same.' }), reply('r3', 3, { opening: 'Plain.' })];
    const kinds = (id: string) => [...host.querySelector(`li[data-id="${id}"] > .body`)!.children].map((child) => (child.classList.contains('speech-bubble') ? `bubble:${child.textContent!.trim()}` : child.tagName.toLowerCase()));
    const view = newView();

    host.innerHTML = html(renderTimeline(pageState(items), view));
    expect(kinds('r1')).toEqual(['bubble:Fixed it.', 'button']);
    expect(kinds('r2')).toEqual(['bubble:Same.']);
    expect(host.querySelector('li[data-id="r3"] .speech-bubble')).toBeNull();

    view.open.add('more:r1');
    host.innerHTML = html(renderTimeline(pageState(items), view));
    expect(kinds('r1')).toEqual(['p', 'bubble:Fixed it.', 'ul', 'button']);
    expect(host.querySelector('li[data-id="r1"] > .body')!.textContent!.match(/Fixed it\./g)).toHaveLength(1);
    expect([...host.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
  });

  it("keeps raw HTML out of Markdown, opens web links in a new tab and shows paths as text", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [web](https://example.com) [file](src/a.ts) [bad](javascript:alert(1))');

    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a class="path-link" title="src/a.ts"');
    expect(html).not.toContain('href="javascript');
  });

  it('says what the turn waits for: Starting or Thinking with the spinner, and the answer or permission the terminal asks for instead of Thinking', () => {
    expect(html(turnRow(session({ state: 'starting' }), true))).toContain('Starting…');
    expect(html(turnRow(session({ state: 'running' }), true))).toContain('codicon-modifier-spin');
    expect(html(turnRow(session({ state: 'running' }), false))).toBe('');
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'question' }), true))).toMatch(/codicon-question[\s\S]*Waiting for your answer/);
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), false))).toMatch(/codicon-shield[\s\S]*Waiting for permission/);
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), true))).not.toContain('Thinking');
  });

  it('opens a page or an SVG artifact in a sandboxed frame with an opaque origin, and media in the page', () => {
    const page = html(renderArtifactView('key', artifact('chat/p.html', 'html', 'html')));
    const svg = html(renderArtifactView('key', artifact('chat/p.svg', 'image', 'svg')));

    expect(page).toContain('sandbox="allow-scripts"');
    expect(page).not.toContain('allow-same-origin');
    expect(page).toContain(`src="${artifactUrl('key', 'chat/p.html')}?v=1500"`);
    expect(svg).toContain('<iframe');
    expect(html(renderArtifactView('key', artifact('chat/p.png', 'image', 'png')))).toContain('<img class="media"');
    expect(html(renderArtifactView('key', artifact('chat/v.mp4', 'video', 'mp4')))).toContain('<video');
    // Only a file of another kind is a download, in place of a preview.
    expect(html(renderArtifactView('key', artifact('chat/d.pdf', 'file', 'pdf')))).not.toContain('download');
    expect(html(renderArtifactView('key', artifact('chat/d.bin', 'file', 'bin')))).toContain('The page cannot show this kind of file.');
    expect(html(renderArtifactView('key', artifact('chat/d.bin', 'file', 'bin')))).not.toContain('download');

    // The head: the kind as a badge, the title and Open in new window, and no Download; each version's file loads afresh.
    const head = document.createElement('div');

    head.innerHTML = html(renderArtifactView('key', { ...artifact('chat/v.mp4', 'video', 'mp4'), kind: 'demo', title: 'Demo' }));
    expect(head.querySelector('.artifact-badge')!.textContent).toBe('demo');
    expect(head.querySelector('.artifact-head .artifact-title')!.textContent).toBe('Demo');
    expect(head.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('1500');
    expect(head.querySelector('video')!.getAttribute('src')).toBe('/v1/conversation/artifact/key/chat/v.mp4?v=1500');
    expect(head.querySelector('a[title="Open in new window"]')!.getAttribute('target')).toBe('_blank');
    expect(head.querySelector('a[title="Open in new window"]')!.getAttribute('href')).toBe('/v1/conversation/artifact/key/chat/v.mp4?v=1500');
    expect(head.querySelector('.artifact-head a[download], .artifact-head [title="Download"]')).toBeNull();
    // Markdown, which the page draws itself, opens as drawn rather than as its source text.
    head.innerHTML = html(renderArtifactView('key', artifact('chat/a.md', 'markdown', 'md')));
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

    root.innerHTML = html(renderList(groups, 3, new Set()));

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
    expect(first.querySelector('.mark')!.className).toBe('codicon codicon-eye mark');
    expect(first.querySelector('.mark')!.getAttribute('aria-label')).toBe('Review, then approve');
    expect(first.querySelector('.pill')!.className).toBe('pill ticket source-github');
    // The ticket key's icon shows only when the pill shrinks to it: its source's logo, the dock's path.
    expect(first.querySelector('.pill .pill-icon')!.getAttribute('class')).toBe('source-logo github pill-icon');
    expect(first.querySelector('.pill .pill-icon path')!.getAttribute('d')).toMatch(/^M12 \.297c-6\.63 0-12 5\.373-12 12/);
    expect(first.querySelector('.playbook')!.innerHTML).toBe('<span class="namespace">dev:</span>build');
    expect(root.querySelector('[data-work-item="2"]')!.className).toBe('row stripe-warning dim');
    expect(root.querySelectorAll('.voice-mark')).toHaveLength(0);
    expect(root.querySelector('[data-work-item="2"] .pill')!.className).toBe('pill ticket source-zoho');
    expect(root.querySelector('[data-work-item="2"] .pill .pill-icon')!.getAttribute('class')).toBe('source-logo zoho pill-icon');
    expect(root.querySelector('[data-work-item="2"] .playbook')!.innerHTML).toBe('triage');
    // A running mark spins, as the dock's does; a failed one is marked for the error colour, and no mark takes a tone.
    expect(root.querySelector('[data-work-item="3"] .mark')!.className).toBe('codicon codicon-loading mark codicon-modifier-spin');
    expect(root.querySelector('[data-work-item="4"] .mark')!.className).toBe('codicon codicon-error mark failed');
    expect(root.querySelector('[data-work-item="3"]')!.className).toBe('row selected');
    expect(root.querySelector('[data-work-item="3"]')!.getAttribute('aria-current')).toBe('true');
    expect(root.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    // A hosted conversation shows its host in the playbook's place; no row shows an unread count.
    expect(root.querySelector('[data-work-item="9"] .playbook')!.textContent).toBe('support');
    expect(root.querySelector('[data-work-item="9"] .playbook')!.classList.contains('host')).toBe(true);
    expect(root.querySelector('.count')).toBeNull();
    // The dropdown shows no count, and no dot for the selected conversation's own unread items.
    expect(html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, unread: 3 }] }, session: session(), unread: 3 }, { ...newView(), picker: true }))).not.toContain('class="count"');
    expect(html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, unread: 3 }] }, session: session(), unread: 3 }, { ...newView(), picker: true }))).not.toContain('unread-dot');
    // Another conversation with unseen items has the dot on its row, and the button carries it.
    const other = { ...scope.conversations[0]!, workItemId: 77, primary: false, title: 'Older', unread: 2 };
    const header = document.createElement('div');

    header.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [scope.conversations[0]!, other] }, session: session() }, { ...newView(), picker: true }));
    expect([...header.querySelectorAll('.conversation-row')].map((row) => row.querySelector('.unread-dot') !== null)).toEqual([false, true]);
    expect(header.querySelector('button.picker .unread-dot')?.getAttribute('title')).toBe('Unread replies or status');
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

    root.innerHTML = html(renderList([listGroup('progress', [full, listRow(2)])], null, new Set()));

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
    // An issue's pill has no icon whole, and the issues codicon when it shrinks to its icon, as the dock's.
    expect([...line2!.querySelectorAll('.issue .codicon')].map((one) => one.className)).toEqual(['codicon codicon-issues pill-icon']);
    expect(line2!.querySelector('.issue')!.getAttribute('title')).toBe('gh 18800, named in the ticket\nhttps://github.com/o/r/issues/18800');
    expect(line2!.querySelector('.returned .pill-text')!.textContent).toBe('2');
    // Line 3: the mark, then each detail in its tone with a muted separator between them, never before the first.
    expect(line3!.className).toBe('row-line row-details');
    expect(line3!.firstElementChild!.className).toBe('codicon codicon-watch mark');
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

  it('collapses Done and Snoozed by default, still showing the selected row of a collapsed group, and says when there is nothing', () => {
    const root = document.createElement('div');
    const groups = [listGroup('progress', [listRow(1)]), listGroup('snoozed', [listRow(4)]), listGroup('done', [listRow(5), listRow(6)])];

    expect(newView().collapsed).toEqual(new Set(['done', 'snoozed']));
    root.innerHTML = html(renderList(groups, 1, newView().collapsed));
    expect(root.querySelector('[data-group="snoozed"] .group-head')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('[data-group="snoozed"] .row')).toHaveLength(0);
    root.innerHTML = html(renderList(groups, 1, newView().collapsed));
    expect(root.querySelector('[data-group="done"] .group-head')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-group="done"] .codicon-chevron-right')).not.toBeNull();
    expect(root.querySelector('[data-group="done"] .group-count')!.textContent).toBe('2');
    expect(root.querySelectorAll('[data-group="done"] .row')).toHaveLength(0);
    root.innerHTML = html(renderList(groups, 6, newView().collapsed));
    expect([...root.querySelectorAll('[data-group="done"] .row')].map((row) => row.getAttribute('data-work-item'))).toEqual(['6']);
    expect(html(renderList([listGroup('progress', [])], null, new Set()))).toBe('<p class="empty">No work items yet. They appear here when Switchboard starts one.</p>');
  });

  it("puts the mic mark before the time on the voice target's row only, with its tooltip", () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderList([listGroup('progress', [listRow(1, { time: { text: '2h', title: 'In queue' }, voice: { glyph: '\u{ec12}', title: 'The voice speaks for this session.' } }), listRow(2, { voice: null })])], null, new Set()));
    expect([...root.querySelector('[data-work-item="1"] .row-head')!.children].map((child) => child.className)).toEqual(['row-title', 'codicon voice-mark', 'row-time']);
    expect(root.querySelector('[data-work-item="1"] .voice-mark')!.getAttribute('aria-label')).toBe('The voice speaks for this session.');
    expect(root.querySelector('[data-work-item="1"] .voice-mark')!.textContent).toBe('\u{ec12}');
    expect(root.querySelector('[data-work-item="2"] .voice-mark')).toBeNull();
  });

  it("draws Done's rows under their date bands, Today and Yesterday open and the older ones closed, each with its count and a rule", () => {
    const root = document.createElement('div');
    const done = listGroup('done', [listRow(5, { band: 'Today' }), listRow(6, { band: 'Today' }), listRow(7, { band: 'Yesterday' }), listRow(8, { band: 'Last week' }), listRow(9, { band: 'Last week' })]);
    const bands = () => [...root.querySelectorAll('[data-group="done"] .band')].map((band) => [band.querySelector('.band-title')!.textContent, band.querySelector('.band-count')!.textContent, band.querySelector('.band-head')!.getAttribute('aria-expanded'), [...band.querySelectorAll('.row')].map((row) => row.getAttribute('data-work-item'))]);

    root.innerHTML = html(renderList([done], null, new Set()));
    expect(bands()).toEqual([
      ['Today', '2', 'true', ['5', '6']],
      ['Yesterday', '1', 'true', ['7']],
      ['Last week', '2', 'false', []],
    ]);
    // Each band's rows are a list of their own, so its first row has no rule above it.
    expect(root.querySelectorAll('[data-group="done"] .band > ul.rows')).toHaveLength(2);
    expect(root.querySelector('.band-head[data-band="done:Last week"] .band-rule')).not.toBeNull();
    // A closed band still shows the selected row; the operator's choice opens or closes a band; a search opens every band.
    root.innerHTML = html(renderList([done], 9, new Set()));
    expect(bands()[2]![3]).toEqual(['9']);
    root.innerHTML = html(renderList([done], null, new Set(), false, null, new Map([['done:Today', false], ['done:Last week', true]])));
    expect(bands().map((band) => band[2])).toEqual(['false', 'true', 'true']);
    root.innerHTML = html(renderList([done], null, new Set(), true));
    expect(bands().map((band) => band[3])).toEqual([['5', '6'], ['7'], ['8', '9']]);
    // Rows without a band, in any other group, have no band heading.
    root.innerHTML = html(renderList([listGroup('progress', [listRow(1), listRow(2)])], null, new Set()));
    expect(root.querySelector('.band')).toBeNull();
    expect(root.querySelectorAll('ul.rows .row')).toHaveLength(2);
  });

  it("puts the session's state codicon inside the dropdown's button, before the title, as each option has it", () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }) }, newView()));
    expect([...root.querySelector('button.picker')!.children].map((child) => child.className)).toEqual(['codicon codicon-loading codicon-modifier-spin state-icon tone-muted', 'title', 'codicon codicon-chevron-down']);
    expect(root.querySelector('.header > .codicon')).toBeNull();
    // The session's provider as its mark inside the button, as on each option that names one, from the same renderer.
    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, provider: 'codex' }] }, session: session({ provider: 'codex' }) }, { ...newView(), picker: true }));
    expect(root.querySelector('.header > .provider')).toBeNull();
    expect(root.querySelector('button.picker > .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('.conversation-menu .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('button.picker')!.innerHTML).toBe(`${root.querySelector('.conversation-menu [aria-checked="true"]')!.innerHTML}<span class="codicon codicon-chevron-down" aria-hidden="true"></span>`);
    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope, session: session() }, newView()));
    expect(root.querySelector('.provider')).toBeNull();
  });

  it("shows only the page's own voice state, with Talk here when the voice is elsewhere", () => {
    expect(renderVoice(null)).toBe('');
    expect(renderVoice({ enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null })).toContain('data-voice="talk-here"');
    expect(renderVoice({ enabled: true, here: true, mic: 'idle-off', speaking: 'r1', speakReplies: false, error: null, recognizer: null })).toContain('data-voice="stop"');
    expect(renderVoice({ enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null })).toContain('The voice is not on this page.');
    // One renderer with the Conversation view: every mic state is drawn by the view's own button.
    expect(renderMicButton).toBe(viewMicButton);
    expect(renderMicButton({ enabled: true, here: true, mic: 'paused-by-voice', speaking: null, speakReplies: true, error: null })).toContain('data-on="true"');
    expect(renderMicButton({ enabled: true, here: true, mic: 'hearing', speaking: 'r1', speakReplies: true, error: null, halfDuplex: 'no echo cancellation' })).toContain('class="mic held"');
  });

  it('draws the spinner after the newest item while the session works on a reply, so progress written mid-turn shows above it', () => {
    const items = [message('m1', 1), reply('a1', 2, { kind: 'aside' }), reply('a2', 3, { kind: 'aside' })];
    const order = (markup: string): string[] => [...markup.matchAll(/<li class="([^"]+)"(?: data-id="([^"]+)")?/g)].map((match) => match[2] ?? match[1]!);
    const markup = html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }), items }, newView()));

    expect(order(markup)).toEqual(['day', 'm1', 'a1', 'a2', 'working']);
    expect(html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }), items: [...items, reply('r1', 4)] }, newView()))).not.toContain('class="working"');
    expect(html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items }, newView()))).not.toContain('class="working"');
  });

  it('gives a time the tooltip the VS Code view gives it: date, 24-hour time and zone', () => {
    const at = Date.UTC(2026, 10, 20, 18, 30, 17);
    const markup = html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items: [message('m1', at - 1_000), reply('r1', at)] }, newView()));

    expect(markup).toMatch(/<time class="stamp" datetime="2026-11-20T18:30:17\.000Z" title="2026-11-20 \d{2}:30:17 [^"]+">/);
  });

  it('draws a card under a reply that asks, answered by the next message', () => {
    const state = { ...EMPTY, connected: true, scope, session: session(), items: [reply('r1', 1, { opening: 'Pick:\n- A) x\n- B) y' }), message('m1', 2, { text: 'B' })] };

    expect(html(renderTimeline(state, newView()))).toMatch(/question-card[\s\S]*aria-checked="true" data-action="pick" data-card="reply:r1" data-question="0" data-letter="B"[\s\S]*Answered/);
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

  it('marks #root.off-conversation while the tabs show another tab, for the short-screen rule, keeping the draft, and never in the wide layout', () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('off-conversation')).toBe(false);
    input.value = 'Half a thought';
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    // Hidden by the stylesheet only, so the box and its text stay.
    expect(composer.hidden).toBe(false);
    expect(root.querySelector('#composer textarea')).toBe(input);
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(input.value).toBe('Half a thought');

    // In the wide layout the conversation's pane always shows the conversation, whatever the column shows.
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    resizeTo(1920);
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('off-conversation')).toBe(false);
    resizeTo(1024);
    page.close();
  });

  it('opens the persona dialog from the view options menu, keeps it open over stream events, and pins the one picked', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return {
        status: 200,
        ok: true,
        json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and brief.' }, { id: 'iris', name: 'Iris', voice: 'marin', style: 'none', personality: '' }] } : {}),
        text: async () => '',
      } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: false } })], items: [], more: false, status: null, artifacts: [] });
    // The header has no persona button of its own any more.
    expect(root.querySelector('button.persona, .persona-anchor')).toBeNull();
    root.querySelector<HTMLElement>('button.view-options')!.click();

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona: Nova…');
    expect(row.querySelector('.menu-note')?.textContent).toBe('Pinned');
    expect(row.querySelector('.codicon-pinned')).not.toBeNull();
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    row.click();
    // The menu closes, the dialog opens with the rest of the page inert, and Close has the focus while the roster loads.
    expect(root.querySelector('.view-options-menu')).toBeNull();

    const dialog = root.querySelector<HTMLElement>('.persona-dialog[role="dialog"]')!;

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.persona-body')?.textContent).toBe('Loading…');
    expect(document.activeElement?.classList.contains('persona-close')).toBe(true);
    expect(root.querySelector('#head')?.closest('[inert]')).not.toBeNull();
    expect(root.querySelector('#panel')?.closest('[inert]')).not.toBeNull();
    expect(dialog.closest('[inert]')).toBeNull();
    await flush();
    await flush();
    source.emit('reply', { reply: reply('r1', 1) });

    const options = [...root.querySelectorAll<HTMLElement>('.persona-option')];

    expect(options.map((one) => [one.querySelector('.persona-name')?.textContent, one.getAttribute('aria-current')])).toEqual([
      ['NovaCurrent, pinned', 'true'],
      ['Iris', null],
    ]);
    expect(options[0]!.textContent).toContain('Voice Cedar · Style Pair');
    expect(options[0]!.querySelector('.persona-personality')?.textContent).toBe('Warm and brief.');
    expect(options[1]!.textContent).toContain('No personality');
    // The current persona takes the focus from Close once the roster shows.
    expect(document.activeElement).toBe(options[0]);
    expect(root.querySelector('.persona-bar [data-persona=""]')?.textContent).toBe('Clear pin');
    root.querySelector<HTMLElement>('.persona-option[data-persona="iris"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'iris' });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(root.querySelector('#head')?.closest('[inert]')).toBeNull();
    expect(document.activeElement?.classList.contains('view-options')).toBe(true);
    page.close();
  });

  it('clears a pin from the persona dialog, and closes it on Escape, on Close and on its backdrop but not on a press inside it', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: '' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('button.view-options')!.click();
      root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
      await flush();
      await flush();
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } })], items: [], more: false, status: null, artifacts: [] });
    await open();
    expect(root.querySelector('.persona-body .persona-note')?.textContent).toBe("The session takes Nova's tone when it next resumes.");
    root.querySelector<HTMLElement>('.persona-body')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('.persona-backdrop')).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(document.activeElement?.classList.contains('view-options')).toBe(true);
    await open();
    root.querySelector<HTMLElement>('.persona-close')!.click();
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    await open();
    root.querySelector<HTMLElement>('.persona-backdrop')!.click();
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    await open();
    root.querySelector<HTMLElement>('.persona-bar [data-persona=""]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: null });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    page.close();
  });

  it('offers Persona… for a session with none only when it can take a pin, and pins from the dialog', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: '' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: false })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.view-options')!.click();
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="persona"]')).toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona…');
    expect(row.title).toBe('No persona. Choose one for this session.');
    expect(row.querySelector('.codicon-person')).not.toBeNull();
    row.click();
    await flush();
    await flush();
    expect([...root.querySelectorAll('.persona-option')].map((one) => one.getAttribute('aria-current'))).toEqual([null]);
    expect(root.querySelector('.persona-bar')).toBeNull();
    root.querySelector<HTMLElement>('.persona-option[data-persona="nova"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'nova' });
    page.close();
  });

  it('closes the persona dialog when another conversation replaces it, and drops a roster answer for an earlier opening', async () => {
    const answers: Array<(value: Response) => void> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return url.endsWith('/personas') ? new Promise<Response>((resolve) => answers.push(resolve)) : ({ status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response);
    });
    const roster = (name: string): Response => ({ status: 200, ok: true, json: async () => ({ personas: [{ id: name.toLowerCase(), name, voice: 'cedar', style: 'pair', personality: '' }] }), text: async () => '' }) as unknown as Response;
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;
    const open = (): void => {
      root.querySelector<HTMLElement>('button.view-options')!.click();
      root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });
    open();
    root.querySelector<HTMLElement>('.persona-close')!.click();
    open();
    answers[0]!(roster('Old'));
    await flush();
    await flush();
    expect(root.querySelector('.persona-body')?.textContent).toBe('Loading…');
    answers[1]!(roster('Nova'));
    await flush();
    await flush();
    expect([...root.querySelectorAll('.persona-option')].map((one) => one.getAttribute('data-persona'))).toEqual(['nova']);
    // Another conversation replaces the one the dialog opened for, so no pick can pin its session.
    source.emit('scope', { scope: { ...scope, scopeGen: scope.scopeGen + 1 } });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(root.querySelector('#head')?.closest('[inert]')).toBeNull();
    expect(posts.some((post) => post.url.endsWith('/persona'))).toBe(false);
    page.close();
  });

  it("shows why the persona dialog has no roster", async () => {
    const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [] } : {}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.view-options')!.click();
    root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.persona-message')?.textContent).toBe('No personas. Add them to voice.personas in settings.json, with voice.enabled on.');
    expect(root.querySelector('.persona-option')).toBeNull();
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
    // The artifact opens in its own tab, chosen.
    expect(root.querySelector('.tab.selected')?.getAttribute('data-path')).toBe('chat/a.md');
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
    root.querySelector<HTMLElement>('button.view-options')!.click();
    root.querySelector<HTMLElement>('button.picker')!.click();
    expect(root.querySelectorAll('.conversation-menu')).toHaveLength(1);
    expect(root.querySelector('.view-options-menu')).toBeNull();
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

    // Back is the header's first button, which CSS hides outside the phone's layout; the Work items button after it shows only where the list is a drawer.
    const back = root.querySelector<HTMLElement>('.header > button.back-toggle')!;

    expect(back.getAttribute('aria-label')).toBe('Back to work items');
    expect(back.previousElementSibling).toBeNull();
    expect(back.nextElementSibling!.classList.contains('list-toggle')).toBe(true);
    expect(root.querySelector('.back-bar')).toBeNull();
    back.click();
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    // The selection stays while the list shows; opening another row leaves the list.
    expect(root.querySelector('[data-work-item="1"]')!.classList.contains('selected')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    page.close();
  });

  it('turns the mic off when a phone\'s width leaves the conversation for the list, and not on a wide page or with the mic off (PRD R119)', async () => {
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const voice = (mic: string) => ({ voice: { enabled: true, here: true, mic, speaking: 'r1', speakReplies: true, error: null } });
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    const { page, source } = start();
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
      await flush();
      source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    };

    window.innerWidth = 375;
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    await open();
    source.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);
    // Speech goes on: no Stop is sent.
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);

    // With the mic already off, Back sends nothing.
    await open();
    source.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);

    // A wide page keeps the conversation beside the list: nothing is left.
    window.innerWidth = 1440;
    await open();
    source.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);
    page.close();

    // A paired device's page, which holds a phone's microphone, does the same, once.
    window.innerWidth = 375;
    posts.length = 0;
    root = document.createElement('div');
    document.body.replaceChildren(root);

    let holdMic: Promise<void> | null = null;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      if (url.endsWith('/mic') && holdMic !== null) {
        await holdMic;
      }

      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, local: false });
    const phone = FakeSource.last!;

    history.replaceState(null, '', '#');
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);

    // A Mic on still opening when Back is tapped is not turned on afterwards: the phone's audio and socket never answer here.
    const sockets: Array<{ onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }> = [];

    vi.stubGlobal('AudioContext', class {
      state = 'running';
      destination = {};
      onstatechange = null;
      audioWorklet = { addModule: async () => undefined };
      resume = async () => undefined;
      close = async () => undefined;
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    });
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: () => undefined, onmessage: null };
      connect(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('WebSocket', class {
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [{ muted: false, readyState: 'live', stop: () => undefined }] }) } });
    onTestFinished(() => void Reflect.deleteProperty(navigator, 'mediaDevices'));
    onTestFinished(() => void vi.unstubAllGlobals());
    posts.length = 0;
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    // The socket is welcomed only after Back.
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await flush();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(mics().filter((on) => on === true)).toEqual([]);

    // Back while the hub has not answered Mic on yet: the page sends Mic off after that answer.
    let answerMic!: () => void;

    holdMic = new Promise((resolve) => (answerMic = resolve));
    posts.length = 0;
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    // The voice is already on this phone, its socket welcomed.
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(mics()).toEqual([true]);
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    holdMic = null;

    const before = mics().length;

    answerMic();
    await flush();
    await flush();
    // Sent after the hub answered Mic on, so it cannot arrive first and leave the mic on.
    expect(mics().slice(before)).toEqual([false]);

    // Back, then the conversation again and Mic on, while the first Mic on is still unanswered: its late answer leaves the new mic alone.
    let answerFirst!: () => void;

    holdMic = new Promise((resolve) => (answerFirst = resolve));
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    holdMic = null;
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();

    const second = mics().length;

    answerFirst();
    await flush();
    await flush();
    expect(mics().slice(second)).toEqual([]);
    expect(mics().at(-1)).toBe(true);
    window.innerWidth = width;
    paired.close();
  });

  it("draws the phone's layout on a phone on its side, wider than 768 px, and the tablet's on an iPad (isPhone)", async () => {
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    let t = 0;
    const swipe = (target: Element): void => {
      // Fake timers fake performance too, so its clock is mocked after them.
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockImplementation(() => t);
      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 200 }] });
        t += 16;
        target.dispatchEvent(event);
      }

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      vi.advanceTimersByTime(400);
      vi.useRealTimers();
    };

    onTestFinished(() => {
      window.innerWidth = width;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    // An iPhone 14 on its side: 844 px wide, its screen 390 by 844.
    vi.stubGlobal('screen', { width: 390, height: 844 });
    window.innerWidth = 844;

    const phone = start();

    phone.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    // Separate views, no drawer, and the conversation a history entry of its own, as in portrait.
    expect(root.classList.contains('listing')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(history.state).toEqual({ switchboardConversation: true });
    // Back leaves the work item, so the mic on for it turns off.
    phone.source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(mics()).toEqual([false]);
    // A swipe right over the conversation goes back too.
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(true);
    phone.page.close();
    expect(document.documentElement.classList.contains('phone')).toBe(false);

    // An iPad Air on its side, 1180 px wide, gets the drawer beside the conversation, and a swipe stays.
    vi.stubGlobal('screen', { width: 820, height: 1180 });
    window.innerWidth = 1180;
    history.replaceState(null, '', '#');
    root = document.createElement('div');
    document.body.replaceChildren(root);

    const tablet = start();

    tablet.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(document.documentElement.classList.contains('phone')).toBe(false);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    tablet.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('drawers')).toBe(true);
    expect(history.state).not.toEqual({ switchboardConversation: true });
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);

    // Turned to portrait, 820 px wide, it keeps the tablet's layout; a window narrowed under 768 px gets the phone's.
    resizeTo(820);
    expect(document.documentElement.classList.contains('phone')).toBe(false);
    resizeTo(700);
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    expect(root.classList.contains('drawers')).toBe(false);
    tablet.page.close();
  });

  it('goes back to the list on a phone with a swipe right over the conversation, as Back does, but not over a menu or from a wider page', async () => {
    history.replaceState(null, '', '#');
    vi.useFakeTimers();

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const main = root.querySelector<HTMLElement>('.main')!;
    let t = 0;
    const swipe = (target: Element): void => {
      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 400 }] });
        t += 16;
        target.dispatchEvent(event);
      }

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      vi.advanceTimersByTime(400);
    };

    vi.spyOn(performance, 'now').mockImplementation(() => t);
    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(false);

    // With the header's dropdown open the swipe is the menu's, and the conversation stays.
    root.querySelector<HTMLElement>('.header .picker')!.click();
    expect(root.querySelector('.menu, [role="menu"]')).not.toBeNull();
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);
    root.querySelector<HTMLElement>('.header .picker')!.click();
    expect(root.querySelector('.menu, [role="menu"]')).toBeNull();

    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(true);
    expect(root.classList.contains('swiping')).toBe(false);
    expect(main.style.transform).toBe('');
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));

    // From tablet width the list is beside the conversation, and a swipe does nothing.
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    resizeTo(1024);
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
    page.close();
  });

it("makes a phone's conversation a history entry, which the browser's back leaves as Back does and its forward opens again", async () => {
    history.replaceState(null, '', '#');

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    const entries = history.length;

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    expect(history.length).toBe(entries + 1);
    expect(location.hash).toBe('#w=1');

    // Back, as Android's back button gives it: the list, on the selected row, and the list's entry keeps the work item's address.
    let pop = popped();

    history.back();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    expect(location.hash).toBe('#w=1');
    // Forward opens the conversation again.
    pop = popped();
    history.forward();
    await pop;
    expect(root.classList.contains('listing')).toBe(false);

    // The Back button takes the entry with it, so the browser's back from the list leaves the page as before.
    pop = popped();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(root.classList.contains('listing')).toBe(true);
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();
    expect(location.hash).toBe('#w=1');

    // Another conversation chosen from the header's dropdown replaces the entry rather than adding one.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    const after = history.length;

    root.querySelector<HTMLElement>('.header .picker')!.click();
    root.querySelector<HTMLElement>('.header [role="menu"] [data-action="select"][data-work-item="1"]')!.click();
    expect(history.length).toBe(after);
    expect(location.hash).toBe('#w=1');

    // A row opened before Back's own step back lands keeps an entry of its own.
    pop = popped();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await pop;
    expect(root.classList.contains('listing')).toBe(false);
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(location.hash).toBe('#w=2');
    page.close();
  });

it('steps back through history once for Back, select and Back in quick succession, and drops a refused row\'s entry or a reloaded mark', async () => {
    history.replaceState({ switchboardConversation: true }, '', '#w=1');

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') && refuse ? 404 : 200, ok: true, json: async () => (refuse ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    let refuse = false;
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];

    // A reload drops the mark, whose list entry belonged to the page before.
    expect(history.state).toBeNull();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const back = vi.spyOn(history, 'back');
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });

    let pop = popped();

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).toHaveBeenCalledOnce();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();

    // A refused first open from the list takes its entry back with it.
    source.emit('hello', { key: 'pk2', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    refuse = true;
    pop = popped();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });
    await pop;
    expect(back).toHaveBeenCalledTimes(2);
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();
    back.mockRestore();
    page.close();
  });

it("turns the mic off through Back's path when a phone's conversation is left by a swipe or the browser's back (PRD R119)", async () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 375;

    const voice = (mic: string) => ({ voice: { enabled: true, here: true, mic, speaking: null, speakReplies: true, error: null } });
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    const groups = [listGroup('progress', [listRow(1)])];
    const { page, source } = start();
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
      await flush();
      source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
      source.emit('voice', voice('listening'));
    };
    const swipe = async (): Promise<void> => {
      const target = root.querySelector('#panel .timeline')!;

      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        target.dispatchEvent(Object.defineProperty(new Event(type, { bubbles: true, cancelable: true }), 'touches', { value: [{ clientX: x, clientY: 400 }] }));
      }

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      await flush();
    };

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    await open();
    await swipe();
    expect(root.classList.contains('listing')).toBe(true);
    expect(mics()).toEqual([false]);

    // The browser's back, as Android's back button gives it.
    await open();

    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.back();
    await popped;
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(mics()).toEqual([false, false]);
    // Speech goes on: no Stop is sent.
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);
    page.close();
  });

  it('adds no history entry from tablet width, where the list stays beside the conversation', () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 1024;

    const { page, source } = start();
    const entries = history.length;

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(history.length).toBe(entries);
    expect(location.hash).toBe('#w=1');
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

  it("keeps each group's open or closed choice across a reload, and a band's only until then", () => {
    const groups = [listGroup('progress', [listRow(1)]), listGroup('snoozed', [listRow(4)]), listGroup('done', [listRow(5, { band: 'Today' }), listRow(6, { band: 'Two weeks ago' })])];
    const first = start();

    first.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-group="done"] .group-head')!.click();
    root.querySelector<HTMLElement>('[data-group="progress"] .group-head')!.click();
    root.querySelector<HTMLElement>('.band-head[data-band="done:Two weeks ago"]')!.click();
    expect(root.querySelector('[data-work-item="6"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.groups')!)).toEqual({ done: true, progress: false });
    first.page.close();

    const second = start();

    second.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    const open = () => [...root.querySelectorAll('.group-head')].map((head) => [head.getAttribute('data-group'), head.getAttribute('aria-expanded')]);

    expect(open()).toEqual([['progress', 'false'], ['snoozed', 'false'], ['done', 'true']]);
    // The band the operator opened starts closed again after the reload, as the dock's do after it restarts.
    expect(root.querySelector('[data-work-item="6"]')).toBeNull();
    expect(root.querySelector('[data-work-item="5"]')).not.toBeNull();
    second.page.close();
    // A kept value that does not read leaves the defaults.
    expect(collapsedGroups('not json')).toEqual(new Set(['done', 'snoozed']));
    expect(collapsedGroups('["done"]')).toEqual(new Set(['done', 'snoozed']));
    expect(collapsedGroups('{"snoozed":true,"review":false,"done":"yes"}')).toEqual(new Set(['done', 'review']));
  });

  it('sends the composer\'s text to the session it shows, with its scope generation and launch, and keeps a draft per work item', async () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const input = root.querySelector('textarea')!;

    expect(input.disabled).toBe(false);
    // The same short placeholder in every conversation, not its title.
    expect(input.placeholder).toBe('Message…');
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

it('shows the context meter as one ring in the composer, its numbers in the tooltip, and sends /compact from its menu only after Compact is confirmed (architecture.md § Context meter)', async () => {
    const { page, source } = start();
    const context = { used: 150_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ context })], items: [], more: false, status: null, artifacts: [] });

    const slot = root.querySelector<HTMLElement>('.composer-controls .context-meter')!;
    const ring = () => slot.querySelector<HTMLButtonElement>('button.context-ring')!;
    const input = root.querySelector('textarea')!;

    expect(ring().textContent).toBe('');
    expect(ring().classList.contains('warn')).toBe(true);
    expect(ring().title).toContain('Context: 75% · 150k / 200k tokens');
    expect(slot.querySelector('.context-menu')).toBeNull();
    source.emit('session', { session: session({ context: { ...context, used: 20_000 } }) });
    expect(ring().classList.contains('ok')).toBe(true);

    input.value = 'my draft';
    ring().click();
    expect(ring().getAttribute('aria-expanded')).toBe('true');
    expect(slot.querySelector('.context-menu')!.textContent).toContain('Context: 10% · 20k / 200k tokens');
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(false);
    expect(document.activeElement).toBe(slot.querySelector('[data-context="compact-confirm"]'));
    slot.querySelector<HTMLButtonElement>('[data-context="cancel"]')!.click();
    expect(slot.querySelector('[data-context="compact-confirm"]')).toBeNull();
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    slot.querySelector<HTMLButtonElement>('[data-context="compact-confirm"]')!.click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/send')).map((post) => post.body)).toMatchObject([{ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', text: '/compact', command: true }]);
    expect(slot.querySelector('.context-menu')).toBeNull();
    expect(input.value).toBe('my draft');

    // Escape and a click elsewhere close the menu.
    ring().click();
    slot.querySelector('.context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(slot.querySelector('.context-menu')).toBeNull();
    ring().click();
    document.body.click();
    expect(slot.querySelector('.context-menu')).toBeNull();
    page.close();
  });

  it('shows an unknown context as the empty ring, and offers no Compact for a session the composer cannot talk to', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ conversation: 'read-only', reason: 'Ended.' })], items: [], more: false, status: null, artifacts: [] });

    const slot = root.querySelector<HTMLElement>('.context-meter')!;

    expect(slot.querySelector('button')!.classList.contains('unknown')).toBe(true);
    slot.querySelector('button')!.click();
    expect(slot.querySelector('.context-menu')!.textContent).toContain('Context size unknown');
    expect(slot.querySelector('[data-context="compact"]')).toBeNull();
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
  let installed: boolean;

  beforeEach(() => {
    posts = [];
    answers = {};
    installed = false;
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

  const start = (loadDiagrams: () => Promise<boolean> = async () => false) => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.includes(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => answer.text ?? '' } as unknown as Response;
    });
    const mermaid = vi.fn(loadDiagrams);
    const opened: string[] = [];
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadMermaid: mermaid, openUrl: (url) => opened.push(url), standalone: () => installed });

    return { page, source: FakeSource.last!, mermaid, opened };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) =>
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side', host: 'w' })])], scope: { ...scope, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Side', primary: false }] }, sessions: [session()], items: [message('m1', 1), reply('r1', 2, { unread: true, opening: '1. Port?\n   - A) 1\n   - B) 2', answers: 'm1' })], more: true, status: { id: 'st-r1', sessionId: 's', at: 5_000, markdown: '**Working** on it\n\n```mermaid\ngraph TD; A-->B;\n```', fallback: false, unread: true }, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')], unread: 1, voice: { enabled: true, here: false, speaking: null, speakReplies: true, error: null }, ...patch });

  it("draws Mermaid diagrams in the system scheme's theme, and draws the ones shown again from their sources when the scheme changes", async () => {
    const changes: Array<() => void> = [];
    // As a browser's, the listener goes when its signal aborts.
    const scheme = {
      matches: false,
      addEventListener: (_type: string, listener: () => void, options?: { signal?: AbortSignal }) => {
        changes.push(listener);
        options?.signal?.addEventListener('abort', () => changes.splice(changes.indexOf(listener), 1));
      },
    };
    const drawn: string[] = [];
    const mermaid = {
      initialize: vi.fn(),
      run: vi.fn(async ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
        // As Mermaid does, a block already drawn is skipped.
        for (const node of Array.from(nodes).filter((one) => !one.hasAttribute('data-processed'))) {
          drawn.push(node.textContent ?? '');
          node.setAttribute('data-processed', 'true');
          node.textContent = 'svg';
        }
      }),
    };

    vi.stubGlobal('matchMedia', vi.fn((query: string) => (query === '(prefers-color-scheme: light)' ? scheme : { matches: false, addEventListener: () => {} })));
    vi.stubGlobal('mermaid', mermaid);

    // The page's own loader initializes Mermaid in the scheme's theme once its script loads.
    const loaded = loadMermaid();
    const script = document.head.querySelector<HTMLScriptElement>('script[src="/page/mermaid.min.js"]')!;

    script.dispatchEvent(new Event('load'));
    expect(await loaded).toBe(true);
    expect(mermaid.initialize).toHaveBeenLastCalledWith({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    script.remove();

    const { page, source } = start(async () => true);

    hello(source);
    click('[data-tab="status"]');
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n']);
    expect(root.querySelector('pre.mermaid')!.textContent).toBe('svg');

    scheme.matches = true;
    changes.forEach((change) => change());
    await flush();
    expect(mermaid.initialize).toHaveBeenLastCalledWith({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    expect(drawn).toEqual(['graph TD; A-->B;\n', 'graph TD; A-->B;\n']);
    page.close();

    // A closed page stops listening.
    expect(changes).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('draws a diagram again when its source changes, never leaving the old drawing over the new source', async () => {
    const drawn: string[] = [];
    const mermaid = {
      initialize: vi.fn(),
      run: vi.fn(async ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
        // As Mermaid does, a block already drawn is skipped.
        for (const node of Array.from(nodes).filter((one) => !one.hasAttribute('data-processed'))) {
          drawn.push(node.textContent ?? '');
          node.setAttribute('data-processed', 'true');
          node.textContent = `svg of ${node.textContent ?? ''}`;
        }
      }),
    };

    vi.stubGlobal('mermaid', mermaid);

    const { page, source } = start(async () => true);
    const status = (markdown: string) => ({ id: 'st-r1', sessionId: 's', at: 5_000, markdown, fallback: false, unread: false });

    hello(source);
    click('[data-tab="status"]');
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n']);
    source.emit('status', { status: status('**Working** on it\n\n```mermaid\ngraph TD; A-->C;\n```') });
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n', 'graph TD; A-->C;\n']);
    expect([...root.querySelectorAll('pre.mermaid')].map((node) => node.textContent)).toEqual(['svg of graph TD; A-->C;\n']);
    // The same source again keeps its drawing.
    source.emit('status', { status: { ...status('**Working** on it\n\n```mermaid\ngraph TD; A-->C;\n```'), at: 6_000 } });
    await flush();
    expect(drawn).toHaveLength(2);
    expect(root.querySelector('pre.mermaid')!.textContent).toBe('svg of graph TD; A-->C;\n');
    page.close();
    vi.unstubAllGlobals();
  });

  it('fits the artifact tabs to the strip, newest first, and lists every artifact in the Artifacts menu with those in tabs dimmed', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    // Unmeasured, the strip shows the most tabs, ARTIFACT_TABS_MAX, then Artifacts with the rest.
    const paths = () => [...root.querySelectorAll<HTMLElement>('#detail .artifact-tab')].map((tab) => tab.dataset['path']);

    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md', 'chat/a3.md']);
    expect(root.querySelector('#detail .artifact-menu-button .tab-badge')!.textContent).toBe('+5');

    // A 700 px strip whose Status and Console take 200 px fits (700 - 200 - 132) / 168, two tabs beside the menu.
    vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 700 } as DOMRect);
    root.querySelectorAll<HTMLElement>('#detail .tabs > .tab[data-side]').forEach((tab) => vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect));
    click('#detail [data-side="console"]');
    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md']);

    // The menu lists all eight, newest first, those with a tab dimmed; picking one shows it in place of the last tab.
    click('#detail [data-action="artifact-menu"]');
    const rows = [...root.querySelectorAll<HTMLElement>('#detail .artifact-menu .menu-row')];

    // The hello's own two artifacts are older than the eight.
    expect(rows.map((row) => row.dataset['path']).slice(0, 8)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md', 'chat/a3.md', 'chat/a2.md', 'chat/a1.md', 'chat/a0.md']);
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.classList.contains('in-bar')).map((row) => row.dataset['path'])).toEqual(['chat/a7.md', 'chat/a6.md']);
    click('#detail .artifact-menu [data-path="chat/a1.md"]');
    expect(root.querySelector('#detail .artifact-menu')).toBeNull();
    expect(paths()).toEqual(['chat/a7.md', 'chat/a1.md']);
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(root.querySelector('#detail .artifact-menu-button .tab-badge')!.textContent).toBe('+8');

    // The menu closes on a press elsewhere and on Escape.
    click('#detail [data-action="artifact-menu"]');
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('#detail .artifact-menu')).toBeNull();
    click('#detail [data-action="artifact-menu"]');
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#detail .artifact-menu')).toBeNull();

    // Left, Right, Home and End move between the strip's tabs, the artifact tabs among them.
    const strip = () => [...root.querySelectorAll<HTMLElement>('#detail .tabs [role="tab"]')];

    strip()[0]!.focus();
    strip()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[1]);
    strip()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect((document.activeElement as HTMLElement).closest<HTMLElement>('.artifact-tab')!.dataset['path']).toBe('chat/a1.md');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[0]);
    // A tab a narrow strip hides (page.css) is skipped, since it cannot take the focus.
    const hidden = strip()[1]!.closest<HTMLElement>('.tab')!;

    hidden.style.display = 'none';
    strip()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[2]);
    hidden.style.display = '';
    strip()[0]!.focus();
    // The open artifact's close button is its own, and shows Status.
    root.querySelector<HTMLElement>('#detail .artifact-tab.selected .tab-close')!.click();
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-side')).toBe('status');
    // Closed, its tab is gone for the work item, kept in the hub for every device, and the menu marks it.
    expect(paths()).not.toContain('chat/a1.md');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-2)?.body).toMatchObject({ workItemId: 1, close: { path: 'chat/a1.md', updatedAt: 10_001 } });
    const cleared = posts.filter((post) => post.url.endsWith('/page-tabs')).at(-1)!.body;

    expect(cleared).toMatchObject({ workItemId: 1, tab: null });
    expect(cleared).not.toHaveProperty('openOn');
    click('#detail [data-action="artifact-menu"]');
    expect(root.querySelector('#detail .artifact-menu [data-path="chat/a1.md"]')!.classList.contains('closed')).toBe(true);
    // Choosing it opens its tab again.
    click('#detail .artifact-menu [data-path="chat/a1.md"]');
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-2)?.body).toMatchObject({ workItemId: 1, reopen: 'chat/a1.md' });
    // Another device closing the open artifact shows Status here.
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/a1.md', updatedAt: 10_001 }] } });
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-side')).toBe('status');
    expect(paths()).not.toContain('chat/a1.md');
    // Another device closing a tab closes it here too, and a newer version opens it again.
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/a7.md', updatedAt: 10_007 }] } });
    expect(paths()).not.toContain('chat/a7.md');
    source.emit('artifact', { artifact: { path: 'chat/a7.md', owner: 'chat', kind: 'note', title: 'Note 7', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    expect(paths()).toContain('chat/a7.md');

    // An artifact that goes away leaves Status shown.
    click('#detail .artifact-tab[data-path="chat/a7.md"]');
    hello(source, { artifacts: [] });
    expect(root.querySelector('#detail .artifact-tab')).toBeNull();
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-side')).toBe('status');
    vi.unstubAllGlobals();
    page.close();
  });

  it('switches tabs, opens artifacts in the page, and draws a Markdown artifact with its pictures from its own folder', async () => {
    const { page, source, mermaid } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '---\ntitle: Plan\n---\n# Plan\n\n![pic](plan/pic.png) ![up](../x.png)' };
    hello(source);
    click('[data-tab="status"]');
    expect(root.querySelector('#panel')!.innerHTML).toContain('status-tab');
    expect(mermaid).toHaveBeenCalled();
    // Each artifact has its own tab, newest first, and no Artifacts tab lists them.
    expect(root.querySelector('[data-tab="artifacts"]')).toBeNull();
    expect([...root.querySelectorAll<HTMLElement>('#head .artifact-tab')].map((tab) => tab.dataset['path'])).toHaveLength(2);
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector('.artifact-doc')!.innerHTML;

    expect(doc).toContain('<h1>Plan</h1>');
    expect(doc).toContain('src="/v1/conversation/artifact/pk/chat/plan/pic.png"');
    expect(doc).not.toContain('x.png');
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-path')).toBe('chat/plan.md');
    // Closing its tab shows Status, and the closed tab goes.
    click('#head .artifact-tab.selected .tab-close');
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-tab')).toBe('status');
    expect(root.querySelectorAll('#head .artifact-tab')).toHaveLength(1);
    click('#head .artifact-tab[data-path="chat/p.html"]');
    expect(root.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    click('[data-tab="conversation"]');
    expect(root.querySelector('#composer')!.hasAttribute('hidden')).toBe(false);
    page.close();
  });

  it('shows text, data and code preformatted, JSON indented, a PDF in the browser viewer, and only an unknown file as a download', async () => {
    const { page, source } = start();
    const artifact = (path: string, ext: string, updatedAt: number) => ({ path, owner: 'chat', kind: 'report', title: path, ext, type: 'file', updatedAt });

    answers['/artifact/'] = { status: 200, body: {}, text: '{"a":1,"b":"<x>"}' };
    hello(source, { artifacts: [artifact('chat/data.json', 'json', 4), artifact('chat/notes.txt', 'txt', 3), artifact('chat/report.pdf', 'pdf', 2), artifact('chat/blob.bin', 'bin', 1)] });
    click('#head .artifact-tab[data-path="chat/data.json"]');
    await flush();
    await flush();
    const json = root.querySelector('.artifact-doc pre.artifact-text code')!;

    expect(json.textContent).toBe('{\n  "a": 1,\n  "b": "<x>"\n}');
    expect(json.innerHTML).toContain('&lt;x&gt;');
    expect(root.querySelector('.artifact-view a[download]')).toBeNull();
    expect(root.querySelector('.artifact-view [title="Open in new window"]')).not.toBeNull();

    answers['/artifact/'] = { status: 200, body: {}, text: 'plain <b>text</b>' };
    click('#head .artifact-tab[data-path="chat/notes.txt"]');
    await flush();
    await flush();
    expect(root.querySelector('.artifact-doc pre.artifact-text')!.textContent).toBe('plain <b>text</b>');
    expect(root.querySelector('.artifact-doc b')).toBeNull();

    click('#head .artifact-tab[data-path="chat/report.pdf"]');
    const pdf = root.querySelector('iframe.artifact-pdf')!;

    expect(pdf.getAttribute('src')).toContain('/v1/conversation/artifact/pk/chat/report.pdf');
    expect(pdf.hasAttribute('sandbox')).toBe(false);

    click('#head .artifact-tab[data-path="chat/blob.bin"]');
    expect(root.querySelector('.artifact-view .empty')!.textContent).toBe('The page cannot show this kind of file. Open it in a new window from the button above.');
    expect(root.querySelector('.artifact-view a[download]')).toBeNull();
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

  it("opens the header's menus down and to the right of their buttons, and the other way only where the page has no room", () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    let gear = 770;
    const rect = (element: HTMLElement): DOMRect => {
      // A menu in its default place: under its anchor, left edges lined up.
      const anchor = element.classList.contains('menu') ? rect(element.parentElement!) : null;
      const left = anchor?.left ?? (element.classList.contains('view-options-anchor') ? gear : 40);
      const top = anchor === null ? 8 : anchor.bottom + 2;
      const [width, height] = anchor === null ? [24, 24] : [200, 120];

      return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    };

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this);
    });

    const { page, source } = start();

    hello(source);
    click('.header button.picker');
    expect(root.querySelector('.conversation-menu')!.className).toBe('glass menu conversation-menu');
    expect(root.querySelector<HTMLElement>('.conversation-menu')!.style.maxWidth).toBe('360px');
    click('.header button.view-options');
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu flip-x');
    // A scroll that moves the button is followed; the menu's own scrolling is not.
    gear = 40;
    root.querySelector('.view-options-menu')!.dispatchEvent(new Event('scroll'));
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu flip-x');
    root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu');
    page.close();
  });

  it("keeps the conversation's text at fixed sizes: drops the old text size key, leaves Ctrl+=, Ctrl+- and Ctrl+0 to the browser, and offers no text size in View options", () => {
    localStorage.setItem('switchboard.textScale', '1.25');

    const { page, source } = start();

    expect(localStorage.getItem('switchboard.textScale')).toBeNull();
    expect(root.style.getPropertyValue('--chat-scale')).toBe('');
    hello(source);

    for (const key of ['=', '+', '-', '0']) {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });

      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(root.querySelector('.view-options-menu')).toBeNull();
    click('.header button.view-options');
    expect(root.querySelector('.header button.view-options')!.getAttribute('title')).toBe('View options');
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim())).toEqual(['Show message details', 'Expand spoken replies']);
    expect(root.querySelector('.view-options-menu .menu-separator')).toBeNull();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.view-options-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.header button.view-options'));

    // One header menu at a time: View options closes the dropdown, and the dropdown View options.
    click('.header button.picker');
    click('.header button.view-options');
    expect(root.querySelector('.header button.picker')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    click('.header button.picker');
    expect(root.querySelector('.view-options-menu')).toBeNull();
    click('.header button.picker');

    // Show message details, in the same menu, kept.
    click('.header button.view-options');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('false');
    click('[data-action="toggle-details"]');
    expect(localStorage.getItem('switchboard.messageDetails')).toBe('1');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('true');
    page.close();

    const again = start();

    hello(again.source);
    click('.header button.view-options');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('true');
    click('[data-action="toggle-details"]');
    expect(localStorage.getItem('switchboard.messageDetails')).toBeNull();
    again.page.close();
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
    // Under its least width, but not past the snap, the list stops at its least width.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: SIDE_COLLAPSE, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    expect(sash.classList.contains('snapping')).toBe(false);
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
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
    click('#head .artifact-tab[data-path="chat/plan.md"]');
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

    // An answer that comes after a newer version replaced its own is dropped.
    let late: () => void = () => {};

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v3', wait: new Promise<void>((resolve) => (late = resolve)) };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 3_000 } });
    await flush();
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v2\n\n![pic](plan/pic.png) [page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 4_000 } });
    await flush();
    await flush();
    late();
    await flush();
    await flush();
    expect(root.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('4000');
    expect(root.querySelector('.artifact-doc h1')!.textContent).toBe('Plan v2');

    // Another selection's artifact of the same path and time is fetched for it, never shown from the last one's.
    const before = posts.filter((post) => post.url.includes('/artifact/')).length;

    source.emit('scope', { scope: { ...scope, scopeGen: scope.scopeGen + 1 } });
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(before + 1);

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
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
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
      { label: 'Approve', action: 'approve', icon: 'check', group: 'main' as const, confirm: null, input: null },
      { label: 'Stop', action: 'stop', icon: 'debug-stop', group: 'work' as const, confirm: { question: 'Stop gh 1?', detail: 'It stops.', action: 'Stop' }, input: null },
      { label: 'Mark done', action: 'mark-done', icon: 'pass', group: 'state' as const, confirm: null, input: null },
      { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null },
      { label: 'Move up', action: 'move', icon: 'arrow-up', group: 'order' as const, confirm: null, input: null },
      { label: 'Delete', action: 'delete', icon: 'trash', group: 'asking' as const, confirm: { question: 'Delete gh 1?', detail: 'Gone.', action: 'Delete' }, input: null },
    ];
    const clipboard = vi.fn(async () => undefined);

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelector('.header .row-main')!.textContent).toBe('Approve');
    click('.header .row-main');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, label: 'Approve' });
    expect(root.querySelector('.header .row-main .codicon-check')).not.toBeNull();

    click('button.actions');
    // The dock's menu groups: main, work, state, order, what the row opens, and what asks first.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Approve', 'Stop', 'Mark done', 'Snooze…', 'Move up', 'Copy Reply', 'Delete']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(5);
    click('.actions-menu [data-label="Move up"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-action')).at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Move up' });
    click('button.actions');
    click('.actions-menu [data-label="Stop"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Stop gh 1?');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(root.querySelector('.sheet')).toBeNull();
    expect(posts).toEqual([]);

    click('button.actions');
    click('.actions-menu [data-label="Delete"]');
    answers['/row-action'] = { status: 409, body: { error: 'The work item no longer offers this.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Delete', workItemId: 1 });
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The work item no longer offers this.');
    expect(root.querySelector('.sheet')).toBeNull();

    answers['/row-action'] = { status: 200, body: { done: true } };
    posts = [];
    click('button.actions');
    click('.actions-menu [data-label="Snooze…"]');
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
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Snooze…', until: expect.any(Number), comment: 'after the release' });

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

  it("asks for a control's text in a sheet as the dock's input dialog, with its choice, and sends the text and a changed choice by the control's label", async () => {
    const { page, source } = start();
    const guided = { label: 'Start with guidance…', action: 'start', icon: 'comment', group: 'work' as const, confirm: null, input: { question: 'Start with guidance', detail: 'It ends the prompt.', action: 'Start', text: null, choice: { label: 'Playbook', value: 'dev:build', values: ['dev:build', 'dev:fix'] } } };
    const prompted = { label: 'Start with prompt…', action: 'start', icon: 'edit', group: 'main' as const, confirm: null, input: { question: 'Start with prompt', detail: 'The session runs it.', action: 'Start', text: 'Fix the build', choice: null } };
    const comment = { label: 'Add comment…', action: 'comment', icon: 'comment', group: 'notes' as const, confirm: null, input: { question: 'Add comment', detail: 'Kept here.', action: 'Add', text: null, choice: null } };
    const type = (selector: string, value: string) => {
      const field = root.querySelector<HTMLTextAreaElement | HTMLSelectElement>(selector)!;

      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };

    answers['/row-action'] = { status: 200, body: { done: true } };
    hello(source, { groups: [listGroup('unstarted', [listRow(1, { title: 'Fix it', actions: [prompted, guided, comment], main: 'Start with prompt…' })])] });
    // A main control that asks for text opens its sheet, with the text it starts with.
    click('.header .row-main');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Start with prompt');
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value).toBe('Fix the build');
    expect(document.activeElement).toBe(root.querySelector('.sheet-input'));
    type('.sheet-input', 'Fix the tests');
    root.querySelector('.sheet-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-action')).at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Start with prompt…', text: 'Fix the tests' });
    expect(root.querySelector('.sheet')).toBeNull();

    click('button.actions');
    // Add comment… is its own group, as the dock's notes.
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(2);
    click('.actions-menu [data-label="Start with guidance…"]');
    expect(root.querySelector<HTMLSelectElement>('.sheet-select')!.value).toBe('dev:build');
    // Neither a text nor a changed choice: the button waits, as the dock's.
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(true);
    type('.sheet-select', 'dev:fix');
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(false);
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Start with guidance…', text: '', choice: 'dev:fix' });

    click('button.actions');
    click('.actions-menu [data-label="Add comment…"]');
    type('.sheet-input', '   ');
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(true);
    type('.sheet-input', ' Asked Ana ');
    // A stream event redraws the page; the text stays.
    source.emit('list', { groups: [listGroup('unstarted', [listRow(1, { title: 'Fix it', actions: [prompted, guided, comment], main: 'Start with prompt…' })])] });
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value).toBe(' Asked Ana ');
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Add comment…', text: 'Asked Ana' });
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).not.toHaveProperty('choice');

    // Cancel posts nothing.
    click('button.actions');
    click('.actions-menu [data-label="Add comment…"]');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(posts).toEqual([]);
    page.close();
  });

  it("runs Open in VS Code, Open changes and Open report through the hub from the menu's opens group, and shows a refusal", async () => {
    const { page, source } = start();
    const opens = [{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open changes', icon: 'diff-multiple' }, { label: 'Open report', icon: 'symbol-file' }];

    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', opens, pastes: ['Reply'], url: 'https://github.com/o/r/issues/1' })])] });
    click('button.actions');
    // One group: Copy, then what opens in VS Code, then the ticket, as the dock's opens.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in VS Code', 'Open changes', 'Open report', 'Open ticket']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(0);
    expect(root.querySelector('.actions-menu [data-label="Open in VS Code"] .codicon-vscode')).not.toBeNull();
    click('.actions-menu [data-label="Open changes"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-command'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, label: 'Open changes' });
    expect(root.querySelector('.actions-menu')).toBeNull();

    answers['/row-command'] = { status: 409, body: { error: 'VS Code did not start: Code.exe was not found beside code on PATH.' } };
    click('button.actions');
    click('.actions-menu [data-label="Open in VS Code"]');
    await flush();
    await flush();
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('VS Code did not start: Code.exe was not found beside code on PATH.');
    page.close();
  });

  it("lists a pool ticket with a menu under its row instead of a conversation, and runs its Start, Start with guidance and Snooze through pool-action", async () => {
    const { page, source, opened } = start();
    const actions = [
      { label: 'Start', action: 'pick', icon: 'play', group: 'main' as const, confirm: null, input: null },
      { label: 'Start with guidance…', action: 'pick', icon: 'comment', group: 'work' as const, confirm: null, input: { question: 'Start with guidance', detail: 'It ends the prompt.', action: 'Start', text: null, choice: null } },
      { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null },
    ];
    const pool = listRow(0, { workItemId: null, ticketId: 9, title: 'Pool ticket', ticket: 'gh 9', url: 'https://github.com/o/r/issues/9', actions, main: 'Start' });

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })]), listGroup('unstarted', [pool])] });
    posts = [];
    const row = () => root.querySelector<HTMLElement>('#list [data-action="pool-menu"][data-row="ticket:9"]')!;

    expect(row().getAttribute('aria-expanded')).toBe('false');
    const shown = vi.fn();

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: shown, configurable: true });
    row().click();
    expect(shown).toHaveBeenCalledWith({ block: 'nearest' });
    expect(shown.mock.contexts[0]).toBe(root.querySelector('#list .row-menu'));
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    expect(row().getAttribute('aria-expanded')).toBe('true');
    expect([...root.querySelectorAll('#list .row-menu .menu-row')].map((one) => one.textContent)).toEqual(['Start', 'Start with guidance…', 'Snooze…', 'Open ticket']);
    // Its click selects nothing: a pool ticket has no conversation.
    expect(posts).toEqual([]);

    answers['/pool-action'] = { status: 200, body: { done: true } };
    click('#list .row-menu [data-label="Start"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ window: 'pk', ticketId: 9, label: 'Start' });
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).not.toHaveProperty('workItemId');
    expect(root.querySelector('#list .row-menu')).toBeNull();

    row().click();
    click('#list .row-menu [data-label="Start with guidance…"]');
    root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value = 'Use staging';
    root.querySelector('.sheet-input')!.dispatchEvent(new Event('input', { bubbles: true }));
    posts = [];
    answers['/pool-action'] = { status: 409, body: { error: 'The ticket is no longer in the pool.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ ticketId: 9, label: 'Start with guidance…', text: 'Use staging' });
    // With no conversation, the refusal shows over the list.
    expect(root.querySelector('#list .list-error')!.textContent).toBe('The ticket is no longer in the pool.');

    row().click();
    click('#list .row-menu [data-label="Snooze…"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Pool ticket');
    answers['/pool-action'] = { status: 200, body: { done: true } };
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ ticketId: 9, label: 'Snooze…', until: expect.any(Number) });

    // The menu closes on Escape and on a press outside it, and without the browser pane its pill opens the ticket without opening the menu.
    row().click();
    root.querySelector('#list .row-menu .menu-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list .row-menu')).toBeNull();
    row().click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('#list .row-menu')).toBeNull();
    row().querySelector<HTMLElement>('.pill.ticket')!.click();
    expect(opened).toEqual(['https://github.com/o/r/issues/9']);
    expect(root.querySelector('#list .row-menu')).toBeNull();
    page.close();
  });

  it("opens the Console tab for the dock's Open in terminal, after Copy in the opens group", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', pastes: ['Reply'], terminal: true, opens: [{ label: 'Open in VS Code', icon: 'vscode' }] })])] });
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in terminal', 'Open in VS Code']);
    posts = [];
    click('.actions-menu [data-action="open-console"]');
    expect(root.querySelector('[data-tab="console"]')!.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.actions-menu')).toBeNull();
    // It opens a tab of the page; nothing is posted for it.
    expect(posts.filter((post) => post.url.includes('/row-'))).toEqual([]);

    // Nor while the session has no console to show, as once it has ended.
    source.emit('session', { session: session({ state: 'ended', conversation: 'read-only' }) });
    click('button.actions');
    expect(root.querySelector('.actions-menu [data-action="open-console"]')).toBeNull();
    click('button.actions');
    source.emit('session', { session: session() });

    // A row the dock offers no terminal for has no such item.
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', pastes: ['Reply'] })])] });
    click('button.actions');
    expect(root.querySelector('.actions-menu [data-action="open-console"]')).toBeNull();
    page.close();
  });

  it("opens a row's ticket and link pills in a new tab without selecting the row while the page has no browser pane, and only http or https links", async () => {
    const { page, source, opened } = start();
    const links = [
      { label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: '\u{ea64}', mentioned: false },
      { label: 'Notes', url: 'https://example.test/a?b=1#top', kind: 'url' as const, badge: 'Notes', glyph: null, mentioned: false },
      { label: 'Bad', url: 'javascript:alert(1)', kind: 'url' as const, badge: 'Bad', glyph: null, mentioned: false },
    ];

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other', url: 'https://github.com/o/r/issues/2', links })])] });
    // The pane is on but not paired, so it shows no links.
    source.emit('pane', { pane: { enabled: true, extension: 'unpaired', extensionId: 'ext', marker: null, shown: false, error: null } });
    posts = [];
    click('#list [data-work-item="2"] .pill.ticket');
    click('#list [data-work-item="2"] .pill.link.pr');
    click('#list [data-work-item="2"] .pill.link[title^="Notes"]');
    click('#list [data-work-item="2"] .pill.link[title^="Bad"]');
    await flush();
    expect(opened).toEqual(['https://github.com/o/r/issues/2', 'https://github.com/o/r/pull/5', 'https://example.test/a?b=1#top']);
    // The pill's click is not the row's: nothing is selected.
    expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
    expect(root.querySelector('#list .row.selected')?.getAttribute('data-work-item')).toBe('1');
    // A row without a ticket URL, such as an ad-hoc one, has a ticket pill that opens nothing.
    expect(root.querySelector('#list [data-work-item="1"] .pill.ticket')!.hasAttribute('data-action')).toBe(false);
    page.close();
  });

  it("draws a row's ticket and link pills as labels while the paired browser pane shows the links, a click on one selecting the row and opening nothing", async () => {
    installed = true;
    const { page, source, opened } = start();
    const links = [
      { label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: '\u{ea64}', mentioned: false },
      { label: 'Notes', url: 'https://example.test/a?b=1#top', kind: 'url' as const, badge: 'Notes', glyph: null, mentioned: false },
    ];

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other', url: 'https://github.com/o/r/issues/2', links })])] });
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    expect(root.querySelectorAll('#list .pill[data-action]')).toHaveLength(0);
    // A pane that stops, or turns off, leaves the links to the pills until it runs again.
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: 'Gone.' } });
    expect(root.querySelectorAll('#list [data-work-item="2"] .pill[data-action="open-link"]')).toHaveLength(3);
    source.emit('pane', { pane: { enabled: false, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    expect(root.querySelectorAll('#list [data-work-item="2"] .pill[data-action="open-link"]')).toHaveLength(3);
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    expect(root.querySelectorAll('#list .pill[data-action]')).toHaveLength(0);
    expect(root.querySelector('#list [data-work-item="2"] .pill.link.pr')!.getAttribute('title')).toBe('PR #5\nhttps://github.com/o/r/pull/5');
    expect(root.querySelector('#list [data-work-item="2"] .pill.ticket')!.getAttribute('title')).toContain('https://github.com/o/r/issues/2');
    posts = [];
    click('#list [data-work-item="2"] .pill.link.pr');
    await flush();
    expect(opened).toEqual([]);
    expect(posts.find((post) => post.url.endsWith('/select'))?.body).toMatchObject({ workItemId: 2 });
    page.close();
  });

  it('says it is the installed app as it opens its stream, and shows the work item a dock click sends with its marker in the title for a while', async () => {
    vi.useFakeTimers();
    installed = true;

    const { page, source } = start();

    expect(source.url).toBe('/v1/conversation/events?page=1&installed=1');
    hello(source);
    source.emit('show', { workItemId: 2, marker: '0123456789ab' });
    expect(location.hash).toBe('#w=2');
    expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body).toMatchObject({ workItemId: 2 });
    expect(document.title).toMatch(/ \[sb-show 0123456789ab\]$/);
    vi.advanceTimersByTime(SHOW_MARKER_MS);
    expect(document.title).not.toContain('sb-show');
    page.close();

    installed = false;
    expect(start().source.url).toBe('/v1/conversation/events?page=1');
  });

  it('raises a needs-you alert the hub sends as a silent notification per work item whose click shows it, with the chime only when asked', async () => {
    const notices: FakeNotice[] = [];
    const asked = vi.fn(async () => 'granted');

    class FakeNotice {
      static permission = 'default';
      static requestPermission = asked;
      onclick: (() => void) | null = null;
      closed = false;

      constructor(
        readonly title: string,
        readonly options: NotificationOptions,
      ) {
        notices.push(this);
      }

      close(): void {
        this.closed = true;
      }
    }

    vi.stubGlobal('Notification', FakeNotice);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { page, source } = start();

    hello(source);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body).toMatchObject({ notify: false });
    // Asked once, on the first press in the page; the answer tells the hub the page may now alert.
    asked.mockImplementation(async () => ((FakeNotice.permission = 'granted'), 'granted'));
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('pointerdown'));
    expect(asked).toHaveBeenCalledTimes(1);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body).toMatchObject({ notify: true });
    FakeNotice.permission = 'denied';
    // Not allowed yet: no notification, but the message shows under the list header as the dock's toast.
    source.emit('needs', { items: [{ workItemId: 2, message: 'Switchboard: Side — Review, then approve' }], sound: false });
    expect(notices).toEqual([]);
    expect(root.querySelector('.needs-toast .needs-message')?.textContent).toBe('Switchboard: Side — Review, then approve');

    FakeNotice.permission = 'granted';
    source.emit('needs', { items: [{ workItemId: 2, message: 'Switchboard: Side — Review, then approve' }], sound: false });
    expect(notices.map((one) => [one.title, one.options])).toEqual([['Switchboard', { body: 'Side — Review, then approve', tag: 'switchboard-needs-2', silent: true }]]);
    notices[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(notices[0]!.closed).toBe(true);
    expect(location.hash).toBe('#w=2');

    const oscillators = vi.fn();

    vi.stubGlobal(
      'AudioContext',
      class {
        currentTime = 0;
        destination = {};
        createOscillator = () => {
          const one = { frequency: { value: 0 }, connect: (next: unknown) => next, start: () => {}, stop: () => oscillators(one.frequency.value) };

          return one;
        };
        createGain = () => ({ gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: (next: unknown) => next });
        close = async () => {};
      },
    );
    source.emit('needs', { items: [{ workItemId: 1, message: 'Switchboard: Fix it — Answer a question' }], sound: false });
    expect(oscillators).not.toHaveBeenCalled();
    source.emit('needs', { items: [{ workItemId: 1, message: 'Switchboard: Fix it — Answer a question' }], sound: true });
    expect(oscillators.mock.calls).toEqual([[880], [1320]]);
    page.close();
    vi.unstubAllGlobals();
  });

  it('asks the hub to open a link in the default browser when installed as an app, and shows its refusal', async () => {
    const { page, source, opened } = start();
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }, { label: 'Bad', url: 'file:///C:/x', kind: 'url' as const, badge: 'Bad', glyph: null, mentioned: false }];

    installed = true;
    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    expect(opened).toEqual([]);
    expect(posts.map((post) => post.url)).toEqual(['/v1/conversation/row-open']);
    // The hub gets the row's own URL, unmarked, and checks it against the row itself.
    expect(posts[0]!.body).toMatchObject({ window: 'pk', workItemId: 1, url: 'https://github.com/o/r/pull/5' });

    answers['/row-open'] = { status: 409, body: { error: 'The work item no longer links to this.' } };
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    await flush();
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('The work item no longer links to this.');
    page.close();
  });

  it("opens a link in the device's own browser from an installed page on another device, which the hub would open on the computer", async () => {
    const opened: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => true, local: false });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];

    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    // The computer's pane is paired, which a page on another device leaves aside: its pills open their links.
    FakeSource.last!.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(posts.map((post) => post.url)).not.toContain('/v1/conversation/row-open');
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    page.close();

    // Left to the browser, the link opens in a new tab without an opener or referrer.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const own = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, local: false });

    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/5', '_blank', 'noopener,noreferrer');
    own.close();
  });

  it("lists Open ticket and each link in the actions menu, more than two in an Open link submenu, a long label cut with its whole text in the tooltip", async () => {
    const { page, source, opened } = start();
    const link = (label: string, url: string) => ({ label, url, kind: 'url' as const, badge: label, glyph: null, mentioned: false });
    const long = 'A link label that a session reported which runs far past the limit';

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1', links: [link('PR #5', 'https://github.com/o/r/pull/5'), link(long, 'https://example.test/long')] })])] });
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open ticket', 'Open PR #5', `Open ${long.slice(0, 42).trimEnd()}…`]);
    expect(root.querySelector('.actions-menu [data-link="1"]')!.getAttribute('title')).toBe(`Open ${long}`);
    click('.actions-menu [data-link="ticket"]');
    expect(opened).toEqual(['https://github.com/o/r/issues/1']);
    expect(root.querySelector('.actions-menu')).toBeNull();

    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links: [link('One', 'https://example.test/1'), link('Two', 'https://example.test/2'), link('Three', 'https://example.test/3')] })])] });
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open link']);
    click('.actions-menu [data-action="link-menu"]');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open link', 'One', 'Two', 'Three']);
    expect(root.querySelector('.actions-menu [data-action="link-menu"]')!.getAttribute('aria-expanded')).toBe('true');
    click('.actions-menu [data-link="2"]');
    expect(opened.at(-1)).toBe('https://example.test/3');
    // The submenu starts closed the next time the menu opens.
    click('button.actions');
    expect(root.querySelectorAll('.actions-menu .submenu-row')).toHaveLength(0);
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

  it('hides the Chrome pane at once while a menu, the composer list or a sheet is open, and shows it again only once they have stayed closed a moment', async () => {
    vi.useFakeTimers();
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    const page = startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    const source = FakeSource.last!;
    const rects = () => posts.filter((post) => post.url.endsWith('/pane-rect')).map((post) => post.body['rect']);
    const turn = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    hello(source, { openOn: 'browser', groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: true, error: null } });
    expect(rects().at(-1)).toMatchObject({ width: 600 });

    // The actions menu opens: hidden at once. It closes: still hidden, until the delay has passed with none open.
    click('button.actions');
    expect(rects().at(-1)).toBeNull();
    const hidden = rects().length - 1;

    click('button.actions');
    await turn();
    expect(rects().at(-1)).toBeNull();
    vi.advanceTimersByTime(PANE_SHOW_DELAY_MS - 10);
    // Opened again within the delay: it stays hidden, and nothing shows it in between.
    click('button.actions');
    click('button.actions');
    await turn();
    vi.advanceTimersByTime(PANE_SHOW_DELAY_MS - 10);
    expect(rects().at(-1)).toBeNull();
    expect(rects().slice(hidden).every((rect) => rect === null)).toBe(true);
    vi.advanceTimersByTime(20);
    expect(rects().at(-1)).toMatchObject({ width: 600 });

    // The composer's list opens without a redraw: the page sees it all the same.
    const list = root.querySelector<HTMLElement>('.composer-menu')!;

    list.hidden = false;
    await turn();
    expect(rects().at(-1)).toBeNull();
    list.hidden = true;
    await turn();
    vi.advanceTimersByTime(PANE_SHOW_DELAY_MS);
    expect(rects().at(-1)).toMatchObject({ width: 600 });
    page.close();
  });

  it('says on the Browser tab that the Chrome pane is hidden while a menu or the composer list is open, and no longer once they close', async () => {
    vi.useFakeTimers();
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    const page = startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    const source = FakeSource.last!;
    const note = () => root.querySelector('#detail .detail-body')!.textContent!.trim();
    const turn = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const pane = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null };

    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    hello(source, { openOn: 'browser', groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    source.emit('pane', { pane });
    expect(note()).toBe('Opening the work item’s links…');

    // The actions menu opens and the hub hides the pane: the tab says why, not that it is opening.
    click('button.actions');
    source.emit('pane', { pane });
    await turn();
    expect(note()).toBe('The browser is hidden while a menu or dialog is open.');
    click('button.actions');
    await turn();
    vi.advanceTimersByTime(PANE_SHOW_DELAY_MS);
    await turn();
    expect(note()).toBe('Opening the work item’s links…');

    // The composer's list opens without a redraw: the tab says so all the same.
    const list = root.querySelector<HTMLElement>('.composer-menu')!;

    list.hidden = false;
    await turn();
    await turn();
    expect(note()).toBe('The browser is hidden while a menu or dialog is open.');
    list.hidden = true;
    await turn();
    vi.advanceTimersByTime(PANE_SHOW_DELAY_MS);
    await turn();
    expect(note()).toBe('Opening the work item’s links…');
    // Shown: no note. A menu opening says why at once, before the hub reports the pane hidden.
    source.emit('pane', { pane: { ...pane, shown: true } });
    expect(note()).toBe('');
    click('button.actions');
    await turn();
    expect(note()).toBe('The browser is hidden while a menu or dialog is open.');
    page.close();
  });

  it('shows the Browser tab only for a work item with links and the Console tab only for an active held session, falling back to Status', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const page = startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    const source = FakeSource.last!;
    const tabs = () => [...root.querySelectorAll<HTMLElement>('#detail .side-switch [data-side]')].map((tab) => tab.dataset['side']);
    const chosen = () => root.querySelector<HTMLElement>('#detail .side-switch .tab.selected')?.dataset['side'];
    const paired = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null };
    const linked = [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])];
    const unlinked = [listGroup('progress', [listRow(1, { title: 'Fix it', url: '', links: [] })])];

    hello(source, { groups: linked });
    source.emit('pane', { pane: paired });
    expect(tabs()).toEqual(['status', 'console', 'browser']);

    // Browser chosen, then the links go: no Browser tab, Status shown; the choice of Browser stays for the next work item with links.
    click('#detail [data-side="browser"]');
    source.emit('list', { groups: unlinked });
    expect(tabs()).toEqual(['status', 'console']);
    expect(chosen()).toBe('status');
    source.emit('list', { groups: linked });
    expect(chosen()).toBe('browser');

    // Console chosen, then the session ends: no Console tab, Status shown.
    click('#detail [data-side="console"]');
    source.emit('session', { session: session({ state: 'ended', conversation: 'read-only' }) });
    expect(tabs()).toEqual(['status', 'browser']);
    expect(chosen()).toBe('status');
    // A session the terminal holder does not hold has none either.
    source.emit('session', { session: session({ state: 'running', conversation: 'none' }) });
    expect(tabs()).toEqual(['status', 'browser']);
    source.emit('session', { session: session({ state: 'running' }) });
    expect(tabs()).toEqual(['status', 'console', 'browser']);
    page.close();
  });

  it('opens each work item on Browser when it has no session and links the paired pane can show, else on Status, keeping a choice only within the work item', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const page = startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    const source = FakeSource.last!;
    const chosen = () => root.querySelector<HTMLElement>('#detail .side-switch .tab.selected')?.dataset['side'];
    const paired = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null };
    const linked = (workItemId: number) => [listGroup('progress', [listRow(workItemId, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])];
    const unlinked = (workItemId: number) => [listGroup('progress', [listRow(workItemId, { title: 'Fix it', url: '', links: [] })])];

    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    // An unstarted work item with a link: Browser, once the pane's state is known, and its area is reported.
    hello(source, { sessions: [], groups: linked(1) });
    expect(chosen()).toBe('status');
    source.emit('pane', { pane: paired });
    expect(chosen()).toBe('browser');
    expect(posts.filter((post) => post.url.endsWith('/pane-rect')).at(-1)?.body['rect']).not.toBeNull();
    // Without a session it has no Console tab. A tab chosen there stays while the work item is open.
    expect(root.querySelector('#detail [data-side="console"]')).toBeNull();
    click('#detail [data-side="status"]');
    source.emit('pane', { pane: { ...paired, shown: true } });
    expect(chosen()).toBe('status');

    // Another work item: one with a session opens on Status, whatever was chosen before.
    hello(source, { groups: linked(2), scope: { ...scope, workItemId: 2 } });
    expect(chosen()).toBe('status');
    // One without a session but no link to show opens on Status too.
    hello(source, { sessions: [], groups: unlinked(3), scope: { ...scope, workItemId: 3 } });
    expect(chosen()).toBe('status');
    // Not paired: Status.
    source.emit('pane', { pane: { ...paired, extension: 'unpaired' } });
    hello(source, { sessions: [], groups: linked(4), scope: { ...scope, workItemId: 4 } });
    expect(chosen()).toBe('status');

    // Narrower: Browser among the conversation's tabs, else the conversation.
    resizeTo(900);
    source.emit('pane', { pane: paired });
    hello(source, { sessions: [], groups: linked(5), scope: { ...scope, workItemId: 5 } });
    expect(root.querySelector<HTMLElement>('#head .tab.selected')!.dataset['tab']).toBe('browser');
    hello(source, { groups: linked(6), scope: { ...scope, workItemId: 6 } });
    expect(root.querySelector<HTMLElement>('#head .tab.selected')!.dataset['tab']).toBe('conversation');

    // A tab the hub kept for a work item comes back when it opens, while it still applies; otherwise the same rule as a first opening.
    resizeTo(1920);
    hello(source, { groups: linked(7), scope: { ...scope, workItemId: 7 }, tabs: { tab: 'console', closed: [] } });
    expect(chosen()).toBe('console');
    hello(source, { groups: linked(8), scope: { ...scope, workItemId: 8 }, tabs: { tab: 'artifact:chat/p.html', closed: [] } });
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-path')).toBe('chat/p.html');
    // Status or Browser is one choice for every work item, kept in the hub: Browser chosen once opens every work item with links on Browser.
    click('#detail [data-side="browser"]');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-1)?.body).toMatchObject({ workItemId: 8, tab: null, openOn: 'browser' });
    hello(source, { groups: linked(9), scope: { ...scope, workItemId: 9 }, openOn: 'browser' });
    expect(chosen()).toBe('browser');
    // Without links it opens on Status, and the choice stays Browser.
    hello(source, { groups: unlinked(11), scope: { ...scope, workItemId: 11 }, openOn: 'browser' });
    expect(chosen()).toBe('status');
    hello(source, { groups: linked(13), scope: { ...scope, workItemId: 13 }, openOn: 'browser' });
    expect(chosen()).toBe('browser');
    // Status chosen: every work item opens on Status, an unstarted one with links too.
    click('#detail [data-side="status"]');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-1)?.body).toMatchObject({ workItemId: 13, tab: null, openOn: 'status' });
    hello(source, { sessions: [], groups: linked(14), scope: { ...scope, workItemId: 14 }, openOn: 'status' });
    expect(chosen()).toBe('status');
    // A work item with no status report yet, or only its stage, opens on Browser when it has links, whatever was chosen; without links on Status.
    hello(source, { groups: linked(15), scope: { ...scope, workItemId: 15 }, openOn: 'status', status: null });
    expect(chosen()).toBe('browser');
    hello(source, { groups: linked(16), scope: { ...scope, workItemId: 16 }, openOn: 'status', status: { id: 'stage-16', sessionId: 's', at: 5_000, markdown: 'Planning', fallback: true, unread: false } });
    expect(chosen()).toBe('browser');
    hello(source, { groups: unlinked(17), scope: { ...scope, workItemId: 17 }, openOn: 'status', status: null });
    expect(chosen()).toBe('status');
    // Narrower: Browser among the conversation's tabs.
    resizeTo(900);
    hello(source, { groups: linked(18), scope: { ...scope, workItemId: 18 }, openOn: 'status', status: null });
    expect(root.querySelector<HTMLElement>('#head .tab.selected')!.dataset['tab']).toBe('browser');
    resizeTo(1920);
    // The hub sends scope before hello: the work item opens on its hello's kept tab.
    source.emit('scope', { scope: { ...scope, workItemId: 12 } });
    hello(source, { groups: linked(12), scope: { ...scope, workItemId: 12 }, tabs: { tab: 'console', closed: [] } });
    expect(chosen()).toBe('console');
    hello(source, { groups: linked(10), scope: { ...scope, workItemId: 10 }, tabs: { tab: 'artifact:chat/p.html', closed: [{ path: 'chat/p.html', updatedAt: 99_999 }] } });
    expect(chosen()).toBe('status');
    // The operator's choice is kept for the work item in the hub.
    click('#detail [data-side="console"]');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-1)?.body).toMatchObject({ workItemId: 10, tab: 'console' });
    page.close();
  });

  it('keeps the pane in step with the tab shown: sends its state again on a tab change, focus and visibility, hides it as the page goes, and shows it after a reload only on Browser', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const inits: Array<{ url: string; keepalive: boolean | undefined }> = [];
    const fetch = (async (url: string, init?: { body?: string; keepalive?: boolean }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      inits.push({ url, keepalive: init?.keepalive });
      return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof globalThis.fetch;
    const open = () => startPage(root, { fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    const paired = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: true, error: null };
    const rects = () => posts.filter((post) => post.url.endsWith('/pane-rect')).map((post) => post.body['rect']);
    let page = open();
    let source = FakeSource.last!;

    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    hello(source, { openOn: 'browser', groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    source.emit('pane', { pane: paired });
    expect(rects().at(-1)).toMatchObject({ left: 1300, width: 600 });

    // Status: null, and again on choosing Status once more, although nothing changed.
    click('#detail [data-side="status"]');
    expect(rects().at(-1)).toBeNull();
    const sent = rects().length;

    click('#detail [data-side="status"]');
    expect(rects()).toHaveLength(sent + 1);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rects()).toHaveLength(sent + 3);
    expect(rects().slice(sent)).toEqual([null, null, null]);

    // Browser again, then the page goes: null, sent to outlive the page.
    click('#detail [data-side="browser"]');
    expect(rects().at(-1)).toMatchObject({ width: 600 });
    window.dispatchEvent(new Event('pagehide'));
    expect(rects().at(-1)).toBeNull();
    expect(inits.filter((init) => init.url.endsWith('/pane-rect')).at(-1)!.keepalive).toBe(true);
    // Back from the back/forward cache, it sends its column again; each report carries a later number than the one before.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(rects().at(-1)).toMatchObject({ width: 600 });
    const seqs = posts.filter((post) => post.url.endsWith('/pane-rect')).map((post) => post.body['seq'] as number);
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
    page.close();

    // After the reload, the kept choice, Browser, shows again with the pane over it.
    page = open();
    source = FakeSource.last!;
    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    hello(source, { openOn: 'browser', groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    source.emit('pane', { pane: paired });
    expect(root.querySelector<HTMLElement>('#detail .side-switch .tab.selected')!.dataset['side']).toBe('browser');
    expect(rects().at(-1)).toMatchObject({ width: 600 });
    page.close();

    // A page on another device cannot drive the pane, so it has no Browser tab.
    page = startPage(root, { fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => true, local: false, toExtension: async () => ({ ok: true }) });
    source = FakeSource.last!;
    hello(source, { openOn: 'browser', groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    source.emit('pane', { pane: paired });
    expect(root.querySelector('#detail [data-side="browser"]')).toBeNull();
    expect(root.querySelector<HTMLElement>('#detail .side-switch .tab.selected')!.dataset['side']).toBe('status');
    // Nor does its view options menu speak of the computer's pane, and its title carries no marker.
    click('[data-action="view-menu"]');
    expect(root.querySelector('.view-options-menu .pane-note')).toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="pane-pair"]')).toBeNull();
    source.emit('pane', { pane: { ...paired, marker: '0123456789ab', extension: 'unpaired' } });
    expect(root.querySelector('.view-options-menu .pane-note')).toBeNull();
    expect(document.title).not.toContain('[sb-pane');
    click('[data-action="view-menu"]');
    const remote = rects().length;

    window.dispatchEvent(new Event('focus'));
    expect(rects()).toHaveLength(remote);
    page.close();
    posts.length = 0;
  });

  it('says in the Browser tab why the Chrome pane does not cover it, and nothing while it does', () => {
    const pane = { enabled: true, extension: 'paired' as const, marker: null, shown: false, error: null };

    expect(browserNote({ ...pane, shown: true }, 600, true)).toBeNull();
    expect(browserNote(null, 600, true)).toBeNull();
    expect(browserNote({ ...pane, enabled: false }, 600, true)).toBeNull();
    expect(browserNote({ ...pane, error: 'Gone.' }, 600, true)).toBe('The browser stopped: Gone.');
    expect(browserNote({ ...pane, extension: 'none' }, 600, true)).toContain('not connected');
    expect(browserNote({ ...pane, extension: 'unpaired' }, 600, true)).toContain('Pair the Chrome extension');
    expect(browserNote(pane, 600, false)).toBe('This work item has no web links to show.');
    expect(browserNote(pane, BROWSER_MIN_WIDTH - 1, true)).toBe('Widen this area to at least 515 pixels to show the browser here.');
    expect(browserNote(pane, BROWSER_MIN_WIDTH, true)).toBe('Opening the work item’s links…');
    // Hidden for a menu or dialog: says so, unless something else keeps it from showing anyway.
    expect(browserNote(pane, BROWSER_MIN_WIDTH, true, true)).toBe('The browser is hidden while a menu or dialog is open.');
    // Before the hub reports the pane hidden, too.
    expect(browserNote({ ...pane, shown: true }, BROWSER_MIN_WIDTH, true, true)).toBe('The browser is hidden while a menu or dialog is open.');
    expect(browserNote({ ...pane, extension: 'unpaired' }, BROWSER_MIN_WIDTH, true, true)).toContain('Pair the Chrome extension');
    expect(browserNote(pane, BROWSER_MIN_WIDTH, false, true)).toBe('This work item has no web links to show.');
    expect(browserNote(pane, BROWSER_MIN_WIDTH - 1, true, true)).toContain('Widen this area');
    // The view options menu names the browser pane and the extension it is paired with.
    expect(paneStatus(null)).toBeNull();
    expect(paneStatus({ ...pane, enabled: false })).toBeNull();
    expect(paneStatus(pane)).toBe('Browser pane: paired with the Chrome extension.');
    expect(paneStatus({ ...pane, shown: true })).toBe('Browser pane: showing, paired with the Chrome extension.');
    expect(paneStatus({ ...pane, extension: 'unpaired' })).toBe('Browser pane: the Chrome extension is not paired.');
    // Only links the hub opens tabs for count.
    expect(paneLink('https://github.com/o/r/issues/1')).toBe(true);
    expect(paneLink('https://%')).toBe(false);
    expect(paneLink('file:///C:/x')).toBe(false);
    expect(paneLink(`https://a.test/${'x'.repeat(2048)}`)).toBe(false);
  });

  it('adds a Browser tab for the Chrome pane, reports its area under the tab strip only while it is chosen, marks the title, and wakes and pairs the extension (PRD R113)', async () => {
    window.innerWidth = 1920;

    const sent: Array<[string, Record<string, unknown>]> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const body = url.endsWith('/pane-pair') ? { token: 'tok', extensionId: 'ext' } : {};

      return { status: 200, ok: true, json: async () => body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource,
      now: () => 10_000,
      standalone: () => true,
      toExtension: async (id, message) => (sent.push([id, message]), { ok: true }),
    });
    const source = FakeSource.last!;
    const rects = () => posts.filter((post) => post.url.endsWith('/pane-rect')).map((post) => post.body['rect']);

    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1300, top: 85, width: 600, height: 855 } as DOMRect);
    vi.spyOn(root.querySelector('#panel')!, 'getBoundingClientRect').mockReturnValue({ left: 300, top: 120, width: 700, height: 700 } as DOMRect);
    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' })])] });
    await flush();
    // Off: no Browser tab and nothing reported.
    expect(root.querySelector('[data-side="browser"]')).toBeNull();
    expect(rects()).toEqual([]);

    source.emit('pane', { pane: { enabled: true, extension: 'none', extensionId: 'ext', marker: '0123456789ab', shown: false, error: null } });
    await flush();
    expect(sent).toEqual([['ext', { type: 'wake' }]]);
    expect(document.title).toMatch(/ \[sb-pane 0123456789ab\]$/);
    expect([...root.querySelectorAll<HTMLElement>('#detail [data-side]')].map((tab) => tab.dataset['side'])).toEqual(['status', 'console', 'browser']);
    // Status is shown, so the pane has no area yet: the page reports none.
    expect(rects()).toEqual([null]);
    expect(root.querySelector('#detail .status-tab')).not.toBeNull();

    click('#detail [data-side="browser"]');
    expect(rects().at(-1)).toMatchObject({ left: 1300, top: 85, width: 600, height: 855, dpr: expect.any(Number) });
    expect(root.querySelector('#detail .detail-body')!.textContent).toContain('The Switchboard Chrome extension is not connected.');

    click('[data-action="view-menu"]');
    expect(root.querySelector('.view-options-menu .pane-note')!.textContent).toBe('Browser pane: the Switchboard Chrome extension is not connected.');
    click('[data-action="pane-pair"]');
    await flush();
    await flush();
    expect(sent.at(-1)).toEqual(['ext', { type: 'pair', token: 'tok' }]);
    expect(root.querySelector('.view-options-menu [role="status"]')!.textContent).toBe('Sent to the Chrome extension.');

    // Shown: the tab strip stays, the area under it is empty for the pane window, and Status, Artifacts and Console stay in the column.
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: true, error: null } });
    await flush();
    expect(document.title).not.toContain('sb-pane');
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#head .tabs')).toBeNull();
    expect(root.querySelector('#detail .side-switch [aria-selected="true"]')!.textContent).toBe('Browser');
    expect(root.querySelector('[data-action="pane-pair"]')).toBeNull();
    // The view options menu is still open, so the pane stays hidden, and the area says so, until a moment after it closes.
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    expect(root.querySelector('#detail .detail-body')!.textContent).toBe('The browser is hidden while a menu or dialog is open.');
    click('[data-action="view-menu"]');
    await new Promise((resolve) => setTimeout(resolve, PANE_SHOW_DELAY_MS + 20));
    expect(root.querySelector('#detail .detail-body')!.textContent).toBe('');

    // Another tab hides the pane; Browser again shows it.
    click('#detail [data-side="status"]');
    expect(rects().at(-1)).toBeNull();
    expect(root.querySelector('#detail .status-tab')).not.toBeNull();
    click('#detail [data-side="browser"]');
    expect(rects().at(-1)).toMatchObject({ left: 1300, width: 600 });

    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: 'The pane would not fit the column.' } });
    expect(root.querySelector('#detail .detail-body')!.textContent).toBe('The browser stopped: The pane would not fit the column.');
    click('[data-action="view-menu"]');
    expect(root.querySelector('.view-options-menu .pane-note')!.textContent).toBe('Browser pane stopped: The pane would not fit the column.');
    click('[data-action="view-menu"]');
    await new Promise((resolve) => setTimeout(resolve, PANE_SHOW_DELAY_MS + 20));

    // Narrow: the tabs are the conversation's, Browser among them and still chosen, and its area is the conversation's pane.
    resizeTo(900);
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    expect([...root.querySelectorAll<HTMLElement>('#head [data-tab]')].map((tab) => tab.dataset['tab'])).toEqual(['conversation', 'status', 'console', 'browser']);
    expect(root.querySelector('#head [aria-selected="true"]')!.textContent).toBe('Browser');
    expect(rects().at(-1)).toMatchObject({ left: 300, top: 120, width: 700, height: 700 });
    click('#head [data-tab="status"]');
    expect(rects().at(-1)).toBeNull();
    // Status chosen while narrow is the column's choice when wide again.
    resizeTo(1920);
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    expect(root.querySelector<HTMLElement>('#detail .side-switch [aria-selected="true"]')!.dataset['side']).toBe('status');
    expect(rects().at(-1)).toBeNull();
    click('#detail [data-side="browser"]');
    expect(rects().at(-1)).toMatchObject({ left: 1300, width: 600 });
    // A list header's sheet covers the page too: the area goes while it shows and comes back when it closes.
    click('.more-actions');
    click('[data-action="list-later-log"]');
    await flush();
    expect(root.querySelector('#list-sheet .sheet-backdrop')).not.toBeNull();
    expect(rects().at(-1)).toBeNull();
    click('#list-sheet .sheet-button');
    await flush();
    expect(root.querySelector('#list-sheet .sheet-backdrop')).toBeNull();
    // Shown again a moment after the last layer closed.
    expect(rects().at(-1)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, PANE_SHOW_DELAY_MS + 20));
    expect(rects().at(-1)).toMatchObject({ left: 1300, width: 600 });
    // Settings covers the page, and the pane window would stay above it: the area goes while Settings shows.
    click('.more-actions');
    click('[data-action="list-settings"]');
    await flush();
    expect(rects().at(-1)).toBeNull();
    resizeTo(900);
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });

    // Turned off: the Browser tab goes, and the conversation shows in its place.
    source.emit('pane', { pane: { enabled: false, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    await flush();
    expect(rects().at(-1)).toBeNull();
    expect(root.querySelector('#head [data-tab="browser"]')).toBeNull();
    expect(root.querySelector('#head [aria-selected="true"]')!.textContent).toBe('Conversation');
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    vi.unstubAllGlobals();
    page.close();
  });

  it('hides the list in a drawer at tablet widths while a work item is open, shown by its button or a resting pointer and hidden as the dock auto-hides', () => {
    vi.useFakeTimers();
    window.innerWidth = 1024;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const isOpen = () => root.classList.contains('drawer-open');
    const toggle = () => root.querySelector<HTMLElement>('.header > .list-toggle')!;
    const sliver = root.querySelector<HTMLElement>('.sliver')!;
    const side = root.querySelector<HTMLElement>('.side')!;

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', stripe: 'turn' }), listRow(2, { title: 'Two' }), listRow(3, { title: 'Three', stripe: 'warning' })])] });
    expect(root.classList.contains('listing')).toBe(false);
    expect(isOpen()).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    // Hidden, the sliver draws each striped row's stripe at its height, the selected row's the full height, cut to the list's view.
    vi.spyOn(root.querySelector('#list')!, 'getBoundingClientRect').mockReturnValue({ top: 40, bottom: 200 } as DOMRect);
    vi.spyOn(root.querySelector('[data-work-item="1"]')!, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 160 } as DOMRect);
    vi.spyOn(root.querySelector('[data-work-item="3"]')!, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 220 } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(50);
    expect([...sliver.children].map((bar) => [bar.className, (bar as HTMLElement).style.top, (bar as HTMLElement).style.height])).toEqual([
      ['stripe-turn', '100px', '60px'],
      ['stripe-warning', '168px', '32px'],
    ]);

    // The button shows it, with the focus on the open work item's row, and it stays while the pointer is elsewhere.
    toggle().click();
    expect(isOpen()).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    // Shown, it has no sliver.
    vi.advanceTimersByTime(50);
    expect(sliver.children).toHaveLength(0);
    // Escape hides it and gives the focus to the button.
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(toggle());

    // A press inside keeps it; one outside hides it; the button toggles it.
    toggle().click();
    side.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    root.querySelector('#panel')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(false);
    toggle().click();
    toggle().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    toggle().click();
    expect(isOpen()).toBe(false);

    // Choosing a work item hides it.
    toggle().click();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(isOpen()).toBe(false);

    // A pointer resting on the sliver for 0.5 s shows it; leaving sooner, or a touch, does not.
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS - 100);
    sliver.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(false);
    sliver.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'touch' }));
    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(false);
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS);
    expect(isOpen()).toBe(true);
    // Shown that way, it stays while the pointer is over it, and hides 0.4 s after the pointer leaves, unless the search box has the focus.
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    side.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(DRAWER_HIDE_MS - 100);
    expect(isOpen()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(isOpen()).toBe(false);

    const search = document.createElement('input');

    side.append(search);
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS);
    search.focus();
    side.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    search.blur();
    vi.advanceTimersByTime(DRAWER_HIDE_MS);
    expect(isOpen()).toBe(false);

    // Where the list is a column, or a phone's view, there is no drawer; narrowed to a phone, which hides the list, the focus goes to Back.
    toggle().click();
    expect(side.contains(document.activeElement)).toBe(true);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => ({ display: element === side ? 'none' : 'block' }) as CSSStyleDeclaration);
    resizeTo(700);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('.header > .back-toggle'));
    vi.mocked(window.getComputedStyle).mockRestore();
    toggle().click();
    expect(isOpen()).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    page.close();
  });

  it('puts Status and Artifacts in a column beside the conversation on a wide screen, with their own switch and no toggle, and keeps the tabs otherwise', async () => {
    window.innerWidth = 1920;

    const { page, source } = start();

    hello(source);
    expect(root.querySelector('#head .tabs')).toBeNull();
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    expect(root.querySelector('#detail .status-tab')).not.toBeNull();
    expect(root.querySelectorAll('#detail .artifact-tab')).toHaveLength(2);
    // An artifact row in the conversation opens in the column, and the conversation stays.
    click('#panel [data-action="artifact"][data-path="chat/p.html"]');
    expect(root.querySelector('#detail iframe')).not.toBeNull();
    expect(root.querySelector('#panel .timeline')).not.toBeNull();

    // Both side columns show whenever the width allows: no toggle, no shortcut, and no kept choice.
    localStorage.setItem('switchboard.layout', JSON.stringify({ list: false, detail: false }));
    expect(root.querySelector('[data-action="toggle-list"], [data-action="toggle-detail"], .layout-toggle')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true, cancelable: true }));
    expect(root.classList.contains('list-hidden')).toBe(false);
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#head .tabs')).toBeNull();

    resizeTo(900);
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    expect(root.querySelector('#detail .detail-body')!.innerHTML).toBe('');
    vi.unstubAllGlobals();
    page.close();
  });

  it('shows the list as a column only while it, the conversation and the column fit, and brings a column back only past its need', () => {
    window.innerWidth = 1440;

    const { page, source } = start();
    const columns = (): string => `${root.classList.contains('drawers') ? 'drawer' : 'list'} + ${root.classList.contains('wide') ? 'column' : 'tabs'}`;

    hello(source);
    // The list's default 340 px, the conversation's 640 and the column's 360 fit 1440 px.
    expect(columns()).toBe('list + column');
    // Under 1340 px they do not: the list leaves first, and the conversation and the column keep the room.
    resizeTo(1339);
    expect(columns()).toBe('drawer + column');
    // The list comes back only 40 px past its need, so a width at the edge does not flap; then it stays until it no longer fits.
    resizeTo(1360);
    expect(columns()).toBe('drawer + column');
    resizeTo(1380);
    expect(columns()).toBe('list + column');
    resizeTo(1340);
    expect(columns()).toBe('list + column');
    // Under 1000 px the column folds into the tabs, and comes back from 1040 px.
    resizeTo(999);
    expect(columns()).toBe('drawer + tabs');
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    resizeTo(1020);
    expect(columns()).toBe('drawer + tabs');
    resizeTo(1040);
    expect(columns()).toBe('drawer + column');
    expect(root.querySelector('#head .tabs')).toBeNull();
    // A phone has separate views, with neither.
    resizeTo(700);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    page.close();
  });

  it("counts the list's kept width, and stops its sash where the list would no longer fit", () => {
    localStorage.setItem('switchboard.sideWidth', '400');
    window.innerWidth = 1366;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.side-sash')!;

    hello(source);
    // 400 + 640 + 360 is more than 1366 px, which the default 340 px list would fit.
    expect(root.classList.contains('drawers')).toBe(true);
    resizeTo(1440);
    expect(root.classList.contains('drawers')).toBe(false);
    // End stops at 1440 - 640 - 360 px rather than SIDE_MAX, so the list stays a column.
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('440');
    expect(root.classList.contains('drawers')).toBe(false);
    // Reset to the default 340 px at 1300 px, a list kept at 200 px no longer fits: the list becomes a drawer at once, with its sliver drawn,
    // and the focus leaves the hidden sash for the Work items button.
    localStorage.setItem('switchboard.sideWidth', '200');
    page.close();
    history.replaceState(null, '', '#w=1');
    window.innerWidth = 1300;
    const again = start();

    hello(again.source);
    expect(root.classList.contains('drawers')).toBe(false);
    const reset = root.querySelector<HTMLElement>('.side-sash')!;

    reset.focus();
    reset.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('.header > .list-toggle'));
    again.page.close();
  });

  it("brings the list back as a column when the conversation is narrowed on its sash, and sends it to the drawer when widened again", () => {
    window.innerWidth = 1300;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.chat-sash')!;

    hello(source);
    // The default 340 px list, the conversation at 640 px and the column at 360 px do not fit 1300 px.
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.classList.contains('wide')).toBe(true);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(localStorage.getItem('switchboard.chatWidth')).toBe(String(CHAT_MIN));
    // 340 + 400 + 360 px fit.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(true);
    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    page.close();
  });

  it("hides the list in the drawer when its sash is dragged past the snap, saying so while dragged, and keeps that on the device", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.side-sash')!;

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(root.style.getPropertyValue('--side-width')) || 300 }) as DOMRect);
    expect(root.classList.contains('drawers')).toBe(false);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: SIDE_COLLAPSE - 1, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(true);
    expect(sash.dataset['snap']).toBe('Release to hide the work items');
    expect(root.classList.contains('snap')).toBe(true);
    // Back over the snap point, the note goes.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: SIDE_COLLAPSE + 1, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    expect(root.classList.contains('snap')).toBe(false);
    // The list is in the drawer though it fits, and keeps the width it had before the drag.
    expect(root.classList.contains('drawers')).toBe(true);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');
    expect(root.style.getPropertyValue('--side-width')).toBe('300px');
    expect(document.activeElement).toBe(root.querySelector('.header > .list-toggle'));
    page.close();

    // A reload keeps it; a wider page does too.
    window.innerWidth = 1920;
    const again = start();

    hello(again.source);
    expect(root.classList.contains('drawers')).toBe(true);
    // Status and Artifacts take the room the list left.
    expect(root.classList.contains('wide')).toBe(true);
    again.page.close();
  });

  it("hides the list from the keyboard with Left or Home at its least width", () => {
    localStorage.setItem('switchboard.sideWidth', String(SIDE_MIN + 16));
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.side-sash')!;

    hello(source);
    sash.focus();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    expect(root.classList.contains('drawers')).toBe(false);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    page.close();
  });

  it("pins the list back as a column when the open drawer's sash is dragged wider past the snap, only where it then fits", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    localStorage.setItem('switchboard.listCollapsed', '1');
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.drawer-sash')!;

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(root.style.getPropertyValue('--side-width')) || 300 }) as DOMRect);
    expect(root.classList.contains('drawers')).toBe(true);
    click('.header > .list-toggle');
    expect(root.classList.contains('drawer-open')).toBe(true);
    expect(sash.parentElement).toBe(side);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 + PIN_SNAP - 1, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    // The drawer widens as it is dragged, and keeps open while the pointer is outside it.
    expect(root.style.getPropertyValue('--side-width')).toBe(`${300 + PIN_SNAP - 1}px`);
    // 1440 - 640 - 360 leaves the list at most 440 px as a column; past that the release would not show it, so no snap.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 441, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 + PIN_SNAP, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(true);
    expect(sash.dataset['snap']).toBe('Release to keep the work items open');
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('drawer-open')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(300 + PIN_SNAP));
    expect(document.activeElement).toBe(root.querySelector('.side-sash'));
    page.close();
  });

  it("pins the drawer wherever the list then fits, without the slack a list that left by width needs", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    localStorage.setItem('switchboard.listCollapsed', '1');
    window.innerWidth = 1360;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.drawer-sash')!;

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(root.style.getPropertyValue('--side-width')) || 300 }) as DOMRect);
    click('.header > .list-toggle');
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    // 361 + 640 + 360 px is more than 1360; 348 + 640 + 360 px fits, though not with LAYOUT_SLACK more.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 361, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 + PIN_SNAP, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(true);
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    page.close();
  });

  it("keeps nothing from a drag the browser cancels, on either sash", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.side-sash')!;
    const drawerSash = root.querySelector<HTMLElement>('.drawer-sash')!;
    const width = () => root.style.getPropertyValue('--side-width');

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(width()) || 300 }) as DOMRect);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(true);
    sash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(sash.classList.contains('snapping')).toBe(false);
    expect(root.classList.contains('resizing')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    expect(width()).toBe('300px');
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 380, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(width()).toBe('300px');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');

    // The drawer's sash: a cancelled drag past the pin neither pins nor keeps its width.
    sash.focus();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    click('.header > .list-toggle');
    const kept = localStorage.getItem('switchboard.sideWidth');
    drawerSash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 200, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, bubbles: true }));
    expect(drawerSash.classList.contains('snapping')).toBe(true);
    drawerSash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(kept);
    page.close();
  });

  it("only resizes the open drawer on a release short of the pin, and pins it from the keyboard past the snap", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    localStorage.setItem('switchboard.listCollapsed', '1');
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.drawer-sash')!;

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(root.style.getPropertyValue('--side-width')) || 300 }) as DOMRect);
    click('.header > .list-toggle');
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 320, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('320');
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(root.classList.contains('drawer-open')).toBe(true);
    sash.focus();
    // The drawer opened at 300 px: Right to 336 and 352 px stays a drawer; past 348 px it pins.
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(true);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(root.classList.contains('drawers')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.side-sash'));
    page.close();
  });

  it('shows the drawer on a touch swiping right from the left edge, not on a mouse, a short or a mostly vertical swipe', () => {
    window.innerWidth = 1024;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const sliver = root.querySelector<HTMLElement>('.sliver')!;
    const isOpen = () => root.classList.contains('drawer-open');
    const pointer = (type: string, x: number, y: number, pointerType = 'touch') => sliver.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { pointerType, pointerId: 1, clientX: x, clientY: y, button: 0 }));

    hello(source);
    expect(root.classList.contains('drawers')).toBe(true);
    pointer('pointerdown', 2, 300, 'mouse');
    pointer('pointermove', 2 + SWIPE_OPEN + 10, 300, 'mouse');
    expect(isOpen()).toBe(false);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN - 1, 300);
    pointer('pointerup', 2 + SWIPE_OPEN - 1, 300);
    expect(isOpen()).toBe(false);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN, 300 + SWIPE_OPEN + 5);
    pointer('pointermove', 2 + SWIPE_OPEN + 20, 300 + SWIPE_OPEN + 5);
    expect(isOpen()).toBe(false);
    pointer('pointerup', 0, 0);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN, 310);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    page.close();
  });

  it('takes a list width kept elsewhere as it is', () => {
    localStorage.setItem('switchboard.sideWidth', '440');
    window.innerWidth = 1440;

    const { page, source } = start();

    hello(source);
    expect(root.classList.contains('drawers')).toBe(false);
    // A width kept elsewhere is taken as it is, and a narrower page then makes the list a drawer.
    resizeTo(1400);
    expect(root.style.getPropertyValue('--side-width')).toBe('440px');
    expect(root.classList.contains('drawers')).toBe(true);
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

  it("sets voice.expandReplies from View options' Expand spoken replies on this computer's page, follows the hub's settings, and leaves it out on a paired device", async () => {
    const { page, source } = start();
    const expandRow = () => root.querySelector('[data-action="toggle-expand-replies"]');

    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' })] });
    expect(root.querySelector('#panel')!.textContent).not.toContain('Whole reply.');
    click('.header button.view-options');
    expect(expandRow()!.getAttribute('aria-checked')).toBe('false');
    expect(expandRow()!.getAttribute('role')).toBe('menuitemcheckbox');
    click('[data-action="toggle-expand-replies"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/expand-replies')).map((post) => post.body)).toEqual([expect.objectContaining({ window: 'pk', on: true })]);
    // The checkbox and the replies follow settings.json as the hub reloads it, not the click.
    expect(expandRow()!.getAttribute('aria-checked')).toBe('false');
    source.emit('settings', { settings: { expandReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });
    expect(expandRow()!.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelector('#panel')!.textContent).toContain('Whole reply.');

    // A second click before the hub's settings event reverses the first; the saves go one at a time, so the last click's value is the one kept.
    let answer = () => {};
    const sent = () => posts.filter((post) => post.url.endsWith('/expand-replies')).map((post) => post.body['on']);

    answers['/expand-replies'] = { status: 200, body: {}, wait: new Promise<void>((done) => (answer = done)) };
    click('[data-action="toggle-expand-replies"]');
    click('[data-action="toggle-expand-replies"]');
    click('[data-action="toggle-expand-replies"]');
    click('[data-action="toggle-expand-replies"]');
    await flush();
    expect(sent()).toEqual([true, false]);
    delete answers['/expand-replies'];
    answer();
    await flush();
    await flush();
    expect(sent()).toEqual([true, false, true]);
    source.emit('settings', { settings: { expandReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });

    // A refusal shows why, and the setting stays as it was.
    answers['/expand-replies'] = { status: 409, body: { error: 'settings.json is not valid JSON: Unexpected token.' } };
    click('[data-action="toggle-expand-replies"]');
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/expand-replies')).at(-1)!.body).toMatchObject({ on: false });
    expect(root.querySelector('.composer-error-text')!.textContent).toBe('settings.json is not valid JSON: Unexpected token.');
    expect(expandRow()!.getAttribute('aria-checked')).toBe('true');
    page.close();

    // A paired device may not change settings.json (architecture.md § Remote access), so its menu has Show message details only.
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, local: false });

    hello(FakeSource.last!, { settings: { expandReplies: true } });
    click('.header button.view-options');
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim())).toEqual(['Show message details']);
    paired.close();
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

  it('shows a paired device\'s mic off while the voice is elsewhere, so its tap can take the voice to the phone (PRD R119)', () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, local: false });
    const source = FakeSource.last!;

    hello(source);
    source.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')?.getAttribute('data-on')).toBe('true');
    page.close();

    // This computer's page shows Talk here instead, as the Conversation view does.
    const local = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, local: true });

    hello(FakeSource.last!);
    FakeSource.last!.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')).toBeNull();
    local.close();
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

  it('shows the app\'s title in the list header only in the phone\'s layout, taking the room the icons leave', () => {
    expect(declarationsOf((selector) => selector === '.list-title')).toEqual(['display: none;']);
    expect(declarationsOf((selector) => selector === ':where(html.phone) .list-title')).toEqual([expect.stringMatching(/^display: flex; flex: 1;.*min-width: 0;/)]);
    expect(css).toContain(':where(html.phone) .list-header .header-sources, :where(html.phone) .list-header .header-separator { display: none; }');
    expect(css).toContain(':where(html:not(.phone)) .more-menu .more-source { display: none; }');
    expect(declarationsOf((selector) => selector === '.list-title-text')).toEqual([expect.stringContaining('text-overflow: ellipsis')]);
  });

  it('marks the selected row with only the selection colours, as the dock does, leaving the focus ring to a keyboard focus', () => {
    const selected = declarationsOf((selector) => selector === '.row.selected');

    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('background: var(--sb-row-selected)');
    // The dock's selection colours: the theme's in Dark Modern and its own #E4E6F1 in Light Modern (App.axaml DockSelected).
    expect(css).toMatch(/:root \{[^}]*--sb-row-selected: var\(--vscode-list-activeSelectionBackground\);/);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--sb-row-selected: #E4E6F1;/);
    expect(selected[0]).not.toMatch(/box-shadow|outline|border/);
    expect(declarationsOf((selector) => selector === 'button:focus-visible')).toEqual([expect.stringContaining('outline: 1px solid var(--vscode-focusBorder)')]);
    // The selected row keeps the dock's text colours: no foreground and no faded muted texts.
    expect(selected[0]).not.toMatch(/(^|[ ;])color:/);
    expect(css).not.toMatch(/\.row\.selected [^{]*\{[^}]*opacity/);
  });

  it("draws rows in the dock's sizes and colours (MainWindow.axaml, App.axaml)", () => {
    const one = (selector: string): string => {
      const found = declarationsOf((each) => each === selector);

      expect(found, selector).toHaveLength(1);

      return found[0]!;
    };

    // 18 px lines in 13 px text, the first row in a band without the rule's pixel.
    expect(one('.row-head')).toContain('height: 18px');
    expect(one('.row-line')).toContain('height: 18px');
    expect(one('.row-line')).not.toMatch(/font-size/);
    expect(one('.row-time')).not.toMatch(/font-size/);
    expect(one('.rows > li:first-child > .row')).toContain('border-top: none');
    // Pills 18 px tall with 14 px icons and 12 px text; a key's logo 12 px; GitHub's key in the dock's GitHub colour, not the foreground.
    expect(one('.row-line .pill')).toMatch(/height: 18px;.*font-size: 12px/);
    expect(one('.row-line .pill .codicon')).toBe('flex: none; font-size: 14px;');
    expect(one('.row-line .pill .source-logo')).toContain('width: 12px; height: 12px');
    expect(declarationsOf((each) => each === '.row-line .pill.ticket.source-github')).toEqual(['border-color: var(--sb-github); background: color-mix(in srgb, var(--sb-github) 18%, transparent);']);
    // Marks in the foreground, Failed in the dock's error colour; the muted texts in the dock's grey, #717171 in Light Modern.
    expect(one('.row-details .mark')).toBe('font-size: 14px;');
    expect(declarationsOf((each) => each === '.row-details .mark.failed')).toEqual(['color: var(--vscode-testing-iconFailed);']);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--sb-row-muted: #717171;/);
    expect(one('.row-time')).toContain('color: var(--sb-row-muted)');
  });

  it('hides Back and shows the work items\' sash outside the phone\'s layout alone, with no kept list toggle', () => {
    expect(css).not.toMatch(/layout-toggle|list-hidden/);
    // A selector that outranks button.icon's display; :where() adds nothing to it, as the media query it replaced did not.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) .header > .back-toggle')).toEqual(['display: none;']);
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) .side-sash')).toEqual(['display: block;']);
    expect(declarationsOf((selector) => selector === '.header > .back-toggle' || selector === '.side-sash')).toEqual([]);
  });

  it("switches the phone's layout by the document's phone class alone, which isPhone sets, never by a media query on the width", () => {
    for (const name of ['page.css', 'settings.css']) {
      const sheet = readFileSync(join(__dirname, '../src', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

      expect(sheet, name).not.toMatch(/@media[^{]*\b(7\d\d)px/);
      expect(sheet.replaceAll(':where(html.phone)', '').replaceAll(':where(html:not(.phone))', ''), name).not.toContain('.phone');
    }
    // The selectors the class gives are only these two, which add nothing to a rule's specificity.
    expect(new Set(css.match(/:where\([^)]*phone[^)]*\)\)?/g))).toEqual(new Set([':where(html.phone)', ':where(html:not(.phone))']));
  });

  it('gives the notes above the composer its edges, corners and an 8 px gap', () => {
    const composer = declarationsOf((selector) => selector === '#composer').join(' ');
    const note = declarationsOf((selector) => selector === '#note').join(' ');

    expect(note).toContain('max-width: var(--chat-width, 940px)');
    expect(composer).toContain('max-width: var(--chat-width, 940px)');
    expect(note).toContain('padding: 0 20px');
    expect(composer).toContain('padding: 0 20px 16px');
    expect(declarationsOf((selector) => selector === '.session-note').join(' ')).toMatch(/margin: 0 0 8px;.*border-radius: 8px;/);
    // The composer's own corners come from the composer.css the Conversation view shares.
    expect(readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/composer.css'), 'utf8')).toMatch(/\n\.composer \{[^}]*border-radius: 8px;/);
    expect(declarationsOf((selector) => selector === '.composer-error').join(' ')).toMatch(/margin: 0 0 8px;.*border-radius: 8px;/);
  });

  it("pins each group's header at the list's top on an opaque bar, with the gap inside the group so the next header pushes it up", () => {
    const head = declarationsOf((selector) => selector === '.group-head').join(' ');

    expect(head).toMatch(/position: sticky; top: 0; z-index: 2;/);
    expect(head).toContain('min-height: var(--group-head-height)');
    // Mixed with the list's background, never with transparent, so rows do not show through.
    for (const rule of [head, declarationsOf((selector) => selector === '.group-head:hover').join(' ')]) {
      expect(rule).toMatch(/background: color-mix\(in srgb, var\(--vscode-focusBorder\) \d+%, var\(--vscode-sideBar-background\)\)/);
    }
    // A margin outside the section would unpin the header 8 px before the next one arrives.
    expect(declarationsOf((selector) => selector === '.group')).toEqual([]);
    expect(declarationsOf((selector) => selector === '.group::after').join(' ')).toContain('height: 8px');
    // A row or menu scrolled into view lands below the pinned header, which is as tall as the variable says.
    expect(declarationsOf((selector) => selector === '.work-list .row')).toEqual(['scroll-margin-top: var(--group-head-height);']);
    expect(declarationsOf((selector) => selector === '.work-list').join(' ')).toContain('--group-head-height: 44px');
    const fine = css.split('@media (pointer: fine) {').slice(1).map((block) => block.slice(0, block.indexOf('\n}'))).join('\n');

    expect(fine).toContain(':where(html:not(.phone)) .work-list { --group-head-height: 32px; }');
  });

  it("keeps the pinned group headers the list's full width, the list a stacking context so iOS draws its scroll indicator over them", () => {
    expect(declarationsOf((selector) => selector === '#list').join(' ')).toMatch(/overflow-y: auto; isolation: isolate;/);
    expect(declarationsOf((selector) => selector === '.group-head').join(' ')).toContain('width: 100%;');
    expect(css).not.toMatch(/\.group-head \{[^}]*width: calc/);
    expect(css).not.toContain('--sb-overlay-scrollbar');
  });

  it("draws replies, our messages and the composer at the theme's text size, with no size of their own, and spoken bubbles at 110% from the shared bubbles.css", () => {
    expect(css).not.toContain('--chat-scale');
    // The bubble's 110% is of the reply's size, so the reply and the message around it keep the theme's.
    for (const parent of [".timeline",".timeline > li",".reply",".reply .body",".message",".message .bubble",".message .box"]) {
      expect(declarationsOf((selector) => selector === parent).join(' ')).not.toContain('font-size');
    }
    expect(declarationsOf((selector) => selector === '.composer textarea').join(' ')).toContain('font: inherit');
    expect(declarationsOf((selector) => selector === '.composer textarea').join(' ')).not.toContain('font-size');
    const bubbles = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/bubbles.css'), 'utf8');

    expect(bubbles).toMatch(/\n\.speech-bubble \{[^}]*font-size: 110%;/);
  });

  it("makes the list a drawer with its sliver and button outside the phone's layout where #root.drawers says it does not fit, while a work item is open, sliding in and hiding at once", () => {
    expect(declarationsOf((selector) => selector === '.header > .list-toggle')).toEqual(['display: none;']);
    // No fixed width decides it: a phone never gets the drawer, and outside the phone's layout only the class the layout sets does.
    expect(css).not.toMatch(/@media \(\d+px <= width < /);

    for (const rule of ['#root.drawers:not(.listing):not(.history) > .side-sash { display: none; }', '#root.drawers:not(.listing):not(.history):not(.drawer-open) > .sliver { display: block; }', '#root.drawers:not(.listing):not(.history) .header > .list-toggle { display: inline-flex; }']) {
      expect(css).toContain(`\n:where(html:not(.phone)) ${rule}`);
    }

    expect(css).not.toMatch(/(^|\n)#root\.drawers/);
    // Hidden, the list keeps its layout off the left edge, so its rows can be measured for the sliver.
    expect(css).toMatch(/:where\(html:not\(\.phone\)\) #root\.drawers:not\(\.listing\):not\(\.history\) > \.side \{[^}]*position: fixed;[^}]*visibility: hidden; transform: translateX\(-100%\);/);
    // Only the shown drawer has a transition, so it slides in and hides at once, as the dock does.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers:not(.listing):not(.history) > .side').join(' ')).not.toContain('transition');
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers.drawer-open:not(.listing):not(.history) > .side').join(' ')).toContain('transition: transform 0.15s ease-out');
    expect(declarationsOf((selector) => selector === '.sliver').join(' ')).toMatch(/position: fixed;.*left: env\(safe-area-inset-left\);.*width: 3px;/);
  });

  it('shows the composer and the note above it only on the Conversation tab under 800 px of height, unless the composer has the focus or an error', () => {
    // Kept while focused, for the on-screen keyboard, and while it shows an error, such as a refused header action from another tab.
    const rule = '#root.off-conversation:not(:has(#composer:focus-within, #composer .composer-error:not([hidden])))';

    // Every height under 800 px, a zoomed 799.5 px included, and no width condition.
    expect(css).toContain(`@media (height < 800px) {\n  ${rule} #note, ${rule} #composer { display: none; }\n}`);
    // Nothing else hides them by that class, so taller screens keep the composer on every tab; the class's one other use gives a phone's
    // other tabs' scrollers back the home indicator's inset at their end, which a shown composer takes away.
    expect(css.match(/off-conversation/g)).toHaveLength(3);
    expect(css).toContain(`${rule} > .main { --sb-end: env(safe-area-inset-bottom); }`);
  });

  it('puts Status and Artifacts beside the conversation only where #root.wide says they fit, never on a phone', () => {
    expect(css).toContain('\n:where(html:not(.phone)) #root.wide > .main {');
    expect(css).not.toMatch(/(^|\n)#root\.wide/);
  });

  it('caps the conversation on a wide screen and gives the Status and Artifacts column the rest of the width, with no cap of its own', () => {
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.wide > .main')).toEqual(['flex: 0 1 var(--chat-width, 940px);']);
    // With the column hidden the conversation keeps that width, centred.
    expect(declarationsOf((selector) => selector === '.timeline').join(' ')).toContain('max-width: calc(var(--chat-width, 940px) - 40px)');
    expect(declarationsOf((selector) => selector === '#composer').join(' ')).toContain('max-width: var(--chat-width, 940px)');
    const unprefixed = (selector: string): string => selector.replace(':where(html:not(.phone)) ', '');
    const detail = declarationsOf((selector) => unprefixed(selector).startsWith('#root.wide > .detail') || unprefixed(selector) === '.detail' || unprefixed(selector).startsWith('.detail .'));

    expect(detail.join(' ')).toContain(`flex: 1 1 ${DETAIL_MIN}px`);
    expect(detail.join(' ')).toContain(`min-width: ${DETAIL_MIN}px`);
    expect(detail.join(' ')).not.toMatch(/(?<![-\w])width:|clamp\(|max-width: (?!none)/);
    expect(declarationsOf((selector) => ['.detail .status-tab', '.detail .artifact-list', '.detail .artifact-doc'].includes(unprefixed(selector)))).toEqual(['max-width: none;']);
  });
});
