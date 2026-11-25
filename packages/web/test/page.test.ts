import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY, inTurn, mentionOf, mentionQuery, commandQuery, timeline, withEarlier } from '../src/model.js';
import { parseQuestions, resolveAnswers } from '@switchboard/conversation/questions';
import { artifactUrl, collapsedGroups, newView, renderMicButton, renderVoice, markdownBody } from '../src/render.js';
import { renderArtifactView, renderStatus } from '../src/side.js';
import { backgroundRow, renderTimeline, turnRow } from '../src/timeline.js';
import { renderHeader, renderSideSwitch, renderTabs } from '../src/header.js';
import { renderList } from '../src/list.js';
import { html } from './html.js';
import { REPLAY_TIP, SPEAKING_TIP, renderMicButton as viewMicButton } from '@switchboard/conversation/voiceControls';
import { renderMarkdown } from '../src/markdown.js';
import { SEND_RETRY_MS } from '../src/main.js';
import { LINK_ANSWER_MS, CHAT_MAX, CHAT_MIN, DRAWER_HIDE_MS, COMMENT_SETTLE_MS, DRAWER_REVEAL_MS, loadMermaid, FRAME_SHOW_DELAY_MS, SENT_NOTE_MS, SIDE_MAX, SIDE_MIN, startPage, SWIPE_OPEN } from '../src/main.js';
import { DETAIL_MIN } from '../src/layout.js';
import { BACKOFF_MS, GRACE_MS, JITTER } from '../src/connection.js';
import { NAVIGATION_MS } from '../src/request.js';
import type { ArtifactView, MessageView, PageGroup, PageRow, ReplyView, SessionView } from '@switchboard/protocol';
import { drawAtOnce } from './frame.js';
import { showToast } from '../src/toast.js';

const message = (id: string, ord: number, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at: 1_000 + ord, ord, provisional: false, withdrawn: false, origin: 'typed', text: `text ${id}`, delivery: 'sent', error: null, ...patch });
const reply = (id: string, ord: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's', at: 1_000 + ord, ord, provisional: false, kind: 'reply', answers: null, opening: `reply ${id}`, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null, ...patch });
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, ticketId: null, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
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
  it('reads numbered questions outside code, with ids, and resolves a typed answer against them', () => {
    const text = '1. Which port? {#port-choice}\n   - A) 8765\n   - B) 8799\n2. Which checks? Choose all that apply.\n   - A) Unit\n   - B) Live\n\n```\n3. Not a question\n   - A) x\n   - B) y\n```';
    const questions = parseQuestions(text);

    expect(questions.map((question) => [question.number, question.slug, question.multi, question.options.length])).toEqual([[1, 'port-choice', false, 2], [2, 'checks-choose-all', true, 2]]);
    expect(resolveAnswers('port-choice B, checks-choose-all A and B', questions.map((question) => ({ replyId: 'r1', question })))).toEqual([
      { replyId: 'r1', slug: 'port-choice', letters: ['B'], other: '' },
      { replyId: 'r1', slug: 'checks-choose-all', letters: ['A', 'B'], other: '' },
    ]);
    expect(parseQuestions('Pick one:\n- A) x\n- B) y')).toMatchObject([{ number: null, text: 'Pick one:' }]);
  });
});

describe('question cards in replies', () => {
  const ending = 'Before I go on:\n\n1. Port?\n   - A) 1\n   - B) 2';
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, status: null, artifacts: [], settings: { briefReplies: true } });

  it('leaves questions that end a reply out of its text, folds ones written mid-message, and keeps a card open under a message that answers nothing', () => {
    const host = document.createElement('div');
    const fresh = (items: Array<MessageView | ReplyView>) => ({ ...pageState(items), questions: { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] } });

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
    expect(host.querySelector('li[data-id="r1"] .reply-primary')?.textContent?.trim()).toBe('Then I start.');
    // A question id and a withdraw line never show.
    host.innerHTML = html(renderTimeline(fresh([reply('r1', 1, { opening: 'Before I go on:\n[withdraw: old-one]\n\n1. Port? {#port-choice}\n   - A) 1\n   - B) 2\n\nThen I start.' })]), newView()));
    expect(host.querySelector('li[data-id="r1"] > .body')?.textContent).not.toMatch(/withdraw|\{#/);
    // After the cutover, a message that answers nothing leaves the card open; one that answers settles it.
    host.innerHTML = html(renderTimeline(fresh([reply('r1', 1, { opening: ending }), message('m1', 2, { text: 'Later.' })]), newView()));
    expect(host.querySelector('.question-card .qc-option')).not.toBeNull();
    host.innerHTML = html(renderTimeline(fresh([reply('r1', 1, { opening: ending }), message('m1', 2, { text: 'port B' })]), newView()));
    expect(host.querySelector('.question-card.qc-collapsed .qc-progress')?.textContent).toBe('Question answered');
    // Before the cutover, the old rules: the next message skips it.
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: 'Later.' })]), newView()));
    expect(host.querySelector('.question-card .qc-state')?.getAttribute('title')).toBe('Skipped');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B', delivery: 'open' })]), newView()));
    expect(host.querySelector('.question-card .qc-option')).not.toBeNull();
  });

  it("shows a status's questions on the Status tab as plain Markdown, with no card or fold", () => {
    const host = document.createElement('div');
    const state = { ...pageState([reply('r1', 1, { opening: '' })]), status: { id: 'st-r1', sessionId: 's', at: 1, markdown: `Blocked on a choice.\n\n${ending}`, fallback: false, unread: false } };

    host.innerHTML = html(renderStatus(state, 2));
    expect(host.querySelector('.status-body')?.textContent).toContain('Blocked on a choice.');
    expect(host.querySelectorAll('.status-body ol > li')).toHaveLength(1);
    // The status is a Markdown document, typeset as an artifact's (`md-doc`).
    expect(host.querySelector('.status-body')!.className).toBe('status-body md-doc body');
    expect(host.querySelector('.question-card')).toBeNull();
    expect(host.querySelector('.questions-fold')).toBeNull();
  });

  it('marks an unread status with the unread dot, not a New label, on the Status tab in the strip and the column and in its head', () => {
    const host = document.createElement('div');
    const unread = { ...pageState([]), status: { id: 'st-1', sessionId: 's', at: 1, markdown: 'Built.', fallback: false, unread: true } };
    const seen = { ...unread, status: { ...unread.status, unread: false } };
    const dot = (markup: string, selector: string) => {
      host.innerHTML = markup;
      return host.querySelector(selector);
    };

    for (const [markup, tab] of [[html(renderTabs(newView(), unread)), '[data-tab="status"]'], [html(renderSideSwitch('console', unread)), '[data-side="status"]']] as const) {
      const shown = dot(markup, `${tab} .unread-dot`);

      expect(shown?.getAttribute('role')).toBe('img');
      // Right after the label, so page.css draws it at the label's top-right.
      expect(shown?.previousElementSibling?.className).toBe('tab-label');
      expect(shown?.getAttribute('aria-label')).toBe('Unread');
      expect(shown?.getAttribute('title')).toBe('Unread');
      expect(host.querySelector(tab)?.textContent).toBe('Status');
      expect(host.querySelector('.tab-badge')).toBeNull();
    }
    expect(dot(html(renderStatus(unread, 2)), '.status-head .unread-dot')?.getAttribute('aria-label')).toBe('Unread');
    expect(host.querySelector('.status-head')?.textContent).not.toContain('New');

    // A seen status has none.
    expect(dot(html(renderTabs(newView(), seen)), '.unread-dot')).toBeNull();
    expect(dot(html(renderSideSwitch('console', seen)), '.unread-dot')).toBeNull();
    expect(dot(html(renderStatus(seen, 2)), '.unread-dot')).toBeNull();
  });

  it("draws a tab's unread dot at its label's top-right, over the gap after it, and the dropdown's dot alike, so the dot leaves the tab's width as it was", () => {
    const page = readFileSync(join(__dirname, '../src/page.css'), 'utf8');
    const picker = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/picker.css'), 'utf8');

    expect(page).toContain('.tab .tab-label + .unread-dot { flex: none; position: relative; top: -6px; margin: 0 -7px 0 -6px; }');
    expect(page).not.toMatch(/\.tab(:has\([^)]*\))? > \.unread-dot/);
    expect(page).not.toContain('.status-new');
    expect(picker).toMatch(/^\.unread-dot \{[^}]*width: 7px; height: 7px; border-radius: 50%; background: var\(--vscode-activityBarBadge-background\);/m);
  });

  it('leaves a card answerable under a provisional message queued before the reply, and answered by one queued after it', () => {
    const host = document.createElement('div');
    // A notice an earlier run left queued shows after the transcript's items, dated days before the reply.
    const stale = message('m0', 1, { text: '2 background agents were stopped by the user: "A".', provisional: true, delivery: null });

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 5, { opening: ending }), stale]), newView()));
    expect(host.querySelector<HTMLButtonElement>('.qc-option')?.disabled).toBe(false);
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 5, { opening: ending }), message('m1', 6, { text: '1B', provisional: true, delivery: null })]), newView()));
    expect(host.querySelector('.question-card.qc-collapsed .qc-progress')?.textContent).toBe('Question answered');
  });

  it('draws each option as a full-width button with a mark and no letter, its label and description, and a Comment field under them', () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: 'Before I go on:\n\n1. Port? {#port-choice}\n   - A) 8765 (recommended) — the default.\n   - B) 8799' })]), newView()));
    const options = [...host.querySelectorAll('.qc-option')];

    expect(options.map((one) => one.textContent)).toEqual(['8765RecommendedThe default.', '8799']);
    expect(options.map((one) => [...one.children].map((child) => child.className))).toEqual(Array(2).fill(['qc-mark qc-mark-radio', 'qc-option-body']));
    expect(host.querySelector('.qc-options + .qc-comment-box textarea.qc-comment')).not.toBeNull();
    // The shared styles reach the page's bundle.
    expect(readFileSync(join(__dirname, '../build.mjs'), 'utf8')).toContain("'@switchboard/conversation/questionCard.css'");
  });
});

describe('drawing', () => {
  // The page's state with these items, as a hello brings them.
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, status: null, artifacts: [], settings: { briefReplies: true } });

  it('puts a Today, Yesterday or dated divider before the first item and each turn on another day', () => {
    const at = (day: number, hour: number): number => new Date(2026, 10, day, hour).getTime();
    const markup = html(renderTimeline(pageState([message('m1', 1, { at: at(17, 9) }), reply('r1', 2, { at: at(18, 1) }), message('m2', 3, { at: at(19, 9) }), message('m3', 4, { at: at(20, 9) })]), newView(), at(20, 12)));
    const host = document.createElement('div');

    host.innerHTML = markup;
    expect([...host.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.textContent)).toEqual(['Tue, Nov 17', 'm1', 'r1', 'Yesterday', 'm2', 'Today', 'm3']);
    expect(html(renderTimeline(pageState([message('m1', 1, { at: new Date(2025, 11, 31, 9).getTime() })]), newView(), at(20, 12)))).toContain('>Wed, Dec 31, 2025</li>');
    // A message dated before the items above it, such as one queued days ago and placed last, starts no divider back in time.
    host.innerHTML = html(renderTimeline(pageState([message('m2', 3, { at: at(19, 9) }), message('m3', 4, { at: at(20, 9) }), message('m0', 5, { at: at(17, 21), provisional: true })]), newView(), at(20, 12)));
    expect([...host.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.textContent)).toEqual(['Yesterday', 'm2', 'Today', 'm3', 'm0']);
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

    expect(spoken('interrupted')).toContain('<div class="reply-primary"><p class="passage">Fix<span class="unheard">ed it.</span></p></div>');
    expect(spoken('interrupted')).not.toContain('0:07');
    expect(spoken('failed')).toContain('<span>Not spoken</span>');
    // Not spoken is a message detail; the dimmed part of an interrupted passage is not.
    expect(spoken('failed', false)).not.toContain('class="spoken');
    expect(spoken('interrupted', false)).toContain('<span class="unheard">ed it.</span>');
    expect(spoken('playing')).not.toContain('class="unheard"');

    for (const routine of ['playing', 'interrupted', 'stopped-moved', 'played', 'queued'] as const) {
      expect(spoken(routine)).not.toContain('class="spoken');
    }
  });

  it('draws the primary response once, in its place when the whole reply shows, and a reply that is all primary response as only that', () => {
    const host = document.createElement('div');
    const items = [reply('r1', 1, { opening: 'Before.\n\nFixed it.\n\n- one', speak: 'Fixed it.' }), reply('r2', 2, { opening: 'Same.', speak: 'Same.' }), reply('r3', 3, { opening: 'Plain.' })];
    const kinds = (id: string) => [...host.querySelector(`li[data-id="${id}"] > .body`)!.children].map((child) => (child.classList.contains('reply-primary') ? `primary:${child.textContent!.trim()}` : child.tagName.toLowerCase()));
    const view = newView();

    host.innerHTML = html(renderTimeline(pageState(items), view));
    expect(kinds('r1')).toEqual(['primary:Fixed it.', 'div']);
    expect(kinds('r2')).toEqual(['primary:Same.']);
    expect(host.querySelector('li[data-id="r3"] .reply-primary')).toBeNull();

    view.open.add('more:r1');
    host.innerHTML = html(renderTimeline(pageState(items), view));
    // The text around the passage shows as details.
    // Opening it is for good: there is no Show less.
    expect(kinds('r1')).toEqual(['div', 'primary:Fixed it.', 'div']);
    expect([...host.querySelectorAll('li[data-id="r1"] > .body > .reply-details')].map((details) => details.firstElementChild!.tagName.toLowerCase())).toEqual(['p', 'ul']);
    expect(host.querySelector('li[data-id="r1"] > .body')!.textContent!.match(/Fixed it\./g)).toHaveLength(1);
    expect([...host.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
  });

  it('fades the start of a folded reply\'s details under its primary response, as a control with no visible text that a screen reader reaches by name', () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: 'Fixed it, see [the PR](https://example.com/pr).\n\nThe test was flaky.\n\n- one\n- [two](https://example.com/two)', speak: 'Fixed it, see [the PR](https://example.com/pr).' }), reply('r2', 2)]), newView()));
    const li = host.querySelector('li[data-id="r1"]')!;
    const fade = li.querySelector('.body > .reply-fade')!;

    expect(li.classList.contains('folded')).toBe(true);
    expect([fade.getAttribute('role'), fade.getAttribute('tabindex'), fade.getAttribute('aria-expanded'), fade.getAttribute('aria-label'), fade.getAttribute('data-action')]).toEqual(['button', '0', 'false', 'Show the rest of this reply', 'more']);
    expect(fade.textContent).not.toMatch(/Show (more|the rest)/);
    // The details show in order after the primary response, hidden from screen readers; a link in them takes a click but no keyboard focus.
    const glimpse = fade.querySelector('.reply-fade-text')!;
    expect(glimpse.getAttribute('aria-hidden')).toBe('true');
    expect(glimpse.hasAttribute('inert')).toBe(false);
    expect(glimpse.querySelector('ul a')!.getAttribute('tabindex')).toBe('-1');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: 'Fixed it.\n\n```\nnpm test\n```\n\n<details><summary>Log</summary>x</details>', speak: 'Fixed it.' }), reply('r2', 2)]), newView()));
    const controls = [...host.querySelectorAll('li[data-id="r1"] .reply-fade-text :is(a, button, summary, input, select, textarea)')];

    expect(controls.length).toBeGreaterThan(0);
    expect(controls.filter((one) => one.getAttribute('tabindex') !== '-1')).toEqual([]);
    expect(glimpse.textContent).toContain('The test was flaky.');
    expect(glimpse.querySelector('ul a')?.textContent).toBe('two');
    expect(glimpse.textContent).not.toContain('Fixed it');
    // The primary response's link stays a link outside the fade.
    expect(li.querySelector('.reply-primary a')?.getAttribute('href')).toBe('https://example.com/pr');
    expect(li.querySelector('.show-more')).toBeNull();
  });

  it("draws details that follow the primary response in one box, folded or opened, which only the fade's classes and attributes tell apart", () => {
    const host = document.createElement('div');
    const items = [reply('r1', 1, { opening: 'Fixed it.\n\n**The three:**\n\n- one\n- two', speak: 'Fixed it.' }), reply('r2', 2, { opening: 'Before.\n\nFixed it.\n\nAfter.', speak: 'Fixed it.' })];
    const view = newView();
    const shape = (id: string) => [...host.querySelector(`li[data-id="${id}"] > .body`)!.children].map((child) => child.className);

    host.innerHTML = html(renderTimeline(pageState(items), view));
    const folded = host.querySelector('li[data-id="r1"] .reply-more')!;

    expect(shape('r1')).toEqual(['reply-primary', 'reply-more reply-fade']);
    expect(folded.querySelector(':scope > .reply-more-text.reply-fade-text > .reply-details')).not.toBeNull();
    const details = folded.querySelector('.reply-details')!.outerHTML;

    view.open.add('more:r1');
    view.open.add('more:r2');
    host.innerHTML = html(renderTimeline(pageState(items), view));
    const opened = host.querySelector('li[data-id="r1"] .reply-more')!;

    // Opened, the same box holds the same details, a plain box with no control, glimpse or fade.
    expect(shape('r1')).toEqual(['reply-primary', 'reply-more']);
    expect(opened.querySelector(':scope > .reply-more-text > .reply-details')!.outerHTML).toBe(details);
    expect(['role', 'tabindex', 'aria-expanded', 'aria-label', 'data-action'].filter((name) => opened.hasAttribute(name))).toEqual([]);
    expect(['aria-hidden', 'inert'].filter((name) => opened.firstElementChild!.hasAttribute(name))).toEqual([]);
    expect(opened.firstElementChild!.className).toBe('reply-more-text');
    // Text before the passage shows in its place once opened, as with Collapse details off.
    expect(shape('r2')).toEqual(['reply-details', 'reply-primary', 'reply-details']);
    host.innerHTML = html(renderTimeline({ ...pageState(items), briefReplies: false }, newView()));
    expect(shape('r1')).toEqual(['reply-primary', 'reply-details']);
  });

  it('shows the newest reply whole with Collapse details on, in the box it folds into once a newer reply comes, unlike an aside or a note', () => {
    const host = document.createElement('div');
    const first = reply('r1', 1, { opening: 'Fixed it.\n\n**The three:**\n\n- one\n- two', speak: 'Fixed it.', spoken: { state: 'interrupted', atMs: 900, saidChars: 3 } });
    const shape = (id: string) => [...host.querySelector(`li[data-id="${id}"] > .body`)!.children].map((child) => child.className);
    const draw = (items: ReplyView[], view = newView()) => (host.innerHTML = html(renderTimeline(pageState(items), view)));

    // The newest reply: its details in the plain box an opened reply has, with no fade or control, and its primary response as spoken.
    draw([first]);
    expect(host.querySelector('li[data-id="r1"]')!.classList.contains('folded')).toBe(false);
    expect(shape('r1')).toEqual(['reply-primary', 'reply-more']);
    expect(host.querySelector('li[data-id="r1"] [data-action="more"]')).toBeNull();
    expect(host.querySelector('li[data-id="r1"]')!.getAttribute('data-speak')).toBe('1');
    expect(host.querySelector('li[data-id="r1"] .reply-primary')!.innerHTML).toContain('Fix<span class="unheard">ed it.</span>');
    const details = host.querySelector('li[data-id="r1"] .reply-more .reply-details')!.outerHTML;

    // An aside or a note after it leaves it the newest reply.
    draw([first, reply('a1', 2, { kind: 'aside', opening: 'Checking.' }), reply('n1', 3, { kind: 'note', opening: 'Compacted.' })]);
    expect(shape('r1')).toEqual(['reply-primary', 'reply-more']);

    // A newer reply folds it, the same details in the same box, now the fade.
    draw([first, reply('r2', 2, { opening: 'Next.' })]);
    expect(host.querySelector('li[data-id="r1"]')!.classList.contains('folded')).toBe(true);
    expect(shape('r1')).toEqual(['reply-primary', 'reply-more reply-fade']);
    expect(host.querySelector('li[data-id="r1"] .reply-fade .reply-details')!.outerHTML).toBe(details);
    expect(host.querySelector('li[data-id="r1"] .reply-primary')!.innerHTML).toContain('Fix<span class="unheard">ed it.</span>');
    // One the operator opened stays open.
    const view = newView();

    view.open.add('more:r1');
    draw([first, reply('r2', 2, { opening: 'Next.' })], view);
    expect(shape('r1')).toEqual(['reply-primary', 'reply-more']);
    // A newest reply with text before its passage, which folding would move, stays open once a newer reply comes.
    const around = reply('r4', 4, { opening: 'Before.\n\nFixed it.\n\nAfter.', speak: 'Fixed it.' });
    const kept = newView();

    draw([around], kept);
    expect(shape('r4')).toEqual(['reply-details', 'reply-primary', 'reply-details']);
    draw([around, reply('r5', 5, { opening: 'Next.' })], kept);
    expect(shape('r4')).toEqual(['reply-details', 'reply-primary', 'reply-details']);
    expect(host.querySelector('li[data-id="r4"]')!.classList.contains('folded')).toBe(false);
    // A rewrite of the newest reply, drawn in its place, is the newest reply.
    draw([{ ...first, rewrittenBy: 'r3' }, reply('r3', 3, { opening: 'Fixed it again.\n\nThe details.', speak: 'Fixed it again.' })]);
    expect(host.querySelector('li[data-id="r3"]')!.classList.contains('folded')).toBe(false);
  });

  it('shows a reply with no [details] line whole, with no fade, its ending questions and their markup left to its card', () => {
    const host = document.createElement('div');
    const whole = 'Fixed it.\n\n- one\n\n1. Ship it? {#ship}\n   - A) Yes\n   - B) No';

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: whole, speak: whole })]), newView()));
    expect(host.querySelector('li[data-id="r1"] .reply-fade')).toBeNull();
    expect(host.querySelector('li[data-id="r1"]')!.classList.contains('folded')).toBe(false);
    expect(host.querySelector('li[data-id="r1"] .body ul')).not.toBeNull();
    expect(host.querySelector('li[data-id="r1"] .question-card')).not.toBeNull();
    expect(host.querySelector('li[data-id="r1"] .body')!.textContent).not.toContain('Ship it?');
    expect(host.textContent).not.toContain('{#ship}');
  });

  it('gives a reply whose only text besides its passage is the questions its card draws no fade', () => {
    const host = document.createElement('div');
    const asked = 'Fixed it.\n\n1. Ship it?\n   - A) Yes\n   - B) No';

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: asked, speak: 'Fixed it.' }), reply('r2', 2, { opening: `${asked}\n\nMore after.`, speak: 'Fixed it.' }), reply('r3', 3)]), newView()));
    expect(host.querySelector('li[data-id="r1"] .reply-fade')).toBeNull();
    expect(host.querySelector('li[data-id="r1"] .question-card')).not.toBeNull();
    // Questions written mid-message stay in the text, folded, so the fade still has them and the text after them to show.
    expect(host.querySelector('li[data-id="r2"] .reply-fade')).not.toBeNull();
  });

  it("keeps raw HTML out of Markdown, opens web links in a new tab and shows paths as text", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [web](https://example.com) [file](src/a.ts) [bad](javascript:alert(1))');

    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a class="path-link" title="src/a.ts"');
    expect(html).not.toContain('href="javascript');
  });

  it('keeps Thinking at the timeline\'s end all through a turn, after a reply mid-turn or with no new message, and drops it with only background tasks left', () => {
    const answered = [message('m1', 1), reply('r1', 2, { answers: 'm1' })];
    const draw = (patch: Partial<SessionView>): HTMLElement => {
      const host = document.createElement('div');
      const state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session(patch)], items: answered, more: false, status: null, artifacts: [] });

      host.innerHTML = html(renderTimeline(state, newView()));
      return host;
    };

    // Session 311b1ad4: a reply had answered the latest message, and the turn went on with tool calls, or a task notification started one.
    expect([...draw({ state: 'running', background: null }).querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'm1', 'r1', 'working']);
    expect(draw({ state: 'running', background: null }).querySelector('.working')?.textContent).toBe('Thinking…');
    expect(draw({ state: 'running', background: null }).querySelector('.working .codicon-modifier-spin')).not.toBeNull();
    expect(draw({ state: 'starting' }).querySelector('.working')?.textContent).toBe('Starting…');
    // The turn ended with background tasks running: the session is `running` but in no turn.
    expect(draw({ state: 'running', background: { agents: 1, shells: 0, other: 0 } }).querySelector('.working:not(.background)')).toBeNull();
    expect(draw({ state: 'running', background: { agents: 1, shells: 0, other: 0 } }).querySelector('.working.background')?.textContent).toBe('1 agent running');
    expect(draw({ state: 'idle' }).querySelector('.working')).toBeNull();
    expect(inTurn(session({ state: 'running', background: { agents: 1, shells: 0, other: 0 } }))).toBe(false);
    // An older hub sends no `background`, so only an unanswered message shows the row.
    expect(inTurn(session({ state: 'running' }))).toBe(false);
    expect(draw({ state: 'running' }).querySelector('.working')).toBeNull();
    expect(inTurn(session({ state: 'waiting' }))).toBe(false);
    expect(inTurn(null)).toBe(false);
  });

  it('shows Thinking for a message sent while only background tasks run, until a reply answers it', () => {
    const draw = (items: Array<MessageView | ReplyView>): HTMLElement => {
      const host = document.createElement('div');
      const state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session({ state: 'running', background: { agents: 1, shells: 0, other: 0 } })], items, more: false, status: null, artifacts: [] });

      host.innerHTML = html(renderTimeline(state, newView()));
      return host;
    };

    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3)]).querySelector('.working')?.textContent).toBe('Thinking…');
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3), reply('r2', 4, { answers: 'm2' })]).querySelector('.working:not(.background)')).toBeNull();
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3), reply('r2', 4, { answers: 'm2' })]).querySelector('.working.background')?.textContent).toBe('1 agent running');
  });

  it('says what the turn waits for: Starting or Thinking with the spinner, and the answer or permission the terminal asks for instead of Thinking', () => {
    expect(html(turnRow(session({ state: 'starting' }), true))).toContain('Starting…');
    expect(html(turnRow(session({ state: 'running' }), true))).toContain('codicon-modifier-spin');
    expect(html(turnRow(session({ state: 'running' }), false))).toBe('');
    // A Codex request's card stands in for the row, even before the session's waiting state comes.
    expect(html(turnRow(session({ state: 'running', provider: 'codex', requests: [{ id: 'q', title: 'Pick', kind: 'question', questions: [], decisions: [] }] }), true))).toBe('');
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'question' }), true))).toMatch(/codicon-question[\s\S]*Waiting for your answer/);
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), false))).toMatch(/codicon-shield[\s\S]*Waiting for permission/);
    expect(html(turnRow(session({ state: 'waiting', waitingFor: 'permission' }), true))).not.toContain('Thinking');
  });

  it('says how many background agents and shells run after the turn ended, with the spinner, when no turn row is due', () => {
    const background = session({ state: 'running', background: { agents: 3, shells: 1, other: 0 } });
    const row = html(backgroundRow(background));

    expect(row).toContain('3 agents · 1 shell running');
    expect(row).toContain('codicon-modifier-spin');
    expect(row).toContain('role="status"');
    expect(html(backgroundRow(session({ state: 'running' })))).toBe('');
    expect(html(backgroundRow(session({ state: 'running', background: null })))).toBe('');
    expect(html(backgroundRow(null))).toBe('');

    // A reply answered the message, so no turn row is due; the background line shows until the hub's next state drops it.
    const items = [message('m1', 1, { text: 'Go.' }), reply('r1', 2, { opening: 'Started.' })];
    const shown = html(renderTimeline({ ...EMPTY, connected: true, scope, session: background, items }, newView()));
    const host = document.createElement('div');

    host.innerHTML = shown;
    expect(host.querySelector('.timeline > li:last-child')?.textContent).toBe('3 agents · 1 shell running');
    expect(shown).not.toContain('Thinking');
    // A message sent while they run shows Thinking until its reply, in place of the background line.
    const sent = html(renderTimeline({ ...EMPTY, connected: true, scope, session: background, items: [...items, message('m2', 3, { text: 'And?' })] }, newView()));

    expect(sent).toContain('Thinking');
    expect(sent).not.toContain('agents');
    // Once they finish, the session is idle and the line goes.
    expect(html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items }, newView()))).not.toContain('running');
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

  it("draws the groups with their counts and rows: title, mark, ticket pill and playbook, stripe and the selection", () => {
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
    // A Ready for review row can be dragged (PRD R73).
    expect(first.className).toBe('row stripe-turn movable');
    // The mark by the shared icon name, the ticket key in its source's colour, the playbook's namespace muted.
    expect(first.querySelector('.mark')!.className).toBe('codicon codicon-eye mark');
    expect(first.querySelector('.mark')!.getAttribute('aria-label')).toBe('Review, then approve');
    expect(first.querySelector('.pill')!.className).toBe('pill ticket source-github');
    // The ticket key is its text alone: it never shrinks to an icon.
    expect(first.querySelector('.pill')!.innerHTML).toBe('<span class="pill-text">gh 1</span>');
    expect(first.querySelector('.playbook')!.innerHTML).toBe('<span class="namespace">dev:</span>build');
    expect(root.querySelector('[data-work-item="2"]')!.className).toBe('row stripe-warning dim movable');
    expect(root.querySelectorAll('.voice-mark')).toHaveLength(0);
    expect(root.querySelector('[data-work-item="2"] .pill')!.className).toBe('pill ticket source-zoho');
    expect(root.querySelector('[data-work-item="2"] .playbook')!.innerHTML).toBe('triage');
    // A running mark spins; a failed one is marked for the error colour, and no mark takes a tone.
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

  it("draws a row's three lines from the hub's dock row: priority, title and time; comment, playbook, ticket, links and Returned; mark and details", () => {
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
    // Line 2 in the row's order, each pill's whole name and URL in its tooltip.
    expect([...line2!.children].map((child) => child.className)).toEqual(['codicon comment', 'playbook', 'pill ticket source-github', 'row-links']);
    expect([...line2!.querySelectorAll('.row-links-shown > .pill')].map((child) => child.className)).toEqual(['pill link pr', 'pill link issue mentioned', 'pill returned']);
    expect(line2!.querySelector('.comment')!.getAttribute('title')).toBe('Nov 20\nWaits on Sam');
    expect(line2!.querySelector('.ticket')!.getAttribute('title')).toBe('gh 1\nhttps://github.com/o/r/issues/1');
    expect(line2!.querySelector('.pr')!.textContent).toBe('\u{ea64}19002');
    expect(line2!.querySelector('.pr')!.getAttribute('title')).toBe('PR #19002\nhttps://github.com/o/r/pull/19002');
    // Every link pill has an icon to shrink to: an issue the hub sends no glyph for shows GitHub's mark.
    expect([...line2!.querySelectorAll('.row-links-shown .pill')].map((pill) => pill.querySelector('.codicon')?.textContent)).toEqual(['\u{ea64}', '\u{ea84}', '\u{eae2}']);
    expect(line2!.querySelector('.issue')!.getAttribute('title')).toBe('gh 18800, named in the ticket\nhttps://github.com/o/r/issues/18800');
    expect(line2!.querySelector('.returned .pill-text')!.textContent).toBe('2');
    // The unseen boxes that decide which texts fit (page.css, Line 2): the pills as icons, then each pill's text; hidden from screen readers
    // and holding nothing to focus or click.
    const links2 = line2!.querySelector('.row-links')!;
    expect([...links2.children].map((child) => [child.className, child.getAttribute('aria-hidden'), child.textContent])).toEqual([
      ['row-links-box', null, '\u{ea64}19002\u{ea84}gh 18800\u{eae2}2'],
      ['row-links-fit', 'true', '\u{ea64}\u{ea84}\u{eae2}'],
      ['row-links-fit-text', 'true', '19002'],
      ['row-links-fit-text', 'true', 'gh 18800'],
      ['row-links-fit-text', 'true', '2'],
    ]);
    expect(links2.querySelectorAll('.row-links-fit [title], .row-links-fit [tabindex], .row-links-fit [data-action]')).toHaveLength(0);
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

    root.innerHTML = html(renderList([listGroup('progress', [listRow(1, { time: { text: '2h', title: 'In queue' }, voice: { glyph: '\u{ec12}', title: 'Voice is set to this session. Mic on.' } }), listRow(2, { voice: null })])], null, new Set()));
    expect([...root.querySelector('[data-work-item="1"] .row-head')!.children].map((child) => child.className)).toEqual(['row-title', 'codicon voice-mark', 'row-time']);
    expect(root.querySelector('[data-work-item="1"] .voice-mark')!.getAttribute('aria-label')).toBe('Voice is set to this session. Mic on.');
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
    expect([...root.querySelector('button.picker')!.children].map((child) => child.className)).toEqual(['codicon codicon-loading codicon-modifier-spin state-icon tone-muted', 'provider', 'picker-text', 'codicon codicon-chevron-down']);
    expect(root.querySelector('.header > .codicon')).toBeNull();
    // The provider's mark after the state codicon on the button and every row, the current session's and the earlier ones', each named as its CLI
    // names it; the button shows the work item's title over the session's name, both in its tooltip.
    const conversations = [{ ...scope.conversations[0]!, provider: 'codex', sessionTitle: 'Review PR 21576', sessions: [{ sessionId: 'e1', title: 'Fix the badge', state: 'ended' as const, startedAt: 0, provider: 'claude' }, { sessionId: 'e0', title: 'Setup session', state: 'ended' as const, startedAt: 0 }] }];
    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations }, session: session({ provider: 'codex' }) }, { ...newView(), picker: true }));
    expect([...root.querySelectorAll('.conversation-menu .conversation-row')].map((row) => [[...row.children].map((child) => child.classList[0]).slice(0, 3), row.querySelector('.provider')!.getAttribute('aria-label'), row.querySelector('.title')!.textContent])).toEqual([
      [['codicon', 'provider', 'title'], 'Codex', 'Review PR 21576'],
      [['codicon', 'provider', 'title'], 'Claude', 'Fix the badge'],
      [['codicon', 'provider', 'title'], null, 'Setup session'],
    ]);
    // A provider's mark is never on a background of its own, and an unknown provider's empty mark is hidden from a reader.
    expect(root.querySelector('.session-row[data-session="e0"] .provider')!.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')!.textContent).toBe('Review PR 21576');
    expect(root.querySelector('button.picker .provider')!.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('Review PR 21576 · Fix it');
    // From a hub that sends no session name, or a session named as its work item, the title alone, said once.
    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope, session: session() }, newView()));
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')).toBeNull();
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('Fix it');
    root.innerHTML = html(renderHeader({ ...EMPTY, connected: true, scope: { ...scope, conversations: [{ ...scope.conversations[0]!, sessionTitle: 'Fix it' }] }, session: session() }, newView()));
    expect(root.querySelector('button.picker .picker-session')).toBeNull();
  });

  it("shows only the page's own voice state, with Talk here when the voice is elsewhere", () => {
    expect(renderVoice(null)).toBe('');
    expect(renderVoice({ enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null })).toContain('data-voice="talk-here"');
    expect(renderVoice({ enabled: true, here: true, mic: 'idle-off', speaking: 'r1', speakReplies: false, error: null, recognizer: null })).toContain('data-voice="stop"');
    expect(renderVoice({ enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null })).toContain('Click to use voice for this session.');
    // One renderer from packages/conversation: every mic state is drawn by its own button.
    expect(renderMicButton).toBe(viewMicButton);
    expect(renderMicButton({ enabled: true, here: true, mic: 'paused-by-voice', speaking: null, speakReplies: true, error: null })).toContain('data-on="true"');
    expect(renderMicButton({ enabled: true, here: true, mic: 'hearing', speaking: 'r1', speakReplies: true, error: null, halfDuplex: 'no echo cancellation' })).toContain('class="mic held"');
  });

  it('draws the spinner after the newest item while the session is in a turn, so progress and replies written mid-turn show above it', () => {
    const items = [message('m1', 1), reply('a1', 2, { kind: 'aside' }), reply('a2', 3, { kind: 'aside' })];
    const order = (markup: string): string[] => [...markup.matchAll(/<li class="([^"]+)"(?: data-id="([^"]+)")?/g)].map((match) => match[2] ?? match[1]!);
    const markup = html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running' }), items }, newView()));

    expect(order(markup)).toEqual(['day', 'm1', 'a1', 'a2', 'working']);
    expect(order(html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'running', background: null }), items: [...items, reply('r1', 4)] }, newView())))).toEqual(['day', 'm1', 'a1', 'a2', 'r1', 'working']);
    expect(html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items }, newView()))).not.toContain('class="working"');
  });

  it('gives a time a tooltip of its date, 24-hour time and zone', () => {
    const at = Date.UTC(2026, 10, 20, 18, 30, 17);
    const markup = html(renderTimeline({ ...EMPTY, connected: true, scope, session: session({ state: 'idle' }), items: [message('m1', at - 1_000), reply('r1', at)] }, newView()));

    expect(markup).toMatch(/<time class="stamp" datetime="2026-11-20T18:30:17\.000Z" title="2026-11-20 \d{2}:30:17 [^"]+">/);
  });

  it('draws a card under a reply that asks, answered by the next message', () => {
    const state = { ...EMPTY, connected: true, scope, session: session(), items: [reply('r1', 1, { opening: 'Pick:\n- A) x\n- B) y' }), message('m1', 2, { text: 'B' })] };

    expect(html(renderTimeline(state, newView()))).toMatch(/question-card qc qc-settled-card qc-collapsed[\s\S]*Question answered[\s\S]*answer-ref-answer">→ y</);
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

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

  it('draws a burst of events once, at the next frame, and a frame a draw since makes unneeded draws nothing', () => {
    const frames: Array<() => void> = [];
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: (run) => void frames.push(run), now: () => 10_000 });
    const source = FakeSource.last!;
    const replies = () => root.querySelectorAll('#panel .reply').length;

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    // A long history read arrives as one event per reply; none draws until the frame, which draws them all once.
    for (let index = 1; index <= 200; index++) {
      source.emit('reply', { reply: reply(`r${index}`, index) });
    }

    expect(frames).toHaveLength(1);
    expect(replies()).toBe(0);
    frames.shift()!();
    expect(replies()).toBe(200);

    // A draw before the frame, as a click's, leaves the frame nothing to draw.
    source.emit('reply', { reply: reply('r201', 201) });
    expect(frames).toHaveLength(1);
    root.querySelector<HTMLElement>('.row')!.click();
    expect(replies()).toBe(201);
    root.querySelector('#panel')!.replaceChildren();
    frames.shift()!();
    expect(replies()).toBe(0);
    // Nor does a frame asked for before the page closed.
    source.emit('reply', { reply: reply('r202', 202) });
    page.close();
    frames.shift()!();
    expect(replies()).toBe(0);
  });

  it('brings the conversation to its end on a send, wherever the operator had scrolled, and follows the turn row and the reply after it', async () => {
    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;
    const input = root.querySelector<HTMLTextAreaElement>('#composer textarea')!;
    const sized = (height: number) => {
      Object.defineProperty(panel, 'scrollHeight', { value: height, configurable: true });
      Object.defineProperty(panel, 'clientHeight', { value: 100, configurable: true });
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    sized(500);
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    input.value = 'Next?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.scrollTop).toBe(500);
    // Scrolled away while the send is on its way, the conversation stays where the operator put it until the next send.
    panel.scrollTop = 200;
    panel.dispatchEvent(new Event('scroll'));
    await flush();
    await flush();
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(true);
    expect(panel.scrollTop).toBe(200);
    input.value = 'And then?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.scrollTop).toBe(500);
    await flush();
    await flush();
    // The sent message, then the reply, grow the conversation; it stays at its end.
    sized(700);
    source.emit('message', { message: message('m1', 2, { text: 'Next?' }) });
    expect(panel.scrollTop).toBe(700);
    sized(900);
    source.emit('reply', { reply: reply('r2', 3) });
    expect(panel.scrollTop).toBe(900);
    page.close();
  });

  it('keeps the composer\'s box across tabs, says Sent in the toast after a send that ends off the Conversation tab, shows it for files dropped there, and shows an ended session\'s reason above the composer', async () => {
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
    // The folded tabs hide the composer off the Conversation tab, so the toast says it went, not the composer's own line.
    expect(root.classList.contains('off-conversation')).toBe(true);
    expect(composer.querySelector<HTMLElement>('.composer-sent')!.hidden).toBe(true);
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Sent. Its reply shows on the Conversation tab.');
    expect(SENT_NOTE_MS).toBe(4_000);

    // Files dropped on another tab show the Conversation tab, where the composer shows their chips.
    const dropped = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropped, 'dataTransfer', { value: { types: ['Files'], files: [new File(['d'], 'report.pdf', { type: 'application/pdf' })] } });
    root.querySelector('#panel')!.dispatchEvent(dropped);
    expect(dropped.defaultPrevented).toBe(true);
    expect(root.querySelector('.tab.selected')?.getAttribute('data-tab')).toBe('conversation');
    expect(root.classList.contains('off-conversation')).toBe(false);

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

  it('marks #root.off-conversation while the tabs show another tab, which hides the composer, keeping the draft and dropping its focus, and never in the wide layout', () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('off-conversation')).toBe(false);
    input.value = 'Half a thought';
    input.dispatchEvent(new Event('input'));
    input.focus();
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    // Hidden by the stylesheet only, so the box and its text stay; the hidden box gives up the focus.
    expect(composer.hidden).toBe(false);
    expect(document.activeElement).not.toBe(input);
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: false } })], items: [], more: false, status: null, artifacts: [] });
    // The header has no persona button of its own any more.
    expect(root.querySelector('button.persona, .persona-anchor')).toBeNull();
    root.querySelector<HTMLElement>('button.view-options')!.click();

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona: Nova');
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
    // The toast stays live over it: a failure is read out and Dismiss works.
    expect(root.querySelector('#toast')?.closest('[inert]')).toBeNull();
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
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

  it('names the persona the session has, pinned or not, or None, offering it only when it can take a pin, and pins from the dialog', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: '' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: false })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.view-options')!.click();
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="persona"]')).toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona: None');
    expect(row.querySelector('.menu-note')).toBeNull();
    // A persona resolved at the start, from the playbook or the pool, is named with no pin.
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'iris', name: 'Iris', pinned: false, tonePending: false }, canPin: true })], items: [], more: false, status: null, artifacts: [] });
    expect(root.querySelector('.view-options-menu [data-action="persona"] .title')?.textContent).toBe('Persona: Iris');
    expect(root.querySelector('.view-options-menu [data-action="persona"] .menu-note')).toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="persona"] .codicon-person')).not.toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, status: null, artifacts: [] });
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
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

  it('keeps each voice control its own button, so a focused speaker never turns into Talk here', () => {
    const { page, source } = start();
    const voice = { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null, recognizer: null };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [], voice });

    const speaker = root.querySelector<HTMLElement>('[data-voice="speak-replies"]')!;

    speaker.focus();
    source.emit('voice', { voice: { ...voice, here: false, speaking: null } });
    expect(speaker.isConnected).toBe(false);
    expect(root.querySelector('[data-voice="talk-here"]')).not.toBe(speaker);
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
    // With no work item open, the pane says so in words that hold on a phone, where the list is its own view.
    expect(root.querySelector('#panel .empty')?.textContent).toBe('No work item open. Choose one in the list to see its conversation.');
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

      return { status: 200, ok: true, json: async () => (url.endsWith('/page-voice-ticket') ? { ticket: 't1' } : {}), text: async () => '' } as unknown as Response;
    });
    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
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
    // Starting from the tap, while the voice socket and the microphone open.
    expect(root.querySelector('.composer-mic .mic.starting')?.getAttribute('aria-busy')).toBe('true');
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
    // Starting until the voice view says the mic listens.
    expect(root.querySelector('.composer-mic .mic.starting')).not.toBeNull();
    phone.emit('voice', voice('listening'));
    expect(root.querySelector('.composer-mic .mic.listening')).not.toBeNull();
    await flush();
    // The phone's steps, from the tap: its microphone, the hub's answer and the voice's confirmation.
    expect((posts.filter((post) => post.url.endsWith('/mic-timing')).at(-1)?.body['steps'] as Array<{ step: string }>).map((one) => one.step)).toEqual(['microphone allowed', 'capture connected', 'mic on sent', 'hub answered', 'voice confirmed']);
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    phone.emit('voice', voice('off'));
    // A refused microphone shows on the button, and the next tap tries again.
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) } });
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.composer-mic .mic.unavailable')?.getAttribute('title')).toBe('The mic did not start: Microphone access was not allowed on this device. Click to try again.');
    expect(root.querySelector('.composer-mic [data-voice="mic"]')?.getAttribute('data-on')).toBe('true');
    // The failure belongs to its conversation: another one's mic shows the hub's state.
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: { ...scope, workItemId: 2 }, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    expect(root.querySelector('.composer-mic .mic.unavailable')).toBeNull();
    window.innerWidth = width;
    paired.close();
  });

  it('takes the voice back over the new stream after a hub restart with no tap, and offers the new build without ever reloading by itself', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const tick = () => vi.advanceTimersByTimeAsync(0);
    const sockets: Array<{ url: string; sent: unknown[]; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: ((event: { code: number; reason: string }) => void) | null }> = [];
    const contexts: Array<{ closed: boolean }> = [];
    const reload = vi.fn();

    vi.stubGlobal('AudioContext', class {
      state = 'running';
      destination = {};
      onstatechange = null;
      closed = false;
      audioWorklet = { addModule: async () => undefined };
      resume = async () => undefined;
      close = async () => void (this.closed = true);
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
      constructor() {
        contexts.push(this);
      }
    });
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: () => undefined, onmessage: null };
      connect(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('WebSocket', class {
      binaryType = 'blob';
      readonly sent: unknown[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      send(data: unknown): void {
        this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
      }
      close(): void {}
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [{ muted: false, readyState: 'live', stop: () => undefined }] }) } });
    onTestFinished(() => void Reflect.deleteProperty(navigator, 'mediaDevices'));
    onTestFinished(() => void vi.unstubAllGlobals());

    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url === '/page/ping' ? { build: 'b2' } : url.endsWith('/page-voice-ticket') ? { ticket: 't1' } : {}), text: async () => '' } as unknown as Response;
    });

    window.innerWidth = 375;

    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, build: 'b1', reload });
    const phone = FakeSource.last!;
    const hello = (key: string) => FakeSource.last!.emit('hello', { key, groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    hello('pk');
    phone.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await tick();
    expect(sockets.map((one) => one.url)).toEqual([expect.stringMatching(/\/v1\/voice\/socket\?window=pk&ticket=t1$/)]);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await tick();
    await tick();

    // The hub restarts onto build b2: it closes the voice for the restart, and the page's stream fails until the new hub answers.
    sockets[0]!.onclose?.({ code: 4002, reason: 'Switchboard is restarting.' });
    phone.emit('error', {});
    expect(phone.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));
    expect(contexts.map((one) => one.closed)).toEqual([false]);
    // The page opens its stream again itself, after asking the hub's build.
    expect(FakeSource.last).not.toBe(phone);

    // The new stream has a new key: the voice socket opens with it and takes the voice back.
    hello('pk2');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.map((one) => one.url)).toEqual([expect.stringMatching(/window=pk&ticket=t1$/), expect.stringMatching(/window=pk2&ticket=t1$/)]);
    sockets[1]!.onopen?.();
    expect(sockets[1]!.sent).toEqual([{ type: 'hello', resume: true }]);
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await vi.advanceTimersByTimeAsync(6_000);
    // No reload for the new build: the page offers one, since a reload would end the phone's audio until the next tap.
    expect(reload).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
    expect(root.querySelector('.conn-update')?.textContent).toBe('Update readyReload');

    // Not once the voice is off on this phone either; only the chip's Reload reloads.
    sockets[1]!.onclose?.({ code: 4003, reason: 'Voice is no longer allowed on this device.' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reload).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>('[data-action="conn-reload"]')!.click();
    expect(reload).toHaveBeenCalledTimes(1);
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

    // An iPad Air on its side, 1180 px wide, gets the pinned list beside the conversation, and a swipe stays.
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
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.querySelector('.list-pin')).not.toBeNull();
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

  it('leaves an iOS edge swipe to browser history before and after the conversation marker is cleared', async () => {
    history.replaceState(null, '', '#');
    const userAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');

    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    onTestFinished(() => {
      if (userAgent === undefined) {
        Reflect.deleteProperty(navigator, 'userAgent');
      } else {
        Object.defineProperty(navigator, 'userAgent', userAgent);
      }
    });

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1)])];

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, status: null, artifacts: [] });
    expect(history.state).toEqual({ switchboardConversation: true });

    const target = root.querySelector<HTMLElement>('#panel .timeline')!;

    const drag = (): void => {
      for (const [type, x] of [['touchstart', 5], ['touchmove', 25], ['touchmove', 190]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 400 }] });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(root.classList.contains('swiping')).toBe(false);
      }
    };

    drag();
    history.replaceState(null, '', '#w=1');
    drag();
    history.replaceState({ switchboardConversation: true }, '', '#w=1');

    expect(root.querySelector<HTMLElement>('.main')!.style.transform).toBe('');
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.back();
    await popped;
    expect(root.classList.contains('listing')).toBe(true);
    const returned = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.forward();
    await returned;
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

    // Back, as Android's back button gives it: the list, on the selected row, and the list's entry is the list's address, so a reload shows it.
    let pop = popped();

    history.back();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    expect(location.hash).toBe('#list');
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
    expect(location.hash).toBe('#list');

    // Another conversation chosen from the header's dropdown replaces the entry rather than adding one.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope: { ...scope, workItemId: 2, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Item 2', primary: false }] }, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
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

