import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY, inTurn, mentionOf, mentionQuery, commandQuery, timeline, withEarlier } from '../src/model.js';
import { parseQuestions, resolveAnswers } from '@switchboard/conversation/questions';
import { artifactUrl, newView, renderMicButton, renderVoice, markdownBody } from '../src/render.js';
import { renderArtifactView } from '../src/side.js';
import { renderHistory } from '../src/history.js';
import { backgroundRow, renderTimeline, turnRow } from '../src/timeline.js';
import { renderHeader, renderSideSwitch, renderTabs } from '../src/header.js';
import { renderList } from '../src/list.js';
import { html } from './html.js';
import { renderMicButton as viewMicButton } from '@switchboard/conversation/voiceControls';
import { renderMarkdown } from '../src/markdown.js';
import { startPage } from '../src/main.js';
import { DETAIL_MIN } from '../src/layout.js';
import type { MessageView, PageRow, ReplyView, SessionView, StateView } from '@switchboard/protocol';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, artifact, FakeSource } from './pageFixtures.js';

/** History with no ticket History: the head and the pinned state alone. */
const renderState = (state: StateView | null, now: number) => renderHistory(null, state, now, { key: 'gh 1', title: 'Fix it', sourceKind: null, playbook: null, status: null, needsYou: null, workItemId: 1, sessionId: 's' });