it('steps back through history once for Back, select and Back in quick succession, and drops a refused row\'s entry, and keeps a reloaded conversation\'s entry', async () => {
    // The entries a phone's page made before the reload: the list's, and the conversation's over it.
    history.replaceState(null, '', '#list');
    history.pushState({ switchboardConversation: true }, '', '#w=1');

    const entries = history.length;

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') && refuse ? 404 : 200, ok: true, json: async () => (refuse ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    let refuse = false;
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];

    // A reload keeps the conversation's entry over the list's, adding none, so Back steps back to the list's.
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(history.length).toBe(entries);
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });

    const back = vi.spyOn(history, 'back');
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    let pop = popped();

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).toHaveBeenCalledOnce();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });

    pop = popped();

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).toHaveBeenCalledTimes(2);
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();

    // A refused first open from the list shows why in its place; Back to the list takes its entry back with it.
    source.emit('hello', { key: 'pk2', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    refuse = true;
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('#panel .opening-why')?.textContent).toBe('That work item is gone.');
    pop = popped();
    root.querySelector<HTMLElement>('[data-action="open-back"]')!.click();
    await pop;
    expect(back).toHaveBeenCalledTimes(3);
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

  it("shows a refused open in the work item's place under its own title, with Try again and Back to the list", async () => {
    history.replaceState(null, '', '#');

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') ? 404 : 200, ok: !url.endsWith('/select'), json: async () => (url.endsWith('/select') ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    FakeSource.last!.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    // At once: its title and a placeholder.
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 1');
    expect(root.querySelector('#panel .opening-note')?.textContent).toContain('Opening…');
    await flush();
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 1');
    expect(root.querySelector('#panel .opening-failed h3')?.textContent).toBe("Couldn't open this work item");
    expect(root.querySelector('#panel .opening-why')?.textContent).toBe('That work item is gone.');
    expect(location.hash).toBe('#w=1');

    const selects = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/select')).length;

    // Not asked again until Try again.
    expect(selects()).toBe(1);
    root.querySelector<HTMLElement>('[data-action="open-retry"]')!.click();
    expect(selects()).toBe(2);
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    await flush();
    await flush();
    root.querySelector<HTMLElement>('[data-action="open-back"]')!.click();
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('');
    // The next select hides it.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 2');
    page.close();
  });

  it('keeps every column in its place while another work item opens and after its open fails, with a placeholder strip and the composer kept hidden', async () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 1440;

    let refuse = false;
    const fetch = vi.fn(async (url: string) => {
      const refused = refuse && url.endsWith('/select');

      return { status: refused ? 404 : 200, ok: !refused, json: async () => (refused ? { error: 'That work item is gone.' } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const labels = (selector: string) => [...root.querySelectorAll(selector)].map((one) => one.textContent);
    const scope2 = { ...scope, workItemId: 2, scopeGen: 4, title: 'Item 2', conversations: [{ ...scope.conversations[0]!, workItemId: 2, title: 'Item 2' }] };

    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(true);
    expect(composer.hidden).toBe(false);
    root.querySelector<HTMLElement>('#detail .panel-max')!.click();
    expect(root.classList.contains('maximized')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    // The maximized column restores, so the placeholder shows.
    expect(root.classList.contains('maximized')).toBe(false);
    // At once: the column stays, its strip Status and Console dimmed over a loading note, and the composer keeps its place, hidden by page.css.
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('item-opening')).toBe(true);
    expect(labels('#detail .detail-head .opening-tabs .tab')).toEqual(['Status', 'Console']);
    expect(root.querySelector('#detail .detail-head .opening-tabs')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('#detail .detail-body .opening-side')?.textContent).toContain('Loading…');
    expect(root.querySelector('#head .opening-tabs')).toBeNull();
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    expect(composer.hidden).toBe(false);
    // Its hello: the work item's own strip and status in the same column.
    source.emit('hello', { key: 'pk', groups, scope: scope2, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('item-opening')).toBe(false);
    expect(root.querySelector('#detail .opening-tabs')).toBeNull();
    expect(root.querySelector('#detail .detail-head [data-side="status"]')).not.toBeNull();
    expect(root.querySelector('#detail .detail-body .opening-side')).toBeNull();

    // Where the tabs fold into the conversation's, the placeholder strip is under its head; a refused open keeps it, and the column comes back
    // with no loading note when the page widens.
    resizeTo(1000);
    refuse = true;
    root.querySelector<HTMLElement>('#head [data-tab="status"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    // It opens on the Conversation tab, so the composer keeps its place meanwhile.
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(labels('#head .opening-tabs .tab')).toEqual(['Conversation', 'Status', 'Console']);
    await flush();
    await flush();
    expect(root.querySelector('#panel .opening-failed')).not.toBeNull();
    expect(root.classList.contains('wide')).toBe(false);
    expect(labels('#head .opening-tabs .tab')).toEqual(['Conversation', 'Status', 'Console']);
    resizeTo(1440);
    expect(root.classList.contains('wide')).toBe(true);
    expect(labels('#detail .detail-head .opening-tabs .tab')).toEqual(['Status', 'Console']);
    expect(root.querySelector('#detail .detail-body')?.textContent).toBe('');
    expect(root.querySelector('#head .opening-tabs')).toBeNull();
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
    // The band the operator opened starts closed again after the reload.
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

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

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

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
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

  it('keeps dictation listening while the box has the focus: says so, joins each piece to the end of what was typed, keeps the caret, and tells the hub (architecture.md § Dictation)', async () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const hint = root.querySelector<HTMLElement>('.composer-hint')!;
    const told = () => posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body);

    // Unfocused, spoken turns send on their own, so there is no hint.
    expect(hint.hidden).toBe(true);
    input.focus();
    await flush();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('press Send');
    expect(told().at(-1)).toMatchObject({ focused: true, draft: '', listen: true });

    // The first piece fills the empty box.
    source.emit('draft', { text: 'fix the', sessionId: 's', added: 'fix the' });
    expect(input.value).toBe('fix the');
    // Typed before the hub heard it, with the caret inside the text: the next piece joins the end, and the caret stays.
    input.value = 'fix the sign-in';
    input.setSelectionRange(3, 3);
    source.emit('draft', { text: 'fix the flow', sessionId: 's', added: 'flow' });
    expect(input.value).toBe('fix the sign-in flow');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    await flush();
    expect(told().at(-1)).toMatchObject({ focused: true, draft: 'fix the sign-in flow', listen: true });
    // Typed again, and two pieces the hub joined to drafts that crossed the page's: each joins once, and nothing typed is lost.
    input.value = 'fix the sign-in flow, please';
    input.setSelectionRange(input.value.length, input.value.length);
    source.emit('draft', { text: 'fix the sign-in flow now', sessionId: 's', added: 'now' });
    source.emit('draft', { text: 'fix the sign-in flow then', sessionId: 's', added: 'then' });
    expect(input.value).toBe('fix the sign-in flow, please now then');
    // A caret at the end stays where it was too, before the words dictated after it.
    expect([input.selectionStart, input.selectionEnd]).toEqual([28, 28]);
    // A draft the hub set otherwise replaces the box only while it holds nothing typed since, as the hub's emptied draft after a turn sent,
    // even once the page told the hub the typing, since the draft may predate it.
    input.value = 'my own words';
    source.emit('draft', { text: 'something else', sessionId: 's' });
    expect(input.value).toBe('my own words');
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(told().at(-1)).toMatchObject({ draft: 'my own words' });
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('my own words');
    input.value = '';
    source.emit('draft', { text: 'from the hub', sessionId: 's' });
    expect(input.value).toBe('from the hub');
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');

    // Leaving the box hides the hint; with the mic off it shows on no focus.
    input.blur();
    await flush();
    expect(hint.hidden).toBe(true);
    expect(told().at(-1)).toMatchObject({ focused: false, listen: true });
    // Unfocused, a piece joins an edited box too, and the hub's emptied draft once the turn sent it clears it.
    input.value = 'one edited';
    source.emit('draft', { text: 'one edited two', sessionId: 's', added: 'two' });
    expect(input.value).toBe('one edited two');
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');
    // A piece joined to a draft the hub had before the edit reached it: the box keeps the edit, and the hub is told the box.
    input.value = 'mine';
    source.emit('draft', { text: 'three', sessionId: 's', added: 'three' });
    expect(input.value).toBe('mine three');
    await flush();
    expect(told().at(-1)).toMatchObject({ focused: false, draft: 'mine three' });
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null } });
    input.focus();
    expect(hint.hidden).toBe(true);
    page.close();
  });

  it("fills the box with a draft that came while a message was being sent once the send answered, keeps each conversation's draft baseline, and clears live words on a switch", async () => {
    const { page, source } = start();
    const helloOn = (workItemId: number, sessionId: string) =>
      source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId, sessionId }, sessions: [session({ id: sessionId })], items: [], more: false, status: null, artifacts: [] });

    helloOn(1, 's');

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
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
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

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

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
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
    const error = () => root.querySelector('.toast.warning .toast-text')?.textContent ?? null;

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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadMermaid: mermaid, openUrl: (url) => opened.push(url), standalone: () => installed });

    return { page, source: FakeSource.last!, mermaid, opened };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  /** The panel's text as read: a folded reply's fade is only a glimpse, hidden from screen readers. */
  const shownText = () => {
    const panel = root.querySelector('#panel')!.cloneNode(true) as Element;

    panel.querySelectorAll('.reply-fade-text').forEach((glimpse) => glimpse.remove());
    return panel.textContent;
  };
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

  it('marks the artifacts this device has not shown at their version with the unread dot, on their tabs and in the More menu, until shown here or on another of its pages', () => {
    window.innerWidth = 1920;
    // Kept before the page loaded, by an earlier page that kept paths alone: work item 1 seen with chat/a5.md opened; another work item's
    // opened path does not count.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '1': ['chat/plan.md', 'chat/p.html', 'chat/a5.md'], '2': ['chat/a6.md'] }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 4; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 1 } as DOMRect);
    // Too narrow for any tab but Console, chosen: every artifact is in More.
    click('#detail [data-side="console"]');

    const dotted = () => [...root.querySelectorAll<HTMLElement>('#detail .tab-menu .menu-row[data-path]')].filter((row) => row.querySelector('.title > .unread-dot') !== null).map((row) => row.dataset['path']);

    // More carries the dot while a row in it is unread.
    expect(root.querySelector('#detail .tab-more-button .tab-badge > .unread-dot')).not.toBeNull();
    click('#detail [data-action="tab-menu"]');
    expect(dotted()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a4.md']);
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a4.md"]')!.getAttribute('aria-label')).toBe('Note 4, unread, note, just now');
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a5.md"]')!.getAttribute('aria-label')).toBe('Note 5, note, just now');
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a4.md"] .unread-dot')!.getAttribute('aria-label')).toBe('Unread');
    // No row says whether its tab is closed.
    expect(root.querySelector('#detail .tab-menu')!.textContent).not.toContain('Closed');

    // The work item's hello kept the versions it had of the paths kept alone; a path it did not have stays shown at whatever version comes.
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1 }, '2': { 'chat/a6.md': -1 } });

    // Opening one clears its dot and keeps its version for this device, merged with what another page kept meanwhile.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006 }, '2': { 'chat/a6.md': -1 } }));
    click('#detail .tab-menu [data-path="chat/a4.md"]');
    click('#detail [data-action="tab-menu"]');
    expect(dotted()).toEqual(['chat/a7.md']);
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006, 'chat/a4.md': 10_004 }, '2': { 'chat/a6.md': -1 } });

    // Another of this device's pages showing one clears it here too.
    const kept = JSON.stringify({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006, 'chat/a4.md': 10_004, 'chat/a7.md': 10_007 } });

    localStorage.setItem('switchboard.artifactsSeen', kept);
    window.dispatchEvent(new StorageEvent('storage', { key: 'switchboard.artifactsSeen', newValue: kept }));
    expect(dotted()).toEqual([]);

    // A changed artifact is unread again, with the dot on its own tab where the strip has room for it, until its tab shows it.
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    click('#detail [data-side="status"]');
    source.emit('artifact', { artifact: { path: 'chat/a4.md', owner: 'chat', kind: 'note', title: 'Note 4', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    const tabDot = (path: string) => root.querySelector(`#detail .artifact-tab[data-path="${path}"] .tab-open > .tab-label + .unread-dot`);

    expect(tabDot('chat/a4.md')).not.toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/a4.md"] .tab-open')!.getAttribute('aria-label')).toBe('Note 4, unread');
    expect(tabDot('chat/a7.md')).toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/a7.md"] .tab-open')!.getAttribute('aria-label')).toBe('Note 7');
    // An artifact kept without a version does not turn unread when it changes, until it has a version kept.
    source.emit('artifact', { artifact: { path: 'chat/a5.md', owner: 'chat', kind: 'note', title: 'Note 5', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    expect(tabDot('chat/a5.md')).toBeNull();
    click('#detail .artifact-tab[data-path="chat/a4.md"] .tab-open');
    expect(tabDot('chat/a4.md')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)['1']['chat/a4.md']).toBe(20_000);
    // A new version that comes while its tab shows it is shown at once.
    source.emit('artifact', { artifact: { path: 'chat/a4.md', owner: 'chat', kind: 'note', title: 'Note 4', ext: 'md', type: 'markdown', updatedAt: 30_000 } });
    expect(tabDot('chat/a4.md')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)['1']['chat/a4.md']).toBe(30_000);
    page.close();
  });

  it('opens again an artifact closed on every device when a newer version comes, unread', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    // The same version again leaves it closed.
    source.emit('artifact', { artifact: artifact('chat/plan.md', 'markdown', 'md') });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 2_000 } });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"] .tab-open > .tab-label + .unread-dot')).not.toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/p.html"] .unread-dot')).toBeNull();
    page.close();
  });

  it('counts the artifacts a work item has when this device first sees it as opened, and marks only later ones', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/p.html': 1_500, 'chat/plan.md': 1_500 } });
    source.emit('artifact', { artifact: { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 } });
    vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 1 } as DOMRect);
    // Too narrow for any tab but Console, chosen: every artifact is in More.
    click('#detail [data-side="console"]');
    click('#detail [data-action="tab-menu"]');
    // By the hub's file times alone: an artifact with an older time than the page's clock is still new.
    expect(root.querySelector('#detail .tab-menu [data-path="chat/new.md"] .unread-dot')).not.toBeNull();
    expect(root.querySelector('#detail .tab-menu [data-path="chat/plan.md"] .unread-dot')).toBeNull();
    page.close();

    // A later page whose copy is stale, as when another page kept the work item first without this one hearing of it, adds nothing at its hello.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '2': {} }));

    const again = start();
    const fresh = JSON.stringify({ '1': { 'chat/p.html': 1_500, 'chat/plan.md': 1_500 }, '2': {} });

    localStorage.setItem('switchboard.artifactsSeen', fresh);
    hello(again.source, { artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html'), { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 }] });
    expect(localStorage.getItem('switchboard.artifactsSeen')).toBe(fresh);
    again.page.close();
  });

  it("shows History as a tab of the column after Status only once the Actions menu opens it, with Console last, and an artifact's tab replaces it", () => {
    window.innerWidth = 1920;
    history.replaceState(null, '', '#w=1');
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();
    const tabs = () => [...root.querySelectorAll('#detail .side-switch > .tab:not(.artifact-tab):not(.panel-max)')].map((one) => one.textContent);

    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])] });
    expect(tabs()).not.toContain('History');
    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 1, key: 'gh 1' } })])] });
    source.emit('artifact', { artifact: { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 } });
    // Hidden until chosen from the menu; Console follows Changes, before the maximize button.
    expect(tabs()).toEqual(['Status', 'Changes', 'Console']);
    expect(root.querySelector('#detail .side-switch > :last-child')?.classList.contains('panel-max')).toBe(true);
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/new.md"]')).not.toBeNull();
    click('[data-action="actions"]');
    click('.actions-menu [data-action="row-history"]');
    expect(tabs()).toEqual(['Status', 'History', 'Changes', 'Console']);
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('#detail [data-side="history"]'));
    expect(root.querySelector('#detail .detail-body .history-view')).not.toBeNull();
    // History lies in its tab, not over the conversation: the conversation and its column stay.
    expect(root.classList.contains('history')).toBe(false);
    expect(root.querySelector('#panel .history-view')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': {} });
    click('#detail .artifact-tab[data-path="chat/new.md"] .tab-open');
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-path')).toBe('chat/new.md');
    expect(root.querySelector('.history-view')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/new.md': 1 } });

    // A row that stops offering History takes the tab with it, and the column shows Status in its place.
    click('#detail [data-side="history"]');
    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])] });
    expect(tabs()).not.toContain('History');
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    page.close();
  });

  it('fits the tabs to the strip, keeping the chosen one and Status, and lists the rest in More, every tab reachable through it', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    const paths = () => [...root.querySelectorAll<HTMLElement>('#detail .artifact-tab')].map((tab) => tab.dataset['path']);
    const selected = () => root.querySelector<HTMLElement>('#detail .tabs > .tab.selected');
    const menuRows = () => [...root.querySelectorAll<HTMLElement>('#detail .tab-menu .menu-row')];

    // Unmeasured, the strip shows every tab and no More.
    expect(paths()).toHaveLength(10);
    expect(root.querySelector('#detail .tab-more')).toBeNull();

    // A 400 px strip. jsdom draws every tab 0 wide, so each measures as its 44 px least label alone, and More as page.css's 71 px: 329 px keep
    // seven tabs, Console chosen, Status, then the five newest artifacts.
    const narrow = vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);

    click('#detail [data-side="console"]');
    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md', 'chat/a3.md']);
    expect(root.querySelector('#detail .side-switch > [data-side="status"]')).not.toBeNull();
    expect(root.querySelector('#detail .tab-more-button .tab-badge')!.textContent).toBe('6');

    // More lists the rest in strip order: the older artifacts, then Changes; picking one chooses it, closes the menu, and gives it a tab in place
    // of Console, which More now holds.
    click('#detail [data-action="tab-menu"]');
    expect(menuRows().slice(0, 3).map((row) => row.dataset['path'])).toEqual(['chat/a2.md', 'chat/a1.md', 'chat/a0.md']);
    expect(menuRows().at(-1)!.dataset['action']).toBe('diff-tab');
    expect(menuRows()).toHaveLength(6);
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md', 'chat/a3.md', 'chat/a1.md']);
    expect(selected()!.dataset['path']).toBe('chat/a1.md');
    expect(root.querySelector('#detail .side-switch > [data-side="console"]')).toBeNull();

    // Console and Changes are reached through More too.
    click('#detail [data-action="tab-menu"]');
    click('#detail .tab-menu [data-side="console"]');
    expect(selected()!.dataset['side']).toBe('console');
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    answers['/v1/conversation/changes'] = { status: 404, body: { error: 'No changes here.' } };
    click('#detail [data-action="tab-menu"]');
    click('#detail .tab-menu [data-action="diff-tab"]');
    expect(root.querySelector('#detail .changes-tab.selected')).not.toBeNull();
    expect(root.querySelector('#detail .tab-menu')).toBeNull();

    // Up and Down move through the menu's rows; Escape closes it and gives the focus back to More; so does a press elsewhere.
    click('#detail [data-action="tab-menu"]');
    const more = root.querySelector<HTMLElement>('#detail .tab-more-button')!;

    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[0]);
    menuRows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[1]);
    menuRows()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[0]);
    menuRows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('#detail .tab-more-button'));
    click('#detail [data-action="tab-menu"]');
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('#detail .tab-menu')).toBeNull();

    // A narrower strip keeps the chosen tab and Status, the rest going into More.
    click('#detail [data-action="tab-menu"]');
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    narrow.mockReturnValue({ width: 200 } as DOMRect);
    click('#detail .artifact-tab[data-path="chat/a1.md"] .tab-open');
    expect(paths()).toEqual(['chat/a1.md']);
    expect(selected()!.dataset['path']).toBe('chat/a1.md');
    expect([...root.querySelectorAll<HTMLElement>('#detail .side-switch > [data-id]')].map((tab) => tab.dataset['id'])).toEqual(['status', 'artifact:chat/a1.md']);
    narrow.mockReturnValue({ width: 400 } as DOMRect);
    click('#detail .artifact-tab[data-path="chat/a1.md"] .tab-open');

    // Left, Right, Home and End move between the strip's tabs, the artifact tabs among them, in the strip's order (tabs.ts) as on screen.
    const strip = () => [...root.querySelectorAll<HTMLElement>('#detail .tabs [role="tab"]')];

    strip()[0]!.focus();
    strip()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[1]);
    strip()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect((document.activeElement as HTMLElement).closest<HTMLElement>('.artifact-tab')!.dataset['path']).toBe('chat/a1.md');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect((document.activeElement as HTMLElement).closest<HTMLElement>('.artifact-tab')!.dataset['path']).toBe('chat/a3.md');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[0]);
    // The open artifact's close button is its own, and shows the tab before it in the strip, from More.
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);
    const before = kept().length;

    root.querySelector<HTMLElement>('#detail .artifact-tab.selected .tab-close')!.click();
    expect(selected()!.dataset['path']).toBe('chat/a2.md');
    // Closed, its tab is gone for the work item, kept in the hub for every device; the tab shown in its place is no choice, so it is not kept.
    expect(paths()).not.toContain('chat/a1.md');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ workItemId: 1, close: { path: 'chat/a1.md', updatedAt: 10_001 } })]);
    click('#detail [data-action="tab-menu"]');
    expect(root.querySelector('#detail .tab-menu .menu-separator + [data-path="chat/a1.md"]')).not.toBeNull();
    // Choosing it opens its tab again.
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-2)?.body).toMatchObject({ workItemId: 1, reopen: 'chat/a1.md' });
    // The hub sends this page's own changes back as `tabs`, each with its request's opId, its close after the reopen here: neither moves anything
    // or keeps anything. Nor does another device's older event in which the artifact was open, though it holds the reopen's state before the
    // reopen's own echo.
    const echoed = kept().length;
    const opOf = (key: string) => ([...kept()].reverse().find((body) => (body as Record<string, unknown>)[key] !== undefined) as { opId: string }).opId;
    const [closeOp, reopenOp] = [opOf('close'), opOf('reopen')];

    expect(closeOp).not.toBe(reopenOp);
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    source.emit('tabs', { workItemId: 1, opId: closeOp, tabs: { tab: null, closed: [{ path: 'chat/a1.md', updatedAt: 10_001 }] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    source.emit('tabs', { workItemId: 1, opId: reopenOp, tabs: { tab: 'artifact:chat/a1.md', closed: [] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(kept()).toHaveLength(echoed);
    // Another device closing the open artifact shows Status here, and keeps nothing.
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/a1.md', updatedAt: 10_001 }] } });
    expect(kept()).toHaveLength(echoed);
    expect(selected()!.getAttribute('data-side')).toBe('status');
    expect(paths()).not.toContain('chat/a1.md');
    narrow.mockRestore();
    click('#detail [data-side="status"]');
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

  it('measures hidden tabs again when the strip crosses the 480 px breakpoint, so a tab measured under the other padding neither overflows nor hides', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    // page.css's sizing: --sb-tab-pad is 14 px, or 9 px in a strip of 480 px or less. Each tab is drawn at its least width under the padding in
    // force, its label 44 px: an artifact's pad + 99 px, Status 2 * pad + 67 px, Changes 2 * pad + 111 px, More 2 * pad + 43 px.
    let pad = 14;
    let strip = 600;

    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ display: 'block', maxWidth: '', getPropertyValue: (name: string) => (name === '--sb-tab-pad' ? `${pad}px` : '') }) as unknown as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.matches('#detail .tabs')
        ? strip
        : this.matches('#detail .tabs > .tab-more')
          ? 2 * pad + 43
          : this.matches('#detail .tabs > .changes-tab')
            ? 2 * pad + 111
            : this.matches('#detail .tabs > [data-id]')
              ? this.querySelector(':scope > .tab-close') === null ? 2 * pad + 67 : pad + 99
              : this.matches('#detail .tabs .tab-label')
                ? 44
                : 0;

      return { width } as DOMRect;
    });

    const shown = () => [...root.querySelectorAll<HTMLElement>('#detail .tabs > [data-id]')].map((tab) => tab.dataset['id']);
    const redraw = () => click('#detail [data-side="status"]');

    // 600 px at 14 px padding: Status (95 px) and three artifacts (113 px each) beside More (71 px); the rest, hidden, were measured at 113 px.
    redraw();
    expect(shown()).toEqual(['status', 'artifact:chat/a7.md', 'artifact:chat/a6.md', 'artifact:chat/a5.md']);
    // 472 px takes 9 px padding: Status 85 px, More 61 px and 108 px an artifact leave 326 px, three artifacts' room. With a7 closed, a4 fits at
    // 108 px, which a measure kept from 14 px padding would hide.
    strip = 472;
    pad = 9;
    redraw();
    expect(shown()).toEqual(['status', 'artifact:chat/a7.md', 'artifact:chat/a6.md', 'artifact:chat/a5.md']);
    root.querySelector<HTMLElement>('#detail .artifact-tab[data-path="chat/a7.md"] .tab-close')!.click();
    expect(shown()).toEqual(['status', 'artifact:chat/a6.md', 'artifact:chat/a5.md', 'artifact:chat/a4.md']);
    // Back to 14 px padding at 615 px: 449 px less Status leaves room for three artifacts at 113 px, not a fourth that a measure kept from 9 px
    // padding (108 px) would let in.
    strip = 615;
    pad = 14;
    redraw();
    expect(shown()).toEqual(['status', 'artifact:chat/a6.md', 'artifact:chat/a5.md', 'artifact:chat/a4.md']);
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

    expect(doc).toContain('<h1 data-anchor="plan">Plan</h1>');
    expect(doc).toContain('src="/v1/conversation/artifact/pk/chat/plan/pic.png"');
    expect(doc).not.toContain('x.png');
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-path')).toBe('chat/plan.md');
    // Closing its tab shows the tab after it, with none before it, and the closed tab goes.
    click('#head .artifact-tab.selected .tab-close');
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-path')).toBe('chat/p.html');
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

  it("gives each of line 2's first fifteen link pills a text box of its own and the rest one box, each a pixel taller, so each text fits on its own (page.css, Line 2)", () => {
    const root = document.createElement('div');
    const links = Array.from({ length: 18 }, (_, i) => ({ label: `L${i}`, url: `https://x/${i}`, kind: 'url' as const, badge: `L${i}`, glyph: null, mentioned: false }));

    root.innerHTML = html(renderList([listGroup('progress', [listRow(1, { links })])], null, new Set()));

    // The sixth pill's text has a box of its own, so it shows where it fits though the seventh's does not (check-shell.mjs measures that).
    const boxes = [...root.querySelectorAll<HTMLElement>('.row-links-fit-text')];

    expect(boxes.map((box) => box.textContent)).toEqual([...Array.from({ length: 15 }, (_, i) => `L${i}`), 'L15L16L17']);
    expect(boxes.map((box) => box.style.height)).toEqual(Array.from({ length: 16 }, (_, i) => `${20 + i}px`));
    // A container query for each box's height shows the text of its pill, the last box's for every pill from the sixteenth.
    const css = readFileSync(join(__dirname, '../src/page.css'), 'utf8');

    for (let index = 1; index < 16; index++) {
      expect(css).toContain(`@container row-links (min-height: ${18 + index}.5px) { .row-line .row-links-shown > .pill:nth-child(${index}) .pill-text { display: inline; } }`);
    }

    expect(css).toContain('@container row-links (min-height: 34.5px) { .row-line .row-links-shown > .pill:nth-child(n + 16) .pill-text { display: inline; } }');
    // A link the hub sends no glyph for shrinks to the link icon.
    expect([...root.querySelectorAll('.row-links-shown .pill .codicon')].map((icon) => icon.textContent)).toEqual(Array(18).fill('\u{eb15}'));
  });

  it("draws line 2's pills the same on every redraw, however narrow the row, without measuring them (page.css, Line 2)", async () => {
    const { page, source } = start();
    // Widths that would not fit: a 150 px line, 80 px pills and a 100 px playbook.
    const widths = vi.fn((element: HTMLElement): number => (element.classList.contains('row-line') ? 150 : element.classList.contains('pill') ? 80 : element.classList.contains('playbook') ? 100 : 0));

    for (const property of ['clientWidth', 'offsetWidth', 'scrollWidth'] as const) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
        return widths(this);
      });
    }
    const groups = [listGroup('progress', [listRow(1, { links: [{ kind: 'pr', badge: '21510', label: 'PR #21510', url: 'https://x/21510', glyph: '\u{ea64}', mentioned: false }, { kind: 'url', badge: 'Design notes', label: 'Design notes', url: 'https://x/notes', glyph: '\u{eb15}', mentioned: false }], returned: 2 })])];

    hello(source, { groups });
    await flush();
    await new Promise((done) => setTimeout(done, 20));

    const line = (): string => root.querySelector('[data-work-item="1"] .row-line:not(.row-details)')!.outerHTML;
    const first = line();
    const changes: string[] = [];
    const watch = new MutationObserver((records) => records.forEach((record) => changes.push(`${record.type} ${(record.target as Element).className ?? ''} ${record.attributeName ?? ''}`)));

    watch.observe(root.querySelector('#list')!, { subtree: true, attributes: true, childList: true, characterData: true });
    // A busy hub resends the same list with every session event.
    for (let again = 0; again < 5; again++) {
      source.emit('list', { groups });
      await flush();
      await new Promise((done) => setTimeout(done, 20));
    }
    watch.disconnect();

    expect(changes).toEqual([]);
    expect(line()).toBe(first);
    // Every pill whole, its text shown: the key's number, the PR's number, the link's label and Returned's count.
    expect([...root.querySelectorAll('[data-work-item="1"] .row-line > .pill, [data-work-item="1"] .row-links-shown > .pill')].map((pill) => [pill.className, pill.querySelector('.pill-text')!.textContent])).toEqual([
      ['pill ticket source-github', 'gh 1'],
      ['pill link pr', '21510'],
      ['pill link url', 'Design notes'],
      ['pill returned', '2'],
    ]);
    // The page reads no width of line 2: its CSS alone decides what shows.
    expect(widths.mock.calls.filter(([element]) => element.closest('.row-line') !== null)).toEqual([]);
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
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim())).toEqual(['Show message details', 'Collapse details']);
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
    // Dragged to the page's edge, the list stops at its least width and stays pinned: a drag never makes it a drawer.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    expect(root.classList.contains('drawers')).toBe(false);
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

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan\n\n[page](p.html) [notes](plan/notes.txt) [up](../x.md) [web](https://example.com/a) [uri](file:///D:/w/src/a.ts#L3)\n\n| a | b |\n|---|---|\n| 1 | 2 |' };
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
    // A file: URI names no artifact: it opens in a file tab.
    expect([...doc.querySelectorAll<HTMLElement>('a.path-link')].map((one) => one.dataset['target'])).toEqual(['../x.md', 'file:///D:/w/src/a.ts#L3']);
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

    expect(html).toContain('<h1 data-anchor="plan-v2" id="plan-v2">Plan v2</h1>');
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

  it('scrolls to the heading or footnote a #name link in a Markdown artifact names, by click or Enter, without changing the route, and links them in a new window', async () => {
    const { page, source } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan\n\n[to notes](#notes) and a note[^1] [hidden](#hidden)\n\n## Notes\n\n<details>\n<summary>Out</summary>\n\n<details>\n<summary>In</summary>\n\n### Hidden\n\n</details>\n</details>\n\n[^1]: The note.' };
    hello(source);
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;
    const shown: string[] = [];

    expect(doc.classList.contains('md-doc')).toBe(true);
    Object.assign(HTMLElement.prototype, { scrollIntoView(this: HTMLElement) { shown.push(this.getAttribute('data-anchor') ?? ''); } });
    onTestFinished(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    const hash = location.hash;

    click('.artifact-doc a.anchor-link[data-target="notes"]');
    click('.artifact-doc sup.footnote-ref a');
    doc.querySelector<HTMLElement>('.footnote-backref')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(shown).toEqual(['notes', '^fn1', '^fnref1']);
    // A place inside closed sections opens each of them first.
    expect([...doc.querySelectorAll('details')].map((one) => one.open)).toEqual([false, false]);
    click('.artifact-doc a.anchor-link[data-target="hidden"]');
    expect([...doc.querySelectorAll('details')].map((one) => one.open)).toEqual([true, true]);
    expect(shown.at(-1)).toBe('hidden');
    expect(location.hash).toBe(hash);

    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    let blob: Blob | null = null;

    Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => ((blob = value), 'blob:x')), revokeObjectURL: vi.fn() });
    click('[data-action="artifact-window"]');
    expect(opened).toHaveBeenCalled();

    const html = await blob!.text();

    expect(html).toContain('<h2 data-anchor="notes" id="notes">Notes</h2>');
    expect(html).toMatch(/<a class="anchor-link" tabindex="0" role="link" data-target="notes" href="#notes">to notes<\/a>/);
    page.close();
  });

  it("moves a dragged Ready for review row with row-move, drawing its drop line, without the release's click, and shows a refused move in the toast (PRD R73)", async () => {
    const { page, source } = start();
    const move = (label: string) => ({ label, action: 'move' as const, icon: 'arrow-up', group: 'order' as const, confirm: null, input: null });
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    hello(source, { groups: [listGroup('review', [listRow(1, { actions: [move('Move down')] }), listRow(2), listRow(3, { actions: [move('Move up')] })]), listGroup('progress', [listRow(4)])] });
    // The list from the top, Ready for review's heading 32 px tall, then its rows 40 px apart and In progress's.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = Number((this as HTMLElement).dataset?.['workItem'] ?? NaN);

      return this.id === 'list' ? rect(0, 600) : this.classList.contains('group-head') ? rect(this.closest('[data-group="review"]') === null ? 160 : 0, 32) : this.classList.contains('row') && id > 0 ? rect(id * 40, 40) : rect(0, 0);
    });

    const list = root.querySelector<HTMLElement>('#list')!;
    const row = (id: number) => list.querySelector<HTMLElement>(`.row[data-work-item="${id}"]`)!;
    const pointer = (target: Element, type: string, y: number) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 20, clientY: y }));

    expect([1, 2, 3].map((id) => row(id).classList.contains('movable'))).toEqual([true, true, true]);
    expect(row(4).classList.contains('movable')).toBe(false);
    pointer(row(3), 'pointerdown', 140);
    pointer(list, 'pointermove', 50);
    expect(row(3).classList.contains('dragging')).toBe(true);
    expect([...list.querySelectorAll<HTMLElement>('.drop-above, .drop-below')].map((one) => [one.dataset['workItem'], one.classList.contains('drop-above')])).toEqual([['1', true]]);
    pointer(list, 'pointerup', 50);
    row(3).click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-move')).map((post) => post.body)).toEqual([{ window: 'pk', opId: expect.any(String), workItemId: 3, after: null }]);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    expect(list.querySelector('.dragging, .drop-above, .drop-below')).toBeNull();

    // Below the last row, the hub refuses: the toast says why.
    answers['/row-move'] = { status: 409, body: { error: 'The work item is not in Ready for review.' } };
    pointer(row(1), 'pointerdown', 60);
    pointer(list, 'pointermove', 150);
    expect(row(3).classList.contains('drop-below')).toBe(true);
    pointer(list, 'pointerup', 150);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-move')).at(-1)?.body).toMatchObject({ workItemId: 1, after: 3 });
    expect(root.querySelector('#toast .toast-text')?.textContent).toBe('The work item is not in Ready for review.');
    page.close();
  });

  it('moves the selected Ready for review row with Alt+Up and Alt+Down, not while typing, with other keys held, or for a row in another group (PRD R73)', async () => {
    const { page, source } = start();
    const move = (label: string) => ({ label, action: 'move' as const, icon: 'arrow-up', group: 'order' as const, confirm: null, input: null });
    const press = (target: EventTarget, key: string, patch: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...patch }));
    const moves = () => posts.filter((post) => post.url.endsWith('/row-action')).map((post) => [post.body['workItemId'], post.body['label']]);

    hello(source, { groups: [listGroup('review', [listRow(5, { actions: [move('Move down')] }), listRow(1, { actions: [move('Move to top'), move('Move up'), move('Move down')] })])] });
    expect(press(document.body, 'ArrowUp')).toBe(false);
    await flush();
    press(document.body, 'ArrowDown');
    await flush();
    expect(moves()).toEqual([[1, 'Move up'], [1, 'Move down']]);

    press(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!, 'ArrowUp');
    press(document.body, 'ArrowUp', { shiftKey: true });
    press(document.body, 'ArrowUp', { ctrlKey: true });
    press(document.body, 'ArrowUp', { altKey: false });
    await flush();
    expect(moves()).toHaveLength(2);

    // The last row has no Move down, and a row in another group none at all.
    source.emit('list', { groups: [listGroup('review', [listRow(5, { actions: [move('Move down')] }), listRow(1, { actions: [move('Move up')] })])] });
    expect(press(document.body, 'ArrowDown')).toBe(true);
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { actions: [move('Move up')] })])] });
    press(document.body, 'ArrowUp');
    await flush();
    expect(moves()).toHaveLength(2);
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

  it("runs the selected work item's row actions from the header: the main button, Stop session and Delete after their question, Snooze with a choice, and Copy", async () => {
    const { page, source } = start();
    const actions = [
      { label: 'Approve', action: 'approve', icon: 'check', group: 'main' as const, confirm: null, input: null },
      { label: 'Stop session', action: 'stop', icon: 'debug-stop', group: 'work' as const, confirm: { question: 'Stop the session for gh 1?', detail: 'It stops.', action: 'Stop session' }, input: null },
      { label: 'Mark done', action: 'mark-done', icon: 'pass', group: 'state' as const, confirm: null, input: null },
      { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null },
      { label: 'Move up', action: 'move', icon: 'arrow-up', group: 'order' as const, confirm: null, input: null },
      { label: 'Delete', action: 'delete', icon: 'trash', group: 'asking' as const, confirm: { question: 'Delete gh 1?', detail: 'Gone.', action: 'Delete' }, input: null },
    ];
    const clipboard = vi.fn(async () => undefined);

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelector('.header .row-main')!.textContent).toBe('Approve');
    // Its label is its tooltip too and a span of its own, which the phone's layout keeps for a screen reader and does not draw (page.css).
    expect(root.querySelector('.header .row-main')!.getAttribute('title')).toBe('Approve');
    expect(root.querySelector('.header .row-main > .row-main-label')!.textContent).toBe('Approve');
    click('.header .row-main');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, label: 'Approve' });
    expect(root.querySelector('.header .row-main .codicon-check')).not.toBeNull();

    click('button.actions');
    // The row menu's groups: main, work, state, order, what the row opens, and what asks first.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Approve', 'Stop session', 'Mark done', 'Snooze…', 'Move up', 'Copy Reply', 'Delete']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(5);
    click('.actions-menu [data-label="Move up"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-action')).at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Move up' });
    click('button.actions');
    click('.actions-menu [data-label="Stop session"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Stop the session for gh 1?');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(root.querySelector('.sheet')).toBeNull();
    expect(posts).toEqual([]);

    click('button.actions');
    click('.actions-menu [data-label="Delete"]');
    // The question starts on Cancel, and neither Enter nor Ctrl+Enter deletes.
    expect(document.activeElement).toBe(root.querySelector('.sheet [data-action="sheet-cancel"]'));
    root.querySelector('.sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    root.querySelector('.sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(posts).toEqual([]);
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Delete gh 1?');
    answers['/row-action'] = { status: 409, body: { error: 'The work item no longer offers this.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Delete', workItemId: 1 });
    // A refusal shows in the toast, in the warning colours, rather than over the composer.
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The work item no longer offers this.');
    expect(root.querySelector('.toast')!.getAttribute('role')).toBe('alert');
    expect(root.querySelector('#composer .toast, #composer [role="alert"]')).toBeNull();
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
    // A copy that worked says so in the neutral toast.
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Copied Reply.');

    // A draft the hub could not read says why, in the warning colours.
    answers['/row-paste'] = { status: 409, body: { error: 'Reply could not be read: the file is gone.' } };
    click('button.actions');
    click('.actions-menu [data-action="row-paste"]');
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('Reply could not be read: the file is gone.');
    expect(clipboard).toHaveBeenCalledTimes(1);

    // The menu belongs to the work item it was opened on.
    click('button.actions');
    click('#list [data-work-item="1"]');
    expect(root.querySelector('.actions-menu')).toBeNull();
    page.close();
  });

  it('opens a Copy submenu of the labels for several drafts, copies the one chosen with "Copied <label>.", and shows a draft the clipboard refused to copy by hand', async () => {
    const { page, source } = start();
    let allowed = true;
    const clipboard = vi.fn(async () => (allowed ? undefined : Promise.reject(new Error('NotAllowedError'))));

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { pastes: ['Reply', 'Summary'] })])] });
    click('button.actions');
    // One Copy item, closed, in place of an item per draft.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy']);
    expect(root.querySelector('.actions-menu [data-action="copy-menu"]')!.getAttribute('aria-expanded')).toBe('false');
    click('.actions-menu [data-action="copy-menu"]');
    expect(root.querySelector('.actions-menu [data-action="copy-menu"]')!.getAttribute('aria-expanded')).toBe('true');
    expect([...root.querySelectorAll('.actions-menu .submenu-row')].map((row) => row.textContent)).toEqual(['Reply', 'Summary']);

    answers['/row-paste'] = { status: 200, body: { text: 'Done: the fix.' } };
    click('.actions-menu .submenu-row[data-label="Summary"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-paste'))?.body).toMatchObject({ workItemId: 1, label: 'Summary' });
    expect(clipboard).toHaveBeenCalledWith('Done: the fix.');
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Copied Summary.');
    // The menu closed with its submenu, which opens closed next time.
    expect(root.querySelector('.actions-menu')).toBeNull();
    click('button.actions');
    expect(root.querySelector('.actions-menu .submenu-row')).toBeNull();

    // A refused clipboard confirms nothing: the sheet shows the text to copy.
    allowed = false;
    click('.actions-menu [data-action="copy-menu"]');
    click('.actions-menu .submenu-row[data-label="Reply"]');
    await flush();
    await flush();
    await flush();
    expect(root.querySelector('.sheet-title')?.textContent).toBe('Copy Reply');
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-text')?.value).toBe('Done: the fix.');
    expect(root.querySelector('.toast-text')?.textContent).not.toBe('Copied Reply.');
    page.close();
  });

  it("asks for a control's text in an input sheet, with its choice, and sends the text and a changed choice by the control's label", async () => {
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
    // Add comment… is its own group.
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(2);
    click('.actions-menu [data-label="Start with guidance…"]');
    expect(root.querySelector<HTMLSelectElement>('.sheet-select')!.value).toBe('dev:build');
    // Neither a text nor a changed choice: the button waits.
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

  it("runs Open in VS Code through the hub and opens Open report's draft in a file tab from the menu's opens group, and shows a refusal", async () => {
    const { page, source } = start();
    const opens = [{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open report', icon: 'symbol-file', file: 'D:/git/wt/1/reply.md' }];

    answers['/local-file?'] = { status: 200, body: { path: 'D:/git/wt/1/reply.md', name: 'reply.md', kind: 'markdown', contents: '# Reply', tooLarge: false, size: 7, entries: null, more: false } };

    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', opens, pastes: ['Reply'], url: 'https://github.com/o/r/issues/1' })])] });
    click('button.actions');
    // One group: Copy, then what opens in VS Code, then the ticket.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in VS Code', 'Open report', 'Open ticket']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(0);
    expect(root.querySelector('.actions-menu [data-label="Open in VS Code"] .codicon-vscode')).not.toBeNull();
    // Open report reads its draft through local-file into a file tab, never through VS Code.
    click('.actions-menu [data-action="row-report"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-command'))).toBeUndefined();
    expect(posts.some((post) => post.url.startsWith('/v1/conversation/local-file?') && post.url.endsWith(`path=${encodeURIComponent('D:/git/wt/1/reply.md')}`))).toBe(true);
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(root.querySelector('[data-action="local-tab"]')?.textContent).toContain('reply.md');

    answers['/row-command'] = { status: 409, body: { error: 'VS Code did not start: Code.exe was not found beside code on PATH.' } };
    click('button.actions');
    click('.actions-menu [data-label="Open in VS Code"]');
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('VS Code did not start: Code.exe was not found beside code on PATH.');
    page.close();
  });

  it("opens each document in one tab whatever opened it: a link or Open report to an artifact's file in the artifact's tab, and a file by two spellings in one tab", async () => {
    window.innerWidth = 1440;
    const { page, source } = start();
    const draft = 'D:/w/.wip/artifacts/w1/chat/review.md';
    const read = (path: string, name: string, artifact?: string) => ({ status: 200, body: { path, name, kind: 'markdown', contents: '# Doc', tooLarge: false, size: 5, entries: null, more: false, ...(artifact === undefined ? {} : { artifact }) } });

    answers[`path=${encodeURIComponent(draft)}`] = read(draft, 'review.md', 'chat/review.md');
    answers[`path=${encodeURIComponent('.wip/artifacts/w1/chat/plan.md')}`] = read('D:/w/.wip/artifacts/w1/chat/plan.md', 'plan.md', 'chat/plan.md');
    answers['notes.md'] = read('D:/w/notes.md', 'notes.md');
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, {
      groups: [listGroup('review', [listRow(1, { title: 'Fix it', opens: [{ label: 'Open report', icon: 'symbol-file', file: draft }] })])],
      items: [reply('r1', 2, { opening: 'See [plan](.wip/artifacts/w1/chat/plan.md), [notes](notes.md) and [the same notes](D:/w/notes.md).' })],
      artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/review.md', 'markdown', 'md')],
    });

    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const files = () => [...root.querySelectorAll('#detail .local-tab .tab-label')].map((label) => label.textContent);
    const shownArtifact = () => root.querySelector<HTMLElement>('#detail .artifact-tab.selected')?.dataset['path'];

    // A link to an artifact's file shows the artifact's tab once read, and no file tab; the link again reads it again, so the hub checks it.
    click('#panel a.path-link[data-target=".wip/artifacts/w1/chat/plan.md"]');
    await flush();
    expect(files()).toEqual([]);
    expect(shownArtifact()).toBe('chat/plan.md');
    click('#detail [data-side="status"]');
    const read1 = reads();

    click('#panel a.path-link[data-target=".wip/artifacts/w1/chat/plan.md"]');
    await flush();
    expect(reads()).toBe(read1 + 1);
    expect(shownArtifact()).toBe('chat/plan.md');

    // Two spellings of one file give one tab, the first.
    click('#panel a.path-link[data-target="notes.md"]');
    await flush();
    click('#panel a.path-link[data-target="D:/w/notes.md"]');
    await flush();
    expect(files()).toEqual(['notes.md']);
    expect(root.querySelector('#detail .local-tab.selected .tab-label')?.textContent).toBe('notes.md');

    // Open report on a draft that is an artifact selects that artifact.
    click('button.actions');
    click('.actions-menu [data-action="row-report"]');
    await flush();
    expect(shownArtifact()).toBe('chat/review.md');
    expect(files()).toEqual(['notes.md']);
    page.close();
  });

it("opens an artifact's file link by a fresh read each time: a link retargeted since opens the file, and a refused read says why", async () => {
    window.innerWidth = 1440;
    const { page, source } = start();
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const link = `#panel a.path-link[data-target="${plan}"]`;
    const read = (path: string, artifact?: string) => ({ status: 200, body: { path, name: 'plan.md', kind: 'markdown', contents: '# Doc', tooLarge: false, size: 5, entries: null, more: false, ...(artifact === undefined ? {} : { artifact }) } });
    const shown = () => root.querySelector('#detail .side-switch > .selected[data-id]')?.getAttribute('data-id');
    const settle = async () => {
      await flush();
      await flush();
    };

    answers['local-file'] = read(`D:/w/${plan}`, 'chat/plan.md');
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, { items: [reply('r1', 2, { opening: `See [plan](${plan}).` })] });
    click(link);
    await settle();
    expect(shown()).toBe('artifact:chat/plan.md');
    click('#detail [data-side="status"]');

    // The link now resolves to a file outside the artifact folder: it opens that file, not the artifact it named before.
    answers['local-file'] = read('D:/elsewhere/plan.md');
    click(link);
    await settle();
    expect(shown()).toBe('file:D:/elsewhere/plan.md');
    click('#detail .local-tab.selected [data-action="local-close"]');
    click('#detail [data-side="status"]');

    // A read the hub refuses now, as on a paired device, says why and opens no artifact.
    answers['local-file'] = { status: 403, body: { error: 'This device can only open files in the work item’s folders.' } };
    click(link);
    await settle();
    expect(shown()).toBe(`file:${plan}`);
    expect(root.querySelector('#detail .local-view .empty')?.textContent).toBe('This device can only open files in the work item’s folders.');
    page.close();
  });

  it('leaves the tab the operator moved to when a file read answers late as an artifact, and keeps the artifact for the column of a narrow page', async () => {
    window.innerWidth = 1440;
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const artifactRead = { status: 200, body: { path: `D:/w/${plan}`, name: 'plan.md', kind: 'markdown', contents: '# Plan', tooLarge: false, size: 6, entries: null, more: false, artifact: 'chat/plan.md' } };
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).length;
    let release = (): void => {};

    answers['local-file'] = { ...artifactRead, wait: new Promise((resolve) => (release = resolve)) };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };

    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: `See [plan](${plan}).` })] });
    click(`#panel a.path-link[data-target="${plan}"]`);
    await flush();
    click('#detail [data-side="status"]');

    const before = kept();

    release();
    await flush();
    await flush();
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('#detail .local-tab')).toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).not.toBeNull();
    expect(kept()).toBe(before);
    page.close();

    // A file tab restored on a narrow page waits for the column while the Conversation shows; read as an artifact, the artifact waits there instead.
    window.innerWidth = 1000;
    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: { side: 'file', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [{ target: plan, line: null }], file: 0, history: false } }));
    answers['local-file'] = artifactRead;

    const keptBefore = kept();
    const narrow = start();

    hello(narrow.source);
    await flush();
    await flush();
    expect(root.querySelector('#head [data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(root.querySelector('#head .local-tab')).toBeNull();
    resizeTo(1920);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    expect(kept()).toBe(keptBefore);
    narrow.page.close();
  });

  it('reads a file tab whose read is still on its way across a reconnect again once that read answers, loading or loaded, and never shows the earlier answer', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');
    const { page, source } = start();
    const items = [reply('r1', 2, { opening: 'See [notes](notes.md).' })];
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const text = () => root.querySelector('#detail .detail-body .local-view > .artifact-doc')?.textContent?.trim();
    let release = (): void => {};

    answers['local-file'] = { status: 403, body: { error: 'Not this page.' }, wait: new Promise((resolve) => (release = resolve)) };
    hello(source, { items });
    click('#panel a.path-link');
    await flush();
    expect(reads()).toBe(1);

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Fresh', tooLarge: false, size: 7, entries: null, more: false } };
    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 }, items });
    await flush();
    await flush();
    // A tab is read once at a time, so the new stream's read waits for the earlier one.
    expect(reads()).toBe(1);

    release();
    await flush();
    await flush();
    await flush();
    expect(reads()).toBe(2);
    expect(text()).toBe('Fresh');
    expect(root.querySelector('#detail .local-view .empty')).toBeNull();

    // A loaded tab read again as a turn ends, its read still on its way at a reconnect, is read again then, and the earlier answer never shows.
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Stale', tooLarge: false, size: 7, entries: null, more: false }, wait: new Promise((resolve) => (release = resolve)) };
    source.emit('session', { session: session({ state: 'running' }) });
    source.emit('session', { session: session({ state: 'idle' }) });
    await flush();
    expect(reads()).toBe(3);
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Current', tooLarge: false, size: 9, entries: null, more: false } };
    source.emit('hello', { key: 'pk10', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    hello(source, { key: 'pk10', scope: { ...scope, scopeGen: 7 }, items });
    await flush();
    expect(reads()).toBe(3);
    expect(text()).toBe('Fresh');

    release();
    await flush();
    await flush();
    await flush();
    expect(reads()).toBe(4);
    expect(text()).toBe('Current');
    page.close();
  });

  it('closes the tab shown to its neighbour in the strip, the one before it else after it, keeps the selection when another tab closes, and keeps no choice for the tab shown next', async () => {
    window.innerWidth = 1440;
    const { page, source } = start();

    answers['/local-file?'] = { status: 404, body: { error: 'Not found.' } };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, { items: [reply('r1', 2, { opening: 'See [a](src/a.ts) and [b](src/b.ts).' })] });

    const shown = () => root.querySelector('#detail .side-switch > .selected[data-id]')?.getAttribute('data-id');
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);

    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    click('#panel a.path-link[data-target="src/a.ts"]');
    click('#panel a.path-link[data-target="src/b.ts"]');
    await flush();
    click('#detail .local-tab [data-action="local-tab"]');
    expect([...root.querySelectorAll('#detail .side-switch > [data-id]')].map((tab) => tab.getAttribute('data-id'))).toEqual(['status', 'artifact:chat/p.html', 'artifact:chat/plan.md', 'file:src/a.ts', 'file:src/b.ts', 'changes', 'console']);
    expect(shown()).toBe('file:src/a.ts');

    // Closing a tab not shown changes nothing else, a file's or an artifact's.
    const before = kept().length;

    click('#detail .local-tab:not(.selected) [data-action="local-close"]');
    expect(shown()).toBe('file:src/a.ts');
    click('#detail .artifact-tab[data-path="chat/plan.md"] .tab-close');
    expect(shown()).toBe('file:src/a.ts');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ close: { path: 'chat/plan.md', updatedAt: 1_500 } })]);

    // Closing the tab shown shows the one before it, an artifact here, then with no document left Status; neither is kept as a choice.
    click('#detail .local-tab.selected [data-action="local-close"]');
    expect(shown()).toBe('artifact:chat/p.html');
    expect(kept().slice(before)).toHaveLength(1);
    click('#detail .artifact-tab.selected .tab-close');
    expect(shown()).toBe('status');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ close: { path: 'chat/plan.md', updatedAt: 1_500 } }), expect.objectContaining({ close: { path: 'chat/p.html', updatedAt: 1_500 } })]);
    page.close();
  });

  it('shows the conversation in place of an artifact another device closes on a narrow page, and Status on a wide one, keeping no choice', () => {
    window.innerWidth = 1000;
    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).length;

    hello(source);
    click('#head .artifact-tab[data-path="chat/plan.md"] .tab-open');
    expect(root.querySelector('#head .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');

    const before = kept();

    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    expect(root.querySelector('#head .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    expect(root.querySelector('#head [data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('off-conversation')).toBe(false);
    // On a wider page the column shows Status, as it would have.
    resizeTo(1920);
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    expect(kept()).toBe(before);
    page.close();
  });

  it('reads the file tab shown again when chosen, after a turn and on a reconnect, keeping its place and its view through a failed read, and a newer read wins', async () => {
    window.innerWidth = 1440;
    // The page asks for its work item, so it shows it again on a new stream.
    history.replaceState(null, '', '#w=1');
    const { page, source } = start();
    const read = (contents: string, wait?: Promise<void>) => ({ status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents, tooLarge: false, size: 7, entries: null, more: false }, ...(wait === undefined ? {} : { wait }) });
    const items = [reply('r1', 2, { opening: 'See [notes](notes.md).' })];
    const doc = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .artifact-doc');
    const text = () => doc()?.textContent?.trim();
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const settle = async () => {
      await flush();
      await flush();
    };
    let release = (): void => {};

    answers['local-file'] = read('# One');
    hello(source, { items });
    click('#panel a.path-link');
    await settle();
    expect(text()).toBe('One');
    doc()!.scrollTop = 200;
    doc()!.dispatchEvent(new Event('scroll'));

    // A turn that ends reads it again, showing what it read until the answer comes, then the new text where the reader was.
    answers['local-file'] = read('# Two', new Promise((resolve) => (release = resolve)));
    source.emit('session', { session: session({ state: 'running' }) });
    expect(reads()).toBe(1);
    source.emit('session', { session: session({ state: 'idle' }) });
    await settle();
    expect(reads()).toBe(2);
    expect(text()).toBe('One');
    release();
    await settle();
    expect(text()).toBe('Two');
    expect(doc()!.scrollTop).toBe(200);

    // Chosen again, it reads again; a failed read keeps what it shows.
    answers['local-file'] = { status: 500, body: { error: 'The disk is busy.' } };
    click('#detail [data-side="status"]');
    click('#detail [data-action="local-tab"]');
    await settle();
    expect(reads()).toBe(3);
    expect(text()).toBe('Two');

    // A reconnect tries it again once the new stream shows the work item.
    answers['local-file'] = read('# Three');
    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(reads()).toBe(3);
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 }, items });
    await settle();
    expect(reads()).toBe(4);
    expect(text()).toBe('Three');

    // Chosen again while a read is on its way, the tab is read again once that read answers, and the earlier answer is dropped.
    answers['local-file'] = read('# Old', new Promise((resolve) => (release = resolve)));
    click('#detail [data-action="local-tab"]');
    answers['local-file'] = read('# New');
    click('#detail [data-action="local-tab"]');
    await settle();
    expect(reads()).toBe(5);
    release();
    await settle();
    expect(reads()).toBe(6);
    expect(text()).toBe('New');
    page.close();
  });

  it('drops a file read for a work item the page has left, and gives a restored file tab to its artifact without keeping a choice or opening a closed one', async () => {
    window.innerWidth = 1440;
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const tabs = (target: string) => ({ side: 'file', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [{ target, line: null }], file: 0, history: false });

    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: tabs(plan) }));
    answers['local-file'] = { status: 200, body: { path: `D:/w/${plan}`, name: 'plan.md', kind: 'markdown', contents: '# Plan', tooLarge: false, size: 6, entries: null, more: false, artifact: 'chat/plan.md' } };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };

    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);

    hello(source);
    await flush();
    await flush();
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    expect(root.querySelector('#detail .local-tab')).toBeNull();
    expect(kept()).toEqual([]);
    page.close();

    // Closed on every device, it stays closed: Status shows.
    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: tabs(plan) }));
    const again = start();

    hello(again.source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    await flush();
    await flush();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    expect(kept()).toEqual([]);

    // A read that answers after the page has left its work item is dropped, there and on the work item's return.
    let release = (): void => {};

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Late', tooLarge: false, size: 6, entries: null, more: false }, wait: new Promise((resolve) => (release = resolve)) };
    again.source.emit('reply', { reply: reply('r2', 3, { opening: 'See [notes](notes.md).' }) });
    click('#panel a.path-link[data-target="notes.md"]');
    click('[data-work-item="2"]');
    hello(again.source, { scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Now', tooLarge: false, size: 5, entries: null, more: false } };
    click('[data-work-item="1"]');
    hello(again.source, { scope: { ...scope, scopeGen: 5 }, items: [reply('r2', 3, { opening: 'See [notes](notes.md).' })] });
    await flush();
    await flush();
    release();
    await flush();
    await flush();
    expect(root.querySelector('#detail .local-view > .artifact-doc')?.textContent?.trim()).toBe('Now');
    again.page.close();
  });

  it('ends its listeners when it closes, so a page started again on the same root handles each click once', () => {
    window.innerWidth = 1440;
    const first = start();

    hello(first.source);
    first.page.close();

    const second = start();

    hello(second.source);
    posts = [];
    click('#detail [data-side="console"]');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body)).toEqual([expect.objectContaining({ tab: 'console' })]);
    second.page.close();
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

    expect(root.querySelector('#list .row-menu')).toBeNull();
    const shown = vi.fn();

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: shown, configurable: true });
    row().click();
    // The menu is fixed to the viewport and flips where it has no room, so the list does not scroll for it.
    expect(shown.mock.contexts).not.toContain(root.querySelector('#list .row-menu'));
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
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
    // A pool ticket's refusal shows in the toast too.
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The ticket is no longer in the pool.');

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

  it("offers no Open in terminal, which the Console tab replaces, while the session has a console", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', pastes: ['Reply'], opens: [{ label: 'Open in VS Code', icon: 'vscode' }] })])] });
    expect(root.querySelector('[data-tab="console"]')).not.toBeNull();
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in VS Code']);
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


  it('says it is the installed app as it opens its stream', async () => {
    installed = true;

    const { page, source } = start();

    expect(source.url).toBe('/v1/conversation/events?page=1&installed=1');
    page.close();

    installed = false;

    const again = start();

    expect(again.source.url).toBe('/v1/conversation/events?page=1');
    again.page.close();
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
    // Not allowed yet: no notification, but the message shows in the toast, neutral.
    source.emit('needs', { items: [{ workItemId: 2, message: 'Switchboard: Side — Review, then approve' }], sound: false });
    expect(notices).toEqual([]);
    expect(root.querySelector('.toast.info .toast-open')?.textContent).toBe('Switchboard: Side — Review, then approve');

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
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The work item no longer links to this.');
    page.close();
  });

  it("opens a link in the device's own browser from an installed page on another device, which the hub would open on the computer", async () => {
    const opened: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => true, local: false });
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
    const own = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, standalone: () => true, local: false });

    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/5', '_blank', 'noopener,noreferrer');
    own.close();
  });

  it("opens a row's links and pills in the extension's tab group on another device, and in a new tab once the extension no longer answers", async () => {
    const opened: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    let installedExtension = true;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const toExtension = async (_id: string, message: Record<string, unknown>) => (sent.push(message), installedExtension ? (message['type'] === 'links' ? { links: true } : { opened: true }) : null);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => true, local: false, toExtension });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];

    await flush();
    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1', links })])] });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="ticket"]');
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(sent).toEqual([{ type: 'links' }, { type: 'open', url: 'https://github.com/o/r/issues/1', until: 10_000 + LINK_ANSWER_MS - 500 }, { type: 'open', url: 'https://github.com/o/r/pull/5', until: 10_000 + LINK_ANSWER_MS - 500 }]);
    expect(opened).toEqual([]);
    expect(posts.map((post) => post.url)).not.toContain('/v1/conversation/row-open');

    // The extension was removed: the open falls back to a new tab, and once the page shows again it no longer asks the extension.
    installedExtension = false;
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(opened).toEqual(['https://github.com/o/r/pull/5']);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    sent.length = 0;
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(sent).toEqual([]);
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    page.close();
  });

  it('opens the link in a new tab when the extension does not answer in time, and opens tabs itself until the extension answers the next probe', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const opened: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    // The extension answers the probe but never an open.
    const toExtension = (_id: string, message: Record<string, unknown>) => (sent.push(message), message['type'] === 'links' ? Promise.resolve({ links: true }) : new Promise<unknown>(() => {}));
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => false, local: false, toExtension });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];
    const turn = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    await turn();
    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    click('#list [data-work-item="1"] .pill.link.pr');
    await turn();
    vi.advanceTimersByTime(LINK_ANSWER_MS - 1);
    expect(opened).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(opened).toEqual(['https://github.com/o/r/pull/5']);
    // The next link opens at once, without asking the extension.
    sent.length = 0;
    click('#list [data-work-item="1"] .pill.link.pr');
    expect(sent).toEqual([]);
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    // Once it answers the probe again, links go to it.
    document.dispatchEvent(new Event('visibilitychange'));
    await turn();
    click('#list [data-work-item="1"] .pill.link.pr');
    expect(sent.at(-1)).toEqual({ type: 'open', url: 'https://github.com/o/r/pull/5', until: 10_000 + LINK_ANSWER_MS - 500 });
    page.close();
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

  it("opens New conversation… as an empty draft in the shown work item, starting nothing until its first message is sent", async () => {
    const { page, source } = start();
    const input = root.querySelector<HTMLTextAreaElement>('#composer textarea')!;
    const typed = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };
    const draftPosts = () => posts.filter((post) => post.url.endsWith('/page-conversation'));

    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    answers['/page-conversation'] = { status: 200, body: { workItemId: 1, sessionId: 's2' } };
    hello(source);
    typed('The work item draft');
    click('[data-action="picker"]');
    expect([...root.querySelectorAll('.conversation-menu .menu-row')].map((row) => row.textContent)).toEqual(['Fix it', 'Side', 'New conversation…']);
    click('[data-action="new-conversation"]');
    await flush();

    // An empty draft in the same work item, its composer focused, its provider the shown conversation's; nothing is made.
    expect(root.querySelector('.conversation-menu')).toBeNull();
    expect(root.querySelector('#panel .new-draft')!.textContent).toContain('It starts when you send its first message');
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')!.textContent).toBe('New conversation');
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('New conversation · Fix it');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect([...root.querySelectorAll('.draft-note [data-action="draft-provider"]')].map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([['Claude', 'true'], ['Codex', 'false']]);
    expect(draftPosts()).toEqual([]);

    // Dictation for the session shown never fills the draft, which is no session's.
    source.emit('draft', { text: 'spoken words', sessionId: 's' });
    expect(input.value).toBe('');

    // Cancel leaves it, starting nothing, with the work item's own draft back.
    click('[data-action="draft-cancel"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(input.value).toBe('The work item draft');
    expect(draftPosts()).toEqual([]);

    // Another selection leaves it too.
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    typed('Never sent');
    click('#list [data-work-item="2"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(draftPosts()).toEqual([]);
    click('#list [data-work-item="1"]');
    await flush();

    // A refused send keeps the draft and its text, with why.
    answers['/page-conversation'] = { status: 409, body: { error: 'A session of this work item is in a turn.' } };
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    click('[data-action="draft-provider"][data-provider="codex"]');
    typed('Why did it fail?');
    click('button.send');
    await flush();
    await flush();
    expect(draftPosts().at(-1)?.body).toMatchObject({ window: 'pk', scopeGen: 3, provider: 'codex', text: 'Why did it fail?' });
    expect(draftPosts().at(-1)?.body).not.toHaveProperty('workItemId');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('A session of this work item is in a turn.');
    expect(root.querySelector('.draft-note')).not.toBeNull();
    expect(input.value).toBe('Why did it fail?');

    // Sent: the hub starts the session with the message and shows it; the draft goes and the work item's own draft comes back.
    const refused = draftPosts().at(-1)!.body['opId'];

    answers['/page-conversation'] = { status: 200, body: { workItemId: 1, sessionId: 's2' } };
    click('button.send');
    await flush();
    await flush();
    expect(draftPosts()).toHaveLength(2);
    expect(draftPosts().at(-1)!.body['opId']).toBe(refused);
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(root.querySelector('#panel .new-draft')).toBeNull();
    expect(input.value).toBe('The work item draft');
    page.close();
  });

  it("presets New conversation…'s provider to the session shown, an earlier one included, not to the work item's current one", async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['claude', 'codex'] } };
    hello(source, { sessions: [session({ provider: 'codex' })] });
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    expect(root.querySelector('.draft-note [aria-pressed="true"]')!.textContent).toBe('Codex');
    page.close();
  });

  it("opens every work item on the Conversation tab in the phone's layout, whatever tab it kept or the column would show, and keeps a tab chosen until another work item opens", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#');
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    let refuse = false;
    const answer = (url: string) => (refuse && url.endsWith('/select') ? 409 : 200);
    const open = () => startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: answer(url), ok: answer(url) === 200, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    let page = open();
    let source = FakeSource.last!;
    const shown = () => root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab'];
    const paired = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null };
    const rows = [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' }), listRow(2, { title: 'Side', url: 'https://github.com/o/r/issues/2' })])];
    // Each opening rule that picks another tab: an artifact kept for the work item, Browser chosen for every work item, no status report yet.
    const kept = { groups: rows, openOn: 'browser', status: null, tabs: { tab: 'artifact:chat/p.html', closed: [] } };

    hello(source, { ...kept, scope: null });
    source.emit('pane', { pane: paired });
    click('[data-work-item="1"]');
    await flush();
    hello(source, kept);
    source.emit('pane', { pane: paired });
    expect(root.classList.contains('listing')).toBe(false);
    expect(shown()).toBe('conversation');

    // A tab chosen there stays while the work item is open.
    click('#head [data-tab="status"]');
    source.emit('pane', { pane: { ...paired, shown: true } });
    expect(shown()).toBe('status');

    // Back to the list and the same work item again: the conversation, with no new hello.
    click('.header > button.back-toggle');
    expect(root.classList.contains('listing')).toBe(true);
    click('[data-work-item="1"]');
    expect(root.classList.contains('listing')).toBe(false);
    expect(shown()).toBe('conversation');

    // Another work item, as from the header's list: the conversation.
    click('#head [data-tab="status"]');
    click('.header > button.back-toggle');
    click('[data-work-item="2"]');
    await flush();
    hello(source, { ...kept, scope: { ...scope, workItemId: 2 }, tabs: { tab: 'console', closed: [] } });
    expect(shown()).toBe('conversation');

    // A conversation of its dropdown the hub refuses to open leaves the open one's tab as it was.
    click('#head [data-tab="status"]');
    click('.header > button.back-toggle');
    refuse = true;
    click('[data-work-item="1"]');
    await flush();
    refuse = false;
    expect(shown()).toBe('status');

    // A reload: the conversation.
    page.close();
    page = open();
    source = FakeSource.last!;
    hello(source, { ...kept, scope: { ...scope, workItemId: 2 } });
    source.emit('pane', { pane: paired });
    expect(shown()).toBe('conversation');
    page.close();
  });



  it('creates tabs for every attached web link on selection and opens a pill only after its row is selected', async () => {
    window.innerWidth = 1920;
    const sent: Record<string, unknown>[] = [];
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async (_id, message) => { sent.push(message); return { ok: true }; },
    });
    const source = FakeSource.last!;
    const links = Array.from({ length: 14 }, (_, i) => ({ label: `Site ${i}`, url: `http://site${i}.test:8080/path?q=1#part`, kind: 'url' as const, badge: `Site ${i}`, glyph: null, mentioned: false }));
    links[0]!.url = 'https://desk.zoho.com/agent/ticket/1';
    links[1]!.url = 'https://forum.example.com/t/2';
    const groups = [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1', links }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2', links: [links[1]!] })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush();
    expect(root.querySelectorAll('#detail [data-action="iframe-open"]')).toHaveLength(15);
    expect(root.querySelector('#detail iframe.browser')).toBeNull();
    posts = []; sent.length = 0;
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2]);
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([{ type: 'iframe-launch', workItemId: 2, url: 'https://forum.example.com/t/2' }]);
    expect(root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url')).toBe('https://forum.example.com/t/2');
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(root.querySelectorAll('#detail [data-action="iframe-open"]')).toHaveLength(2);
    page.close();
  });

  it('honors the last pill after an acknowledged selection whose hello is late, and drops refused pill requests', async () => {
    const sent: Record<string, unknown>[] = [];
    let refuse = false;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); const denied = refuse && url.endsWith('/select'); return { status: denied ? 409 : 200, ok: !denied, json: async () => denied ? { error: 'That work item is gone.' } : {} }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async (_id, message) => { sent.push(message); return { ok: true }; },
    });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1, { url: 'https://forum.example.com/t/forum/one' }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2' })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush(); posts = []; sent.length = 0;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    // The hub acknowledged 2, but its hello has not arrived. A click on 1 must still ask the hub to return to 1.
    click('#list [data-work-item="1"] .pill.ticket'); await flush();
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2, 1]);
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([{ type: 'iframe-launch', workItemId: 1, url: 'https://forum.example.com/t/forum/one' }]);
    sent.length = 0; refuse = true;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    expect(root.textContent).toContain('That work item is gone.');
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    page.close();
  });

  it('keeps rapid pill and tab clicks embedded while the new work item waits for site rules', async () => {
    const postMessage = vi.fn();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    onTestFinished(() => { vi.restoreAllMocks(); });
    const sent: Record<string, unknown>[] = [];
    const opened = vi.fn();
    let hold = false;
    let resolve!: (value: unknown) => void;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: opened,
      toExtension: async (_id, message) => { sent.push(message); return hold && message['type'] === 'iframe-enable' ? new Promise((done) => { resolve = done; }) : { ok: true }; },
    });
    const source = FakeSource.last!;
    const link = { label: 'Forum', url: 'https://forum.example.com/t/forum/topic', kind: 'url' as const, badge: 'Forum', glyph: null, mentioned: false };
    const groups = [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2', links: [link] })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush(); sent.length = 0;
    hold = true;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(sent.filter((message) => !String(message['type']).startsWith('iframe-'))).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    click('[data-action="iframe-open"][data-url="https://desk.zoho.com/agent/ticket/2"]');
    hold = false; resolve({ ok: true }); await flush();
    expect(root.querySelector('[data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url')).toBe('https://desk.zoho.com/agent/ticket/2');
    page.close();
  });

  it('uses the local default browser for Ctrl or Meta pill clicks without selecting or calling the extension, and shows refusals', async () => {
    const sent = vi.fn(async () => ({ ok: true }));
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 409, ok: false, json: async () => ({ error: 'The work item no longer links to this.' }) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: true, standalone: () => false, toExtension: sent,
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2' })])] }); await flush();
    posts = []; sent.mockClear();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      root.querySelector('#list [data-work-item="2"] .pill.ticket')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifier })); await flush();
    }
    expect(posts.map((post) => post.url)).toEqual(['/v1/conversation/row-open', '/v1/conversation/row-open']);
    expect(posts[0]!.body).toMatchObject({ workItemId: 2, url: 'https://desk.zoho.com/agent/ticket/2' });
    expect(sent).not.toHaveBeenCalled();
    expect(root.querySelector('#list .row.selected')?.getAttribute('data-work-item')).toBe('1');
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('The work item no longer links to this.');
    page.close();
  });

  it('opens a Ctrl-clicked pill on the remote device without asking the hub or the extension', async () => {
    const opened = vi.fn(), sent = vi.fn(async () => ({ ok: true }));
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, openUrl: opened, toExtension: sent,
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1), listRow(2, { url: 'https://forum.example.com/t/2' })])] }); await flush();
    posts = []; sent.mockClear();
    root.querySelector('#list [data-work-item="2"] .pill.ticket')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); await flush();
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://forum.example.com/t/2');
    expect(posts).toEqual([]); expect(sent).not.toHaveBeenCalled();
    page.close();
  });

  it('EmbeddedTabs_BrowserThatCannotInstallTheExtension_MakesNoBrowserTabsNorAsksForItAndOpensLinksOutside', async () => {
    window.innerWidth = 1920;
    const opened = vi.fn();
    const sent: Record<string, unknown>[] = [];
    // An iPhone's browser, say: no extension answers, and none can be installed.
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: opened,
      extensionInstallable: () => false, toExtension: async (_id, message) => { sent.push(message); return null; },
    });
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1', links: [pr] }), listRow(2, { url: 'https://github.com/o/r/issues/2' })])] }); await flush();
    expect(root.querySelector('[data-action="iframe-open"]')).toBeNull();
    expect(root.querySelector('[data-side="browser"], [data-tab="browser"]')).toBeNull();
    expect(root.textContent).not.toContain('extension');
    // The work item's links open as ordinary links, in a new tab, its own row's and another row's alike.
    posts = [];
    click('#list [data-work-item="1"] .pill.ticket'); await flush();
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    expect(opened.mock.calls).toEqual([['https://github.com/o/r/issues/1'], ['https://github.com/o/r/issues/2']]);
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
    page.close();
  });

  it('EmbeddedTabs_DesktopChromiumWithoutTheExtension_SelectsTheLinkTabAndOffersABrowserTabAndTheExtension', async () => {
    window.innerWidth = 1920;
    const opened = vi.fn();
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: opened,
      extensionInstallable: () => true, toExtension: async () => null,
    });
    const issue = 'https://github.com/o/r/issues/1';
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };
    const selected = (): string | null | undefined => root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url');
    const button = (label: string): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('#detail .detail-body button')].find((one) => one.textContent === label);

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: issue, links: [pr] })])] }); await flush();
    // The tab chosen selects, not the first one.
    click(`#detail [data-action="iframe-open"][data-url="${pr.url}"]`); await flush();
    expect(selected()).toBe(pr.url);
    expect(root.querySelector('#detail')!.textContent).toContain('Load the experimental Switchboard Chrome/Edge extension in this browser, then select Retry.');
    expect(button('Retry')).not.toBeUndefined();
    button('Open in a browser tab')!.click();
    expect(opened.mock.calls).toEqual([[pr.url]]);
    button('Get the browser extension')!.click(); await flush();
    expect(root.querySelector('#list-sheet .sheet')?.textContent).toContain('Get the browser extension');
    expect(root.querySelector('#list-sheet a[download]')?.getAttribute('href')).toBe('/page/switchboard-extension.zip');
    click('#list-sheet [data-action="list-sheet-cancel"]'); await flush();
    click(`#detail [data-action="iframe-open"][data-url="${issue}"]`); await flush();
    expect(selected()).toBe(issue);
    button('Open in a browser tab')!.click();
    expect(opened.mock.calls.at(-1)).toEqual([issue]);
    // Closing the link tab shown shows the one after it, with none before it; closing the last one, not shown, keeps the tab shown.
    click(`#detail [data-action="iframe-close"][data-url="${issue}"]`);
    expect(selected()).toBe(pr.url);
    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    click(`#detail [data-action="iframe-close"][data-url="${pr.url}"]`);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');
    expect(root.querySelector('#detail .link-tab')).toBeNull();
    page.close();
  });

  it('EmbeddedTabs_ExtensionAnswersWhereItCouldNotBeTold_ShowsTheLinkTabs', async () => {
    window.innerWidth = 1920;
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false,
      extensionInstallable: () => false, toExtension: async () => ({ ok: true }),
    });

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] }); await flush();
    expect(root.querySelector('#detail [data-action="iframe-open"]')?.getAttribute('data-url')).toBe('https://github.com/o/r/issues/1');
    page.close();
  });

  it('shows the experimental GitHub frame on a remote page only after extension confirmation and removes it when disabled', async () => {
    window.innerWidth = 1920;
    const sent: unknown[] = [];
    let resolve!: (reply: unknown) => void;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) } as Response; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, extensionInstallable: () => true,
      toExtension: async (_id, message) => { sent.push(message); return message['type'] === 'iframe-check' ? new Promise((done) => { resolve = done; }) : { ok: true }; },
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    expect(root.querySelector('[data-action="iframe-open"]')).not.toBeNull();
    click('#detail [data-action="iframe-open"]');
    expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBeNull();
    resolve({ ok: true }); await flush();
    const frame = root.querySelector<HTMLIFrameElement>('iframe[title="GitHub browser experiment"]')!;
    expect(root.textContent).toContain('Open with sign-in support');
    // With the extension, the pane offers neither a browser tab nor the extension.
    expect(root.textContent).not.toContain('Open in a browser tab');
    expect(root.textContent).not.toContain('Get the browser extension');
    source.emit('reply', { reply: reply('r9', 9) }); expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBe(frame);
    click('[data-action="artifact"][data-path="chat/p.html"]');
    expect(root.querySelector('#detail .detail-body')!.classList.contains('framed')).toBe(true);
    click('#detail [data-action="iframe-open"]');
    expect(root.querySelector('#detail .detail-body')!.classList.contains('framed')).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/pane-pair') || post.url.endsWith('/pane-rect'))).toEqual([]);
    source.emit('settings', { settings: { iframeBrowser: false } });
    expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBeNull(); expect(sent.at(-1)).toEqual({ type: 'iframe-disable' });
    page.close();
  });


  it('accepts a host link handoff only from its extension parent and opens the requested link tab', async () => {
    const postMessage = vi.fn();
    const parentWindow = { postMessage } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWindow);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    const focusPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { focusPosts.push({ url, body: init?.body === undefined ? {} : JSON.parse(init.body) }); return { status: 200, ok: true, json: async () => ({}) }; }) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    await flush();
    const url = 'https://github.com/o/r/pull/99';
    const data = { type: 'switchboard-iframe-select', workItemId: 1, url };
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'https://evil.test', data }));
    expect(root.querySelector(`[data-action="iframe-open"][data-url="${url}"]`)).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data }));
    expect(root.querySelector(`[data-action="iframe-open"][data-url="${url}"]`)?.getAttribute('aria-selected')).toBe('true');
    expect(postMessage.mock.calls.some(([message]) => message.url === url)).toBe(true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    const focus = () => focusPosts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body['focused'];
    expect(focus()).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'https://github.com', data: { type: 'switchboard-iframe-focus', focused: true } }));
    expect(focus()).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data: { type: 'switchboard-iframe-focus', focused: true } }));
    expect(focus()).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data: { type: 'switchboard-iframe-focus', focused: false } }));
    expect(focus()).toBe(false);
    page.close();
  });

  it('hides the embedded browser under a menu only where the menu overlaps it, as the More menu does, and under a modal dialog always', async () => {
    const postMessage = vi.fn();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    // The column's Browser tab at the right; the session dropdown drops over the conversation, the More menu over the Browser tab.
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      'iframe-slot': { left: 1000, top: 120, right: 1900, bottom: 1000 },
      'conversation-menu': { left: 300, top: 60, right: 700, bottom: 600 },
      'tab-menu': { left: 1400, top: 100, right: 1880, bottom: 500 },
    };
    // Size observers that report only when the test says so, so the toast's host can say its toast grew.
    const sized: Array<{ report: () => void; watched: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly watched: Element[] = [];
      constructor(report: () => void) { sized.push({ report, watched: this.watched }); }
      observe(element: Element): void { this.watched.push(element); }
      unobserve(): void {}
      disconnect(): void {}
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = Object.entries(boxes).find(([name]) => this.classList.contains(name))?.[1] ?? { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }
    await flush();
    click('#detail [data-action="iframe-open"]');
    await flush();
    // The column's strip narrowed to room for the chosen tab alone, so the rest go into More.
    boxes['side-switch'] = { left: 1000, top: 85, right: 1001, bottom: 120 };
    const shown = (): boolean => {
      const last = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).filter((message) => message['type'] === 'switchboard-iframe').at(-1);
      return last !== undefined && 'left' in last;
    };
    const settle = async (): Promise<void> => { await new Promise((done) => setTimeout(done, FRAME_SHOW_DELAY_MS + 20)); await flush(); };
    expect(shown()).toBe(true);

    // The session dropdown lies over the conversation, beside the frame, so the frame stays.
    click('[data-action="picker"]');
    await flush();
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    expect(shown()).toBe(true);
    click('[data-action="picker"]');
    await flush();

    // The More menu drops over the Browser tab, so the frame hides while it is open and comes back once it closes.
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(root.querySelector('#detail .tab-menu')).not.toBeNull();
    expect(shown()).toBe(false);
    click('#detail [data-action="tab-menu"]');
    await settle();
    expect(shown()).toBe(true);

    // A modal dialog hides it wherever its box lies.
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    root.append(modal);
    await flush();
    expect(shown()).toBe(false);
    modal.remove();
    await settle();
    expect(shown()).toBe(true);

    // A toast clear of the frame leaves it; one replaced in place by a longer text that reaches over it hides it, which only its size says.
    showToast('Short.', 'info');
    await flush();
    expect(shown()).toBe(true);
    boxes['toast'] = { left: 900, top: 100, right: 1500, bottom: 200 };
    for (const observer of sized.filter((one) => one.watched.some((element) => element.id === 'toast'))) observer.report();
    await flush();
    expect(shown()).toBe(false);
    page.close();
  });

  it('keeps the embedded browser showing under a menu or modal once its host cuts holes, sending the layers over it and the backdrop darkening', async () => {
    const postMessage = vi.fn();
    const parentWindow = { postMessage } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWindow);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      'iframe-slot': { left: 1000, top: 120, right: 1900, bottom: 1000 },
      'tab-menu': { left: 1400, top: 100, right: 1880, bottom: 500 },
      'test-backdrop': { left: 0, top: 0, right: 1920, bottom: 1080 },
      'test-dialog': { left: 700, top: 300, right: 1300, bottom: 700 },
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = Object.entries(boxes).find(([name]) => this.classList.contains(name))?.[1] ?? { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }
    await flush();
    click('#detail [data-action="iframe-open"]');
    await flush();
    // The column's strip narrowed to room for the chosen tab alone, so the rest go into More.
    boxes['side-switch'] = { left: 1000, top: 85, right: 1001, bottom: 120 };
    click('#detail .link-tab.selected [data-action="iframe-open"]');
    await flush();
    const last = (): Record<string, unknown> | undefined => postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).filter((message) => message['type'] === 'switchboard-iframe').at(-1);
    const answer = (origin: string): void => { window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin, data: { type: 'switchboard-iframe-holes' } })); };
    // Only the extension host's answer counts; another origin's leaves the page hiding the frame under the menu.
    answer('https://github.com');
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).not.toHaveProperty('left');
    click('#detail [data-action="tab-menu"]');
    await new Promise((done) => setTimeout(done, FRAME_SHOW_DELAY_MS + 20)); await flush();
    answer('chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [], dim: 0, modal: false });

    // The More menu over the Browser tab is cut out of the frame, which stays.
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [{ left: 1400, top: 100, width: 480, height: 400 }], modal: false });
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [] });

    // A modal dialog over its backdrop: the frame darkens by the backdrop's alpha and the dialog is cut out.
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop test-backdrop';
    backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    const dialog = document.createElement('div');
    dialog.className = 'test-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    backdrop.append(dialog);
    root.append(backdrop);
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [{ left: 700, top: 300, width: 600, height: 400 }], dim: 0.4, modal: true });
    // An opaque backdrop, as the phone's full-screen dialogs have, hides it.
    backdrop.style.backgroundColor = 'rgb(30, 30, 30)';
    dialog.classList.add('opaque');
    await flush();
    expect(last()).not.toHaveProperty('left');
    backdrop.remove();
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [], dim: 0, modal: false });

    // A layer sliding over the frame is followed each frame while its transition runs, not only when it ends.
    const sliding = document.createElement('div');
    sliding.className = 'glass sliding';
    root.append(sliding);
    await flush();
    sliding.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    boxes['sliding'] = { left: 950, top: 200, right: 1200, bottom: 400 };
    await new Promise((done) => setTimeout(done, 60));
    expect(last()).toMatchObject({ holes: [{ left: 950, top: 200, width: 250, height: 200 }] });
    boxes['sliding'] = { left: 1000, top: 200, right: 1300, bottom: 400 };
    await new Promise((done) => setTimeout(done, 60));
    expect(last()).toMatchObject({ holes: [{ left: 1000, width: 300 }] });
    sliding.dispatchEvent(new Event('transitionend', { bubbles: true }));
    const sent = postMessage.mock.calls.length;
    await new Promise((done) => setTimeout(done, 60));
    // Stopped, it is no longer followed.
    expect(postMessage.mock.calls.length).toBe(sent);
    page.close();
  });

  it('hides the unpinned list in a drawer while a work item is open, shown by its button or a resting pointer and hidden as an auto-hide', () => {
    vi.useFakeTimers();
    localStorage.setItem('switchboard.listCollapsed', '1');
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
    expect(root.classList.contains('drawer-held')).toBe(true);
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
    expect(root.classList.contains('drawer-held')).toBe(false);
    // The backdrop under it takes a press outside, which then only hides it.
    toggle().click();
    const backdrop = root.querySelector<HTMLElement>('.drawer-backdrop')!;

    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    backdrop.click();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).not.toBe(root.querySelector('[data-work-item="1"]'));
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
    // Shown by the pointer, it has no backdrop.
    expect(root.classList.contains('drawer-held')).toBe(false);
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

  it('keeps the pinned list a column at every width outside the phone, folding the column into tabs, and brings a column back only past its need', () => {
    window.innerWidth = 1440;

    const { page, source } = start();
    const columns = (): string => `${root.classList.contains('drawers') ? 'drawer' : 'list'} + ${root.classList.contains('wide') ? 'column' : 'tabs'}`;

    hello(source);
    // The list's default 340 px, the conversation's 640 and the column's 360 fit 1440 px.
    expect(columns()).toBe('list + column');
    // Under 1340 px they do not: the column folds into the tabs, and the pinned list stays.
    resizeTo(1339);
    expect(columns()).toBe('list + tabs');
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    // The column comes back only 40 px past its need, so a width at the edge does not flap; then it stays until it no longer fits.
    resizeTo(1360);
    expect(columns()).toBe('list + tabs');
    resizeTo(1380);
    expect(columns()).toBe('list + column');
    resizeTo(1340);
    expect(columns()).toBe('list + column');
    // The Surface's portrait width keeps the list too.
    resizeTo(912);
    expect(columns()).toBe('list + tabs');
    resizeTo(768);
    expect(columns()).toBe('list + tabs');
    // A phone has separate views, with neither.
    resizeTo(700);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    page.close();
  });

  it("counts the pinned list's kept width, and stops its sash where the conversation, and the column while it shows, keep what they need", () => {
    localStorage.setItem('switchboard.sideWidth', '400');
    window.innerWidth = 1366;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.side-sash')!;

    hello(source);
    // 400 + 640 + 360 is more than 1366 px, which the default 340 px list would fit: the column folds, and the list stays a column.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    resizeTo(1440);
    expect(root.classList.contains('wide')).toBe(true);
    // End stops at 1440 - 640 - 360 px rather than SIDE_MAX, so the column stays.
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('440');
    expect(root.classList.contains('wide')).toBe(true);
    // With the column folded, End stops where the conversation keeps CHAT_MIN.
    resizeTo(912);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(912 - CHAT_MIN));
    expect(root.classList.contains('drawers')).toBe(false);
    page.close();
  });

  it('brings the column back when the conversation is narrowed on its sash, and folds it when widened again', () => {
    window.innerWidth = 1300;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.chat-sash')!;

    hello(source);
    // The default 340 px list, the conversation at 640 px and the column at 360 px do not fit 1300 px.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(localStorage.getItem('switchboard.chatWidth')).toBe(String(CHAT_MIN));
    // 340 + 400 + 360 px fit.
    expect(root.classList.contains('wide')).toBe(true);
    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    page.close();
  });

  it('unpins the list into the drawer and pins it back from the pin at its header, from a click or the keyboard, keeping the choice on the device', () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const pin = () => root.querySelector<HTMLButtonElement>('.side-head .list-pin')!;

    hello(source);
    // Pinned by default: a column, and the pin offers to unpin it.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(pin().getAttribute('aria-label')).toBe('Unpin sidebar');
    expect(pin().title).toBe('Unpin sidebar');
    expect(pin().querySelector('.codicon-pinned')).not.toBeNull();
    // Unpinned, the list is a drawer at any width, hidden, with the focus on the button that shows it.
    pin().focus();
    pin().click();
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.classList.contains('drawer-open')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(document.activeElement).toBe(root.querySelector('.header > .list-toggle'));
    expect(pin().getAttribute('aria-label')).toBe('Pin sidebar');
    expect(pin().querySelector('.codicon-pin')).not.toBeNull();
    resizeTo(1920);
    expect(root.classList.contains('drawers')).toBe(true);
    // A reload keeps it unpinned.
    page.close();

    const again = start();

    hello(again.source);
    expect(root.classList.contains('drawers')).toBe(true);
    // Pinned from the open drawer, by Enter on the pin as a button takes it, the list is a column again, with the focus still on the pin.
    click('.header > .list-toggle');
    expect(root.classList.contains('drawer-open')).toBe(true);
    pin().focus();
    pin().click();
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('drawer-open')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    expect(document.activeElement).toBe(pin());
    again.page.close();
  });

  it('leaves the pin out where the list is a column either way, with no work item open, and keeps it on the History tab', () => {
    window.innerWidth = 1180;
    localStorage.setItem('switchboard.listCollapsed', '1');
    history.replaceState(null, '', '#');

    const listing = start();

    // No work item open: the unpinned list is the side column, so a pin there would change nothing.
    hello(listing.source, { scope: null, sessions: [], items: [] });
    expect(root.classList.contains('listing')).toBe(true);
    expect(root.querySelector('.list-pin')).toBeNull();
    // Opening one makes it the drawer, whose header has the pin.
    listing.page.close();
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 1, key: 'gh 1' } })])] });
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.querySelector('.side-head .list-pin')?.getAttribute('aria-label')).toBe('Pin sidebar');
    // History is a tab of the open work item, so the list stays the drawer and keeps its pin.
    click('[data-action="actions"]');
    click('.actions-menu [data-action="row-history"]');
    expect(root.querySelector('[data-tab="history"], [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.querySelector('.side-head .list-pin')?.getAttribute('aria-label')).toBe('Pin sidebar');
    page.close();
  });

  it('has no pin in the phone\'s layout, where the list is its own view', () => {
    window.innerWidth = 700;

    const { page, source } = start();

    hello(source);
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    // page.css hides it in the phone's layout; an unpinned choice kept on a wider window does not make a phone's list a drawer.
    localStorage.setItem('switchboard.listCollapsed', '1');
    resizeTo(699);
    expect(root.classList.contains('drawers')).toBe(false);
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
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 380, bubbles: true }));
    expect(width()).toBe('380px');
    sash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(width()).toBe('300px');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');

    // The open drawer's sash sets the same width, and a cancelled drag keeps nothing there either.
    click('.side-head .list-pin');
    click('.header > .list-toggle');
    drawerSash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(width()).toBe('300px');
    drawerSash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    // A release only sets the width: the drawer stays open and unpinned.
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('420');
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.classList.contains('drawer-open')).toBe(true);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    page.close();
  });

  it('shows the drawer on a touch swiping right from the left edge, not on a mouse, a short or a mostly vertical swipe', () => {
    window.innerWidth = 1024;
    localStorage.setItem('switchboard.listCollapsed', '1');
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

  it('maximizes the Status and Artifacts column over the whole page from its strip and restores it from the same button or Escape, only while it is a column', () => {
    window.innerWidth = 1440;

    const { page, source } = start();
    const button = () => root.querySelector<HTMLButtonElement>('#detail .detail-head .panel-max');

    hello(source);
    expect(button()!.getAttribute('aria-label')).toBe('Maximize panel');
    expect(button()!.title).toBe('Maximize panel');
    expect(button()!.querySelector('.codicon-screen-full')).not.toBeNull();
    // The strip's last control, after Changes.
    expect(button()!.parentElement!.lastElementChild).toBe(button());
    button()!.focus();
    button()!.click();
    expect(root.classList.contains('maximized')).toBe(true);
    expect(button()!.getAttribute('aria-label')).toBe('Restore panel');
    expect(button()!.querySelector('.codicon-screen-normal')).not.toBeNull();
    expect(document.activeElement).toBe(button());
    // The list and the conversation stay where they were, under it.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    button()!.click();
    expect(root.classList.contains('maximized')).toBe(false);
    expect(button()!.getAttribute('aria-label')).toBe('Maximize panel');

    // Escape restores it, from an idle console too, but not from one typing into its session, which stops its keys (console.ts).
    button()!.click();
    const console = root.querySelector('#detail .detail-body')!.appendChild(document.createElement('div'));
    let typing = true;

    console.className = 'console';
    console.addEventListener('keydown', (event) => typing && event.stopPropagation());
    console.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(true);
    typing = false;
    console.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(false);
    expect(document.activeElement).toBe(button());
    button()!.click();
    button()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(false);

    // Where the column folds into tabs it has no button, and a maximized column is restored; a reload keeps nothing.
    button()!.click();
    resizeTo(1100);
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('maximized')).toBe(false);
    expect(root.querySelector('.panel-max')).toBeNull();
    resizeTo(1440);
    expect(root.classList.contains('maximized')).toBe(false);
    button()!.click();
    page.close();

    const again = start();

    hello(again.source);
    expect(root.classList.contains('maximized')).toBe(false);
    again.page.close();
  });

  it('has no maximize button on a phone, which shows one tab at a time', () => {
    window.innerWidth = 700;

    const { page, source } = start();

    hello(source);
    expect(root.querySelector('.panel-max')).toBeNull();
    page.close();
  });

  it('takes a list width kept elsewhere as it is', () => {
    localStorage.setItem('switchboard.sideWidth', '440');
    window.innerWidth = 1440;

    const { page, source } = start();

    hello(source);
    expect(root.classList.contains('wide')).toBe(true);
    // A width kept elsewhere is taken as it is, and a narrower page then folds the column, keeping the list a column.
    resizeTo(1400);
    expect(root.style.getPropertyValue('--side-width')).toBe('440px');
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    page.close();
  });

  it('links an answer and its card both ways, each going to the other and highlighting it, and supersedes an old card with a later reply', () => {
    const { page, source } = start();
    const scrolled: string[] = [];
    const asked = '1. Move this work to a Code Mode session?\n   - A) Not now, keep it here\n   - B) Yes';

    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? this.dataset['id'] ?? '');
    };
    hello(source, { items: [reply('r1', 2, { opening: asked }), message('m1', 3, { text: '1A' })] });

    const ref = root.querySelector<HTMLButtonElement>('li[data-id="m1"] .bubble > .answer-ref')!;

    expect(ref.textContent).toBe('↳Move this work to a Code Mode session?→ Not now, keep it here');
    click('li[data-id="m1"] .answer-ref');
    expect(scrolled).toEqual(['reply:r1']);
    expect(root.querySelector('.question-card')!.classList.contains('linked')).toBe(true);
    expect(root.querySelector('.question-card .qc-done .qc-progress')!.textContent).toBe('Question answered');
    click('.question-card [data-action="goto-message"]');
    expect(scrolled).toEqual(['reply:r1', 'm1']);
    expect(root.querySelector('li[data-id="m1"]')!.classList.contains('linked')).toBe(true);

    // Before the cutover, a later reply supersedes the card, which takes no answer.
    hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Ignore the question I asked.' })] });
    expect(root.querySelector('.question-card .qc-state')!.getAttribute('title')).toBe('Superseded');
    expect(root.querySelector('.question-card .qc-row-detail')!.textContent).toBe('Superseded: a later reply came after it.');
    expect(root.querySelector('.qc-option, [data-action="card-send"]')).toBeNull();

    // After it, a reply with text leaves the question open, and an Answers message shows as its bubble.
    const questions = { sessionId: 's', since: 0, open: 0, oldest: null, drafts: {}, dismissed: [] };

    hello(source, { questions, items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Working on it.' }), message('m1', 4, { text: '[answers]\n- code-mode-session: Move this work to a Code Mode session? → B) Yes', answers: [{ replyId: 'r1', slug: 'move-work-code', letters: ['B'], other: '', via: 'card' }] })] });
    expect(root.querySelector('li[data-id="m1"] .answers-title')!.textContent).toBe('Answers');
    expect(root.querySelector('li[data-id="m1"] .answers-answer')!.textContent).toBe('Yes');
    expect(root.querySelector('li[data-id="m1"] .box')!.textContent).not.toMatch(/\[answers\]|code-mode-session/);
    expect(root.querySelector('.question-card.qc-collapsed .qc-progress')!.textContent).toBe('Question answered');
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    page.close();
  });

  it('shows how many questions wait over the composer while the answerable card is off screen, and goes to it on a click', () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const scrolled: string[] = [];
    let cardTop = -500;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;
    const asked = '1. Port?\n   - A) 1\n   - B) 2';

    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.id === 'panel' ? rect(0, 400) : this.classList.contains('question-card') ? rect(cardTop, 200) : original.call(this);
    };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      const chip = () => root.querySelector<HTMLElement>('#composer > .question-waiting');

      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Checking.', kind: 'aside' })] });
      expect(chip()!.hidden).toBe(false);
      expect(chip()!.textContent).toBe('1 question waiting');
      click('#composer .question-waiting');
      expect(scrolled).toEqual(['reply:r1']);
      cardTop = 100;
      root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(true);
      cardTop = -500;
      root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(false);
      // On another tab, where the card is not shown, too; a click goes back to it.
      cardTop = 100;
      root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
      expect(chip()!.hidden).toBe(false);
      click('#composer .question-waiting');
      expect(root.classList.contains('off-conversation')).toBe(false);
      expect(scrolled).toEqual(['reply:r1', 'reply:r1']);
      expect(chip()!.hidden).toBe(true);
      // The hub's count is every open question of the conversation, across cards, and the chip goes to the oldest.
      cardTop = -500;
      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Checking.', kind: 'aside' })], questions: { sessionId: 's', since: 0, open: 3, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('3 questions waiting');
      source.emit('questions', { questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('2 questions waiting');
      // Another session's questions change nothing.
      source.emit('questions', { questions: { sessionId: 'other', since: 0, open: 9, oldest: 'reply:x', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('2 questions waiting');
      // Answered or superseded, or while the page cannot answer, there is none.
      hello(source, { items: [reply('r1', 2, { opening: asked }), message('m1', 3, { text: '1B' })] });
      expect(chip()!.hidden).toBe(true);
      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Never mind.' })] });
      expect(chip()!.hidden).toBe(true);
      hello(source, { items: [reply('r1', 2, { opening: asked })], sessions: [session({ conversation: 'read-only' })] });
      expect(chip()!.hidden).toBe(true);
    } finally {
      // Own properties shadow Element.prototype's, which other tests stub.
      delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      resizeTo(1024);
      page.close();
    }
  });

  it('draws the cards carried past retention in a Still open section at the top, answers them as any card, and the chip goes there (PRD R103)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scrolled: string[] = [];
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;

    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.id === 'panel' ? rect(0, 400) : this.classList.contains('question-card') ? rect(-500, 200) : original.call(this);
    };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      const { page, source } = start();
      const asked = '1. **Port.** Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const gone = parseQuestions(asked).map((question) => ({ key: `reply:gone#${question.slug}`, card: 'reply:gone', replyId: 'gone', question, state: 'open' as const, answer: null, reason: null, replacedBy: null }));
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:gone', drafts: {}, dismissed: [], carried: gone };
      const section = () => root.querySelector('#panel .still-open');
      const items = [reply('r9', 9, { opening: 'Step.', kind: 'aside' })];
      const step = () => section()!.querySelector('.question-card')!.getAttribute('data-step');

      hello(source, { items, questions });
      expect(section()!.querySelector('.still-open-title')!.textContent).toBe('Still open');
      // The section comes before the timeline, which draws no card for these questions.
      expect(section()!.compareDocumentPosition(root.querySelector('.timeline')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(root.querySelectorAll('.timeline .question-card')).toHaveLength(0);
      expect(section()!.querySelector('.question-card')!.getAttribute('data-card-key')).toBe('reply:gone');
      expect(section()!.querySelector('.qc-progress')!.textContent).toBe('Question 1 of 2');

      // The chip goes to the carried card.
      const chip = root.querySelector<HTMLElement>('#composer > .question-waiting')!;

      expect(chip.hidden).toBe(false);
      expect(chip.textContent).toBe('2 questions waiting');
      click('#composer .question-waiting');
      expect(scrolled).toEqual(['reply:gone']);

      // One question at a time, with the draft on the hub and a send of the answered one only.
      click('.still-open [data-action="card-pick"][data-letter="B"]');
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body).toMatchObject({ sessionId: 's', card: 'reply:gone', draft: { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } } });
      expect(step()).toBe('port-choice');
      click('.still-open [data-action="card-next"]');
      expect(step()).toBe('keep-route');
      expect(section()!.querySelector('textarea.qc-comment')).not.toBeNull();
      click('.still-open [data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([{ card: 'reply:gone', slug: 'port-choice', letters: ['B'], other: '' }]);

      // Answered in part, the card stays with its open question and the answered one as a row; Dismiss is in its menu.
      const answered = { ...gone[0]!, state: 'answered' as const, answer: { messageId: 'm10', letters: ['B'], other: '', via: 'card' as const, sending: false } };

      source.emit('questions', { questions: { ...questions, open: 1, carried: [answered, gone[1]!] } });
      expect(step()).toBe('keep-route');
      expect(section()!.querySelectorAll('.qc-row')).toHaveLength(1);
      click('.still-open [data-action="card-menu"]');
      click('.still-open [data-action="card-dismiss"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/card-dismiss'))?.body).toMatchObject({ sessionId: 's', card: 'reply:gone', slug: 'keep-route' });

      // Settled, or withdrawn, it leaves the section, and the chip with it.
      source.emit('questions', { questions: { ...questions, open: 0, oldest: null, carried: [] } });
      expect(section()).toBeNull();
      expect(chip.hidden).toBe(true);

      // An answer the page holds settles it before the hub's next event.
      hello(source, { items: [...items, message('m10', 10, { text: '[answers]', answers: [{ replyId: 'gone', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }, { replyId: 'gone', slug: 'keep-route', letters: ['B'], other: '', via: 'card' }] })], questions });
      expect(section()).toBeNull();

      // A reply the page still holds keeps its card under it, once.
      hello(source, { items: [reply('gone', 1, { opening: asked }), ...items], questions });
      expect(section()).toBeNull();
      expect(root.querySelectorAll('.question-card')).toHaveLength(1);
      expect(root.querySelector('li[data-id="gone"] .question-card')).not.toBeNull();

      // The hub's state is current, so a message the page holds from before it is not read against it again: a typed "B" that answered nothing
      // then leaves the question open, and the answer the hub links to a question is shown with its message.
      const linked = { ...gone[0]!, state: 'answered' as const, answer: { messageId: 'm11', letters: ['A'], other: '', via: 'card' as const, sending: false } };

      hello(source, { items: [message('m8', 8, { text: 'B' }), ...items, message('m11', 11, { text: '[answers]\n- port-choice: Which port? → A) 1', answers: [{ replyId: 'gone', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }] })], questions: { ...questions, open: 1, carried: [linked, gone[1]!] } });
      expect(step()).toBe('keep-route');
      expect(root.querySelector('li[data-id="m11"] .answers-answer')!.textContent).toBe('1');
      expect(root.querySelector('li[data-id="m11"] [data-action="goto-card"]')!.getAttribute('data-target-card')).toBe('reply:gone');

      // A session that cannot take answers shows the card locked, as under a reply.
      hello(source, { items, questions, sessions: [session({ conversation: 'read-only' })] });
      expect(section()!.querySelector<HTMLButtonElement>('[data-action="card-pick"]')!.disabled).toBe(true);
      page.close();
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      vi.useRealTimers();
    }
  });

  it('steps through a card one question at a time, keeps its draft on the hub, and sends the picks for the hub to write, showing a refusal on the card', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const asked = '1. **Port.** Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body['draft']);
      const step = () => root.querySelector('.question-card')!.getAttribute('data-step');

      hello(source, { items: [reply('r1', 2, { opening: asked })], questions });
      expect(root.querySelector('.qc-progress')!.textContent).toBe('Question 1 of 2');
      click('[data-action="card-pick"][data-letter="B"]');
      expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
      expect(drafts().at(-1)).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } });
      // A pick stays on its question, so a comment can follow it; Next moves on.
      await vi.advanceTimersByTimeAsync(1000);
      expect(step()).toBe('port-choice');
      click('[data-action="card-next"]');
      expect(step()).toBe('keep-route');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 1 of 2');
      click('[data-action="card-back"]');
      expect(step()).toBe('port-choice');
      click('[data-action="card-next"]');
      // The Comment field's text reaches the hub once the typing pauses.
      const other = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;

      other.value = 'keep it, for now';
      other.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(drafts().at(-1)).toEqual({ step: 'keep-route', picks: { 'port-choice': { letters: ['B'], other: null }, 'keep-route': { letters: [], other: 'keep it, for now' } } });

      // The hub's draft, as another device changed it, shows once the hub has carried this page's last draft back to it.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': drafts().at(-1) } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'keep-route', picks: { 'port-choice': { letters: ['A'], other: null }, 'keep-route': { letters: ['A'], other: null } } } } } });
      expect(root.querySelector('[data-letter="A"]')!.getAttribute('aria-checked')).toBe('true');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 2 answers');

      answers['/send'] = { status: 409, body: { error: 'That question was withdrawn.' } };
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ sessionId: 's', launch: 'L', scopeGen: 3, answers: [{ card: 'reply:r1', slug: 'port-choice', letters: ['A'], other: '' }, { card: 'reply:r1', slug: 'keep-route', letters: ['A'], other: '' }] });
      expect(posts.find((post) => post.url.endsWith('/send'))?.body).not.toHaveProperty('text');
      expect(root.querySelector('.qc-error')!.textContent).toBe('That question was withdrawn.');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-send"]')!.disabled).toBe(false);

      // Dismiss is in the card's menu.
      click('[data-action="card-menu"]');
      click('[data-action="card-dismiss"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/card-dismiss'))?.body).toMatchObject({ sessionId: 's', card: 'reply:r1', slug: 'keep-route' });
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a pick with a comment, and a comment typed just before a pick, Next or Send, never waiting for the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body['draft']);
      const type = (text: string) => {
        const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;

        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };

      hello(source, { items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      // A comment typed, then at once a pick: the pick's draft carries the comment.
      type('unless 2 is taken');
      click('[data-action="card-pick"][data-letter="A"]');
      expect(drafts().at(-1)).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: 'unless 2 is taken' } } });
      // Picking the picked option again drops it and leaves the comment as the answer.
      click('[data-action="card-pick"][data-letter="A"]');
      expect(root.querySelector('[data-letter="A"]')!.getAttribute('aria-checked')).toBe('false');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(false);
      // A comment alone enables Next at once, before the typing pauses.
      type('');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(true);
      type('either');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(false);
      click('[data-action="card-pick"][data-letter="B"]');
      // Next straight after typing carries the newest comment.
      type('unless it is taken');
      click('[data-action="card-next"]');
      expect(drafts().at(-1)).toEqual({ step: 'keep-route', picks: { 'port-choice': { letters: ['B'], other: 'unless it is taken' } } });
      // Send counts a comment typed alone at once.
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 1 of 2');
      type('next week');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 2 answers');
      click('[data-action="card-pick"][data-letter="B"]');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([
        { card: 'reply:r1', slug: 'port-choice', letters: ['B'], other: 'unless it is taken' },
        { card: 'reply:r1', slug: 'keep-route', letters: ['B'], other: 'next week' },
      ]);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a card from the keyboard: numbers pick by place, arrows move between options, Enter goes on and sends, Backspace goes back', async () => {
    const { page, source } = start();
    const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
    const key = (name: string, target: Element = root.querySelector('.question-card')!) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    const step = () => root.querySelector('.question-card')!.getAttribute('data-step');

    hello(source, { items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
    // Letters no longer pick; the second option is 2.
    key('b');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('false');
    key('2');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    key('9');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    // Down and Up move the focus between the options, stopping at the ends.
    key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-letter')).toBe('A');
    key('ArrowDown', document.activeElement!);
    key('ArrowDown', document.activeElement!);
    expect(document.activeElement?.getAttribute('data-letter')).toBe('B');
    key('ArrowUp', document.activeElement!);
    expect(document.activeElement?.getAttribute('data-letter')).toBe('A');
    key('Enter');
    expect(step()).toBe('keep-route');
    key('Backspace');
    expect(step()).toBe('port-choice');
    key('Enter');
    // Keys typed in the Comment field are its text, not picks; Shift+Enter there adds a line.
    expect(key('1', root.querySelector('textarea.qc-comment')!)).toBe(true);
    expect(root.querySelector('textarea.qc-comment')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))).toBe(true);
    expect(step()).toBe('keep-route');
    root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!.value = 'later';
    root.querySelector('textarea.qc-comment')!.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter', root.querySelector('textarea.qc-comment')!);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ answers: [{ slug: 'port-choice', letters: ['B'] }, { slug: 'keep-route', letters: [], other: 'later' }] });
    page.close();
  });

  it('keeps Other text typed before the pause through a questions event, waits for each card on its own, and sends it to the conversation it was typed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body);
      const field = (card: string) => root.querySelector<HTMLTextAreaElement>(`textarea.qc-comment[data-card="${card}"]`)!;
      const type = (card: string, text: string) => {
        field(card).value = text;
        field(card).dispatchEvent(new Event('input', { bubbles: true }));
      };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' }), reply('r2', 3, { opening: '1. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      posts = [];

      type('reply:r1', 'first');
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      // Typing in another card leaves this one's pause running.
      type('reply:r2', 'second');
      // The hub's older draft, as another device last sent it, does not take the place of the text not sent yet.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: null } } } } } });
      expect(field('reply:r1').value).toBe('first');
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      expect(drafts()).toEqual([expect.objectContaining({ sessionId: 's', scopeGen: 3, card: 'reply:r1', draft: { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'first' } } } })]);
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      expect(drafts().map((one) => [one['card'], (one['draft'] as { picks: Record<string, { other: string }> }).picks])).toEqual([
        ['reply:r1', { 'port-choice': { letters: [], other: 'first' } }],
        ['reply:r2', { 'keep-route': { letters: [], other: 'second' } }],
      ]);

      // Opening another work item first sends the text still waiting to the conversation it was typed in, and nothing follows after the pause.
      posts = [];
      type('reply:r1', 'third');
      click('#list [data-work-item="2"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.map((post) => post.url.split('/').at(-1))).toEqual(['card-draft', 'select']);
      expect(drafts()[0]).toMatchObject({ sessionId: 's', scopeGen: 3, card: 'reply:r1', draft: { picks: { 'port-choice': { other: 'third' } } } });
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(drafts()).toHaveLength(1);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest Other text through a questions event from before the hub took it, so Send sends it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment[data-card="reply:r1"]')!;
      const older = { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'older' } } };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      field().value = 'newest';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body['draft']).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'newest' } } });

      // The hub answered; events it sent before it took the draft arrive after, with an older draft or none.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': older } } });
      expect(field().value).toBe('newest');
      source.emit('questions', { questions: { ...questions, drafts: {} } });
      expect(field().value).toBe('newest');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([{ card: 'reply:r1', slug: 'port-choice', letters: [], other: 'newest' }]);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows another device\'s draft once its own is carried back, whatever order the answers and events come in, and opens the work item chosen last', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment[data-card="reply:r1"]')!;
      const draft = (other: string) => ({ step: 'port-choice', picks: { 'port-choice': { letters: [], other } } });
      // Another device picks B.
      const picked = { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } };
      const chose = () => root.querySelector('.question-card[data-card="reply:r1"] [data-letter="B"]')!.getAttribute('aria-checked');
      const type = async (text: string) => {
        field().value = text;
        field().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      };
      const held = () => {
        let release = (): void => {};
        const wait = new Promise<void>((resolve) => (release = resolve));

        return { wait, release };
      };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);

      // Its own draft carried back, then another device's, both before the hub's answer: the other device's shows once the answer comes.
      let slow = held();

      answers['/card-draft'] = { status: 200, body: {}, wait: slow.wait };
      await type('mine');
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': draft('mine') } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': picked } } });
      expect(field().value).toBe('mine');
      expect(chose()).toBe('false');
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(chose()).toBe('true');

      // An older draft refused after the newest was carried back changes nothing.
      await vi.advanceTimersByTimeAsync(0);
      slow = held();
      answers['/card-draft'] = { status: 409, body: { error: 'x' }, wait: slow.wait };
      await type('first');
      answers['/card-draft'] = { status: 200, body: {} };
      await type('second');
      // The comment keeps the other device's pick beside it.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: 'second' } } } } } });
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(field().value).toBe('second');
      expect(chose()).toBe('true');
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: null } } } } } });
      expect(root.querySelector('.question-card[data-card="reply:r1"] [data-letter="A"]')!.getAttribute('aria-checked')).toBe('true');

      // A work item chosen while Other text is on its way wins over one chosen before it.
      await vi.advanceTimersByTimeAsync(0);
      slow = held();
      answers['/card-draft'] = { status: 200, body: {}, wait: slow.wait };
      field().value = 'leaving';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      posts = [];
      click('#list [data-work-item="2"]');
      click('#list [data-work-item="1"]');
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => (post.body['draft'] as ReturnType<typeof draft>).picks['port-choice'].other)).toEqual(['leaving']);
      expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).not.toContain(2);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('trusts a matching questions event for a draft whose answer never came, so another device\'s draft still shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      let release = () => {};
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => release = done) };
      const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field.value = 'acknowledged';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      const mine = { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'acknowledged' } } };
      const other = { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } };
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': mine } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': other } } });
      await vi.advanceTimersByTimeAsync(20_000);
      release();
      expect(root.querySelector('.question-card [data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('sends Other text at the scope generation the same session is shown at after a reconnect, and keeps it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const items = [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })];
      hello(source, { items, questions });
      await vi.advanceTimersByTimeAsync(0);
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field().value = 'keep across reconnect';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      // The stream reconnects and the hub shows the same session at a new scope generation before the typing pauses.
      hello(source, { key: 'reconnected', items, questions, scope: { ...scope, scopeGen: 1 } });
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body).toMatchObject({ sessionId: 's', scopeGen: 1, draft: { picks: { 'port-choice': { other: 'keep across reconnect' } } } });
      expect(field()?.value).toBe('keep across reconnect');
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('waits for every Other text still on its way before it opens another work item', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      const type = (text: string) => {
        const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      let first = () => {};
      let second = () => {};
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => first = done) };
      type('first');
      click('#list [data-work-item="2"]');
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => second = done) };
      type('second');
      click('#list [data-work-item="1"]');
      first();
      await vi.advanceTimersByTimeAsync(0);
      posts = [];
      click('#list [data-work-item="2"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter(post => post.url.endsWith('/select'))).toEqual([]);
      second();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('keeps newer Other text when an older draft the hub carried back times out, so Send sends the newer text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    let release = () => {};
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => release = done) };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field().value = 'acknowledged';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'acknowledged' } } } } } });
      await vi.advanceTimersByTimeAsync(19_900);
      field().value = 'newest still typing';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);
      expect(field()?.value).toBe('newest still typing');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter(post => post.url.endsWith('/send')).at(-1)?.body['answers']).toEqual([{ card: 'reply:r1', slug: 'port-choice', letters: [], other: 'newest still typing' }]);
    } finally {
      release();
      page.close();
      vi.useRealTimers();
    }
  });

  it("fits each fade to its details' lines when drawn, and opens for good, with no fade, details too short to fade", () => {
    // The page's other observers are left out: only the one that observes the fades' details.
    const observed: Element[] = [];
    let fit: ((entries: Array<{ target: Element }>) => void) | null = null;
    const had = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {}

      observe(target: Element): void {
        if (target.classList.contains('reply-more-text')) {
          observed.push(target);
          fit = this.callback;
        }
      }

      unobserve(target: Element): void {
        if (observed.includes(target)) {
          observed.splice(observed.indexOf(target), 1);
        }
      }

      disconnect(): void {
        if (fit === this.callback) {
          observed.length = 0;
          disconnected = true;
        }
      }
    });
    let disconnected = false;
    // Each paragraph of details is one line, 20 px below the one before.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const text = this.startContainer;
        const box = text.parentElement!.closest('.reply-more-text')!;
        const index = [...box.querySelectorAll('p')].indexOf(text.parentElement as HTMLParagraphElement);

        return [{ top: index * 20, bottom: index * 20 + 16, height: 16, width: 100 }];
      },
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
      if (had === undefined) {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      } else {
        Object.defineProperty(Range.prototype, 'getClientRects', had);
      }
    });
    const { page, source } = start();
    const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}.`).join('\n\n');

    // The newest reply shows whole, with no fade to fit, until a newer one comes.
    hello(source, { items: [reply('r1', 2, { opening: `Short.\n\n${paragraphs(3)}`, speak: 'Short.' }), reply('r2', 3, { opening: `Long.\n\n${paragraphs(6)}`, speak: 'Long.' }), reply('n1', 4, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(observed.map((text) => text.closest<HTMLElement>('li.reply')!.dataset['id'])).toEqual(['r1', 'r2']);
    fit!(observed.map((target) => ({ target })));

    // Three lines hide nothing worth a click: the reply opens, with no fade and nothing to click, and is no longer observed.
    const short = root.querySelector('li[data-id="r1"]')!;
    expect(short.classList.contains('folded')).toBe(false);
    expect(short.querySelector('.reply-fade')).toBeNull();
    expect(short.querySelector('.reply-more .reply-details')!.textContent).toContain('Line 3.');
    // Six lines fold after two whole lines and a third fading out.
    const fade = root.querySelector<HTMLElement>('li[data-id="r2"] .reply-fade')!;
    expect(root.querySelector('li[data-id="r2"]')!.classList.contains('folded')).toBe(true);
    expect([fade.style.getPropertyValue('--sb-fade-height'), fade.style.getPropertyValue('--sb-fade-solid')]).toEqual(['56px', '36px']);
    expect(observed.map((text) => text.closest<HTMLElement>('li.reply')!.dataset['id'])).toEqual(['r2']);
    // Opened, it is no longer observed either.
    click('li[data-id="r2"] .reply-fade');
    expect(observed).toEqual([]);

    // A focused fade that a wider page makes too short to fade gives the focus to its reply as it opens.
    source.emit('reply', { reply: reply('r3', 5, { opening: `Wide.\n\n${paragraphs(5)}`, speak: 'Wide.' }) });
    expect(observed).toEqual([]);
    source.emit('reply', { reply: reply('n2', 6, { opening: 'Next.' }) });
    const wide = root.querySelector<HTMLElement>('li[data-id="r3"] .reply-fade')!;
    fit!(observed.map((target) => ({ target })));
    expect(root.querySelector('li[data-id="r3"]')!.classList.contains('folded')).toBe(true);
    wide.focus();
    wide.querySelectorAll('p')[4]!.remove();
    wide.querySelectorAll('p')[3]!.remove();
    fit!(observed.map((target) => ({ target })));
    expect(root.querySelector('li[data-id="r3"]')!.classList.contains('folded')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r3"]'));

    // Closing the page lets go of the fades still folded.
    source.emit('reply', { reply: reply('r4', 7, { opening: `Last.\n\n${paragraphs(6)}`, speak: 'Last.' }) });
    source.emit('reply', { reply: reply('n3', 8, { opening: 'Next.' }) });
    expect(observed).toHaveLength(1);
    page.close();
    expect(disconnected).toBe(true);
    expect(observed).toEqual([]);
  });

  it('opens a folded reply for good on a click on its fade, with no Show less', () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: 'Short.\n\nWhole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    root.querySelector<HTMLElement>('li[data-id="r1"] .reply-fade')!.focus();
    click('li[data-id="r1"] .reply-fade');
    expect(root.querySelector('li[data-id="r1"] .reply-details')!.closest('.reply-fade')).toBeNull();
    expect(root.querySelector('li[data-id="r1"] .reply-fade')).toBeNull();
    expect(root.querySelector('li[data-id="r1"]')!.classList.contains('folded')).toBe(false);
    // The fade goes, and the reply takes its focus rather than leaving it to the page.
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r1"]'));
    expect(root.querySelector('#panel')!.textContent).not.toContain('Show less');
    // The reply stays open as the state changes.
    source.emit('reply', { reply: reply('r2', 4, { opening: 'Next.', speak: 'Next.' }) });
    expect(root.querySelector('#panel')!.textContent).toContain('Whole reply.');
    page.close();
  });

  it('shows the newest reply whole and folds it only once a newer reply comes, leaving a reply opened by a click open', () => {
    const { page, source } = start();
    const folded = (id: string) => root.querySelector(`li[data-id="${id}"]`)!.classList.contains('folded');

    hello(source, { items: [reply('r1', 2, { opening: 'First.\n\nDetails of r1.', speak: 'First.' })], settings: { briefReplies: true } });
    expect(folded('r1')).toBe(false);
    expect(shownText()).toContain('Details of r1.');
    source.emit('reply', { reply: reply('r2', 3, { opening: 'Second.\n\nDetails of r2.', speak: 'Second.' }) });
    expect(folded('r1')).toBe(true);
    expect(folded('r2')).toBe(false);
    expect(shownText()).not.toContain('Details of r1.');
    expect(shownText()).toContain('Details of r2.');
    // Opened by a click, it stays open as newer replies come, and the one they replace folds.
    click('li[data-id="r1"] .reply-fade');
    source.emit('reply', { reply: reply('r3', 4, { opening: 'Third.' }) });
    expect(folded('r1')).toBe(false);
    expect(folded('r2')).toBe(true);
    page.close();
  });

  it("follows a link in a folded reply's faded lines as a link, and opens the reply on a click on the faded text around it", () => {
    const { page, source } = start();
    const folded = () => root.querySelector('li[data-id="r1"]')!.classList.contains('folded');

    hello(source, { items: [reply('r1', 2, { opening: 'Fixed it.\n\nSee [the log](https://example.com/log) for more.', speak: 'Fixed it.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    const link = root.querySelector<HTMLAnchorElement>('li[data-id="r1"] .reply-fade a')!;
    const followed: boolean[] = [];

    link.addEventListener('click', (event) => { followed.push(true); event.preventDefault(); });
    link.click();
    expect(followed).toEqual([true]);
    expect(folded()).toBe(true);
    click('li[data-id="r1"] .reply-fade p');
    expect(folded()).toBe(false);
    expect(root.querySelector('li[data-id="r1"] .reply-more a')!.hasAttribute('tabindex')).toBe(false);
    page.close();
  });

  it('opens a folded reply on a click on its text or Enter or Space on its fade, but not on a click on a link, a selection or a modified key', () => {
    const { page, source } = start();
    const folded = (id: string) => root.querySelector(`li[data-id="${id}"]`)!.classList.contains('folded');
    const keyOn = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    const items = ['r1', 'r2', 'r3', 'r4'].map((id, index) => reply(id, index + 1, { opening: `See [the PR](https://example.com/${id}).\n\nDetails of ${id}.`, speak: `See [the PR](https://example.com/${id}).` }));

    hello(source, { items: [...items, reply('n1', 5, { opening: 'Next.' })], settings: { briefReplies: true } });
    // A link in the primary response opens as a link and leaves the reply folded.
    const link = root.querySelector<HTMLAnchorElement>('li[data-id="r1"] .reply-primary a')!;
    const opened: boolean[] = [];
    link.addEventListener('click', (event) => { opened.push(true); event.preventDefault(); });
    link.click();
    expect(opened).toEqual([true]);
    expect(folded('r1')).toBe(true);
    // A click on the primary response's text opens it.
    click('li[data-id="r1"] .reply-primary p');
    expect(folded('r1')).toBe(false);
    expect(root.querySelector('li[data-id="r1"] .body')!.textContent).toContain('Details of r1.');
    // A click that ends a drag selecting text leaves it folded.
    const text = root.querySelector('li[data-id="r2"] .reply-primary p')!;
    document.getSelection()!.selectAllChildren(text);
    click('li[data-id="r2"] .reply-primary p');
    expect(folded('r2')).toBe(true);
    document.getSelection()!.removeAllRanges();
    // Enter and Space on the fade open the reply and move the focus to it; a key with Ctrl does not.
    const fade3 = root.querySelector<HTMLElement>('li[data-id="r3"] .reply-fade')!;
    fade3.focus();
    expect(keyOn(fade3, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(folded('r3')).toBe(true);
    expect(keyOn(fade3, { key: 'Enter' })).toBe(false);
    expect(folded('r3')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r3"]'));
    const fade4 = root.querySelector<HTMLElement>('li[data-id="r4"] .reply-fade')!;
    expect(keyOn(fade4, { key: ' ' })).toBe(false);
    expect(folded('r4')).toBe(false);
    page.close();
  });

  it("sets voice.briefReplies from View options' Collapse details on this computer's page, follows the hub's settings, and keeps a paired device's choice on that device", async () => {
    const { page, source } = start();
    const briefRow = () => root.querySelector('[data-action="toggle-brief-replies"]');

    // Collapse details is off by default: a reply shows whole.
    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })] });
    expect(shownText()).toContain('Whole reply.');
    click('.header button.view-options');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(briefRow()!.getAttribute('role')).toBe('menuitemcheckbox');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/brief-replies')).map((post) => post.body)).toEqual([expect.objectContaining({ window: 'pk', on: true })]);
    // The checkbox and the replies follow settings.json as the hub reloads it, not the click.
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    source.emit('settings', { settings: { briefReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    expect(shownText()).not.toContain('Whole reply.');

    // A second click before the hub's settings event reverses the first; the saves go one at a time, so the last click's value is the one kept.
    let answer = () => {};
    const sent = () => posts.filter((post) => post.url.endsWith('/brief-replies')).map((post) => post.body['on']);

    answers['/brief-replies'] = { status: 200, body: {}, wait: new Promise<void>((done) => (answer = done)) };
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(sent()).toEqual([true, false]);
    delete answers['/brief-replies'];
    answer();
    await flush();
    await flush();
    expect(sent()).toEqual([true, false, true]);
    source.emit('settings', { settings: { briefReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });

    // A refusal shows why, and the setting stays as it was.
    answers['/brief-replies'] = { status: 409, body: { error: 'settings.json is not valid JSON: Unexpected token.' } };
    click('[data-action="toggle-brief-replies"]');
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/brief-replies')).at(-1)!.body).toMatchObject({ on: false });
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('settings.json is not valid JSON: Unexpected token.');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    page.close();

    // This computer's page never reads a paired device's choice.
    expect(localStorage.getItem('switchboard.briefReplies')).toBeNull();

    // A paired device may not change settings.json (architecture.md § Remote access), so its Collapse details starts from voice.briefReplies
    // and, once toggled, is kept on the device and posts nothing.
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const pairedPage = () => startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const briefPosts = () => fetch.mock.calls.filter((call) => String((call as unknown[])[0]).endsWith('/brief-replies'));
    let paired = pairedPage();

    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    click('.header button.view-options');
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim()).slice(0, 2)).toEqual(['Show message details', 'Collapse details']);
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(shownText()).toContain('Whole reply.');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(briefPosts()).toEqual([]);
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('1');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    expect(shownText()).not.toContain('Whole reply.');

    // The device's choice outlasts the hub's settings and a reload.
    FakeSource.last!.emit('settings', { settings: { briefReplies: false, diffLayout: 'auto', diffWrap: 'auto' } });
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    paired.close();
    paired = pairedPage();
    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    expect(shownText()).not.toContain('Whole reply.');
    click('.header button.view-options');
    click('[data-action="toggle-brief-replies"]');
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('0');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(shownText()).toContain('Whole reply.');
    expect(briefPosts()).toEqual([]);
    paired.close();
  });

  it("starts a paired device's Collapse details from the Expand replies it kept before, inverted, and drops the old key once toggled", async () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const pairedPage = () => startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const briefRow = () => root.querySelector('[data-action="toggle-brief-replies"]');

    localStorage.setItem('switchboard.expandReplies', '0');
    let paired = pairedPage();

    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    expect(shownText()).not.toContain('Whole reply.');
    click('.header button.view-options');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    click('[data-action="toggle-brief-replies"]');
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('0');
    expect(localStorage.getItem('switchboard.expandReplies')).toBeNull();
    paired.close();

    localStorage.removeItem('switchboard.briefReplies');
    localStorage.setItem('switchboard.expandReplies', '1');
    paired = pairedPage();
    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(shownText()).toContain('Whole reply.');
    paired.close();
    localStorage.clear();
  });

  it('opens the dropdown, selects another conversation, pages back, and folds a focused reply', async () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(root.querySelector('#panel')!.textContent).toContain('Short.');
    click('[data-action="more"]');
    expect(shownText()).toContain('Whole reply.');
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

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

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

  it('closes only the composer list, or stops only the speech, on an Escape in the composer, leaving the maximized column and keeping speech for a later Escape', async () => {
    const width = window.innerWidth;

    window.innerWidth = 1440;

    const { page, source } = start();

    hello(source);
    click('#detail .panel-max');
    expect(root.classList.contains('maximized')).toBe(true);

    const input = root.querySelector('textarea')!;
    const escape = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const stops = () => posts.filter((post) => post.url.endsWith('/stop-speaking')).length;

    answers['/files'] = { status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } };
    input.value = '@a';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(false);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null } });
    // The first Escape closes the list alone: the column stays maximized and the reply goes on.
    escape(input);
    await flush();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(true);
    expect(root.classList.contains('maximized')).toBe(true);
    expect(stops()).toBe(0);
    // The next stops the speech alone.
    escape(input);
    await flush();
    expect(stops()).toBe(1);
    expect(root.classList.contains('maximized')).toBe(true);
    // With nothing left in the composer, Escape restores the column.
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null } });
    escape(input);
    expect(root.classList.contains('maximized')).toBe(false);
    window.innerWidth = width;
    page.close();
  });

  it('puts back a message a stopped hub left unsent, only that, with why, and drives the voice from its buttons', async () => {
    const { page, source } = start();

    hello(source);
    // A message a stopped hub left, which every page showing the session takes back.
    source.emit('message', { message: message('m9', 9, { delivery: 'not-sent', error: 'The holder did not answer.', text: 'lost words' }), giveBack: true });
    // One this page did not send stays out of its composer.
    source.emit('message', { message: message('m8', 8, { delivery: 'not-sent', error: 'x', text: 'not mine' }) });
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('lost words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The holder did not answer.');
    // While the voice is elsewhere, one Talk here takes the cluster's place; here, Speak replies, with no Stop beside it while a reply plays.
    expect(root.querySelector('[data-voice="speak-replies"]')).toBeNull();
    click('[data-voice="talk-here"]');
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null } });
    // The cluster sits with the mic and Send, never among the message tools beside the context meter.
    expect(root.querySelector('.composer-footer > .composer-end > .voice-controls ~ .send')).not.toBeNull();
    expect(root.querySelector('.composer-controls .voice-controls')).toBeNull();
    expect(root.querySelectorAll('.voice-controls button')).toHaveLength(1);
    expect(root.querySelector('.voice-controls .codicon-debug-stop')).toBeNull();
    expect(root.querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe(SPEAKING_TIP);
    // The speaker turns Speak replies off, which stops the reply playing.
    click('[data-voice="speak-replies"]');
    await flush();
    expect(posts.filter((post) => /talk-here|speak-replies/.test(post.url)).map((post) => post.body['on'] ?? 'talk')).toEqual(['talk', false]);
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);
    // Off, a reply plays only as a Replay, which the speaker stops.
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: false, error: null } });
    expect(root.querySelector('[data-voice="stop"]')!.getAttribute('title')).toBe(REPLAY_TIP);
    click('[data-voice="stop"]');
    await flush();
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(true);
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null } });

    // The mic is packages/conversation's button, and drives the computer's voice process.
    expect(root.querySelector('.composer-mic')!.innerHTML).toBe(renderMicButton({ enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null }));
    click('.composer-mic [data-voice="mic"]');
    // Starting from the click, before the hub answers.
    expect(root.querySelector('.composer-mic .mic.starting')).not.toBeNull();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/mic'))?.body).toMatchObject({ on: true, scopeGen: 3 });
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'paused-other-app', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic')!.getAttribute('title')).toContain('another app is using the microphone');
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic.listening')).not.toBeNull();
    await flush();
    // The tap's start, timed from the click, goes to the hub log once the voice confirmed it.
    expect(posts.filter((post) => post.url.endsWith('/mic-timing')).map((post) => [post.body['outcome'], (post.body['steps'] as Array<{ step: string }>).map((one) => one.step)])).toEqual([['paused-other-app', ['hub answered', 'voice confirmed']]]);

    // Focusing the box and leaving it tell the hub, for the focus rule of dictation.
    const box = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    box.focus();
    box.blur();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body['focused'])).toEqual([true, false]);
    page.close();
  });

  it('shows a paired device\'s mic off while the voice is elsewhere, so its tap can take the voice to the phone, and fetches its audio worklet ahead (PRD R119)', () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const source = FakeSource.last!;

    hello(source);
    const worklets = () => fetch.mock.calls.filter((call) => String((call as unknown[])[0]).endsWith('/page/voice-worklet.js')).length;

    // The audio worklet is fetched once voice is on, ahead of the tap, and once only.
    source.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')?.getAttribute('data-on')).toBe('true');
    source.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: false, error: null } });
    expect(worklets()).toBe(1);
    page.close();

    // This computer's page shows Talk here instead.
    const local = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: true });

    hello(FakeSource.last!);
    FakeSource.last!.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')).toBeNull();
    expect(worklets()).toBe(1);
    local.close();
  });

  it('marks an unread reply seen once it has shown for a second on a focused page', async () => {
    vi.useFakeTimers();

    let now = 10_000;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => now });

    hello(FakeSource.last!);
    // The unread reply's dot is its plain bullet: unread replies are marked only on conversations not selected (PRD R100).
    expect(root.querySelector('.reply[data-unread="r1"] .dot')!.getAttribute('title')).toBeNull();
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.find((post) => post.url.endsWith('/seen'))?.body).toMatchObject({ sessionId: 's', ids: ['r1'], scopeGen: 3 });
    page.close();
  });

  it('starts on the work item and tab this device kept when the address has none, as an installed app started again, and keeps each tab change', async () => {
    window.innerWidth = 375;
    localStorage.setItem('switchboard.route', '#w=1&t=status');

    const { page, source } = start();

    // At once: the work item, before its hello.
    expect(location.hash).toBe('#w=1&t=status');
    // The stream's first hello, before the page selected the work item on it.
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(location.hash).toBe('#w=1&t=status');
    hello(source);
    expect(root.classList.contains('listing')).toBe(false);
    // Where the column folds into the conversation's strip, the opening shows the Conversation tab (PRD R109), and the address follows it.
    expect(root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab']).toBe('conversation');
    expect(location.hash).toBe('#w=1');
    if (root.querySelector('#head [data-action="artifact"][data-path="chat/plan.md"]') === null) {
      click('#head .tab-more-button');
    }

    click('#head [data-action="artifact"][data-path="chat/plan.md"]');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fplan.md');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1&t=artifact%3Achat%2Fplan.md');
    click('#head [data-tab="conversation"]');
    expect(location.hash).toBe('#w=1');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    page.close();
    window.innerWidth = 1024;
  });

  it("keeps the conversation's place for a reload by the first item in view, and comes back to it", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();

    const first = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    hello(first.source);
    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 500, configurable: true });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);

    for (const [id, top] of [['m1', -200], ['r1', 80]] as const) {
      vi.spyOn(panel.querySelector<HTMLElement>(`li[data-id="${id}"]`)!, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 150 } as DOMRect);
    }

    panel.scrollTop = 40;
    panel.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)).toEqual({ '1 conversation s': { id: 'r1', offset: -20, pinned: false, top: 40 } });
    first.page.close();
    vi.restoreAllMocks();

    // The reload: the item that was first in view goes back 20 px above the pane's top.
    const second = start();
    const again = root.querySelector<HTMLElement>('#panel')!;
    const realQuery = again.querySelectorAll.bind(again);

    vi.spyOn(again, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    vi.spyOn(again, 'querySelectorAll').mockImplementation(((selector: string) => {
      const found = realQuery(selector);

      for (const item of found) {
        if ((item as HTMLElement).dataset['id'] === 'r1') {
          vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 550 } as DOMRect);
        }
      }

      return found;
    }) as typeof again.querySelectorAll);
    Object.defineProperty(again, 'scrollHeight', { value: 2000, configurable: true });
    hello(second.source);
    // From the end (scrollHeight), up by the anchor's offset: 2000 + (400 - 100 - -20).
    expect(again.scrollTop).toBe(2000 + 320);
    second.page.close();
    window.innerWidth = 1024;
  });

  it('restores the Changes tab at its file, a local file tab at its line, and the History tab, from the route after a reload, and keeps them in it', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=changes&f=src%2Fa.ts');
    // The reads' answers do not matter here: only that the page asks for them.
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'Not in this window.' } };
    answers['/page-history'] = { status: 409, body: { error: 'No such ticket.' } };
    answers['/local-file'] = { status: 404, body: { error: 'not found' } };

    const first = start();

    hello(first.source);
    await flush();
    expect(root.querySelector('#detail .detail-body')!.classList.contains('diff-pane')).toBe(true);
    expect(posts.some((post) => post.url.startsWith('/v1/conversation/changes?'))).toBe(true);
    expect(location.hash).toBe('#w=1&t=changes&f=src%2Fa.ts');
    first.page.close();

    history.replaceState(null, '', '#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    posts = [];

    const second = start();

    hello(second.source);
    await flush();
    expect(posts.some((post) => post.url.includes('/local-file') && post.url.includes(encodeURIComponent('D:/w/README.md')))).toBe(true);
    expect(location.hash).toBe('#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    second.page.close();

    // History is a tab of the work item's: an address from before, which named it apart as `h`, opens that tab.
    history.replaceState(null, '', '#w=1&h=7&hk=gh%207');
    posts = [];

    const third = start();

    hello(third.source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 7, key: 'gh 7' } })])] });
    await flush();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(posts.find((post) => post.url.endsWith('/page-history'))?.body).toMatchObject({ ticketId: 7 });
    expect(location.hash).toBe('#w=1&t=history');
    third.page.close();
    window.innerWidth = 1024;
  });

  it("shows the list after a phone's Back and a reload, keeps Back to the list over a reload with no new entries, and opens the kept route from an empty hash", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');

    const entries = history.length;
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])];
    const listHello = (source: FakeSource) => source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    const first = start();

    // Started on a conversation, the page puts the list's entry under it.
    expect(history.length).toBe(entries + 1);
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(location.hash).toBe('#w=1');
    hello(first.source);
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    first.page.close();

    // A reload of that entry adds none, and the browser's back still goes to the list.
    const second = start();

    expect(history.length).toBe(entries + 1);
    hello(second.source);
    expect(root.classList.contains('listing')).toBe(false);

    let pop = popped();

    history.back();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    second.page.close();

    // A reload of the list shows the list, not the work item this device kept.
    posts = [];

    const third = start();

    listHello(third.source);
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    expect(location.hash).toBe('#list');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    third.page.close();

    // An empty hash, as an installed app starts at its start URL, opens the route this device kept.
    history.replaceState(null, '', '#');
    posts = [];

    const fourth = start();

    listHello(fourth.source);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(1);
    expect(location.hash).toBe('#w=1');
    fourth.page.close();
    pop = popped();
    history.back();
    await pop;
    window.innerWidth = 1024;
  });

  it("puts #list in the address for a phone's Back from a conversation with no entry of its own, as after a wider page narrowed, and keeps the device's route", () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source);
    expect(history.state).toBeNull();
    resizeTo(375);
    click('.header > button.back-toggle');
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    expect(localStorage.getItem('switchboard.route')).toMatch(/^#w=1\b/);
    page.close();
    window.innerWidth = 1024;
  });

  it("applies a phone's conversation entry's route on the browser's forward, showing the Conversation tab with the route's tab kept for the column", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#list');
    history.pushState({ switchboardConversation: true }, '', '#w=2&t=status');

    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    let pop = popped();

    history.back();
    await pop;

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    pop = popped();
    history.forward();
    await pop;
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2]);
    hello(source, { scope: { ...scope, workItemId: 2 } });
    expect(root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab']).toBe('conversation');
    expect(location.hash).toBe('#w=2');
    // The route's tab is the column's choice: a wider page shows it.
    resizeTo(1440);
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    page.close();
    window.innerWidth = 1024;
  });

  it('applies an address edited by hand on a wide page, gives way to Status for an artifact closed on every device, and moves no tab on a tabs event', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=artifact%3Achat%2Fplan.md');

    const entries = history.length;
    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs'));
    const selected = () => root.querySelector('#detail .artifact-tab.selected');

    // Closed on every device: the route does not open it again.
    hello(source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    await flush();
    expect(root.querySelector('#detail [data-side="status"]')?.getAttribute('aria-selected')).toBe('true');
    expect(selected()).toBeNull();
    expect(location.hash).toBe('#w=1&t=status');
    expect(kept()).toEqual([]);
    // A wide page adds no history entry.
    expect(history.length).toBe(entries);

    // The address edited by hand: its route, as no choice of the operator's.
    history.pushState(null, '', '#w=1&t=artifact%3Achat%2Fp.html');
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(selected()?.getAttribute('data-path')).toBe('chat/p.html');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fp.html');
    expect(kept()).toEqual([]);

    // A tabs event, as another device's kept tab, only reconciles the closed artifacts.
    source.emit('tabs', { workItemId: 1, tabs: { tab: 'artifact:chat/plan.md', closed: [] } });
    expect(selected()?.getAttribute('data-path')).toBe('chat/p.html');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fp.html');
    page.close();
    window.innerWidth = 1024;
  });

  it("brings back a link tab added from the conversation and the link selected over a reload and another work item, with and without the extension", async () => {
    window.innerWidth = 1920;

    const issue = 'https://github.com/o/r/issues/1';
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };
    const docs = 'https://docs.example.com/guide';
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it', url: issue, links: [pr] }), listRow(2, { title: 'Side', url: 'https://github.com/o/r/issues/2' })])];
    const selected = (): string | null | undefined => root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url');
    const links = (): Array<string | null> => [...root.querySelectorAll('#detail [data-action="iframe-open"]')].map((tab) => tab.getAttribute('data-url'));
    const open = (extension: boolean) =>
      startPage(root, {
        fetch: (async (url: string, init?: { body?: string }) => {
          posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
          return { status: 200, ok: true, json: async () => ({}) };
        }) as unknown as typeof globalThis.fetch,
        EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: () => undefined,
        extensionInstallable: () => true, toExtension: async () => (extension ? { ok: true } : null),
      });

    history.replaceState(null, '', '#w=1');

    const first = open(true);

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups });
    await flush();
    // A web link of the conversation opens a link tab of its own, named by its link.
    root.querySelector('#panel .timeline')!.insertAdjacentHTML('beforeend', `<li><div class="body"><a href="${docs}" target="_blank">Guide</a></div></li>`);
    root.querySelector<HTMLElement>(`#panel a[href="${docs}"]`)!.click();
    await flush();
    expect(selected()).toBe(docs);
    // The ticket's link tab closed.
    click(`#detail [data-action="iframe-close"][data-url="${issue}"]`);
    click(`#detail [data-action="iframe-open"][data-url="${pr.url}"]`);
    await flush();
    expect(links()).toEqual([pr.url, docs]);
    expect(location.hash).toBe(`#w=1&t=link&u=${encodeURIComponent(pr.url)}`);

    // Another work item and back.
    click('#list [data-work-item="2"]');
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    await flush();
    expect(links()).toEqual(['https://github.com/o/r/issues/2']);
    click('#list [data-work-item="1"]');
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups, scope: { ...scope, scopeGen: 5 } });
    await flush();
    expect(links()).toEqual([pr.url, docs]);
    expect(selected()).toBe(pr.url);
    window.dispatchEvent(new Event('pagehide'));
    first.close();

    // A reload, with the extension and without it: the same tabs, the ticket's still closed, and the link the route names selected.
    for (const extension of [true, false]) {
      history.replaceState(null, '', `#w=1&t=link&u=${encodeURIComponent(docs)}`);

      const again = open(extension);

      hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups });
      await flush();
      expect(links()).toEqual([pr.url, docs]);
      expect(selected()).toBe(docs);
      expect(root.querySelector('#detail .detail-body')!.textContent).toContain(extension ? 'Open with sign-in support' : 'Open in a browser tab');
      again.close();
    }
  });

  it("keeps New conversation…'s draft over a reload, with its provider and text, until it is cancelled", async () => {
    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['claude', 'codex'] } };
    history.replaceState(null, '', '#w=1');

    const first = start();
    const input = () => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    hello(first.source);
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    click('[data-action="draft-provider"][data-provider="codex"]');
    input().value = 'Start over';
    input().dispatchEvent(new Event('input'));
    first.page.close();

    const second = start();

    hello(second.source);
    await flush();
    expect(root.querySelector('#panel .new-draft')).not.toBeNull();
    expect(input().value).toBe('Start over');
    expect(root.querySelector('.draft-note [aria-pressed="true"]')!.textContent).toBe('Codex');
    click('[data-action="draft-cancel"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    second.page.close();

    // Cancelled, it is gone after a reload too.
    const third = start();

    hello(third.source);
    await flush();
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(input().value).toBe('');
    third.page.close();
  });

  it("gives a reload of the current session its own place, not an earlier session's, and brings History back to its place", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();
    // Only the earlier session's place.
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 conversation old': { id: 'r1', offset: -20, pinned: false, top: 40 } }));

    const first = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    hello(first.source);
    // At the end, as a conversation with no place of its own.
    expect(panel.scrollTop).toBe(2000);
    first.page.close();
    vi.restoreAllMocks();

    // History's body scrolls under its toolbar, and its place is the body's.
    window.innerWidth = 1440;
    answers['/page-history'] = { status: 200, body: { view: { key: 'gh 7', title: 'Fix it', url: '', facts: [], links: [], reconstructed: false, recordedSince: null, sections: [] }, categories: [] } };
    history.replaceState(null, '', '#w=1&t=history');

    const withHistory = { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 7, key: 'gh 7' } })])] };
    const second = start();

    hello(second.source, withHistory);
    await vi.waitFor(() => expect(root.querySelector('#detail .hist-body .hist-hero')).not.toBeNull());
    root.querySelector<HTMLElement>('#detail .hist-body')!.scrollTop = 180;
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 history']).toMatchObject({ top: 180 });
    second.page.close();

    const third = start();

    hello(third.source, withHistory);
    await vi.waitFor(() => expect(root.querySelector('#detail .hist-body .hist-hero')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('#detail .hist-body')!.scrollTop).toBe(180);
    third.page.close();
    window.innerWidth = 1024;
  });

  it('keeps the Changes tab and a tab\'s scroll place through a new session of the work item, as Approve starts, reading the tab again, and drops them for another work item', async () => {
    window.innerWidth = 375;
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'Not in this window.' } };

    const { page, source } = start();
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/changes?')).length;

    hello(source);
    click('#head [data-action="diff-tab"]');
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(true);
    const before = reads();

    // Approve runs the approval prompt in a new session of the same work item: the hub sends `scope`, then its `hello`.
    source.emit('scope', { scope: { ...scope, scopeGen: 4, sessionId: 's2' } });
    hello(source, { scope: { ...scope, scopeGen: 4, sessionId: 's2' }, sessions: [session({ id: 's2', title: 'Task session s2', state: 'running' })], items: [] });
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(true);
    // The new session can change the worktree, so the open tab reads its list again.
    expect(reads()).toBe(before + 1);

    // A tab's scroll place stays too.
    click('#head [data-tab="status"]');
    const panel = root.querySelector<HTMLElement>('#panel')!;

    panel.scrollTop = 237;
    source.emit('scope', { scope: { ...scope, scopeGen: 5, sessionId: 's4' } });
    hello(source, { scope: { ...scope, scopeGen: 5, sessionId: 's4' }, sessions: [session({ id: 's4' })], items: [] });
    await flush();
    expect(root.querySelector('#head [data-tab="status"]')!.getAttribute('aria-selected')).toBe('true');
    expect(panel.scrollTop).toBe(237);

    // Another work item starts from its own tabs.
    hello(source, { scope: { ...scope, workItemId: 2, scopeGen: 6, sessionId: 's3' }, sessions: [session({ id: 's3' })] });
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(false);
    page.close();
    window.innerWidth = 1024;
  });

  it("lists the work item's earlier sessions newest first in the dropdown, opens one read-only and goes back to the current one", async () => {
    const earlier = [
      { sessionId: 's1', title: 'Task session s1', state: 'ended' as const, startedAt: 10_000 - 3 * 3_600_000, provider: 'claude' },
      { sessionId: 's0', title: 'Setup session s0', state: 'ended' as const, startedAt: 10_000 - 2 * 86_400_000, provider: 'claude' },
    ];
    const listed = { ...scope, sessionId: 's2', conversations: [{ ...scope.conversations[0]!, sessionId: 's2', sessionTitle: 'Fix the badge count', sessionStartedAt: 1_200, sessions: earlier }] };
    const { page, source } = start();
    const selects = () => posts.filter((post) => post.url.endsWith('/select')).map((post) => ({ workItemId: post.body['workItemId'], sessionId: post.body['sessionId'] }));

    const openPicker = () => root.querySelector('.conversation-menu') !== null || click('button.picker');

    hello(source, { scope: listed, sessions: [session({ id: 's2', title: 'Task session s2' })] });
    openPicker();
    expect([...root.querySelectorAll('.conversation-menu .conversation-row')].map((row) => [row.querySelector('.title')!.textContent, row.getAttribute('aria-checked'), row.querySelector('.menu-note')?.textContent ?? null])).toEqual([
      ['Fix the badge count', 'true', null],
      ['Task session s1', 'false', '3 h ago'],
      ['Setup session s0', 'false', '2 d ago'],
    ]);
    expect(root.querySelector('.session-row .codicon')!.getAttribute('aria-label')).toBe('Ended');

    // The artifact open stays open through choosing a session.
    click('[data-action="artifact"][data-path="chat/plan.md"] .tab-open, [data-action="artifact"][data-path="chat/plan.md"]');
    expect(root.querySelector('.artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    openPicker();
    click('.session-row[data-session="s1"]');
    await flush();
    expect(selects()).toEqual([{ workItemId: 1, sessionId: 's1' }]);
    expect(root.querySelector('.artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');

    // Choosing the current session again before the hub's scope for s1 came asks for it, so the late scope cannot win.
    openPicker();
    click('.conversation-menu [data-action="select"][data-work-item="1"]');
    await flush();
    expect(selects()).toEqual([{ workItemId: 1, sessionId: 's1' }, { workItemId: 1, sessionId: undefined }]);
    openPicker();
    click('.session-row[data-session="s1"]');
    await flush();
    expect(selects()).toHaveLength(3);

    // The hub shows it read-only: the composer is off, the note says why and offers the current session, and the button names the session.
    const shown = { ...listed, scopeGen: 4, sessionId: 's1', earlier: true };

    source.emit('scope', { scope: shown });
    hello(source, { scope: shown, sessions: [session({ id: 's1', title: 'Task session s1', state: 'ended', conversation: 'read-only', reason: 'This is an earlier session of the work item, shown read-only.' })], items: [reply('old', 1)] });
    expect(root.querySelector('.session-note-text')!.textContent).toBe('An earlier session of this work item, shown read-only.');
    expect(root.querySelector('[data-action="resume"]')).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('#composer textarea, textarea')!.disabled).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('#composer textarea, textarea')!.placeholder).toBe('Show the current session to send a message.');
    // The button shows the work item's title over the earlier session's name, with its provider's mark, both in its tooltip.
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')!.textContent).toBe('Task session s1');
    expect(root.querySelector('button.picker .provider')!.getAttribute('aria-label')).toBe('Claude');
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('Task session s1 · Fix it');
    // Its timeline ends where the current session started: an artifact written before then shows in it, one written after only in the current one.
    for (const [path, updatedAt] of [['chat/early.md', 1_100], ['chat/late.md', 1_300]] as const) {
      source.emit('artifact', { artifact: { path, owner: 'chat', kind: 'note', title: path, ext: 'md', type: 'markdown', updatedAt } });
    }
    expect(root.querySelector('#panel .artifact-open[data-path="chat/early.md"]')).not.toBeNull();
    expect(root.querySelector('#panel .artifact-open[data-path="chat/late.md"]')).toBeNull();
    openPicker();
    expect([...root.querySelectorAll('.conversation-menu .conversation-row')].map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);

    // A new stream, as after a hub restart, asks for the same earlier session again.
    hello(source, { key: 'pk2', scope: null, sessions: [], items: [] });
    await flush();
    expect(selects().slice(3)).toEqual([{ workItemId: 1, sessionId: 's1' }]);
    source.emit('scope', { scope: { ...shown, key: 'pk2', scopeGen: 5 } });
    hello(source, { key: 'pk2', scope: { ...shown, key: 'pk2', scopeGen: 5 }, sessions: [session({ id: 's1', state: 'ended', conversation: 'read-only' })], items: [reply('old', 1)] });
    await flush();
    expect(selects()).toHaveLength(4);

    // The conversation's own row, or the note's button, goes back to the current session.
    openPicker();
    click('.conversation-menu [data-action="select"][data-work-item="1"]');
    await flush();
    expect(selects().at(-1)).toEqual({ workItemId: 1, sessionId: undefined });
    // The note's button asks for the same, so it is not asked twice while the hub's scope is on its way.
    click('.session-note [data-action="select"]');
    await flush();
    expect(selects()).toHaveLength(5);
    page.close();
  });

  it("keeps a conversation's kept place through a reload onto another tab, gives it back on A to B to A, and reads the Changes tab again after a reconnect", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1&t=status');

    const { page, source } = start();

    hello(source);

    // A to B: A's place is kept; back to A, the conversation takes it again rather than its end.
    const panel = root.querySelector<HTMLElement>('#panel')!;

    click('#head [data-tab="conversation"]');
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    hello(source, { scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    // Where A was when it was left, as the operator had scrolled it.
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 conversation s': { id: 'r1', offset: 0, pinned: false, top: 0 } }));
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    const realQuery = panel.querySelectorAll.bind(panel);

    vi.spyOn(panel, 'querySelectorAll').mockImplementation(((selector: string) => {
      const found = realQuery(selector);

      for (const item of found) {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: (item as HTMLElement).dataset['id'] === 'r1' ? 400 : 0, bottom: 500 } as DOMRect);
      }

      return found;
    }) as typeof panel.querySelectorAll);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    hello(source, { scope: { ...scope, scopeGen: 5 } });
    expect(panel.scrollTop).toBe(2000 + 300);
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    // The Changes tab, kept through a reconnect, reads its list again once the new stream shows the work item.
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'Not in this window.' } };
    click('#head [data-action="diff-tab"]');
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/changes?')).length;
    const before = reads();

    expect(before).toBeGreaterThan(0);

    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(reads()).toBe(before);
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 } });
    expect(reads()).toBe(before + 1);
    page.close();
    window.innerWidth = 1024;
  });

  it("keeps an artifact document's place over a reload", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=artifact%3Achat%2Fplan.md');
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 artifact:chat/plan.md': { id: null, offset: 0, pinned: false, top: 240 } }));
    answers['/v1/conversation/artifact/'] = { status: 200, body: {}, text: '# Plan\n\nLong.' };

    const { page, source } = start();

    hello(source);
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('#detail .artifact-doc')?.textContent).toContain('Long.'));
    expect(root.querySelector<HTMLElement>('#detail .artifact-doc')!.scrollTop).toBe(240);
    root.querySelector<HTMLElement>('#detail .artifact-doc')!.scrollTop = 300;
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 artifact:chat/plan.md']).toMatchObject({ top: 300 });
    page.close();
    window.innerWidth = 1024;
  });

  it('keeps each tab its own scroll place for the work item, and gives it back when the tab shows again', () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();

    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    hello(source);
    click('#head [data-tab="status"]');
    panel.scrollTop = 120;
    click('#head [data-tab="conversation"]');
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 status']).toMatchObject({ top: 120 });
    click('#head [data-tab="status"]');
    expect(panel.scrollTop).toBe(120);
    page.close();
    window.innerWidth = 1024;
  });

  it('tries a send whose answer was lost again with the same opId, and the same text sent again after it failed reuses it', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const sends = () => posts.filter((post) => post.url.endsWith('/send'));

    input.value = 'Ship it';
    input.dispatchEvent(new Event('input'));
    answers['/send'] = { status: 503, body: { error: 'The hub is restarting onto a new build; try again in a few seconds.' } };
    click('button.send');
    await vi.advanceTimersByTimeAsync(SEND_RETRY_MS);
    expect(sends().length).toBeGreaterThan(2);
    expect(new Set(sends().map((post) => post.body['opId'])).size).toBe(1);
    expect(root.querySelector('#toast .toast-text')?.textContent).toBe('Not sent. Switchboard is restarting. Try again in a moment.');
    expect(input.value).toBe('Ship it');

    const first = sends()[0]!.body['opId'];

    answers['/send'] = { status: 200, body: { message: { id: 'm9' } } };
    click('button.send');
    await vi.advanceTimersByTimeAsync(0);
    expect(sends().at(-1)!.body['opId']).toBe(first);
    expect(input.value).toBe('');

    // Another message is another operation.
    input.value = 'And the docs';
    input.dispatchEvent(new Event('input'));
    click('button.send');
    await vi.advanceTimersByTimeAsync(0);
    expect(sends().at(-1)!.body['opId']).not.toBe(first);
    page.close();
  });

  it("brings back a work item's file tabs in order, its Changes tab and the tab shown after another work item and after a reload, and forgets a closed tab", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other' })])];
    const scopeOf = (workItemId: number) => ({ ...scope, workItemId, scopeGen: 3 + workItemId, title: `Item ${workItemId}`, conversations: [{ ...scope.conversations[0]!, workItemId, title: `Item ${workItemId}` }] });
    const helloFor = (source: FakeSource, workItemId: number) => source.emit('hello', { key: 'pk', groups, scope: scopeOf(workItemId), sessions: [session()], items: [reply('r1', 2, { opening: 'See [a](src/a.ts#L3) and [b](src/b.ts).' })], more: false, status: null, artifacts: [artifact('chat/plan.md', 'markdown', 'md')] });
    const fileTabs = () => [...root.querySelectorAll<HTMLElement>('#detail .detail-head [data-action="local-tab"]')].map((one) => `${one.title}${one.getAttribute('aria-selected') === 'true' ? ' *' : ''}`);
    const shown = () => root.querySelector<HTMLElement>('#detail .detail-head [aria-selected="true"]');
    // Read or not, a file tab is named by its link's target.
    answers['local-file'] = { status: 404, body: { error: 'Not found.' } };
    answers['changes'] = { status: 404, body: { error: 'No changes here.' } };
    let { page, source } = start();

    helloFor(source, 1);
    click('#panel a.path-link');
    click('#panel a.path-link:nth-of-type(2)');
    click('#detail .changes-tab');
    click('#detail [data-action="local-tab"]');
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3 *', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')).not.toBeNull();

    // Another work item opens on its own tabs.
    click('[data-work-item="2"]');
    helloFor(source, 2);
    await flush();
    expect(fileTabs()).toEqual([]);
    expect(shown()?.dataset['side']).toBe('status');
    click('#detail [data-side="console"]');
    expect(shown()?.dataset['side']).toBe('console');

    // Back: the same file tabs in their order, a.ts shown, and the Changes tab.
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3 *', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')).not.toBeNull();
    // And work item 2 again on Console.
    click('[data-work-item="2"]');
    helloFor(source, 2);
    expect(shown()?.dataset['side']).toBe('console');

    // A reload, with only the work item in the address, brings them back from this device's storage.
    click('[data-work-item="1"]');
    helloFor(source, 1);
    click('#detail .changes-tab');
    page.close();
    history.replaceState(null, '', '#w=1');
    ({ page, source } = start());
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')?.classList.contains('selected')).toBe(true);

    // A closed tab stays closed.
    click('#detail [data-action="local-close"]');
    await flush();
    click('[data-work-item="2"]');
    helloFor(source, 2);
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/b.ts']);
    expect(JSON.parse(localStorage.getItem('switchboard.tabs')!)).toMatchObject({ w1: { files: [{ target: 'src/b.ts', line: null }], changes: true } });
    page.close();
  });

  it("brings a file tab back to where it was scrolled, keeps the artifact shown before a dropdown conversation, and keeps another page's tab sets", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other' })])];
    const both = [1, 2].map((id) => ({ ...scope.conversations[0]!, workItemId: id, title: `Item ${id}`, primary: id === 1 }));
    const helloFor = (source: FakeSource, workItemId: number) => source.emit('hello', { key: 'pk', groups, scope: { ...scope, workItemId, scopeGen: 3 + workItemId, conversations: both }, sessions: [session()], items: [reply('r1', 2, { opening: 'See [notes](notes.md).' })], more: false, status: null, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')] });
    const doc = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .artifact-doc')!;

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Notes', tooLarge: false, size: 7, entries: null, more: false } };
    answers['artifact'] = { status: 200, body: {}, text: '# Plan' };
    let { page, source } = start();

    helloFor(source, 1);
    click('#panel a.path-link');
    await flush();
    await flush();
    doc().scrollTop = 380;
    doc().dispatchEvent(new Event('scroll'));
    click('#detail [data-side="status"]');
    expect(root.querySelector('#detail .local-view')).toBeNull();
    // Back on the file tab, and after another work item and back, it is where it was left.
    click('#detail [data-action="local-tab"]');
    expect(doc().scrollTop).toBe(380);
    click('[data-work-item="2"]');
    helloFor(source, 2);
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    await flush();
    expect(doc().scrollTop).toBe(380);
    // The column folded into tabs and back draws the file anew, at the same place.
    resizeTo(1000);
    resizeTo(1440);
    expect(doc().scrollTop).toBe(380);

    // A folder's list scrolls in its own element, and comes back the same way.
    answers['local-file'] = { status: 200, body: { path: 'D:/w/src', name: 'src', kind: 'dir', contents: null, tooLarge: false, size: null, entries: [{ name: 'a.ts', dir: false }], more: false } };
    const entries = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .local-entries')!;

    source.emit('reply', { reply: reply('r2', 3, { opening: 'And [src](src/).' }) });
    click('#panel a.path-link[data-target="src/"]');
    await flush();
    await flush();
    entries().scrollTop = 120;
    entries().dispatchEvent(new Event('scroll'));
    resizeTo(1000);
    resizeTo(1440);
    expect(entries().scrollTop).toBe(120);

    // An artifact shown on work item 1 stays its tab after a conversation of its dropdown and back.
    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');
    click('#head [data-action="picker"]');
    click('#head [data-action="select"][data-work-item="2"]');
    helloFor(source, 2);
    click('#head [data-action="picker"]');
    click('#head [data-action="select"][data-work-item="1"]');
    helloFor(source, 1);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');

    // Another page of this device keeps work item 2's tabs meanwhile; this page's next change keeps them.
    const other = JSON.parse(localStorage.getItem('switchboard.tabs')!) as Record<string, unknown>;

    localStorage.setItem('switchboard.tabs', JSON.stringify({ ...other, w2: { side: 'console', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [], file: null } }));
    click('#detail [data-side="status"]');
    expect(JSON.parse(localStorage.getItem('switchboard.tabs')!)).toMatchObject({ w2: { side: 'console' }, w1: { side: 'status' } });
    page.close();
  });

  it("opens another work item under its own head with a placeholder at once, never the one shown before, until its hello", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])] });
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="3"]')!.click();
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Other work');
    expect(root.querySelector('#panel .timeline')).toBeNull();
    expect(root.querySelector('#panel .opening-note')?.textContent).toContain('Opening…');
    // The composer keeps its place, hidden by page.css, so nothing moves when the work item comes.
    expect(root.querySelector<HTMLElement>('#composer')!.hidden).toBe(false);
    expect(root.classList.contains('item-opening')).toBe(true);
    // The row it opens is the one marked.
    expect(root.querySelector('[data-work-item="3"]')!.classList.contains('selected')).toBe(true);
    // An event for the work item shown before changes nothing.
    source.emit('reply', { reply: reply('r9', 9) });
    expect(root.querySelector('#panel .timeline')).toBeNull();
    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])], scope: { ...scope, workItemId: 3, title: 'Other work', conversations: [{ ...scope.conversations[0]!, workItemId: 3, title: 'Other work' }] } });
    expect(root.querySelector('#head .opening-title')).toBeNull();
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    page.close();
  });

  it("keeps the placeholder through the opened work item's scope event until its own hello, so the previous conversation never shows under it", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])] });
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="3"]')!.click();
    source.emit('scope', { scope: { ...scope, workItemId: 3, title: 'Other work', scopeGen: 4, conversations: [{ ...scope.conversations[0]!, workItemId: 3, title: 'Other work' }] } });
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    expect(root.querySelector('#panel .timeline')).toBeNull();
    page.close();
  });

  it('opens the work item the route asked for at the start as a row click does, its refusal in its place', async () => {
    history.replaceState(null, '', '#w=3');
    answers['/select'] = { status: 409, body: { error: 'Its worktree is missing.' } };

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    await flush();
    await flush();
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Other work');
    expect(root.querySelector('#panel .opening-why')?.textContent).toBe('Its worktree is missing.');
    expect(location.hash).toBe('#w=3');
    page.close();
  });

  it("keeps a send's opId over a refusal for an unbound key and a reload, and drops it once the hub took the message", async () => {
    const { page, source } = start();

    hello(source);

    const box = () => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const sends = () => posts.filter((post) => post.url.endsWith('/send'));
    const type = (text: string) => {
      box().value = text;
      box().dispatchEvent(new Event('input'));
    };

    type('Ship it');
    answers['/send'] = { status: 403, body: { error: 'Not in this window.' } };
    click('button.send');
    await flush();
    await flush();
    page.close();

    // The reload: the same message sent again is the same operation.
    const again = start();

    hello(again.source);
    type('Ship it');
    answers['/send'] = { status: 200, body: { message: { id: 'm9' } } };
    click('button.send');
    await flush();
    await flush();
    expect(sends().map((post) => post.body['opId'])).toEqual([sends()[0]!.body['opId'], sends()[0]!.body['opId']]);
    expect(localStorage.getItem('switchboard.sendOps')).toBe('{}');

    // A refusal for a scope generation the page had not caught up with leaves it unsettled; another message replaces it.
    await vi.waitFor(() => expect(box().value).toBe(''));
    type('Next');
    answers['/send'] = { status: 409, body: { error: "The window's conversation changed." } };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Next'));
    await vi.waitFor(() => expect(root.querySelector('#toast .toast-text')?.textContent ?? '').not.toBe(''));
    const stale = sends().at(-1)!.body['opId'];

    expect(JSON.parse(localStorage.getItem('switchboard.sendOps')!)).toEqual({ '1': { key: expect.stringContaining('Next'), opId: stale } });
    type('Something else');
    answers['/send'] = { status: 200, body: { message: { id: 'm10' } } };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Something else'));
    expect(sends().at(-1)!.body['opId']).not.toBe(stale);

    // Another page of this device kept a newer unsettled send meanwhile: this page's answer leaves it.
    let release: () => void = () => {};

    await vi.waitFor(() => expect(box().value).toBe(''));
    type('Third');
    answers['/send'] = { status: 200, body: { message: { id: 'm11' } }, wait: new Promise<void>((resolve) => void (release = resolve)) };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Third'));
    localStorage.setItem('switchboard.sendOps', JSON.stringify({ '1': { key: 'other', opId: 'newer' } }));
    release();
    await vi.waitFor(() => expect(box().value).toBe(''));
    expect(JSON.parse(localStorage.getItem('switchboard.sendOps')!)).toEqual({ '1': { key: 'other', opId: 'newer' } });
    again.page.close();
  });

  it('lets a later tap open a work item after an open that hung, once the open times out', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NAVIGATION_MS);
    delete answers['/select'];
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2, 2]);
    page.close();
  });

  it('changes nothing for a drop shorter than the grace period, then shows the offline banner, dims the page and turns off the composer until a hello', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    expect(root.querySelector('.header .conn-dot')?.getAttribute('aria-label')).toBe('Connected');
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
    expect(root.querySelector('.conn-banner')).toBeNull();
    expect(root.classList.contains('stale')).toBe(false);
    expect(input.disabled).toBe(false);
    expect(root.querySelector('.header .conn-dot')?.className).toBe('conn-dot live');
    // The page asked the hub and opened a new stream, which brings no hello.
    expect(FakeSource.last).not.toBe(source);
    expect(posts.some((post) => post.url === '/page/ping')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect([...root.querySelectorAll('.conn-banner')].map((one) => one.textContent)).toEqual(Array(2).fill('Offline. Showing what was here at ' + new Date(10_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '.Retry'));
    expect(root.classList.contains('stale')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Can't send while offline.");
    expect(root.querySelector('.header .conn-dot')?.className).toBe('conn-dot waiting');
    hello(FakeSource.last!);
    expect(root.querySelector('.conn-banner')).toBeNull();
    expect(root.classList.contains('stale')).toBe(false);
    expect(input.disabled).toBe(false);
    page.close();
  });

  it("keeps the conversation shown through a reconnect, until the new stream's hello for the work item replaces it", async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source);
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));

    const next = FakeSource.last!;

    // The new stream's key is not bound yet: its hello has no work item, and the page selects it again.
    next.emit('hello', { key: 'pk2', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
    expect(root.querySelectorAll('#panel .timeline > li').length).toBeGreaterThan(0);
    expect(root.querySelector<HTMLElement>('#composer')!.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body).toMatchObject({ window: 'pk2', workItemId: 1 });
    hello(next, { key: 'pk2', items: [message('m7', 7)] });
    expect([...root.querySelectorAll('#panel .timeline > li[data-id]')].map((item) => item.getAttribute('data-id'))).toEqual(['m7']);
    page.close();
  });

  it("shows Can't reach Switchboard in the page's place when it never connected, tries at once on Try now, and goes once a hello comes", async () => {
    vi.useFakeTimers();
    answers['/page/ping'] = { status: 503, body: {} };

    const { page, source } = start();

    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    const screen = root.querySelector('.conn-screen')!;

    expect(screen.querySelector('h2')?.textContent).toBe("Can't reach Switchboard");
    expect(screen.querySelector('.conn-screen-status')?.textContent).toMatch(/^Trying again in \d+ s\.$/);
    // Only this computer can start the hub.
    expect(screen.querySelector('a[href="switchboard:start"]')?.textContent).toBe('Start Switchboard');
    expect(root.classList.contains('unreachable')).toBe(true);

    const pings = posts.filter((post) => post.url === '/page/ping').length;

    root.querySelector<HTMLElement>('.conn-screen [data-action="conn-retry"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url === '/page/ping')).toHaveLength(pings + 1);
    delete answers['/page/ping'];
    await vi.advanceTimersByTimeAsync(5_000);
    hello(FakeSource.last!);
    expect(root.querySelector('.conn-screen')).toBeNull();
    expect(root.classList.contains('unreachable')).toBe(false);
    page.close();
  });

  it('shows the Signed out screen in place of the page once the hub says the sign-in is gone, and stops trying', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);
    answers['/page/ping'] = { status: 200, body: { build: '', signedIn: false } };
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));
    expect(root.querySelector('.conn-screen h2')?.textContent).toBe('Signed out');
    expect(root.querySelector('.conn-screen')?.textContent).toContain('This browser is signed out. Run node ~/.switchboard/hub.js web on this computer and open the link it prints.');
    expect(root.querySelector('.header .conn-dot')?.getAttribute('aria-label')).toBe('Signed out');

    const pings = posts.filter((post) => post.url === '/page/ping').length;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts.filter((post) => post.url === '/page/ping')).toHaveLength(pings);
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

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
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

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
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('first words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The holder did not answer.');

    type('second words');
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm2' } } });
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
    helloFor(source, 2, 4);
    source.emit('message', { message: message('m2', 10, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: 'second words' }) });
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
    helloFor(source, 1, 5);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('second words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The session ended.');
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
    root.querySelector<HTMLElement>('[data-action="card-pick"][data-letter="A"]')!.click();
    root.querySelector<HTMLElement>('[data-action="card-send"]')!.click();
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    source.emit('message', { message: message('m5', 9, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: '[answers]\n- pick: Pick: → A) x' }) });
    expect(root.querySelector('.qc-error')!.textContent).toBe('The session ended.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="card-send"]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
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
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('Answer "Key?" first.');

    const secret = root.querySelector<HTMLInputElement>('.request-field[data-field="q1:key"]')!;

    secret.value = 'abc';
    secret.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-action="request-answer"]')!.click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/answer')).at(-1)?.body).toMatchObject({ requestId: 'q1', answer: { port: '8799', key: 'abc' } });
    page.close();
  });
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  /** Types `text` into the box as the operator does, the caret at its end. */
  const typeIn = (text: string) => {
    const input = root.querySelector('textarea')!;

    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input'));
  };
  const key = (name: string, init: KeyboardEventInit = {}) => root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  const commands = { status: 200, body: { commands: [{ name: 'compact', description: 'Compact it' }, { name: 'clear', description: '' }] } };
  const sends = () => posts.filter((post) => post.url.endsWith('/send')).map((post) => post.body);

  it('sends a /name recalled or typed again by hand escaped, and the chosen one as a command while the text starts with it (architecture.md § Slash commands)', async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;

    helloFor(source, 1, 3, [message('m1', 1, { text: '/compact' })]);
    const choose = async () => {
      typeIn('/co');
      pending.shift()!.resolve(commands);
      await flush();
      key('Tab');
      expect(input.value).toBe('/compact ');
    };

    // Chosen, then emptied: an earlier /compact recalled goes as a message.
    await choose();
    typeIn('');
    key('ArrowUp');
    expect(input.value).toBe('/compact');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact' });
    expect(sends().at(-1)).not.toHaveProperty('command');

    // Chosen, a walk up and back down: the draft comes back still chosen.
    await choose();
    key('ArrowUp');
    expect(input.value).toBe('/compact');
    key('ArrowDown');
    expect(input.value).toBe('/compact ');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact ', command: true });

    // Chosen, emptied and typed again by hand: a message.
    await choose();
    typeIn('');
    typeIn('/compact');
    pending.shift()!.resolve({ status: 200, body: { commands: [] } });
    await flush();
    key('Escape');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact' });
    expect(sends().at(-1)).not.toHaveProperty('command');
    expect(sends()).toHaveLength(3);
    page.close();
  });
  it("drops the composer list's answer that comes after Escape, a dictated piece or another selection, and closes an open list on a selection", async () => {
    const { page, source } = start(/commands|files/);
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;

    helloFor(source, 1, 3);
    typeIn('/co');
    key('Escape');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A piece dictation joins changes the text the answer was for.
    typeIn('/co');
    source.emit('draft', { text: 'now', sessionId: 's1', added: 'now' });
    expect(root.querySelector('textarea')!.value).toBe('/co now');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A list already open closes on a piece, so Enter sends the text rather than picking for the text before it.
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);
    source.emit('draft', { text: 'now more', sessionId: 's1', added: 'more' });
    expect(menu.hidden).toBe(true);
    expect(root.querySelector('textarea')!.value).toBe('/co more');

    // Another work item chosen before its scope comes.
    typeIn('see @sr');
    click('[data-action="picker"]');
    click('.conversation-menu [data-work-item="2"]');
    pending.shift()!.resolve({ status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } });
    await flush();
    expect(menu.hidden).toBe(true);

    // Sending closes a list open for the text sent, and drops one still on its way.
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('.composer button.send')!.click();
    expect(menu.hidden).toBe(true);
    await flush();
    typeIn('/co');
    root.querySelector<HTMLButtonElement>('.composer button.send')!.click();
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A list already open closes at once.
    helloFor(source, 1, 5);
    typeIn('see @sr');
    pending.shift()!.resolve({ status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } });
    await flush();
    expect(menu.hidden).toBe(false);
    click('[data-action="picker"]');
    click('.conversation-menu [data-work-item="2"]');
    expect(menu.hidden).toBe(true);
    page.close();
  });
  it('picks from the composer list only on a bare Enter or Tab, and leaves keys an input method composes with to it', async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;

    helloFor(source, 1, 3);
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);

    // Shift+Enter and Shift+Tab keep their own meaning, a new line and the focus moving back.
    expect(key('Enter', { shiftKey: true })).toBe(true);
    expect(key('Tab', { shiftKey: true })).toBe(true);
    // Ctrl, Alt or Meta with Enter or Tab do nothing.
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      expect(key('Enter', { [modifier]: true })).toBe(false);
      expect(key('Tab', { [modifier]: true })).toBe(false);
    }

    // An input method's Enter, marked as composing or only by key code 229, is its own, with the list open or not.
    key('Enter', { isComposing: true });
    key('Enter', { keyCode: 229 });
    expect(input.value).toBe('/co');
    expect(menu.hidden).toBe(false);
    key('Escape');
    key('Enter', { isComposing: true });
    key('Enter', { keyCode: 229 });
    await flush();
    expect(input.value).toBe('/co');
    expect(sends()).toEqual([]);
    page.close();
  });
  it('keeps the focus in the box while a send is on its way with the mic on, keeping dictation in the draft, and gives it up only once the hub took the message (architecture.md § Dictation)', async () => {
    const { page, source } = start(/send/);
    const input = root.querySelector('textarea')!;
    const told = () => posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body);

    helloFor(source, 1, 3);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    input.focus();
    typeIn('fix it');
    key('Enter');
    await flush();
    expect(document.activeElement).toBe(input);
    expect(told().at(-1)).toMatchObject({ focused: true, draft: '' });

    // A piece heard meanwhile waits for the answer; refused, it joins the text kept, and the hub's draft becomes the box's.
    source.emit('draft', { text: 'and more', sessionId: 's1', added: 'and more' });
    pending.shift()!.resolve({ status: 409, body: { error: 'The session ended.' } });
    await flush();
    expect(input.value).toBe('fix it and more');
    expect(document.activeElement).toBe(input);
    expect(told().at(-1)).toMatchObject({ focused: true, draft: 'fix it and more' });

    // Sent with Send, whose press leaves the focus in the box, and taken: the box empties and gives up the focus, so spoken turns send on
    // their own again.
    const sendButton = root.querySelector<HTMLButtonElement>('.composer button.send')!;

    expect(sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(false);
    sendButton.click();
    await flush();
    expect(document.activeElement).toBe(input);
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    expect(input.value).toBe('');
    expect(document.activeElement).not.toBe(input);
    expect(told().at(-1)).toMatchObject({ focused: false, draft: '' });
    expect(sends().map((one) => one['text'])).toEqual(['fix it', 'fix it and more']);
    page.close();
  });
  it("names the composer list and its active option for screen readers, as the box's list", async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;
    const selected = () => [...menu.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-selected'));

    helloFor(source, 1, 3);
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('role')).toBe('listbox');
    typeIn('/c');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.getAttribute('aria-label')).toBe('Slash commands');
    expect(selected()).toEqual(['true', 'false']);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.textContent).toContain('/compact');
    key('ArrowDown');
    expect(selected()).toEqual(['false', 'true']);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.textContent).toContain('/clear');
    key('Escape');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);

    // Nothing found is an option that cannot be chosen, and no option is active.
    typeIn('/z');
    pending.shift()!.resolve({ status: 200, body: { commands: [] } });
    await flush();
    expect(menu.querySelector('[role="option"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
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

  it('marks the selected row with only the selection colours, leaving the focus ring to a keyboard focus', () => {
    const selected = declarationsOf((selector) => selector === '.row.selected');

    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('background: var(--sb-row-selected)');
    // The selection colours, carried over from the retired dock: the theme's in Dark Modern and #E4E6F1 in Light Modern.
    expect(css).toMatch(/:root \{[^}]*--sb-row-selected: var\(--vscode-list-activeSelectionBackground\);/);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--sb-row-selected: #E4E6F1;/);
    expect(selected[0]).not.toMatch(/box-shadow|outline|border/);
    expect(declarationsOf((selector) => selector === 'button:focus-visible')).toEqual([expect.stringContaining('outline: 1px solid var(--vscode-focusBorder)')]);
    // A keyboard-focused row, selected or not, shows the theme's focus ring and never the selection colour, which marks only the open work item.
    expect(declarationsOf((selector) => selector === '.row:focus-visible')).toEqual([expect.stringContaining('outline: 1px solid var(--vscode-focusBorder)')]);
    expect(declarationsOf((selector) => /^\.row:(focus|hover)/.test(selector)).join(' ')).not.toContain('--sb-row-selected');
    // The selected row keeps the row's text colours: no foreground and no faded muted texts.
    expect(selected[0]).not.toMatch(/(^|[ ;])color:/);
    expect(css).not.toMatch(/\.row\.selected [^{]*\{[^}]*opacity/);
  });

  it("draws rows in the list's sizes and colours", () => {
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
    // Pills 18 px tall with 14 px icons and 12 px text; a key's logo 12 px; GitHub's key in GitHub's colour, not the foreground.
    expect(one('.row-line .pill')).toMatch(/height: 18px;.*font-size: 12px/);
    expect(one('.row-line .pill .codicon')).toBe('flex: none; font-size: 14px;');
    // Line 2 by CSS alone: the playbook and pills keep their width and are never cut; the links' one-line box shrinks, its second line clipped,
    // so a link that does not fit drops out whole.
    expect(declarationsOf((each) => each === '.row-line .playbook')).toContain('flex: none; max-width: 100%; overflow-wrap: anywhere;');
    expect(declarationsOf((each) => each === '.row-line .playbook').join(' ')).not.toMatch(/ellipsis|min-width|flex-shrink|flex: 0 1/);
    expect(one('.row-line .comment + .playbook')).toBe('max-width: calc(100% - 22px);');
    expect(one('.row-line .pill')).toMatch(/^flex: none;/);
    expect(one('.row-line .row-links')).toBe('flex: 1 1 0; min-width: 0; margin-left: -6px; display: flex; flex-wrap: wrap; height: 18px; overflow: hidden;');
    // Where the playbook and the key do not fit on one line, the key wraps under the playbook rather than being cut.
    expect(one('.row-line:not(.row-details)')).toBe('flex-wrap: wrap; row-gap: 3px; height: auto; min-height: 18px;');
    // An empty first item, so even the first pill wraps away rather than being cut.
    expect(one('.row-line .row-links-shown::before')).toBe("content: ''; height: 18px;");
    // A pill shows its text whole or not at all: hidden by default, shown by the container query for its place, never cut with an ellipsis.
    expect(one('.row-line .row-links-shown .pill-text')).toBe('display: none;');
    expect(one('.row-line .row-links-box')).toContain('container: row-links / size;');
    expect(css).toContain('@container row-links (min-height: 19.5px) { .row-line .row-links-shown > .pill:nth-child(1) .pill-text { display: inline; } }');
    expect(css).toContain('@container row-links (max-height: 18.5px) { .row-line .row-links-shown { width: auto; } }');
    expect(declarationsOf((each) => each.startsWith('.row-line .row-links')).join(' ')).not.toMatch(/ellipsis/);
    expect(declarationsOf((each) => each === '.row-line .pill.ticket.source-github')).toEqual(['border-color: var(--sb-github); background: color-mix(in srgb, var(--sb-github) 18%, transparent);']);
    // Marks in the foreground, Failed in the error colour; the muted texts in the list's grey, #717171 in Light Modern.
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

  it('stacks the page\'s layers by one scale: the sashes over the top bars, a bar\'s open menu over the sashes, the drawer and its backdrop over all of them, and the toast over every sheet', () => {
    const scale = Object.fromEntries([...css.matchAll(/--sb-z-([a-z-]+): (\d+);/g)].map(([, name, value]) => [name, Number(value)]));
    const order = ['bar', 'sash', 'bar-menu', 'sliver', 'drawer-backdrop', 'drawer', 'maximized', 'sheet', 'persona', 'settings', 'settings-sheet', 'toast', 'top-line', 'top-band'];

    expect(Object.keys(scale).sort()).toEqual([...order].sort());
    expect(order.map((name) => scale[name])).toEqual(order.map((name) => scale[name]).sort((a, b) => a! - b!));
    expect(new Set(Object.values(scale)).size).toBe(order.length);
    expect(declarationsOf((selector) => selector === '.header')).toContainEqual(expect.stringContaining('z-index: var(--sb-z-bar)'));
    expect(declarationsOf((selector) => selector === '.sash')).toEqual([expect.stringContaining('z-index: var(--sb-z-sash)')]);
    expect(css).toContain(':is(.header, .list-header, .tabs):has([role="menu"]) { z-index: var(--sb-z-bar-menu); }');
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers:not(.listing) > .side')).toEqual([expect.stringContaining('z-index: var(--sb-z-drawer)')]);
    expect(declarationsOf((selector) => selector === '.drawer-backdrop')).toEqual([expect.stringContaining('z-index: var(--sb-z-drawer-backdrop)')]);
    // The backdrop shows only under a drawer opened by its button, a key or a swipe, not one a resting pointer showed.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers.drawer-held:not(.listing) > .drawer-backdrop')).toEqual(['display: block;']);
    // No page-level layer keeps a number of its own outside the scale.
    expect(css).not.toMatch(/\.(sash|sliver|sheet-backdrop|persona-backdrop|composer-menu)\b[^{]*\{[^}]*z-index: \d/);
  });

  it('makes every box in a scrolling pane a touch target, so a drag starting just under a tab strip scrolls the pane, not the strip', () => {
    // Chrome's touch adjustment moves a touch onto a nearby box with a :hover style; with one on every box in the pane, the touch stays put.
    expect(declarationsOf((selector) => selector === '.scroll :hover')).toEqual(['--sb-touch-target: 1;']);
  });

  it('hides the list\'s pin in the phone\'s layout, and drops the snap a drag once had', () => {
    expect(declarationsOf((selector) => selector === ':where(html.phone) .list-header > .list-pin')).toEqual(['display: none;']);
    expect(css).not.toMatch(/snapping|#root\.snap\b|data-snap/);
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
    // The composer's own corners come from packages/conversation's composer.css.
    expect(readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/composer.css'), 'utf8')).toMatch(/\n\.composer \{[^}]*border-radius: 8px;/);
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

  it("draws our messages and a reply's primary response at 110% and its details at the theme's size from the shared bubbles.css, and the composer at the theme's size", () => {
    expect(css).not.toContain('--chat-scale');
    // The shared sizes are of the theme's, so the page gives the timeline, the reply and the message around them no size of its own.
    for (const parent of [".timeline",".timeline > li",".reply",".reply .body",".message",".message .bubble",".message .box",".reply-primary",".reply-details"]) {
      expect(declarationsOf((selector) => selector === parent).join(' ')).not.toContain('font-size');
    }
    expect(declarationsOf((selector) => selector === '.composer textarea').join(' ')).toContain('font: inherit');
    expect(declarationsOf((selector) => selector === '.composer textarea').join(' ')).not.toContain('font-size');
    const bubbles = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/bubbles.css'), 'utf8');

    expect(bubbles).toContain('\n.message .box { font-size: 110%; }');
    // A reply's text is at --sb-reply-scale (1.1) of the theme's size and its details at --sb-details-scale (1), each set in one place.
    expect(bubbles).toMatch(/\n:root \{\n  --sb-reply-scale: 1\.1;\n  --sb-details-scale: 1;\n\}/);
    expect(bubbles).toContain('\n.reply:not(.aside) > .body { font-size: calc(var(--sb-reply-scale) * 100%); }');
    expect(bubbles).toContain('\n.reply-details { font-size: calc(var(--sb-details-scale) / var(--sb-reply-scale) * 1em); }');
    expect(bubbles).not.toContain('speech-bubble');
    // A slash command's bubble keeps that 110%: the page's own command rule sets only the font.
    expect(bubbles).not.toContain('.message .box.command');
    expect(declarationsOf((selector) => selector === '.message .box.command').join(' ')).not.toContain('font-size');
  });

  it("makes the list a drawer with its sliver and button outside the phone's layout where #root.drawers says it does not fit, while a work item is open, sliding in and hiding at once", () => {
    expect(declarationsOf((selector) => selector === '.header > .list-toggle')).toEqual(['display: none;']);
    // No fixed width decides it: a phone never gets the drawer, and outside the phone's layout only the class the layout sets does.
    expect(css).not.toMatch(/@media \(\d+px <= width < /);

    for (const rule of ['#root.drawers:not(.listing) > .side-sash { display: none; }', '#root.drawers:not(.listing):not(.drawer-open) > .sliver { display: block; }', '#root.drawers:not(.listing) .header > .list-toggle { display: inline-flex; }']) {
      expect(css).toContain(`\n:where(html:not(.phone)) ${rule}`);
    }

    expect(css).not.toMatch(/(^|\n)#root\.drawers/);
    // Hidden, the list keeps its layout off the left edge, so its rows can be measured for the sliver.
    expect(css).toMatch(/:where\(html:not\(\.phone\)\) #root\.drawers:not\(\.listing\) > \.side \{[^}]*position: fixed;[^}]*visibility: hidden; transform: translateX\(-100%\);/);
    // Only the shown drawer has a transition, so it slides in and hides at once.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers:not(.listing) > .side').join(' ')).not.toContain('transition');
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.drawers.drawer-open:not(.listing) > .side').join(' ')).toContain('transition: transform 0.15s ease-out');
    expect(declarationsOf((selector) => selector === '.sliver').join(' ')).toMatch(/position: fixed;.*left: env\(safe-area-inset-left\);.*width: 1px;/);
  });

  it('shows the composer and the note above it only on the Conversation tab, at every height', () => {
    // A refusal shows in the toast, on every tab.
    const rule = '#root.off-conversation';

    // No media condition: a tall phone hides them off the Conversation tab as a short screen does.
    expect(css).toContain(`\n${rule} #note, ${rule} #composer { display: none; }\n`);
    expect(css).not.toMatch(/off-conversation:not\(:has\(#composer:focus-within\)\)/);
    // The class's one other use gives the other tabs' scrollers back the home indicator's inset at their end, which a shown composer takes away.
    expect(css.match(/off-conversation/g)).toHaveLength(3);
    expect(css).toContain(`\n${rule} > .main { --sb-end: env(safe-area-inset-bottom); }\n`);
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

describe('the highlight an answer link gives', () => {
  // The page's sheet as build.mjs joins it: the shared bubbles and question card styles, then the page's own.
  const sheet = ['@switchboard/conversation/bubbles.css', '@switchboard/conversation/questionCard.css']
    .map((name) => readFileSync(createRequire(import.meta.url).resolve(name), 'utf8'))
    .concat(readFileSync(join(__dirname, '../src/page.css'), 'utf8'))
    .join('');

  /** Each style rule of the sheet, with its declarations and whether it applies under reduced motion only, read with its enclosing blocks. */
  const rules = (): Array<{ selectors: string[]; reduced: boolean; body: string; declarations: Array<[string, string]> }> => {
    const text = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    const found: Array<{ selectors: string[]; reduced: boolean; body: string; declarations: Array<[string, string]> }> = [];
    const open: Array<{ prelude: string; from: number; nested: boolean }> = [];
    let start = 0;

    for (let at = 0; at < text.length; at++) {
      if (text[at] === '{') {
        if (open.length > 0) {
          open.at(-1)!.nested = true;
        }

        open.push({ prelude: text.slice(start, at).trim(), from: at + 1, nested: false });
        start = at + 1;
      } else if (text[at] === '}' && open.length === 0) {
        // A stray brace, as page.css has after its phone persona rules, closes nothing.
        start = at + 1;
      } else if (text[at] === '}') {
        const block = open.pop()!;
        const body = text.slice(block.from, at).trim();

        if (!block.nested && !block.prelude.startsWith('@') && !open.some((outer) => outer.prelude.startsWith('@keyframes'))) {
          found.push({
            selectors: block.prelude.split(/,(?![^(]*\))/).map((one) => one.trim()),
            reduced: open.some((outer) => /prefers-reduced-motion:\s*reduce/.test(outer.prelude)),
            body,
            declarations: body.split(';').filter((one) => one.includes(':')).map((one) => [one.slice(0, one.indexOf(':')).trim(), one.slice(one.indexOf(':') + 1).trim()]),
          });
        }

        start = at + 1;
      } else if (text[at] === ';' && open.length === 0) {
        start = at + 1;
      }
    }

    return found;
  };
  const all = rules();
  const matches = (element: Element, selector: string): boolean => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  };
  /** Whether a declaration draws a ring: a box shadow or an animation that is not none. */
  const draws = ([property, value]: [string, string]): boolean => (property === 'box-shadow' && !/^none\b/.test(value)) || (/^animation(-name)?$/.test(property) && !/^none\b/.test(value));
  /** The rules that draw a ring other than an outline on an element: with motion those outside the reduced-motion blocks, with reduced motion those inside. */
  const rings = (element: Element, reduced: boolean): string[] =>
    all.filter((rule) => rule.reduced === reduced && rule.declarations.some(draws) && rule.selectors.some((selector) => matches(element, selector))).map((rule) => rule.body);
  /** A selector's specificity as one number: ids, then classes, attributes and pseudo-classes, then elements; :where counts nothing. */
  const specificity = (selector: string): number => {
    let rest = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/:(?:not|is)\(((?:[^()]|\([^()]*\))*)\)/g, ' $1');
    const ids = (rest.match(/#[\w-]+/g) ?? []).length;

    rest = rest.replace(/#[\w-]+/g, '');
    const classes = (rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
    const elements = (rest.replace(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, '').match(/[a-z][\w-]*/gi) ?? []).length;

    return ids * 10_000 + classes * 100 + elements;
  };
  /** The value the sheet gives an element's property, by specificity and then order, with reduced motion or without; '' when no rule sets it. */
  const cascaded = (property: string, element: Element, reduced: boolean): string => {
    let best: { weight: number; value: string } | null = null;

    for (const rule of all.filter((one) => reduced || !one.reduced)) {
      const weight = Math.max(-1, ...rule.selectors.filter((selector) => matches(element, selector)).map(specificity));
      const value = rule.declarations.filter(([name]) => name === property).at(-1)?.[1];

      if (weight >= 0 && value !== undefined && (best === null || weight >= best.weight)) {
        best = { weight, value };
      }
    }

    return best?.value ?? '';
  };
  const outline = (element: Element, reduced: boolean): string => cascaded('outline', element, reduced);
  const animation = (element: Element, reduced: boolean): string => cascaded('animation', element, reduced);

  it('draws one ring on an answer message, on its bubble and never on its full-width row, and one on a card, focused or not, with motion and without', () => {
    const host = document.createElement('div');

    host.innerHTML = '<ul class="timeline"><li class="message linked" data-id="m1"><div class="bubble"><div class="box answers"><div class="answers-bubble"><span class="answers-title">Answers</span><button type="button" class="answers-link">Questions</button></div></div></div></li><li class="reply"><div class="question-card qc linked" tabindex="-1"></div></li></ul>';
    document.body.append(host);

    const row = host.querySelector('li.message')!;
    const box = host.querySelector('.box')!;
    const card = host.querySelector<HTMLElement>('.question-card')!;

    // The page focuses the card it goes to.
    card.focus();
    expect(card.matches(':focus')).toBe(true);

    // A ring on the row too was the doubled outline the operator saw on an iPhone with Reduce Motion on.
    for (const reduced of [true, false]) {
      expect([rings(row, reduced), outline(row, reduced)], `row, reduced motion ${reduced}`).toEqual([[], '']);
    }

    // With motion, the fading ring and no outline: the focused card's focus ring stays off, or it would ring twice.
    expect(rings(box, false)).toEqual([expect.stringMatching(/^animation: sb-linked 1\.6s ease-out;/)]);
    expect(rings(card, false)).toEqual([expect.stringMatching(/^animation: sb-linked 1\.6s ease-out;/)]);
    expect([outline(box, false), outline(card, false)]).toEqual(['', 'none']);
    expect([animation(box, false), animation(card, false)]).toEqual(['sb-linked 1.6s ease-out', 'sb-linked 1.6s ease-out']);
    // With reduced motion, a still outline in place of the ring, which the card's focus rule does not take away.
    expect([animation(box, true), animation(card, true)]).toEqual(['none', 'none']);
    // No still shadow beside either ring: the moving ring is the animation's alone.
    expect([false, true].flatMap((reduced) => [box, card].map((element) => cascaded('box-shadow', element, reduced)))).toEqual(['', '', '', '']);
    expect([outline(box, true), outline(card, true)]).toEqual([expect.stringMatching(/^2px solid/), expect.stringMatching(/^2px solid/)]);

    // Without the class, nothing rings, and the focused card draws no outline.
    row.classList.remove('linked');
    card.classList.remove('linked');
    expect([false, true].flatMap((reduced) => [...rings(row, reduced), ...rings(box, reduced), ...rings(card, reduced)])).toEqual([]);
    expect([false, true].map((reduced) => [outline(row, reduced), outline(box, reduced), outline(card, reduced)])).toEqual([['', '', 'none'], ['', '', 'none']]);
    host.remove();
  });
});