describe('the page model', () => {
  it('orders items by transcript place, drops not-sent messages, and starts from empty at hello', () => {
    let state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items: [message('m2', 2), message('m1', 1)], more: true, state: null, artifacts: [], unread: 2 });

    expect(state).toMatchObject({ key: 'k', connected: true, unread: 2, more: true });
    state = applyEvent(state, { type: 'message', message: message('m3', 0, { provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r1', 3) });
    expect(state.items.map((item) => item.id)).toEqual(['m2', 'm1', 'r1', 'm3']);
    state = applyEvent(state, { type: 'message', message: message('m3', 0, { delivery: 'not-sent' }) });
    expect(state.items.map((item) => item.id)).not.toContain('m3');
    state = applyEvent(state, { type: 'unread', workItemId: 1, count: 5 });
    expect(state.unread).toBe(5);
    state = applyEvent(state, { type: 'state', state: { id: 'st-x', sessionId: 'other', at: 1, headline: 'x', body: null, stale: 'session', unread: false } });
    expect(state.state).toMatchObject({ id: 'st-x', headline: 'x' });
    state = applyEvent(state, { type: 'state', state: null });
    expect(state.state).toBeNull();
    state = withEarlier(state, [message('m0', -1), message('m1', 1)], false);
    expect(state.items[0]!.id).toBe('m0');
    expect(state.more).toBe(false);
    state = applyEvent(state, { type: 'hello', scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
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
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, state: null, artifacts: [], settings: { briefReplies: true } });

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
    expect(host.querySelector('.question-card .qc-state')?.getAttribute('title')).toBe('Unanswered');
    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: ending }), message('m1', 2, { text: '1B', delivery: 'open' })]), newView()));
    expect(host.querySelector('.question-card .qc-option')).not.toBeNull();
  });

  it("shows a status's questions on the Status tab as plain Markdown, with no card or fold", () => {
    const host = document.createElement('div');
    const state = { id: 'st-r1', sessionId: 's', at: 1, headline: 'Blocked on a choice', body: ending, stale: null, unread: false } as const;

    host.innerHTML = html(renderState(state, 2));
    expect(host.querySelector('.hist-now-headline')?.textContent).toBe('Blocked on a choice');
    expect(host.querySelectorAll('.hist-now-body ol > li')).toHaveLength(1);
    // The body is a Markdown document, typeset as an artifact's (`md-doc`).
    expect(host.querySelector('.hist-now-body')!.className).toBe('hist-now-body md-doc body');
    expect(host.querySelector('.question-card')).toBeNull();
    expect(host.querySelector('.questions-fold')).toBeNull();
    // A headline alone draws no body.
    host.innerHTML = html(renderState({ ...state, body: null }, 2));
    expect(host.querySelector('.hist-now-body')).toBeNull();
  });

  it('marks an unread status with the unread dot, not a New label, on the Status tab in the strip and the column and in its head', () => {
    const host = document.createElement('div');
    const unread = { ...pageState([]), state: { id: 'st-1', sessionId: 's', at: 1, headline: 'Built', body: 'All green.', stale: null, unread: true } };
    const seen = { ...unread, state: { ...unread.state, unread: false } };
    const dot = (markup: string, selector: string) => {
      host.innerHTML = markup;
      return host.querySelector(selector);
    };

    for (const [markup, tab] of [[html(renderTabs(newView(), unread)), '[data-tab="history"]'], [html(renderSideSwitch('console', unread)), '[data-side="history"]']] as const) {
      const shown = dot(markup, `${tab} .unread-dot`);

      expect(shown?.getAttribute('role')).toBe('img');
      // Between the icon and the label, so page.css draws it on the icon's top-right corner.
      expect(shown?.previousElementSibling?.className).toBe('codicon codicon-history');
      expect(shown?.nextElementSibling?.className).toBe('tab-label');
      expect(shown?.getAttribute('aria-label')).toBe('Unread');
      expect(shown?.getAttribute('title')).toBe('Unread');
      expect(host.querySelector(tab)?.textContent).toBe('History');
    }
    expect(dot(html(renderState(unread.state, 2)), '.hist-now-head .unread-dot')?.getAttribute('aria-label')).toBe('Unread');
    expect(host.querySelector('.hist-now-head')?.textContent).not.toContain('New');

    // A seen state has none.
    expect(dot(html(renderTabs(newView(), seen)), '.unread-dot')).toBeNull();
    expect(dot(html(renderSideSwitch('console', seen)), '.unread-dot')).toBeNull();
    expect(dot(html(renderState(seen.state, 2)), '.unread-dot')).toBeNull();
  });

  it('labels a current state State, dims one whose turn ended as of the last turn, one whose session ended as the last state, and says when there is none', () => {
    const host = document.createElement('div');
    const state = { id: 'st-1', sessionId: 's', at: 1, headline: 'fixing tests', body: null, unread: false } as const;
    const drawn = (stale: 'turn' | 'session' | null) => {
      host.innerHTML = html(renderState({ ...state, stale }, 2));
      return { label: host.querySelector('.hist-now-label')?.textContent, dim: host.querySelector('.hist-now')!.classList.contains('stale') };
    };

    expect(drawn(null)).toEqual({ label: 'Now', dim: false });
    expect(drawn('turn')).toEqual({ label: 'As of the last turn', dim: true });
    expect(drawn('session')).toEqual({ label: 'Last state', dim: true });
    host.innerHTML = html(renderState(null, 2));
    expect(host.querySelector('.hist-now.empty')?.textContent).toBe('No state yet. It appears here when the session sets one.');
  });

  it("draws a tab's unread dot as a badge on its icon's top-right corner, ringed in the tab's fill, and the dropdown's dot alike, so the dot leaves the tab's width as it was", () => {
    const page = readFileSync(join(__dirname, '../src/page.css'), 'utf8');
    const picker = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/picker.css'), 'utf8');

    expect(page).toContain('.tab :is(.codicon, .file-icon) + .unread-dot { flex: none; position: relative; top: -7px; margin: 0 -4px 0 -9px; box-shadow: 0 0 0 1.5px var(--sb-tab-strip); }');
    expect(page).toContain('.tab:is(.selected, :hover, .open) :is(.codicon, .file-icon) + .unread-dot { box-shadow: 0 0 0 1.5px var(--sb-tab-surface); }');
    expect(page).not.toContain('.tab-label + .unread-dot');
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

  it("draws a context's and a description's lists and paragraphs, and no markup a session wrote", () => {
    const host = document.createElement('div');
    const asked = [
      "1. **State.** Merge fix 4's state work into `main`? {#state-merge}",
      '   This also confirms:',
      '   - mid-turn `[state]` is not relied on;',
      '   - **n/total** is optional. <img src=x onerror=alert(1)>',
      '',
      '   Verify passes.',
      '   - A) Accept and merge (recommended) — the data moves:',
      '     1. statuses',
      '     2. stages <script>alert(1)</script> [run](javascript:alert(1))',
      '   - B) Change something first',
    ].join('\n');

    host.innerHTML = html(renderTimeline(pageState([reply('r1', 1, { opening: asked })]), newView()));
    const context = host.querySelector('.qc-context')!;

    expect([...context.children].map((one) => one.tagName)).toEqual(['P', 'UL', 'P']);
    expect([...context.querySelectorAll('li')].map((one) => one.textContent)).toEqual(['mid-turn [state] is not relied on;', 'n/total is optional. <img src=x onerror=alert(1)>']);
    expect(context.querySelector('li strong')?.textContent).toBe('n/total');
    const description = host.querySelector('.qc-option .qc-desc')!;

    expect([...description.querySelectorAll('ol > li')].map((one) => one.textContent)).toEqual(['statuses', 'stages <script>alert(1)</script> [run](javascript:alert(1))']);
    expect(host.querySelector('.question-card img, .question-card script, .question-card [onerror], .question-card a[href^="javascript"]')).toBeNull();
  });
});

describe('drawing', () => {
  // The page's state with these items, as a hello brings them.
  const pageState = (items: Array<MessageView | ReplyView>) => applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session()], items, more: false, state: null, artifacts: [], settings: { briefReplies: true } });

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

    host.innerHTML = html(renderTimeline({ ...pageState(items), messageTimes: true }, newView(), at(12)));
    expect(stamps()).toEqual(['m1:9:00 AM', 'r1:9:05 AM', 'm2:10:00 AM', 'm3:11:00 AM']);
    expect(host.querySelector('li[data-id="m1"] .voice-mark')!.textContent).toBe('dictated');
    expect(host.querySelector('li[data-id="m1"] .voice-mark')!.getAttribute('title')).toBe('Dictated in 1 piece:\nhello there · match 0.91 · 140 Hz');
    expect(host.querySelector('li[data-id="r1"] .tone')!.textContent).toBe('calm');
    expect(host.querySelector('li[data-id="r1"] .meta')!.hasAttribute('title')).toBe(false);
  });

  it("puts a message's and a reply's metadata on one line under it, the reply's copy button first and the time at the right", () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderTimeline({ ...pageState([message('m1', 1, { delivery: 'uncertain', error: 'Check the terminal.' }), reply('r1', 120_000, { tone: 'calm', spoken: { state: 'failed', atMs: null, saidChars: null } })]), messageTimes: true }, newView()));
    expect([...host.querySelector('li[data-id="m1"] > .bubble')!.children].map((child) => child.className)).toEqual(['box', 'meta']);
    expect([...host.querySelector('li[data-id="m1"] .meta')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    expect([...host.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
    expect([...host.querySelector('li[data-id="r1"] .meta-marks')!.children].map((child) => child.className)).toEqual(['copy', 'tone', 'spoken failed']);
    expect(host.querySelector('li[data-id="r1"] .meta > :last-child')?.className).toBe('stamp');
  });

  it('dims the part of an interrupted passage not heard, and says Not spoken only when speech failed, with message details on', () => {
    const spoken = (state: ReplyView['spoken']['state'], details = true) => html(renderTimeline({ ...pageState([reply('r1', 1, { opening: 'Fixed it. More.', speak: 'Fixed it.', spoken: { state, atMs: 7_400, saidChars: 3 } })]), messageTimes: details }, newView()));

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
      const state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session(patch)], items: answered, more: false, state: null, artifacts: [] });

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
      const state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session({ state: 'running', background: { agents: 1, shells: 0, other: 0 } })], items, more: false, state: null, artifacts: [] });

      host.innerHTML = html(renderTimeline(state, newView()));
      return host;
    };

    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3)]).querySelector('.working')?.textContent).toBe('Thinking…');
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3), reply('r2', 4, { answers: 'm2' })]).querySelector('.working:not(.background)')).toBeNull();
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), message('m2', 3), reply('r2', 4, { answers: 'm2' })]).querySelector('.working.background')?.textContent).toBe('1 agent running');
  });

  it('shows no Thinking for an unconfirmed message, which may never have reached the session, and no Send again on an answer message', () => {
    const draw = (items: Array<MessageView | ReplyView>): HTMLElement => {
      const host = document.createElement('div');
      const state = applyEvent(EMPTY, { type: 'hello', key: 'k', groups: [], scope, sessions: [session({ state: 'running', background: { agents: 1, shells: 0, other: 0 } })], items, more: false, status: null, artifacts: [] });

      host.innerHTML = html(renderTimeline(state, newView()));
      return host;
    };
    const lost = message('m2', 3, { delivery: 'unconfirmed', error: 'Not in the transcript.' });

    // Session bfd12580: the message stuck at the bottom with Thinking under it while background agents ran.
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), lost]).querySelector('.working:not(.background)')).toBeNull();
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), lost]).querySelector('li[data-id="m2"] [data-action="resend-message"]')).not.toBeNull();
    // A message sent after it still waits for its reply.
    expect(draw([message('m1', 1), reply('r1', 2, { answers: 'm1' }), lost, message('m3', 4)]).querySelector('.working:not(.background)')?.textContent).toBe('Thinking…');
    expect(draw([message('m4', 1, { delivery: 'unconfirmed', text: '[answers]\n- pick: Pick: → A) x' })]).querySelector('[data-action="resend-message"]')).toBeNull();
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
    expect(html(renderArtifactView('key', artifact('chat/d.bin', 'file', 'bin')))).toContain('This kind of file cannot be shown here.');
    expect(html(renderArtifactView('key', artifact('chat/d.bin', 'file', 'bin')))).not.toContain('download');

    // The head: the type's icon, named, the title, when it changed and Open in new window, no kind and no Download; each version's file loads afresh.
    const head = document.createElement('div');

    head.innerHTML = html(renderArtifactView('key', { ...artifact('chat/v.mp4', 'video', 'mp4'), kind: 'demo', title: 'Demo' }, undefined, 1500 + 5 * 60_000));
    expect(head.querySelector('.artifact-head > .artifact-type.codicon-device-camera-video')!.getAttribute('aria-label')).toBe('Video');
    expect(head.querySelector('.artifact-head > .artifact-age')!.textContent).toBe('5 min ago');
    expect(head.querySelector('.artifact-head > .artifact-age')!.getAttribute('datetime')).toBe(new Date(1500).toISOString());
    expect(head.querySelector('.artifact-badge')).toBeNull();
    expect(head.querySelector('.artifact-head')!.textContent).not.toContain('demo');
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
    // The ticket key has its source's logo to shrink to, hidden from screen readers, then its text, which stays its accessible name.
    expect([...first.querySelector('.pill')!.children].map((child) => [child.tagName.toLowerCase(), child.getAttribute('class'), child.getAttribute('aria-hidden'), child.textContent])).toEqual([
      ['svg', 'source-logo github', 'true', ''],
      ['span', 'pill-text', null, 'gh 1'],
    ]);
    expect(first.querySelector('.playbook')!.innerHTML).toBe('<span class="namespace">dev:</span>build');
    expect(root.querySelector('[data-work-item="2"]')!.className).toBe('row stripe-warning dim movable');
    expect(root.querySelectorAll('.voice-mark')).toHaveLength(0);
    expect(root.querySelector('[data-work-item="2"] .pill')!.className).toBe('pill ticket source-zoho');
    expect(root.querySelector('[data-work-item="2"] .pill .source-logo')!.getAttribute('class')).toBe('source-logo zoho');
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
    expect(header.querySelector('button.picker .unread-dot')?.getAttribute('title')).toBe('Unread replies or state');
  });

  it("draws a row's three lines from the hub's dock row: priority, title and time; comment, playbook, ticket, links and Returned; mark and details", () => {
    const root = document.createElement('div');
    const links: PageRow['links'] = [
      { label: 'PR #19002', url: 'https://github.com/o/r/pull/19002', kind: 'pr', badge: '19002', glyph: '\u{ea64}', mentioned: false },
      { label: 'gh 18800', url: 'https://github.com/o/r/issues/18800', kind: 'issue', badge: '18800', glyph: null, mentioned: true },
    ];
    const details: PageRow['details'] = [
      { text: 'Usage limit · resumes 1:20 PM', title: 'Resets at 1:20 PM', tone: 'warning' },
      { text: 'Setup <failed>', title: null, tone: 'error' },
      { text: 'Post the reply', title: null, tone: null },
    ];
    const full = listRow(1, { priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, url: 'https://github.com/o/r/issues/1', links, returned: 2, comment: { glyph: '\u{ea6b}', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: '\u{eba2}', title: 'Usage limit' }, details });

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
    expect([...line2!.querySelectorAll('.row-links > .pill')].map((child) => child.className)).toEqual(['pill link pr', 'pill link issue mentioned', 'pill returned']);
    expect(line2!.querySelector('.comment')!.getAttribute('title')).toBe('Nov 20\nWaits on Sam');
    expect(line2!.querySelector('.ticket')!.getAttribute('title')).toBe('gh 1\nhttps://github.com/o/r/issues/1');
    expect(line2!.querySelector('.pr')!.textContent).toBe('\u{ea64}19002');
    // An issue's source label before its number is hidden from view, GitHub's mark standing for it, but read with the number.
    expect([...line2!.querySelectorAll('.row-links .link')].map((pill) => [pill.querySelector('.key-label')?.textContent ?? null, pill.querySelector('.pill-text')!.textContent])).toEqual([
      [null, '19002'],
      ['gh ', 'gh 18800'],
    ]);
    expect(line2!.querySelector('.pr')!.getAttribute('title')).toBe('PR #19002\nhttps://github.com/o/r/pull/19002');
    // Every link pill has an icon to shrink to: an issue the hub sends no glyph for shows GitHub's mark.
    expect([...line2!.querySelectorAll('.row-links .pill')].map((pill) => pill.querySelector('.codicon')?.textContent)).toEqual(['\u{ea64}', '\u{ea84}', '\u{eae2}']);
    expect(line2!.querySelector('.issue')!.getAttribute('title')).toBe('gh 18800, named in the ticket\nhttps://github.com/o/r/issues/18800');
    expect(line2!.querySelector('.returned .pill-text')!.textContent).toBe('2');
    // The link pills sit straight in their box, with no unseen copies to measure them by.
    expect([...line2!.querySelector('.row-links')!.children].map((child) => child.className)).toEqual(['pill link pr', 'pill link issue mentioned', 'pill returned']);
    // Line 3: the mark, then each detail in its tone with a muted separator between them, never before the first.
    expect(line3!.className).toBe('row-line row-details');
    expect(line3!.firstElementChild!.className).toBe('codicon codicon-sb-hourglass mark');
    expect([...line3!.querySelectorAll('.row-detail')].map((one) => [one.className, one.textContent, one.getAttribute('title')])).toEqual([
      ['row-detail warning', 'Usage limit · resumes 1:20 PM', 'Resets at 1:20 PM'],
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

  it('puts the waiting questions after the title on line 1 as an icon alone, a button named by their count, on any row that has them', () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderList([listGroup('progress', [listRow(1, { time: { text: '2h', title: 'In queue' }, questions: 2 }), listRow(2, { questions: 1 }), listRow(3, { questions: 0 }), listRow(4)])], null, new Set()));
    expect([...root.querySelector('[data-work-item="1"] .row-head')!.children].map((child) => child.className)).toEqual(['row-title', 'questions', 'row-time']);

    const badge = root.querySelector<HTMLElement>('[data-work-item="1"] .questions')!;

    expect([badge.getAttribute('role'), badge.getAttribute('aria-label'), badge.getAttribute('title'), badge.dataset['action'], badge.dataset['workItem'], badge.tabIndex]).toEqual(['button', '2 questions waiting', '2 questions waiting\nOpens the work item at its questions', 'goto-questions', '1', -1]);
    // The icon alone shows (the operator's decision, 2026-11-25); the count is in its name and tooltip only.
    expect([...badge.children].map((child) => [child.className, child.getAttribute('aria-hidden')])).toEqual([['codicon codicon-question', 'true']]);
    expect(badge.textContent).toBe('');
    expect(root.querySelector('[data-work-item="2"] .questions')!.getAttribute('aria-label')).toBe('1 question waiting');
    expect(root.querySelectorAll('[data-work-item="3"] .questions, [data-work-item="4"] .questions')).toHaveLength(0);
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
    // Each mic state names the actor: you dictate, and Switchboard speaks replies.
    const mic = (patch: Partial<Parameters<typeof renderMicButton>[0] & object>): string => renderMicButton({ enabled: true, here: true, speaking: null, speakReplies: true, error: null, ...patch });
    expect(mic({ mic: 'listening' })).toContain('title="Mic on: Switchboard is ready for your dictation. It sends when you pause.');
    expect(mic({ mic: 'hearing' })).toContain('title="Mic on: Switchboard is taking dictation.');
    expect(mic({ mic: 'hearing', speaking: 'r1', halfDuplex: 'no echo cancellation' })).toContain('title="Mic on, dictation paused while Switchboard speaks the reply (no echo cancellation): it resumes when the reply ends.');
    expect(mic({ mic: 'listening', halfDuplex: 'no echo cancellation' })).toContain('Dictation pauses while Switchboard speaks a reply (no echo cancellation), so you cannot stop the reply by speaking over it.');
    expect(mic({ mic: 'listening', fullDuplex: 'echo cancelled' })).toContain('Full duplex (echo cancelled): you can stop a spoken reply by speaking over it.');
    expect(mic({ mic: 'listening', roomHold: true })).toContain('Switchboard heard another voice, so your dictation waits in the composer until you send it.');
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

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    return { page, source };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
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
    second.source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId: 2, scopeGen: 4 }, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
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

    // How line 2 fits its width, cuts the playbook, drops links whole and hides pill texts under 300 px is checked in a browser by
    // check:shell; this checks the sizes and colours that check does not.
    // 18 px lines in 13 px text, the first row in a band without the rule's pixel.
    expect(one('.row-head')).toContain('height: 18px');
    expect(one('.row-line')).toContain('height: 18px');
    expect(one('.row-line')).not.toMatch(/font-size/);
    expect(one('.row-time')).not.toMatch(/font-size/);
    expect(one('.rows > li:first-child > .row')).toContain('border-top: none');
    // Pills 18 px tall with 14 px icons and 12 px text; a key's logo 14 px, a plugin's at its width's share of 14 px.
    expect(one('.row-line .pill')).toContain('height: 18px');
    expect(one('.row-line .pill')).toContain('font-size: 12px');
    expect(one('.row-line .pill .codicon')).toContain('font-size: 14px');
    expect(one('.row-line .pill .source-logo')).toContain('width: 14px');
    expect(one('.row-line .pill .source-logo')).toContain('height: 14px');
    expect(one('.row-line .pill svg.source-logo.custom')).toContain('width: calc(var(--source-icon-width) * 14 / 16)');
    // A key takes at most 60% of the line, so the playbook keeps its room; GitHub's key in GitHub's colour, not the foreground.
    expect(one('.row-line .pill.ticket')).toContain('max-width: 60%');
    expect(one('.row-line .pill.ticket.source-github')).toContain('border-color: var(--sb-github)');
    // Marks in the foreground at 14 px, Failed in the error colour; the muted texts in the theme's description colour, in both schemes.
    expect(one('.row-details .mark')).toContain('font-size: 14px');
    expect(one('.row-details .mark')).not.toMatch(/(^|[ ;])color:/);
    expect(one('.row-details .mark.failed')).toContain('color: var(--vscode-testing-iconFailed)');
    expect(css).toMatch(/^:root \{[^}]*--sb-row-muted: var\(--vscode-descriptionForeground\);/m);
    expect(css).not.toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--sb-row-muted/);
    expect(one('.row-time')).toContain('color: var(--sb-row-muted)');
  });

  it('hides Back and shows the work items\' sash outside the phone\'s layout alone, with no kept list toggle', () => {
    expect(css).not.toMatch(/layout-toggle|list-hidden/);
    // A selector that outranks button.icon's display; :where() adds nothing to it, as the media query it replaced did not.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) .header > .back-toggle')).toEqual(['display: none;']);
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) .side-sash')).toEqual(['display: block;']);
    expect(declarationsOf((selector) => selector === '.header > .back-toggle' || selector === '.side-sash')).toEqual([]);
  });

  it('stacks the page\'s layers by one scale: the sashes over the top bars, a bar\'s open menu over the sashes, the drawer and its backdrop over all of them, and Update ready and the toast over every sheet and dialog', () => {
    const scale = Object.fromEntries([...css.matchAll(/--sb-z-([a-z-]+): (\d+);/g)].map(([, name, value]) => [name, Number(value)]));
    const order = ['bar', 'sash', 'bar-menu', 'sliver', 'drawer-backdrop', 'drawer', 'maximized', 'sheet', 'settings', 'settings-sheet', 'update', 'toast', 'top-line', 'top-band'];

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
    // Update ready stays clickable while Settings, the persona dialog or a sheet is open, as #connection stays live over them (layers.ts).
    expect(declarationsOf((selector) => selector === '.conn-update')).toEqual([expect.stringContaining('z-index: var(--sb-z-update)')]);
    // No page-level layer keeps a number of its own outside the scale.
    expect(css).not.toMatch(/\.(sash|sliver|sheet-backdrop|composer-menu|conn-update)\b[^{]*\{[^}]*z-index: \d/);
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
      expect(rule).toMatch(/background: color-mix\(in srgb, var\(--vscode-focusBorder\) \d+%, var\(--sb-content\)\)/);
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

  it('shows the composer and the note above it only on the Chat tab, at every height', () => {
    // A refusal shows in the toast, on every tab.
    const rule = '#root.off-conversation';

    // No media condition: a tall phone hides them off the Chat tab as a short screen does.
    expect(css).toContain(`\n${rule} #note, ${rule} #composer { display: none; }\n`);
    expect(css).not.toMatch(/off-conversation:not\(:has\(#composer:focus-within\)\)/);
    // The class's one other use gives the other tabs' scrollers back the home indicator's inset at their end, which a shown composer takes away.
    expect(css.match(/off-conversation/g)).toHaveLength(3);
    expect(css).toContain(`\n${rule} > .main { --sb-end: env(safe-area-inset-bottom); }\n`);
  });

  it('ends the maximized column above the composer while the mic is on, at the composer\'s measured height', () => {
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.wide.maximized.dictating > .detail')).toEqual(['bottom: var(--sb-composer-height, 0px); border-bottom: 1px solid var(--vscode-panel-border);']);
    // The column's own rule still runs it to the page's bottom while the mic is off.
    expect(declarationsOf((selector) => selector === ':where(html:not(.phone)) #root.wide.maximized > .detail').join(' ')).toMatch(/inset: var\(--sb-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\);/);
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
    expect(declarationsOf((selector) => ['.detail .state-view', '.detail .artifact-list', '.detail .artifact-doc'].includes(unprefixed(selector)))).toEqual(['max-width: none;']);
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
