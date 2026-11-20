import { readFileSync } from 'node:fs';
import type { ArtifactView, ItemView, MessageView, ReplyView, SessionView, StatusView, ScopeView, VoiceView } from '@switchboard/hub';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY_CONVERSATION, isWorking, lastSpokenReply, limitText, micOn, selectedEntry, stateIcon, statusLine, timeline, totalUnread, voiceStatus, withEarlier } from '../src/conversationModel.js';
import type { ConversationState, Entry } from '../src/conversationModel.js';
import { linkTarget, previewLinks, supportsSecondarySidebar } from '../src/links.js';
import { shortTitle, startConversation, STATUS_NEW_MS } from '../src/webview/conversationMain.js';
import { ago, linkAllowed, personaButton, PICKER, renderConversation, renderMarkdown, renderMicButton, renderVoiceControls } from '../src/webview/conversationRender.js';
import type { Tab } from '../src/webview/conversationRender.js';

/** The page's extras for a tab. */
const on = (tab: Tab, unopened: string[] = []) => ({ tab, unopened: new Set(unopened) });

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: ScopeView = { kind: 'item', workItemId: 2, key: 'k1', folder: 'D:/w', title: 'Fix the <inbox> badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2', conversations: [{ workItemId: 2, title: 'Fix the <inbox> badge', primary: true, sessionId: 's2', state: 'running', conversation: 'full', unread: 0 }] };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'running', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, persona: null };

// Each item's ord is its time unless a test gives it another.
const reply = (id: string, at: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's2', at, ord: at, provisional: false, kind: 'reply', answers: null, opening: `Reply ${id}`, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const message = (id: string, at: number, text: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's2', workItemId: 2, at, ord: at, origin: 'terminal', text, provisional: false, withdrawn: false, delivery: null, error: null, ...patch });
const typed = (id: string, delivery: 'open' | 'sent' | 'not-sent', error: string | null = null): ItemView => ({ type: 'message', id, sessionId: 's2', workItemId: 2, at: T0, ord: T0, origin: 'typed', text: `Typed ${id}`, provisional: delivery === 'open' || delivery === 'sent', withdrawn: false, delivery, error });

const hello = (items: ItemView[] = [], patch: Partial<{ scope: ScopeView | null; sessions: SessionView[]; more: boolean; status: StatusView | null; artifactsDir: string | null; artifacts: ArtifactView[]; unread: number; voice: VoiceView; settings: { expandReplies: boolean } }> = {}) => ({ type: 'hello', scope: SCOPE, sessions: [SESSION], items, more: false, status: null, artifactsDir: null, artifacts: [], unread: 0, ...patch });
/** A timeline entry's ID: an item's, or an artifact's path. */
const idOf = (entry: Entry): string => (entry.type === 'artifact' ? entry.artifact.path : entry.item.id);

describe('the conversation state', () => {
  it('labels the current provider and updates it when the conversation changes', () => {
    const root = document.createElement('div');
    const first = applyEvent(EMPTY_CONVERSATION, hello([], { sessions: [{ ...SESSION, provider: 'codex' }] }));
    root.innerHTML = renderConversation(first);
    // The provider's own mark in the text colour, its name as the tooltip and the accessible name.
    expect(root.querySelector('.header > .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('.header > .provider')?.getAttribute('title')).toBe('Codex');
    expect(root.querySelector('.header > .provider svg path')?.getAttribute('fill')).toBe('currentColor');
    const codexMark = root.querySelector('.header > .provider svg path')?.getAttribute('d');
    const next = applyEvent(first, hello([], { sessions: [{ ...SESSION, id: 'claude-session', provider: 'claude' }] }));
    root.innerHTML = renderConversation(next);
    expect(root.querySelector('.header > .provider')?.getAttribute('aria-label')).toBe('Claude');
    expect(root.querySelector('.header > .provider svg path')?.getAttribute('d')).not.toBe(codexMark);
    root.innerHTML = renderConversation(applyEvent(next, hello([], { sessions: [] })));
    expect(root.querySelector('.provider')).toBeNull();
  });
  it('renders native Codex requests and unknown delivery without exposing a request as a chat answer', () => {
    const uncertain = message('m-unknown', T0, 'Check delivery', { origin: 'typed', delivery: 'uncertain', error: 'Check the terminal before resending.' });
    const native = { ...SESSION, provider: 'codex' as const, state: 'waiting' as const, waitingFor: 'question' as const, requests: [{id:'1:0',kind:'question' as const,title:'Choose <red> or blue',questions:[{id:'color',question:'Which color?',options:['Red','Blue']}],decisions:[]}] };
    const state = applyEvent(EMPTY_CONVERSATION, hello([uncertain], { sessions: [native] }));
    const html = renderConversation(state);
    expect(html).toContain('data-action="answer-request" data-request="1:0"');
    expect(html).toContain('Choose &#60;red&#62; or blue');
    expect(html).toContain('delivery unknown; check before resending');
    expect(html).not.toContain('Claude is waiting');
    expect(state.items).toHaveLength(1);
  });
  it('posts a native request click with the session and scope shown by that page', () => {
    const root=document.createElement('div');const live=document.createElement('div');const posted:unknown[]=[];
    document.body.replaceChildren(root,live);
    startConversation(root,live,{postMessage:(message:unknown)=>posted.push(message),getState:()=>null,setState:()=>{}});
    const native={...SESSION,provider:'codex' as const,requests:[{id:'1:0',kind:'permission' as const,title:'Approve command',questions:[],decisions:['accept','decline']}]};
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:applyEvent(EMPTY_CONVERSATION,hello([],{sessions:[native]}))}}));
    root.querySelector<HTMLElement>('[data-action="answer-request"]')!.click();
    expect(posted.at(-1)).toEqual({type:'answer-request',requestId:'1:0',target:{sessionId:'s2',scopeGen:1}});
  });
  it('starts from each hello, adds and replaces items in time order, and takes only its current session\'s state', () => {
    let state = applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Why?')]));

    state = applyEvent(state, { type: 'reply', reply: reply('r1', T0 + 2, { source: 'screen' }) });
    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Also') });
    state = applyEvent(state, { type: 'reply', reply: reply('r1', T0 + 3, { opening: 'Whole.' }) });
    state = applyEvent(state, { type: 'session', session: { ...SESSION, id: 'other', state: 'ended' } });
    state = applyEvent(state, { type: 'session', session: { ...SESSION, state: 'idle' } });
    state = applyEvent(state, { type: 'notice' });

    expect(state.items.map((item) => item.id)).toEqual(['m1', 'm2', 'r1']);
    expect(state.items[2]).toMatchObject({ opening: 'Whole.', source: 'transcript' });
    expect(state.session?.state).toBe('idle');
    expect(state.connected).toBe(true);

    const moved = applyEvent(applyEvent(state, { type: 'scope', scope: { ...SCOPE, workItemId: 3, sessionId: null } }), hello([], { scope: { ...SCOPE, workItemId: 3, sessionId: null }, sessions: [] }));

    expect(moved).toEqual({ scope: { ...SCOPE, workItemId: 3, sessionId: null }, session: null, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false } });
  });

  it('keeps the voice state and the setting from hello and their events, and shows a playing reply\'s progress (architecture.md § Voice)', () => {
    const voice = { enabled: true, here: true, mic: 'off' as const, speaking: null, speakReplies: true, error: null, recognizer: null };
    let state = applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0, { speak: 'Done.' })], { voice, settings: { expandReplies: true } }));

    expect(state.voice).toEqual(voice);
    expect(state.settings).toEqual({ expandReplies: true });
    state = applyEvent(state, { type: 'voice', voice: { ...voice, here: false } });
    expect(state.voice?.here).toBe(false);
    state = applyEvent(state, { type: 'settings', settings: { expandReplies: false } });
    expect(state.settings.expandReplies).toBe(false);
    state = applyEvent(state, { type: 'progress', replyId: 'r1', chars: 3, atMs: 450 });
    expect(state.items[0]).toMatchObject({ spoken: { state: 'playing', atMs: 450, saidChars: 3 } });
    expect(applyEvent(state, { type: 'progress', replyId: 'gone', chars: 1, atMs: 1 }).items).toEqual(state.items);
    // A hub without voice sends none, and a new hello keeps the setting it had.
    expect(applyEvent(state, hello([]))).toMatchObject({ voice: null, settings: { expandReplies: false } });
  });

  it('shows the voice in the status bar only as this window sees it, and finds the reply Replay speaks again', () => {
    const voice = { enabled: true, here: true, mic: 'off' as const, speaking: null, speakReplies: true, error: null, recognizer: null };

    expect(voiceStatus(null)).toBeNull();
    expect(voiceStatus({ ...voice, enabled: false })).toBeNull();
    expect(voiceStatus({ ...voice, here: false })).toEqual({ text: '$(circle-slash) Voice not here', tooltip: 'Voice is not in this window. Click to talk here.', command: 'switchboard.talkHere', warning: false });
    expect(voiceStatus({ ...voice, error: 'no device' })).toMatchObject({ text: '$(warning) Voice', command: 'switchboard.showVoiceLog', warning: true });
    expect(voiceStatus({ ...voice, speaking: 'r1' })).toMatchObject({ text: '$(unmute) Speaking', command: 'switchboard.stopSpeaking' });
    // The mic (architecture.md § Dictation).
    expect(voiceStatus(voice)).toEqual({ text: '$(mic) Mic off', tooltip: 'Click to turn the mic on.', command: 'switchboard.toggleMicrophone', warning: false });
    expect(voiceStatus({ ...voice, mic: 'idle-off' })).toMatchObject({ text: '$(mic) Mic off', tooltip: 'The mic stopped after a quiet spell. Click to turn it on.' });
    expect(voiceStatus({ ...voice, mic: 'listening' })).toMatchObject({ text: '$(mic-filled) Listening', command: 'switchboard.toggleMicrophone' });
    expect(voiceStatus({ ...voice, mic: 'hearing' })).toMatchObject({ text: '$(mic-filled) Listening' });
    expect(voiceStatus({ ...voice, mic: 'typing' })).toMatchObject({ text: '$(mic-filled) Typing' });
    expect(voiceStatus({ ...voice, mic: 'starting' })).toMatchObject({ text: '$(mic-filled) Mic starting' });
    expect(voiceStatus({ ...voice, mic: 'paused-other-app' })).toEqual({ text: '$(mic) Mic paused', tooltip: 'Paused: another app is using the microphone.', command: null, warning: false });
    expect(voiceStatus({ ...voice, mic: 'listening', speaking: 'r1' })).toMatchObject({ text: '$(unmute) Speaking', tooltip: 'Click to stop speaking.' });
    expect(voiceStatus({ ...voice, mic: 'listening' })).toMatchObject({ tooltip: 'Dictation sends when you stop talking. Click to turn the mic off.' });
    // Half-duplex capture: the tooltip says listening pauses while a reply plays, and why.
    const halfDuplex = { ...voice, mic: 'listening' as const, halfDuplex: 'no echo cancellation on Remote Audio' };
    expect(voiceStatus(halfDuplex)).toMatchObject({ tooltip: 'Dictation sends when you stop talking. Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to turn the mic off.' });
    expect(voiceStatus({ ...halfDuplex, speaking: 'r1' })).toMatchObject({ text: '$(unmute) Speaking', tooltip: 'Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to stop speaking.' });
    // Full duplex with no echo cancellation, as the echo check decided: the tooltip says so, and that talking over a reply stops it.
    const fullDuplex = { ...voice, mic: 'listening' as const, fullDuplex: 'echo check: none heard' };
    expect(voiceStatus(fullDuplex)).toMatchObject({ tooltip: 'Dictation sends when you stop talking. Full duplex (echo check: none heard): talking over a reply stops it. Click to turn the mic off.' });
    expect(voiceStatus({ ...fullDuplex, speaking: 'r1' })).toMatchObject({ tooltip: 'Full duplex (echo check: none heard): talking over a reply stops it. Click to stop speaking.' });
    // A room hold: spoken turns stay in the box.
    expect(voiceStatus({ ...voice, mic: 'listening', roomHold: true })).toEqual({ text: '$(mic-filled) Listening (held)', tooltip: 'Held: someone else is talking in the room, so dictation stays in the box until you press Enter. Click to turn the mic off.', command: 'switchboard.toggleMicrophone', warning: false });
    // Paused by "stop listening": the toggle listens again.
    expect(voiceStatus({ ...voice, mic: 'paused-by-voice' })).toEqual({ text: '$(mic) Mic paused', tooltip: 'Paused: you said "stop listening". Say "start listening", or click to listen again.', command: 'switchboard.toggleMicrophone', warning: false });
    expect(micOn({ ...voice, mic: 'paused-by-voice' })).toBe(false);
    expect(micOn({ ...voice, mic: 'listening' })).toBe(true);
    expect(micOn({ ...voice, mic: 'paused-other-app' })).toBe(true);
    expect(micOn({ ...voice, mic: 'idle-off' })).toBe(false);
    expect(micOn({ ...voice, mic: 'unavailable', error: 'No speech recognition model in m.' })).toBe(false);
    expect(micOn({ ...voice, mic: 'listening', here: false })).toBe(false);
    expect(micOn(null)).toBe(false);

    const items = [reply('r1', T0, { speak: 'One.' }), reply('r2', T0 + 1, { speak: 'Two.', rewrittenBy: 'r3' }), reply('r3', T0 + 2), message('m1', T0 + 3, 'Next')];

    expect(lastSpokenReply({ ...EMPTY_CONVERSATION, items })?.id).toBe('r1');
    expect(lastSpokenReply(EMPTY_CONVERSATION)).toBeNull();
  });

  it("takes the unread count from the hello and each unread event, and drops it when the window's session moves", () => {
    let state = applyEvent(EMPTY_CONVERSATION, hello([], { unread: 2 }));

    expect(state.unread).toBe(2);
    state = applyEvent(state, { type: 'unread', workItemId: 2, count: 3 });
    expect(state.unread).toBe(3);
    expect(applyEvent(state, { type: 'scope', scope: { ...SCOPE, title: 'Renamed' } }).unread).toBe(3);
    expect(applyEvent(state, { type: 'scope', scope: { ...SCOPE, sessionId: 's9' } }).unread).toBe(0);
  });

  it("keeps items in the transcript's order, by ord and not by time, with a sent message and a screen copy after them until their lines are read", () => {
    let state = applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'First?', { ord: 1 }), reply('r1', T0 + 9000, { ord: 2 })]));
    const ids = () => state.items.map((item) => item.id);

    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Second?', { ord: 3, provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r2', T0 + 2, { ord: 4, source: 'screen', provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r3', T0 + 3, { ord: 5 }) });
    expect(ids()).toEqual(['m1', 'r1', 'r3', 'm2', 'r2']);

    // The screen copy's transcript line is read, then the line where Claude received the message.
    state = applyEvent(state, { type: 'reply', reply: reply('r2', T0 + 2, { ord: 6 }) });
    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Second?', { ord: 7 }) });
    expect(ids()).toEqual(['m1', 'r1', 'r3', 'r2', 'm2']);

    // A sent message Claude never received leaves the timeline.
    state = applyEvent(state, { type: 'message', message: message('m3', T0 + 4, 'Never', { ord: 8, withdrawn: true }) });
    expect(timeline(state.items).map((entry) => idOf(entry))).toEqual(['m1', 'r1', 'r3', 'r2', 'm2']);
  });

  it('drops a typed message that was not sent, from an event, a hello or a page of earlier items', () => {
    const empty = applyEvent(EMPTY_CONVERSATION, hello());
    const shown = applyEvent(empty, { type: 'message', message: typed('m1', 'open') });

    expect(shown.items.map((item) => item.id)).toEqual(['m1']);
    expect(applyEvent(shown, { type: 'message', message: typed('m1', 'not-sent', 'The session has ended.') }).items).toEqual([]);
    expect(applyEvent(empty, { type: 'message', message: typed('m2', 'not-sent', 'x') }).items).toEqual([]);
    expect(applyEvent(EMPTY_CONVERSATION, hello([typed('m1', 'not-sent', 'x'), typed('m2', 'sent')])).items.map((item) => item.id)).toEqual(['m2']);
    expect(withEarlier(empty, [typed('m1', 'not-sent', 'x'), typed('m2', 'sent')], false).items.map((item) => item.id)).toEqual(['m2']);
  });

  it('puts earlier items before the shown ones once each', () => {
    const state = applyEvent(EMPTY_CONVERSATION, hello([reply('r3', T0 + 3)], { more: true }));

    expect(withEarlier(state, [reply('r1', T0 + 1), reply('r3', T0 + 3)], false)).toMatchObject({ items: [{ id: 'r1' }, { id: 'r3' }], more: false });
  });

  it('leaves out withdrawn copies and puts a rewrite in the place of the reply it rewrote', () => {
    const entries = timeline([
      reply('r1', T0, { rewrittenBy: 'r3' }),
      message('m1', T0 + 1, 'the other one'),
      reply('r2', T0 + 2, { withdrawn: true }),
      reply('r3', T0 + 3, { replaces: 'r1' }),
      reply('r4', T0 + 4, { rewrittenBy: 'r5' }),
      reply('r5', T0 + 5, { replaces: 'r4', withdrawn: true }),
    ]);

    expect(entries.map((entry) => `${idOf(entry)}${entry.type === 'reply' && entry.earlier !== null ? `<${entry.earlier.id}` : ''}`)).toEqual(['r3<r1', 'm1', 'r4']);

    // Rewritten twice: the last rewrite alone, in the first reply's place.
    const chain = timeline([reply('a', T0, { rewrittenBy: 'b' }), reply('b', T0 + 1, { replaces: 'a', rewrittenBy: 'c' }), reply('c', T0 + 2, { replaces: 'b' })]);

    expect(chain.map((entry) => `${idOf(entry)}${entry.type === 'reply' && entry.earlier !== null ? `<${entry.earlier.id}` : ''}`)).toEqual(['c<b']);
  });

  it("names the header's codicon for each state", () => {
    expect(stateIcon(SESSION)).toEqual({ icon: 'loading~spin', text: 'Working' });
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'question' }).icon).toBe('question');
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'permission' }).icon).toBe('shield');
    expect(stateIcon({ ...SESSION, state: 'idle' }).icon).toBe('check');
    expect(stateIcon({ ...SESSION, state: 'ended' }).icon).toBe('circle-slash');
    expect(stateIcon({ ...SESSION, state: 'starting' }).icon).toBe('loading~spin');
    expect(stateIcon(null).icon).toBe('circle-slash');
  });

  it('shows a session waiting for a usage limit to reset with a watch and when it resumes (architecture.md § Rate limits)', () => {
    const until = new Date(2026, 10, 20, 13, 21).getTime();

    expect(stateIcon({ ...SESSION, state: 'idle', limit: { until, retry: false } })).toEqual({ icon: 'watch', text: 'Rate limited · resumes 1:21 PM' });
    expect(limitText({ until, retry: true }, until)).toBe('Rate limited · retries 1:21 PM');
    expect(limitText({ until, retry: false }, until - 24 * 3_600_000)).toBe('Rate limited · resumes Fri 1:21 PM');
  });

  it('waits for a reply to the latest message only while the session works, as the header spins, until a reply comes', () => {
    const items = [message('m1', T0, 'One'), reply('r1', T0 + 1), message('m2', T0 + 2, 'Two'), reply('a1', T0 + 3, { kind: 'aside' }), reply('n1', T0 + 4, { kind: 'note' })];

    for (const state of ['starting', 'running', 'waiting', 'idle', 'ended'] as const) {
      const session = { ...SESSION, state };

      expect(isWorking(session)).toBe(stateIcon(session).icon === 'loading~spin');
      expect(awaitingReply(items, session)).toBe(isWorking(session) || state === 'waiting');
    }

    expect(awaitingReply(items, null)).toBe(false);
    expect(awaitingReply([...items, reply('r2', T0 + 5)], SESSION)).toBe(false);
    expect(awaitingReply([reply('r1', T0)], SESSION)).toBe(false);

    // A rewrite of the earlier reply answers the latest message, though the timeline shows it above that message.
    const rewritten = [message('m1', T0, 'One'), reply('r1', T0 + 1, { rewrittenBy: 'r2' }), message('m2', T0 + 2, 'Two'), reply('r2', T0 + 3, { replaces: 'r1' })];

    expect(awaitingReply(rewritten, SESSION)).toBe(false);
    // A reply ends the wait when it answers the latest message or a later one, wherever the timeline shows it; one answering an earlier message
    // does not, such as the reply to the first message written after the second was sent.
    const batch = [message('m1', T0, 'One'), message('m2', T0 + 1, 'Two'), reply('r1', T0 + 2, { answers: 'm1' })];

    expect(awaitingReply(batch, SESSION)).toBe(true);
    expect(awaitingReply([...batch, reply('r2', T0 + 3, { answers: 'm2' })], SESSION)).toBe(false);
    // A withdrawn screen copy is no reply.
    expect(awaitingReply([...items, reply('r3', T0 + 5, { withdrawn: true })], SESSION)).toBe(true);
  });
});

describe('the Conversation view page', () => {
  const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });

  it('draws the header, messages as boxes, replies whole, asides, notes and rewrites, escaping every text', () => {
    const html = renderConversation(
      state([
        message('m1', T0, 'Is <b>it</b> fixed?'),
        reply('r1', T0 + 1, { opening: 'Yes, **fixed**.\n\n| a | b |\n|---|---|\n| 1 | 2 |', rewrittenBy: 'r3' }),
        reply('r2', T0 + 2, { kind: 'aside', opening: 'Reading <script>alert(1)</script>' }),
        reply('n1', T0 + 2, { kind: 'note', opening: 'Conversation continued from another session.' }),
        reply('r3', T0 + 3, { opening: 'Both fixed.', replaces: 'r1' }),
      ]),
      new Set(['earlier:r3']),
    );
    const root = document.createElement('div');

    root.innerHTML = html;
    // The dropdown's button holds the state codicon and the title, as each of its options does.
    expect([...root.querySelector('.header button.picker')!.children].map((child) => child.className)).toEqual(['codicon codicon-loading codicon-modifier-spin', 'title', 'codicon codicon-chevron-down']);
    expect(root.querySelector('.header > .codicon')).toBeNull();
    expect(root.querySelector('.header .title')?.textContent).toBe('Fix the <inbox> badge');
    expect(root.querySelector('.message .box')?.textContent).toBe('Is <b>it</b> fixed?');
    root.innerHTML = renderConversation(state([message('m1', T0, 'Sent', { provisional: true })]));
    expect(root.querySelector('.message')?.className).toBe('message provisional');
    root.innerHTML = html;
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['message', 'reply reply', 'reply aside', 'note']);
    expect(root.querySelector('.reply.reply .body > p')?.innerHTML).toBe('Both fixed.');
    expect(root.querySelector<HTMLDetailsElement>('.fold.earlier')?.open).toBe(true);
    expect(root.querySelector('.fold.earlier .was table')).not.toBeNull();
    expect(root.querySelector('.fold.earlier .was')?.innerHTML).toContain('<strong>fixed</strong>');
    // Raw HTML in a reply stays text.
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('.reply.aside')?.textContent).toContain('<script>');
  });

  it("shows the session's persona in the header, pinned or with its tone change pending, and nothing without one (architecture.md § Personas)", () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([], { session: { ...SESSION, persona: { id: 'nova', name: 'Nova <N>', pinned: false, tonePending: false } } }));

    const button = root.querySelector<HTMLButtonElement>('header button.persona')!;

    expect(button.dataset['action']).toBe('persona');
    expect(button.textContent).toBe('Nova <N>');
    expect(button.title).toBe('Persona: Nova <N>. Click to choose another.');
    expect(button.querySelector('.codicon-person')).not.toBeNull();
    // After the conversation dropdown, before the plus.
    expect(button.previousElementSibling?.classList.contains('picker')).toBe(true);

    const pinned = personaButton({ id: 'nova', name: 'Nova', pinned: true, tonePending: true });

    expect(pinned).toContain('class="persona pending"');
    expect(pinned).toContain('codicon-pinned');
    expect(pinned).toContain('title="Persona: Nova, pinned to this session. Its tone changes when the session next resumes or compacts. Click to choose another."');
    expect(personaButton(null)).toBe('');
    expect(renderConversation(state([]))).not.toContain('class="persona');
  });

  it('says why the view cannot talk to a session, and when there is nothing to show', () => {
    const ended = renderConversation(state([], { session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' } }));

    expect(ended).toContain('The session has ended. Open it in the terminal to resume it.');
    // Every session is read with the current rules, so no rules note shows.
    expect(ended).not.toContain('conversation rules');
    expect(ended).toContain('No messages yet.');
    expect(renderConversation(state([], { session: { ...SESSION, conversation: 'none', reason: 'background' } }))).not.toContain('data-action="terminal"');
    expect(renderConversation({ ...EMPTY_CONVERSATION, connected: true })).toContain('This window has no Switchboard session.');
    expect(renderConversation(EMPTY_CONVERSATION)).toContain('Connecting to Switchboard');
    expect(renderConversation(state([reply('r1', T0)], { more: true }))).toContain('data-action="earlier"');
  });

  it('draws our messages as bubbles on the right, at most 85% wide in the Chat view\'s request bubble colour with a smaller bottom-right corner, with the delivery and the time over them', () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

    expect(rule('.message')).toContain('align-items: flex-end;');
    expect(rule('.message .box')).toContain('max-width: 85%;');
    expect(rule('.message .box')).toContain('border-radius: 12px 12px 4px 12px;');
    expect(rule('.message .box')).toContain('background: var(--vscode-chat-requestBubbleBackground, var(--vscode-editor-inactiveSelectionBackground,');
    expect(rule('.message .box')).toContain('border: 1px solid var(--vscode-contrastBorder, transparent);');
    expect(rule('.message .box')).toContain('color: var(--vscode-foreground);');
    expect(rule('body.vscode-high-contrast .message .box, body.vscode-high-contrast-light .message .box')).toContain('background: transparent;');

    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([typed('t1', 'not-sent', 'The session has ended.')]), new Set(), T0);
    expect([...root.querySelector('li[data-id="t1"]')!.children].map((child) => child.className)).toEqual(['stamp-line', 'box']);
    // The state comes before the time, so the times stay flush right.
    expect([...root.querySelector('li[data-id="t1"] > .stamp-line')!.children].map((child) => child.className)).toEqual(['delivery not-sent', 'stamp-dot', 'stamp']);
  });

  it('shows a time only where the minute changes from the item before, never repeating it under a message and over its reply', () => {
    const at = (minute: number, second = 0) => new Date(2026, 10, 19, 13, minute, second).getTime();
    const root = document.createElement('div');

    root.innerHTML = renderConversation(
      state([
        message('m1', at(47, 5), '/support-process #453696'),
        reply('r1', at(47, 40)),
        reply('n1', at(48), { kind: 'note', opening: 'Conversation continued from another session.' }),
        reply('r2', at(47, 50)),
        reply('r3', at(59)),
        message('m2', at(59, 30), 'Thanks'),
        reply('r4', at(60)),
      ]),
      new Set(),
      at(61),
    );

    const stamps = (id: string) => root.querySelector(`li[data-id="${id}"] > .stamp-line .stamp`)?.textContent ?? null;

    // A note has no time and is not the item before; the minute after it is compared with the reply before it.
    expect(['m1', 'r1', 'n1', 'r2', 'r3', 'm2', 'r4'].map(stamps)).toEqual(['1:47 PM', null, null, null, '1:59 PM', null, '2:00 PM']);
    // A reply with no time takes no room for one.
    expect(root.querySelector('li[data-id="r1"] > .stamp-line')).toBeNull();
    expect([...root.querySelector('li[data-id="m2"]')!.children].map((child) => child.className)).toEqual(['box']);
  });

  it('leaves a reply with no text out of the timeline', () => {
    expect(timeline([reply('r1', T0, { opening: ' \n ' }), reply('r2', T0 + 1)]).map((entry) => idOf(entry))).toEqual(['r2']);
  });

  it('stamps each message and reply with its time, not a note, and puts a divider before a turn that starts on another day', () => {
    const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime();
    const root = document.createElement('div');

    root.innerHTML = renderConversation(
      state([
        message('m1', at(19, 13, 46), '/support-process #453532'),
        reply('r1', at(19, 13, 47)),
        reply('n1', at(19, 13, 48), { kind: 'note', opening: 'Conversation continued from another session.' }),
        reply('a1', at(19, 14, 5), { kind: 'aside', opening: 'Reading' }),
        message('m2', at(20, 9, 0), 'Next day'),
        reply('r2', at(20, 21, 30)),
      ]),
      new Set(),
      at(20, 22, 0),
    );

    const stamps = (id: string) => root.querySelector(`li[data-id="${id}"] > .stamp-line .stamp`)?.textContent ?? null;

    expect(['m1', 'r1', 'n1', 'a1', 'm2', 'r2'].map(stamps)).toEqual(['1:46 PM', '1:47 PM', null, '2:05 PM', '9:00 AM', '9:30 PM']);
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('datetime')).toBe(new Date(at(19, 13, 46)).toISOString());
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('title')).toMatch(/^2026-11-19 13:46:00 \S+$/);
    // The stamp sits over a message's bubble, as over a reply, and a slash command shows in the editor font.
    expect([...root.querySelector('li[data-id="m1"]')!.children].map((child) => child.className)).toEqual(['stamp-line', 'box command']);
    expect(root.querySelector('li[data-id="m2"] .box')?.className).toBe('box');
    // No divider before the first turn; one, without the year, before the turn on the next day, which the keys skip.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['m1', 'r1', 'n1', 'a1', 'day', 'm2', 'r2']);
    expect(root.querySelector('.day')?.textContent).toBe('Fri, Nov 20');
    expect(root.querySelector('.day')?.getAttribute('role')).toBe('separator');

    // A reply after midnight in the same turn gets no divider, the next turn does; a turn in an earlier year shows its year.
    root.innerHTML = renderConversation(state([message('m1', at(19, 23, 50), 'Late'), reply('r1', at(20, 0, 10)), message('m2', at(20, 0, 20), 'Still')], { session: { ...SESSION, state: 'idle' } }), new Set(), at(20, 1, 0));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['m1', 'r1', 'day', 'm2']);
    root.innerHTML = renderConversation(state([message('m1', new Date(2026, 11, 30, 9).getTime(), 'Old'), message('m2', new Date(2026, 11, 31, 9).getTime(), 'New')]), new Set(), new Date(2027, 2, 1).getTime());
    expect(root.querySelector('.day')?.textContent).toBe('Thu, Dec 31, 2026');
  });

  it('shows a spinner after the newest item while the session works on a reply, gone when the reply arrives or the turn ends', () => {
    const root = document.createElement('div');
    const asked = [reply('r1', T0, { opening: 'Hi' }), message('m1', T0 + 1, 'Why?'), reply('a1', T0 + 2, { kind: 'aside', opening: 'Reading' })];

    root.innerHTML = renderConversation(state(asked));
    // Progress written mid-turn shows above it, as an artifact written since does.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['reply reply', 'message', 'reply aside', 'working']);
    root.innerHTML = renderConversation(state([...asked, reply('a2', T0 + 3, { kind: 'aside', opening: 'Writing' })], { artifacts: [{ path: 'chat/a.md', owner: 'chat', kind: 'page', title: 'Page', ext: 'md', type: 'markdown', updatedAt: T0 + 4 }] }));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['r1', 'm1', 'a1', 'a2', 'artifact:chat/a.md', 'working']);
    expect(root.querySelector('.working .codicon')?.className).toBe('working-icon codicon codicon-loading codicon-modifier-spin');
    // "Thinking…" beside it, as in Claude Code's panel, which a screen reader hears once, as "Thinking".
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Thinking…');
    expect(root.querySelector('.working .working-label')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.working')?.getAttribute('data-id')).toBeNull();
    expect(root.querySelector('.working [role="status"]')?.textContent).toBe('Thinking');
    expect(root.querySelector('.working .codicon')?.getAttribute('aria-hidden')).toBe('true');

    root.innerHTML = renderConversation(state([...asked, reply('r2', T0 + 3)]));
    expect(root.querySelector('.working')).toBeNull();
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'idle' } }));
    expect(root.querySelector('.working')).toBeNull();
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'ended' } }));
    expect(root.querySelector('.working')).toBeNull();
    // "Starting…" while the session starts.
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'starting' } }));
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Starting…');
    // Waiting on the operator, it says for what, with a still icon in the warning colour and Open in terminal, and no "Thinking".
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'waiting', waitingFor: 'question' } }));
    expect(root.querySelector('.working.waiting .codicon')?.className).toBe('working-icon codicon codicon-question');
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Waiting for your answer');
    expect(root.textContent).not.toContain('Thinking');
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'waiting', waitingFor: 'permission' } }));
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Waiting for permission');
    expect(root.querySelector('.working [role="status"]')?.textContent).toBe('Waiting for permission. Claude asks for permission in the terminal.');
    expect(root.querySelector('.working.waiting [data-action="terminal"]')?.textContent).toBe('Open in terminal');
    // A wait shows even when no reply is due, as before the first message.
    root.innerHTML = renderConversation(state([], { session: { ...SESSION, state: 'waiting', waitingFor: 'permission' } }));
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Waiting for permission');
    expect(root.querySelector('.empty')).toBeNull();
  });

  it('draws file:, drive-letter, relative and spaced links as links, and unsafe schemes as text', () => {
    const href = (text: string) => /data-href="([^"]*)"/.exec(renderMarkdown(text))?.[1] ?? null;

    expect(href('[Index.cshtml](file:///D:/git/widgets/Widgets.Web/Views/Home/Index.cshtml)')).toBe('file:///D:/git/widgets/Widgets.Web/Views/Home/Index.cshtml');
    expect(href('[c.ts:3](file:///D:/a%20b/c.ts#L3)')).toBe('file:///D:/a%20b/c.ts#L3');
    expect(href('[c.ts](<D:/a b/c.ts#L4>)')).toBe('D:/a%20b/c.ts#L4');
    expect(href('[a](../src/a.ts#L42)')).toBe('../src/a.ts#L42');
    expect(href('[a](#L9)')).toBe('#L9');
    for (const unsafe of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'mailto:x@y.z', 'command:workbench.action.quit', 'vscode://file/D:/a.ts']) {
      expect(href(`[x](${unsafe})`)).toBeNull();
    }
    expect(linkAllowed(' javascript:x')).toBe(false);
  });

  it("keeps a link's target for the extension and never lets the page follow it", () => {
    expect(renderMarkdown('See [a.ts:4](./src/a.ts#L4) and https://x.test')).toBe('<p>See <a href="#" data-href="./src/a.ts#L4">a.ts:4</a> and <a href="#" data-href="https://x.test">https://x.test</a></p>\n');
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('copies a code block as written and a reply as its Markdown, and shows a check for 2 seconds once copied', () => {
    vi.useFakeTimers();

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };
    const show = (items: ItemView[]) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state(items, { session: { ...SESSION, state: 'idle' } }) } }));
    const copied = (id: number, ok: boolean) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'copied', id, ok } }));

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show([
      reply('r1', T0, { opening: 'Run:\n\n```sh\nnpm run build && echo "<done>"\n```\n\nThen **check** it.' }),
      reply('r2', T0 + 1, { source: 'screen', provisional: true }),
      reply('n1', T0 + 2, { kind: 'note', opening: 'Conversation continued from another session.' }),
    ]);

    // A copy button in each code block's frame, and one under each reply read from the transcript.
    const code = root.querySelector<HTMLButtonElement>('li[data-id="r1"] .body > .code-block > button.copy[data-action="copy-code"]')!;
    const response = root.querySelector<HTMLButtonElement>('li[data-id="r1"] > .actions > button.copy[data-action="copy-reply"]')!;

    expect(code.nextElementSibling?.tagName).toBe('PRE');
    expect(code.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    expect(response.getAttribute('aria-label')).toBe('Copy response to clipboard');
    expect(root.querySelector('li[data-id="r2"] .actions')).toBeNull();
    expect(root.querySelector('li[data-id="n1"] .actions')).toBeNull();

    code.click();
    response.click();
    expect(posted.filter((message) => message.type === 'copy')).toEqual([
      { type: 'copy', id: 1, text: 'npm run build && echo "<done>"' },
      { type: 'copy', id: 2, text: 'Run:\n\n```sh\nnpm run build && echo "<done>"\n```\n\nThen **check** it.' },
    ]);

    // A failed write shows nothing; a written one shows the check until 2 seconds pass.
    copied(1, false);
    expect(code.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    copied(2, true);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-check');
    expect(response.title).toBe('Copied');
    expect(live.textContent).toBe('Copied');
    vi.advanceTimersByTime(1_999);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-check');
    vi.advanceTimersByTime(1);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    expect(response.title).toBe('Copy response');

    // Enter on a copy button presses it rather than toggling the reply's fold.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    response.focus();
    response.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    vi.useRealTimers();
  });

  it('posts ready, draws each state, posts a link, a fold and Open in terminal, and moves between items with the keys', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: unknown[] = [];
    let saved: unknown = { open: ['earlier:w2'] };
    const vscode = { postMessage: (message: unknown) => posted.push(message), getState: () => saved, setState: (next: unknown) => (saved = next) };

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(root.textContent).toContain('Connecting to Switchboard');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'Before', rewrittenBy: 'w2' }), reply('w2', T0 + 1, { opening: 'See [a](./a.ts#L2)', replaces: 'r1' })]) } }));
    expect(root.querySelector<HTMLDetailsElement>('details.fold')?.open).toBe(true);
    expect(root.textContent).not.toContain('Show more');

    root.querySelector<HTMLElement>('a[data-href]')!.click();
    root.querySelector<HTMLElement>('[data-action="terminal"]')!.click();
    expect(posted.slice(1)).toEqual([{ type: 'open', href: './a.ts#L2' }, { type: 'terminal' }]);

    const fold = root.querySelector<HTMLDetailsElement>('details.fold')!;

    fold.open = false;
    fold.dispatchEvent(new Event('toggle'));
    expect(saved).toMatchObject({ open: [] });

    // A second reply arrives and is announced once.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'One' }), reply('r2', T0 + 1, { opening: 'Two' })]) } }));
    expect(live.textContent).toBe('Two');

    const list = root.querySelector<HTMLElement>('.timeline')!;

    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r2');

    // The keys skip the spinner at the end of a turn the session is working on. jsdom has no CSS.escape, which a redraw with a focused item uses.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'One' }), message('m3', T0 + 1, 'Three?'), reply('a3', T0 + 2, { kind: 'aside', opening: 'Reading' })]) } }));
    expect(root.querySelector('.timeline > li.working')).not.toBeNull();
    root.querySelector<HTMLElement>('li[data-id="m3"]')!.focus();
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('a3');
    // From the last item, the spinner after it is not a stop.
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.className).not.toBe('working');
    expect(document.activeElement?.getAttribute('data-id')).toBe('a3');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe('unread replies and statuses', () => {
  const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });
  const status = (id: string, patch: Partial<StatusView> = {}): StatusView => ({ id, sessionId: 's2', at: T0, markdown: 'Done.', fallback: false, unread: true, ...patch });

  it("marks an unread reply's dot on the Conversation tab and the unread status on the Status tab, and never a seen one, a note or the stage", () => {
    const root = document.createElement('div');
    const shown = state([reply('r1', T0, { unread: true }), reply('r2', T0 + 1), reply('n1', T0 + 2, { kind: 'note', unread: true })], { status: status('st1') });

    root.innerHTML = renderConversation(shown, new Set(), T0);
    expect([...root.querySelectorAll<HTMLElement>('[data-unread]')].map((one) => one.dataset['unread'])).toEqual(['r1']);
    expect(root.querySelector('li[data-id="r1"]')?.className).toBe('reply reply unread');
    expect(root.querySelector('li[data-id="r1"] .dot')?.getAttribute('title')).toBe('Unread');
    expect(root.querySelector('li[data-id="r2"] .dot')?.textContent).toBe('');

    root.innerHTML = renderConversation(shown, new Set(), T0, false, on('status'));
    expect([...root.querySelectorAll<HTMLElement>('[data-unread]')].map((one) => one.dataset['unread'])).toEqual(['st1']);
    expect(root.querySelector('.status-tab')?.getAttribute('aria-label')).toBe('Status, unread');

    root.innerHTML = renderConversation(state([], { status: status('stage-2', { fallback: true, unread: true }) }), new Set(), T0, false, on('status'));
    expect(root.querySelector('[data-unread]')).toBeNull();
    expect(root.querySelector('.tab-badge')).toBeNull();
  });

  it('reports each unread item seen once it was visible in a focused window for a second, leaving those outside the timeline unread', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };
    // Where each unread item sits, against a timeline 100 px tall at the top of the view.
    const boxes = new Map<string, [number, number]>([['r1', [-200, -140]], ['r2', [20, 80]]]);
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = boxes.get((this as HTMLElement).dataset['unread'] ?? '');

      return this.classList.contains('scroll') ? rect(0, 100) : box === undefined ? rect(0, 0) : rect(...box);
    });

    const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
    const seen = () => posted.filter((message) => message.type === 'seen');
    const items = [reply('r1', T0, { unread: true }), reply('r2', T0 + 1, { unread: true })];

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    send({ type: 'state', state: state(items, { status: status('st1'), unread: 3 }) });

    // Nothing counts while the window has no focus.
    vi.advanceTimersByTime(5_000);
    expect(seen()).toEqual([]);

    send({ type: 'focus', focused: true });
    vi.advanceTimersByTime(999);
    expect(seen()).toEqual([]);
    vi.advanceTimersByTime(1);
    // The reply in view; the reply scrolled above the timeline stays unread, and the status, on the Status tab, too.
    expect(seen()).toEqual([{ type: 'seen', ids: ['r2'], target: { scopeGen: 1, sessionId: 's2' } }]);

    // A redraw before the hub's answer does not report them again.
    send({ type: 'state', state: state(items, { status: status('st1'), unread: 3 }) });
    vi.advanceTimersByTime(5_000);
    expect(seen()).toHaveLength(1);

    // Less than half of r1 in view does not count; scrolled half in, it counts after a second in view, restarted when the focus leaves.
    boxes.set('r1', [-35, 25]);
    root.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(2_000);
    expect(seen()).toHaveLength(1);
    boxes.set('r1', [-30, 30]);
    root.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(600);
    send({ type: 'focus', focused: false });
    vi.advanceTimersByTime(2_000);
    expect(seen()).toHaveLength(1);
    send({ type: 'focus', focused: true });
    vi.advanceTimersByTime(1_000);
    expect(seen().at(-1)).toEqual({ type: 'seen', ids: ['r1'], target: { scopeGen: 1, sessionId: 's2' } });

    // The window's next session starts over: its own unread items are reported for it.
    send({ type: 'state', state: state([reply('r2', T0 + 1, { sessionId: 's5', unread: true })], { scope: { ...SCOPE, sessionId: 's5', scopeGen: 2 }, session: { ...SESSION, id: 's5' } }) });
    vi.advanceTimersByTime(1_000);
    expect(seen().at(-1)).toEqual({ type: 'seen', ids: ['r2'], target: { scopeGen: 2, sessionId: 's5' } });
    expect(seen()).toHaveLength(3);

    // One the hub did not take is reported again after another second in view.
    send({ type: 'seen-failed', ids: ['r2'] });
    vi.advanceTimersByTime(999);
    expect(seen()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(seen().at(-1)).toEqual({ type: 'seen', ids: ['r2'], target: { scopeGen: 2, sessionId: 's5' } });

    // So is one reported while the stream was down, once it is back.
    const s5 = (connected: boolean) => state([reply('r2', T0 + 1, { sessionId: 's5', unread: true })], { scope: { ...SCOPE, sessionId: 's5', scopeGen: 2 }, session: { ...SESSION, id: 's5' }, connected });

    send({ type: 'state', state: s5(false) });
    vi.advanceTimersByTime(2_000);
    expect(seen()).toHaveLength(4);
    send({ type: 'state', state: s5(true) });
    vi.advanceTimersByTime(1_000);
    expect(seen()).toHaveLength(5);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts the second over for an item hidden and shown again without a scroll, and checks when the Conversation tab is shown again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };
    let box: [number, number] = [20, 80];
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('scroll') ? rect(0, 100) : (this as HTMLElement).dataset['unread'] === 'r1' ? rect(...box) : rect(0, 0);
    });

    const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
    const seen = () => posted.filter((message) => message.type === 'seen');

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    send({ type: 'focus', focused: true });
    send({ type: 'state', state: state([reply('r1', T0, { unread: true })], { status: status('st1', { unread: false }) }) });

    // Hidden by a layout change between two checks, then shown again: the second starts over.
    vi.advanceTimersByTime(300);
    box = [200, 260];
    vi.advanceTimersByTime(300);
    box = [20, 80];
    vi.advanceTimersByTime(700);
    expect(seen()).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(seen()).toEqual([{ type: 'seen', ids: ['r1'], target: { scopeGen: 1, sessionId: 's2' } }]);

    // A reply that arrived while another tab was shown counts only once the Conversation tab shows it again.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="artifacts"]')!.click();
    send({ type: 'state', state: state([reply('r1', T0), reply('r2', T0 + 1, { unread: true })], { status: status('st1', { unread: false }) }) });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('scroll') ? rect(0, 100) : (this as HTMLElement).dataset['unread'] === 'r2' ? rect(...box) : rect(0, 0);
    });
    vi.advanceTimersByTime(5_000);
    expect(seen()).toHaveLength(1);
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    vi.advanceTimersByTime(1_000);
    expect(seen().at(-1)).toMatchObject({ ids: ['r2'] });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});

describe('speech in the view (architecture.md § Voice)', () => {
  const VOICE = { enabled: true, here: true, mic: 'off' as const, speaking: null, speakReplies: true, error: null, recognizer: null };
  const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: VOICE, settings: { expandReplies: false }, ...patch });

  function page() {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) }, host);

    const show = (next: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: next } }));

    return { root, host, posted, show };
  }

  it('shows a reply with a passage as the passage first, the whole reply behind Show more, and whole with voice.expandReplies', () => {
    const passage = reply('r1', T0, { opening: 'Fixed the **badge**.\n\n- one\n- two', speak: 'Fixed the **badge**.', tone: 'calm' });
    const { root, show } = page();

    show(state([passage, reply('r2', T0 + 1, { opening: 'Same.', speak: 'Same.' }), reply('r3', T0 + 2, { opening: 'Plain.' })]));

    const first = root.querySelector<HTMLElement>('li[data-id="r1"]')!;

    expect(first.querySelector('.body')!.innerHTML).toContain('<strong>badge</strong>');
    expect(first.querySelector('.body ul')).toBeNull();
    expect(first.querySelector('.tone')!.textContent).toBe('calm');
    expect(first.dataset['speak']).toBe('1');
    // A reply whose passage is all of it, and one with none, have no Show more.
    expect(root.querySelector('li[data-id="r2"] .show-more')).toBeNull();
    expect(root.querySelector('li[data-id="r3"] .show-more')).toBeNull();
    expect(root.querySelector<HTMLElement>('li[data-id="r3"]')!.dataset['speak']).toBeUndefined();

    // Enter on the focused reply flips it, as the button does.
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(root.querySelector('li[data-id="r1"] .body ul')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('li[data-id="r1"] .show-more')!.click();
    expect(root.querySelector('li[data-id="r1"] .body ul')).toBeNull();
    root.querySelector<HTMLButtonElement>('li[data-id="r1"] .show-more')!.click();
    expect(root.querySelector('li[data-id="r1"] .body ul')).not.toBeNull();
    expect(root.querySelector('li[data-id="r1"] .show-more')!.textContent).toBe('Show less');
    root.querySelector<HTMLButtonElement>('li[data-id="r1"] .show-more')!.click();
    expect(root.querySelector('li[data-id="r1"] .body ul')).toBeNull();

    const expanded = renderConversation(state([passage], { settings: { expandReplies: true } }));

    expect(expanded).toContain('<li>one</li>');
    expect(expanded).toContain('aria-expanded="true">Show less</button>');
  });

  it("says what became of a reply's speech, dimming the passage not heard yet", () => {
    const spoken = (state_: ReplyView['spoken']['state'], atMs: number | null = null, saidChars: number | null = null) =>
      renderConversation(state([reply('r1', T0, { opening: 'Fixed it. More.', speak: 'Fixed it.', spoken: { state: state_, atMs, saidChars } })]));

    expect(spoken('playing', 100, 3)).toContain('<p class="passage">Fix<span class="unheard">ed it.</span></p>');
    expect(spoken('playing', 100, 3)).toContain('<span>Speaking</span>');
    expect(spoken('interrupted', 7_400, 5)).toContain('<span>interrupted at 0:07</span>');
    expect(spoken('interrupted')).toContain('<span>interrupted</span>');
    expect(spoken('stopped-moved')).toContain('<span>stopped: voice moved</span>');
    expect(spoken('failed')).toContain('<span>not spoken: speech failed</span>');
    expect(spoken('played')).not.toContain('class="spoken');
    expect(spoken('queued')).not.toContain('class="spoken');
  });

  it('offers Speak replies and Stop as icon buttons, Talk here only while the voice is elsewhere, R to replay a reply and Escape to stop', () => {
    const { root, host, posted, show } = page();
    const controls = () => host.querySelector<HTMLElement>('.voice-controls')!;

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, enabled: false } }));
    expect(controls().innerHTML).toBe('');

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, here: false } }));
    // Talk here is the only text; Speak replies is a speaker toggle that says its state in its tooltip.
    expect(controls().textContent).toBe('Talk here');
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe('Speak replies: on. Click to stop speaking replies.');
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(controls().querySelector('[data-voice="speak-replies"] .codicon-unmute')).not.toBeNull();
    expect(controls().querySelector('.codicon-circle-slash')).toBeNull();
    // One mic control: the mic button, with a slash, whose tooltip says why.
    expect(host.querySelectorAll('[data-voice="mic"]')).toHaveLength(1);
    expect(host.querySelector('.mic-slot .mic-glyph.off')).not.toBeNull();
    controls().querySelector<HTMLButtonElement>('[data-voice="talk-here"]')!.click();
    controls().querySelector<HTMLButtonElement>('[data-voice="speak-replies"]')!.click();

    // A session the voice cannot speak for, such as an ended one, offers no Talk here, which the hub would refuse.
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended.' }, voice: { ...VOICE, here: false } }));
    expect(controls().querySelector('[data-voice="talk-here"]')).toBeNull();
    expect(controls().querySelector('[data-voice="speak-replies"]')).not.toBeNull();
    expect(host.querySelector('[data-voice="mic"]')).toBeNull();

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, speaking: 'r1', speakReplies: false } }));
    expect(controls().textContent).toBe('');
    expect(controls().querySelector('[data-voice="talk-here"]')).toBeNull();
    expect(controls().querySelector('[data-voice="stop"]')!.getAttribute('title')).toBe('Stop speaking (Escape)');
    expect(controls().querySelector('[data-voice="speak-replies"] .codicon-mute')).not.toBeNull();
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe('Speak replies: off. Click to speak replies.');
    controls().querySelector<HTMLButtonElement>('[data-voice="stop"]')!.click();
    controls().querySelector<HTMLButtonElement>('[data-voice="speak-replies"]')!.click();

    const item = root.querySelector<HTMLElement>('li[data-id="r1"]')!;

    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(posted.filter((message) => message.type !== 'ready' && message.type !== 'seen' && message.type !== 'composer')).toEqual([
      { type: 'talk-here' },
      { type: 'speak-replies', on: false },
      { type: 'stop-speaking' },
      { type: 'speak-replies', on: true },
      { type: 'replay', replyId: 'r1' },
      { type: 'stop-speaking' },
      { type: 'stop-speaking' },
    ]);
    // Capture's error is the mic button's tooltip, not text in the footer.
    expect(renderVoiceControls({ ...VOICE, mic: 'unavailable', error: 'no <device>' })).not.toContain('device');
  });

  it('marks a dictated message with the mic glyph, "partial" for a part sent while it was spoken, and its pieces in the tooltip', () => {
    const pieces = [
      { text: 'fix the', score: null, f0: null, dropped: false },
      { text: 'login', score: 0.82, f0: 118.4, dropped: true },
    ];
    const html = renderConversation(
      state([
        message('v1', T0, 'fix the login', { origin: 'voice', delivery: 'sent', pieces }),
        message('v2', T0 + 1, 'and the', { origin: 'voice', delivery: 'sent', partial: true }),
        message('t1', T0 + 2, 'typed', { origin: 'typed', delivery: 'sent' }),
      ]),
      new Set(),
    );

    expect(html).toContain('<div class="voice-line" title="Dictated in 2 pieces:\nfix the\n(dropped) login · match 0.82 · 118 Hz"><span class="codicon codicon-mic" aria-hidden="true"></span><span>dictated</span></div>');
    expect(html).toContain('<div class="voice-line" title="Dictated"><span class="codicon codicon-mic" aria-hidden="true"></span><span>partial</span></div>');
    expect(html.match(/voice-line/g)).toHaveLength(2);

    const over = renderConversation(
      state([
        message('v3', T0, 'hold on', { origin: 'voice', delivery: 'sent', interrupted: { replyId: 'r1', said: 'The session token', rest: 'is refreshed.' } }),
        message('v4', T0 + 1, 'stop', { origin: 'voice', delivery: 'sent', interrupted: { replyId: 'r2', said: '', rest: 'Done.' } }),
      ]),
      new Set(),
    );

    expect(over).toContain('<div class="voice-line" title="Dictated\nSpoke over the reply after &#34;The session token&#34;."><span class="codicon codicon-mic" aria-hidden="true"></span><span>dictated · interrupted the reply</span></div>');
    expect(over).toContain('title="Dictated\nSpoke over the reply before its first words."');
  });

  it('draws one mic button whose glyph and tooltip carry the mic state, and nothing with voice off (architecture.md § Dictation)', () => {
    const glyph = (voice: VoiceView): string => /<span class="mic-glyph ([a-z]+)">(.*)<\/span><\/button>$/.exec(renderMicButton(voice))!.slice(1).join(' ');

    expect(renderMicButton(null)).toBe('');
    expect(renderMicButton({ ...VOICE, enabled: false })).toBe('');
    // Off, after the idle timeout, unavailable and elsewhere: a mic with a slash, never a bare ban icon.
    expect(renderMicButton({ ...VOICE, here: false })).not.toContain('circle-slash');
    expect(glyph({ ...VOICE, here: false })).toMatch(/^off .*codicon-mic"/);
    expect(renderMicButton({ ...VOICE, here: false })).toContain('data-on="true"');
    expect(renderMicButton({ ...VOICE, here: false })).toContain('title="Mic off: the voice is not in this window. Click to talk here with the mic on."');
    expect(renderMicButton(VOICE)).toMatch(/class="mic off".*data-on="true".*aria-pressed="false"/);
    expect(glyph(VOICE)).toMatch(/^off /);
    expect(glyph({ ...VOICE, mic: 'idle-off' })).toMatch(/^off /);
    expect(renderMicButton({ ...VOICE, mic: 'idle-off' })).toContain('Mic off after a quiet spell.');
    expect(glyph({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toMatch(/^off /);
    // The mic is on but cannot run: the click turns it off, never only tries again.
    expect(renderMicButton({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toContain('Mic on but unavailable: No &#60;model&#62;. Click to turn the mic off.');
    expect(renderMicButton({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toContain('data-on="false"');
    // On and waiting: a plain mic; hearing: filled, pulsing by its class.
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).toMatch(/class="mic listening".*data-on="false".*aria-pressed="true"/);
    expect(glyph({ ...VOICE, mic: 'listening' })).toMatch(/^on .*codicon-mic"/);
    expect(renderMicButton({ ...VOICE, mic: 'hearing' })).toContain('class="mic hearing"');
    expect(glyph({ ...VOICE, mic: 'hearing' })).toMatch(/^filled .*codicon-mic-filled"/);
    expect(renderMicButton({ ...VOICE, mic: 'starting' })).toContain('class="mic starting"');
    // Typing and another app recording: a mic with a pause badge.
    expect(renderMicButton({ ...VOICE, mic: 'typing' })).toContain('Mic paused while you type');
    expect(renderMicButton({ ...VOICE, mic: 'typing' })).toContain('<span class="mic-glyph paused"><span class="codicon codicon-mic" aria-hidden="true"></span><span class="codicon codicon-debug-pause mic-badge"');
    expect(renderMicButton({ ...VOICE, mic: 'paused-other-app' })).toContain('Mic paused: another app is using the microphone.');
    expect(renderMicButton({ ...VOICE, mic: 'paused-other-app' })).toContain('class="mic paused"');
    // Half-duplex capture says why listening pauses while a reply plays, only while it listens or hears.
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).not.toContain('Listening pauses');
    const halfDuplex = { ...VOICE, halfDuplex: 'no echo cancellation on Remote Audio' };
    expect(renderMicButton({ ...halfDuplex, mic: 'listening' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, fullDuplex: 'echo check: none heard', mic: 'listening' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Full duplex (echo check: none heard): talking over a reply stops it. Click to turn the mic off."');
    expect(renderMicButton({ ...halfDuplex, mic: 'hearing' })).toContain('title="Mic on: hearing you. Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to turn the mic off."');
    // Where recognition runs, once the recogniser loaded.
    expect(renderMicButton({ ...VOICE, mic: 'listening', recognizer: 'gpu' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Speech recognition runs on the GPU. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, mic: 'hearing', recognizer: 'cpu' })).toContain('Speech recognition runs on the CPU.');
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).not.toContain('Speech recognition');
    // Paused by "stop listening": a pause badge, and a click listens again.
    expect(renderMicButton({ ...VOICE, mic: 'paused-by-voice' })).toContain('title="Mic paused: you said &#34;stop listening&#34;. Say &#34;start listening&#34;, or click to listen again."');
    expect(renderMicButton({ ...VOICE, mic: 'paused-by-voice' })).toMatch(/class="mic paused".*data-on="true"/);
    // A room hold says spoken turns stay in the box.
    expect(renderMicButton({ ...VOICE, mic: 'listening', roomHold: true })).toContain('title="Mic on: listening. Held: someone else is talking in the room, so dictation stays in the box until you press Enter. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, mic: 'hearing', roomHold: true })).toContain('title="Mic on: hearing you. Held: someone else is talking in the room, so dictation stays in the box until you press Enter. Click to turn the mic off."');
  });
});

describe('the composer', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });

  function page() {
    // Pages of earlier tests still listen on the window, and jsdom has no CSS.escape for the one that kept a focused item.
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, vscode, host);

    const input = host.querySelector('textarea')!;
    const show = (next: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: next } }));
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const sent = (id: number, error: string | null) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sent', id, error } }));

    return { host, input, posted, show, press, sent };
  }

  it('tells the hub its focus and draft, takes the hub\'s draft and live words, shows a refused turn\'s reason, and hands the box back to the voice on Enter (architecture.md § Dictation)', () => {
    vi.useFakeTimers();

    try {
      const { input, posted, show, press, sent, host } = page();
      const voice = { enabled: true, here: true, mic: 'listening' as const, speaking: null, speakReplies: true, error: null, recognizer: null };
      const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
      const composerPosts = () => posted.filter((message) => message.type === 'composer');

      show({ ...state(), voice });
      expect(host.querySelector('.mic-slot button.mic.listening')).not.toBeNull();
      // A state event with the same voice keeps the button under the pointer, so a click that straddles it still lands.
      const micButton = host.querySelector<HTMLButtonElement>('.mic-slot button')!;

      show({ ...state(), voice });
      expect(host.querySelector('.mic-slot button')).toBe(micButton);
      micButton.click();
      expect(posted.at(-1)).toEqual({ type: 'mic', on: false });
      // With capture unavailable, as with no recognition model, the click still turns the mic off.
      show({ ...state(), voice: { ...voice, mic: 'unavailable', error: 'No speech recognition model in m.' } });
      host.querySelector<HTMLButtonElement>('.mic-slot button')!.click();
      expect(posted.at(-1)).toEqual({ type: 'mic', on: false });
      show({ ...state(), voice });

      // The hub's draft fills the box; live words show dimmed under it.
      post({ type: 'draft', text: 'fix the login', workItemId: 2 });
      // Another conversation's draft waits for it.
      post({ type: 'draft', text: 'elsewhere', workItemId: 9 });
      expect(input.value).toBe('fix the login');
      expect(input.value).toBe('fix the login');
      post({ type: 'words', text: 'flow' });
      // Live words continue the draft's line: they follow a copy of its text in the layer under the box, after a space, not on a line of their own.
      expect(host.querySelector<HTMLElement>('.live-words')!.hidden).toBe(false);
      expect(host.querySelector('.live-words')!.textContent).toBe('flow');
      expect(host.querySelector('.live-mirror')!.contains(host.querySelector('.live-words'))).toBe(true);
      expect(host.querySelector('.composer-input')!.contains(input)).toBe(true);
      expect(host.querySelector('.mirror-text')!.textContent).toBe('fix the login');
      expect(host.querySelector<HTMLElement>('.live-words')!.dataset['lead']).toBe(' ');
      expect(host.classList.contains('live-showing')).toBe(true);
      // Live words that wrap past a full box pad its end by their height, so the box scrolls as far as its copy and they stay reachable.
      const mirror = host.querySelector<HTMLElement>('.live-mirror')!;

      Object.defineProperty(mirror, 'scrollHeight', { configurable: true, get: () => 260 });
      Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 230 + (input.style.paddingBottom === '' ? 0 : Number.parseInt(input.style.paddingBottom, 10) - 10) });
      post({ type: 'words', text: 'flow and the rest' });
      expect(input.style.paddingBottom).toBe('40px');
      expect(input.style.height).toBe('200px');
      delete (mirror as unknown as Record<string, unknown>)['scrollHeight'];
      delete (input as unknown as Record<string, unknown>)['scrollHeight'];
      post({ type: 'words', text: 'flow' });
      expect(input.style.paddingBottom).toBe('');

      // Settling: the draft takes the words and the live words clear, so they stay in place.
      post({ type: 'draft', text: 'fix the login flow', workItemId: 2 });
      post({ type: 'words', text: '' });
      expect(input.value).toBe('fix the login flow');
      expect(host.querySelector<HTMLElement>('.live-words')!.hidden).toBe(true);
      expect(host.querySelector('.mirror-text')!.textContent).toBe('');
      expect(host.classList.contains('live-showing')).toBe(false);
      post({ type: 'draft', text: 'fix the login', workItemId: 2 });
      post({ type: 'refused', error: 'The session has ended.', workItemId: 2 });
      expect(host.querySelector('.composer-error-text')!.textContent).toBe('The session has ended.');

      // Focus, edits after a pause, and leaving the box reach the hub.
      input.focus();
      expect(composerPosts().at(-1)).toEqual({ type: 'composer', focused: true, draft: 'fix the login' });
      input.value = 'fix the login flow';
      input.dispatchEvent(new Event('input'));
      const told = composerPosts().length;

      vi.advanceTimersByTime(299);
      expect(composerPosts()).toHaveLength(told);
      vi.advanceTimersByTime(1);
      expect(composerPosts().at(-1)).toEqual({ type: 'composer', focused: true, draft: 'fix the login flow' });

      // A recognition that settles after the operator corrected the box joins its end instead of replacing the correction.
      input.value = 'fix the sign-in flow';
      post({ type: 'draft', text: 'fix the login flow now', workItemId: 2 });
      expect(input.value).toBe('fix the sign-in flow now');
      expect(composerPosts().at(-1)).toEqual({ type: 'composer', focused: true, draft: 'fix the sign-in flow now' });

      // Enter sends and hands the box back: the focus leaves it, and the text being sent is no draft.
      expect(press('Enter')).toBe(true);
      expect(document.activeElement).not.toBe(input);
      expect(composerPosts().at(-1)).toEqual({ type: 'composer', focused: false, draft: '' });
      // Dictation that joins while the message is sent takes the box once the hub answered.
      post({ type: 'draft', text: 'and the tests', workItemId: 2 });
      expect(input.value).toBe('fix the sign-in flow now');
      sent(1, null);
      expect(input.value).toBe('and the tests');

      // With the mic off, Enter keeps the focus in the box.
      show({ ...state(), voice: { ...voice, mic: 'off' } });
      input.focus();
      press('Enter');
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the text on Enter, keeps it read-only until the hub took it, and empties the box then', () => {
    const { input, posted, show, press, sent, host } = page();

    show(state());
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('Message Fix the <inbox> badge…');

    input.value = 'Fix it\nplease';
    // Shift+Enter is a new line, left to the box.
    expect(press('Enter', { shiftKey: true })).toBe(false);
    expect(press('Enter', { isComposing: true })).toBe(false);
    expect(posted.filter((message) => message.type === 'send')).toEqual([]);
    expect(press('Enter')).toBe(true);
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Fix it\nplease', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
    expect(input.readOnly).toBe(true);
    expect(host.classList.contains('sending')).toBe(true);

    // A second Enter while the first is sent posts nothing.
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);

    // An answer for another send changes nothing.
    sent(7, null);
    expect(input.value).toBe('Fix it\nplease');
    sent(1, null);
    expect(input.value).toBe('');
    expect(input.readOnly).toBe(false);
    expect(host.classList.contains('sending')).toBe(false);

    // An empty box sends nothing.
    input.value = '   ';
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('draws the footer with a send button, enabled only while there is text the session can take, which sends as Enter does', () => {
    const { input, posted, show, sent, host } = page();
    const send = host.querySelector<HTMLButtonElement>('.composer > .composer-footer > button.send')!;
    const type = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };

    // The left side holds the attach and slash command buttons (test/composer.test.ts), and later slices' controls after them.
    expect([...host.querySelectorAll('.composer > .composer-input:has(> textarea) ~ .composer-footer > .composer-controls > button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Attach files', 'Show slash commands']);
    expect(send.querySelector('.codicon')?.className).toBe('codicon codicon-arrow-up');
    expect(send.getAttribute('aria-label')).toBe('Send');
    show(state());
    expect(send.disabled).toBe(true);
    type('  ');
    expect(send.disabled).toBe(true);
    type('Ship it');
    expect(send.disabled).toBe(false);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Ship it', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
    // Disabled while the hub has the message, and again once the box empties.
    expect(send.disabled).toBe(true);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
    sent(1, null);
    expect(send.disabled).toBe(true);

    // A session that cannot take messages disables it whatever the box holds.
    type('More');
    expect(send.disabled).toBe(false);
    show(state({ session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended.' } }));
    expect(send.disabled).toBe(true);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('names the work item in the placeholder without its leading tags, cut at a word', () => {
    expect(shortTitle('[Feedback] Event Time-slot no longer a Choice to select for UI')).toBe('Event Time-slot no longer a Choice to');
    expect(shortTitle('[Support][Bug]  Fix the badge')).toBe('Fix the badge');
    expect(shortTitle('[Only a tag]')).toBe('[Only a tag]');
    expect(shortTitle('A'.repeat(60))).toBe('A'.repeat(40));
  });

  it("keeps the text and shows the hub's refusal above the box until it is dismissed", () => {
    const { input, posted, show, press, sent, host } = page();

    show(state());
    input.value = 'Hello';
    press('Enter');
    sent(1, 'The session has ended. Open it in the terminal to resume it.');

    const error = host.querySelector<HTMLElement>('.composer-error')!;

    expect(error.nextElementSibling?.className).toBe('composer');
    expect(input.value).toBe('Hello');
    expect(input.readOnly).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('The session has ended. Open it in the terminal to resume it.');
    input.dispatchEvent(new Event('input'));
    expect(error.hidden).toBe(false);
    error.querySelector<HTMLButtonElement>('button.dismiss')!.click();
    expect(error.hidden).toBe(true);
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('puts the text of a message that was not sent back in the box, below a draft after a blank line, with why above it', () => {
    const { input, show, press, sent, host } = page();
    const unsent = (text: string, error: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'unsent', returned: [{ text, error }] } }));
    const error = host.querySelector<HTMLElement>('.composer-error')!;

    show(state());
    unsent('First', 'The terminal holder did not answer.');
    expect(input.value).toBe('First');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('The terminal holder did not answer.');

    input.value = 'A draft\n';
    unsent('Second', 'The session has ended. Open it in the terminal to resume it.');
    expect(input.value).toBe('A draft\n\nSecond');
    expect(error.textContent).toBe('The session has ended. Open it in the terminal to resume it.');

    // While another message is being sent, the text comes back once the hub answered it.
    input.value = 'Third';
    press('Enter');
    unsent('Fourth', 'A newer session of this work item started; the message was not sent.');
    expect(input.value).toBe('Third');
    sent(1, null);
    expect(input.value).toBe('Fourth');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('A newer session of this work item started; the message was not sent.');
  });

  it('is disabled with the reason for a session the view cannot talk to, and hidden in a window with no work item', () => {
    const { input, posted, show, press, host } = page();

    show(state({ session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' } }));
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('The session has ended. Open it in the terminal to resume it.');
    input.value = 'Hello';
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toEqual([]);

    show(state({ session: null }));
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('No session has started yet.');

    show(state({ connected: false }));
    expect(input.disabled).toBe(true);

    show({ ...EMPTY_CONVERSATION, connected: true });
    expect(host.hidden).toBe(true);
  });

  it('keeps a draft when the window moves to a newer session, and sends it to the session the page then shows', () => {
    const { input, posted, show, press } = page();

    show(state());
    input.value = 'Half written';
    show(state({ scope: { ...SCOPE, scopeGen: 2, sessionId: 's9' }, session: { ...SESSION, id: 's9', launch: 'l9' } }));
    expect(input.value).toBe('Half written');
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Half written', target: { scopeGen: 2, sessionId: 's9', launch: 'l9' } }]);
  });

  it('never takes the focus from the composer when a redraw puts it back on the timeline item it was on', () => {
    const { input, show } = page();
    const items = [reply('r1', T0), reply('r2', T0 + 1)];

    show(state({ items }));

    const list = document.querySelector<HTMLElement>('.timeline')!;

    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    show(state({ items }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    input.focus();
    show(state({ items: [...items, reply('r3', T0 + 2)] }));
    expect(document.activeElement).toBe(input);
  });

  it("draws a typed message's error state before its time over its box, with why in the tooltip, never sending or sent, and none for a terminal message", () => {
    const root = document.createElement('div');
    const minute = (n: number) => T0 + n * 60_000;
    const at = (item: ItemView, when: number): ItemView => ({ ...item, at: when, ord: when });

    root.innerHTML = renderConversation(
      state({
        items: [
          message('m0', minute(0), 'from the terminal'),
          at(typed('m1', 'open'), minute(1)),
          at(typed('m2', 'sent'), minute(2)),
          at(typed('m3', 'not-sent', 'The session has <ended>.'), minute(3)),
          // The same minute as m3: no time, so one sent or sending shows no line, and one in error shows its state alone.
          at(typed('m4', 'sent'), minute(3)),
          at(typed('m5', 'open'), minute(3)),
          at(typed('m6', 'not-sent', 'The session has ended.'), minute(3)),
        ],
      }),
    );

    const line = (id: string) => root.querySelector(`li[data-id="${id}"] > .stamp-line`);
    const delivery = (id: string) => line(id)?.querySelector('.delivery') ?? null;

    expect(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => delivery(id)?.textContent ?? null)).toEqual([null, null, null, 'not sent', null, null, 'not sent']);
    expect([...line('m1')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect([...line('m2')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect(delivery('m3')?.getAttribute('title')).toBe('not sent · The session has <ended>.');
    expect(line('m3')?.textContent).toMatch(/^not sent•\d+:\d\d [AP]M$/);
    expect(line('m4')).toBeNull();
    expect(line('m5')).toBeNull();
    expect([...line('m6')!.children].map((child) => child.className)).toEqual(['delivery not-sent']);
    // Nothing under a bubble.
    expect([...root.querySelectorAll('.message')].map((li) => li.lastElementChild?.className)).toEqual(['box', 'box', 'box', 'box', 'box', 'box', 'box']);
  });
});

describe('reply links and the secondary side bar', () => {
  it('opens web pages, and files at their line relative to the session folder, and drops other schemes', () => {
    expect(linkTarget('https://github.com/o/r/pull/1', 'D:/w')).toEqual({ url: 'https://github.com/o/r/pull/1' });
    expect(linkTarget('./src/a.ts#L42', 'D:/w')).toMatchObject({ line: 42 });
    expect((linkTarget('./src/a.ts#L42', 'D:/w') as { file: string }).file.replaceAll('\\', '/')).toBe('D:/w/src/a.ts');
    expect(linkTarget('src/b.ts#L4-L9', 'D:/w')).toMatchObject({ line: 4 });
    expect(linkTarget('D:/x/c.ts', null)).toEqual({ file: 'D:/x/c.ts', line: null });
    expect(linkTarget('src/d.ts', null)).toBeNull();
    expect(linkTarget('javascript:alert(1)', 'D:/w')).toBeNull();
    expect(linkTarget('mailto:x@y.z', 'D:/w')).toBeNull();
  });

  it('opens a file: URL, a drive-letter path and a path with spaces at their line', () => {
    expect(linkTarget('file:///D:/git/widgets/Views/Index.cshtml', 'D:/w')).toEqual({ file: 'D:/git/widgets/Views/Index.cshtml', line: null });
    expect(linkTarget('file:///D:/a%20b/c.ts#L3', null)).toEqual({ file: 'D:/a b/c.ts', line: 3 });
    expect(linkTarget('file://localhost/D:/c.ts#L7-L9', null)).toEqual({ file: 'D:/c.ts', line: 7 });
    expect(linkTarget('file:///D%3A/c.ts', null)).toEqual({ file: 'D:/c.ts', line: null });
    expect(linkTarget('D:/a%20b/c.ts#L5', null)).toEqual({ file: 'D:/a b/c.ts', line: 5 });
    expect((linkTarget('./my%20dir/a.ts#L2', 'D:/w') as { file: string }).file.replaceAll('\\', '/')).toBe('D:/w/my dir/a.ts');
    expect(linkTarget('D:/x/100%25%23.ts#L1', null)).toEqual({ file: 'D:/x/100%#.ts', line: 1 });
    expect(linkTarget('D:/x/50%.ts', null)).toEqual({ file: 'D:/x/50%.ts', line: null });
    expect(linkTarget('file:javascript:alert(1)', 'D:/w')).toBeNull();
  });

  it('puts the view in the secondary side bar from VS Code 1.106', () => {
    expect(supportsSecondarySidebar('1.146.0')).toBe(true);
    expect(supportsSecondarySidebar('1.106.0')).toBe(true);
    expect(supportsSecondarySidebar('1.105.1')).toBe(false);
    expect(supportsSecondarySidebar('2.0.0')).toBe(true);
  });
});

describe('the Status tab', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });
  const status = (id: string, markdown: string, patch: Partial<StatusView> = {}): StatusView => ({ id, sessionId: 's2', at: T0, markdown, fallback: false, unread: false, ...patch });

  it("takes the hello's status and each status of the window's session or work item, and drops another session's", () => {
    let current = applyEvent(EMPTY_CONVERSATION, hello([], { status: status('stage-2', 'Reading', { fallback: true }) }));

    expect(current.status?.markdown).toBe('Reading');
    current = applyEvent(current, { type: 'status', status: status('st-1', 'Done.') });
    expect(current.status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('st-9', 'Theirs.', { sessionId: 's3' }) }).status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('stage-3', 'Theirs.', { sessionId: null, fallback: true }) }).status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('stage-2', 'Stage.', { sessionId: null, fallback: true }) }).status?.id).toBe('stage-2');
    expect(applyEvent(current, { type: 'status', status: null }).status).toBeNull();
    expect(applyEvent(current, hello()).status).toBeNull();
    // A scope event that moves the window drops the row until the next hello; one that keeps it keeps the row.
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, workItemId: 3, sessionId: 's3' } }).status).toBeNull();
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, sessionId: 's9' } }).status).toBeNull();
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, title: 'Renamed' } }).status?.id).toBe('st-1');
  });

  it("points a status's relative and absolute file links at files for the Markdown preview, and leaves web links, anchors and code alone", () => {
    const cwd = process.platform === 'win32' ? 'D:\\w' : '/w';
    const url = (path: string) => pathToFileURL(join(cwd, path)).href;
    const out = previewLinks('See [a](./src/a.ts#L42), [b](<src/b c.ts>), [web](https://x.test/a) and [top](#x).\n```\n[c](c.ts)\n```\n[d](d.ts)', cwd);

    expect(out.split('\n')[0]).toBe(`See [a](${url('src/a.ts')}#L42), [b](${url('src/b c.ts')}), [web](https://x.test/a) and [top](#x).`);
    expect(out.split('\n')[4]).toBe(`[d](${url('d.ts')})`);
    expect(out.split('\n').slice(1, 4)).toEqual(['```', '[c](c.ts)', '```']);
    // With no folder, a relative link stays as written.
    expect(previewLinks('[a](a.ts)', null)).toBe('[a](a.ts)');
  });


  it('leaves a reply that is only a status out of the timeline', () => {
    expect(timeline([reply('r1', T0, { opening: '' }), reply('r2', T0 + 1)]).map((entry) => idOf(entry))).toEqual(['r2']);
  });

  it('says how long ago a status came, and gives its first line without Markdown marks', () => {
    expect(ago(T0, T0 + 59_000)).toBe('just now');
    expect(ago(T0, T0 + 4 * 60_000)).toBe('4 min ago');
    expect(ago(T0, T0 + 3 * 3_600_000)).toBe('3 h ago');
    expect(ago(T0, T0 + 50 * 3_600_000)).toBe('2 d ago');
    expect(statusLine('\n## **Where** it stands\n- x')).toBe('Where it stands');
    expect(statusLine('- 1. `a.ts` fixed')).toBe('a.ts fixed');
  });

  it('draws the status on the Status tab under its time, how long ago and the tools to open it, escaped, and the stage or a line before it', () => {
    const at = T0 + 4 * 60_000;
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state({ status: status('st-1', '## Done <img src=x onerror=alert(1)>\n\n| a |\n|---|\n| 1 |') }), new Set(), at, false, on('status'));
    expect([...root.children].map((child) => child.className)).toEqual(['header', 'tabs', 'panel']);
    expect(root.querySelector('.status-head .codicon-pulse')).not.toBeNull();
    expect(root.querySelector('.status-time')?.textContent).toBe(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(T0));
    expect(root.querySelector('.status-age')?.textContent).toBe('4 min ago');
    expect(root.querySelector('.status-body h2')?.textContent).toBe('Done <img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.status-body table')).not.toBeNull();
    expect(root.querySelector('[data-action="status-open"]')).not.toBeNull();
    expect(root.querySelector('[data-action="statuses"]')).not.toBeNull();
    expect(root.querySelector('.status-new')).toBeNull();
    expect(root.querySelector('.timeline')).toBeNull();

    root.innerHTML = renderConversation(state({ status: status('st-1', 'x') }), new Set(), T0, true, on('status'));
    expect(root.querySelector('.status-new')?.textContent).toBe('New');
    expect(root.querySelector('[data-tab="status"] .tab-badge')?.textContent).toBe('New');

    // Not on the Conversation tab any more.
    root.innerHTML = renderConversation(state({ status: status('st-1', 'x') }), new Set(), T0, true);
    expect(root.querySelector('.status-tab')).toBeNull();
    expect(root.querySelector('[data-tab="status"] .tab-badge')?.textContent).toBe('New');

    // The stage stands in, dimmed, with nothing to open; with neither, a line says so.
    root.innerHTML = renderConversation(state({ status: status('stage-2', 'Reading the inbox code', { fallback: true }) }), new Set(), T0, false, on('status'));
    expect(root.querySelector('.status-tab.fallback .status-body')?.textContent).toBe('Reading the inbox code\n');
    expect(root.querySelector('.status-tab.fallback .empty')?.textContent).toContain('no status yet');
    expect(root.querySelector('[data-action="status-open"]')).toBeNull();
    root.innerHTML = renderConversation(state(), new Set(), T0, false, on('status'));
    expect(root.querySelector('.panel > .empty')?.textContent).toBe('The session has posted no status yet. Ask it for one, and its latest shows here.');
  });

  it('marks a status that replaced the one before as New for a minute once the Status tab shows it or until it is opened, redraws its age, and posts its tools', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };
    const show = (patch: Partial<ConversationState>) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state(patch) } }));
    const badge = () => root.querySelector('[data-tab="status"] .tab-badge')?.textContent ?? null;

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show({ status: status('stage-2', 'Reading', { fallback: true }) });
    expect(badge()).toBeNull();

    // The first status after the stage, and each that replaces it, is New; on another tab it stays New, however long.
    show({ status: status('st-1', 'First.') });
    expect(badge()).toBe('New');
    expect(live.textContent).toBe('New status: First.');
    vi.advanceTimersByTime(5 * STATUS_NEW_MS);
    expect(badge()).toBe('New');

    // Shown on the Status tab, it is New for a minute.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(root.querySelector('.status-new')).not.toBeNull();
    expect(root.querySelector('.status-age')?.textContent).toBe('5 min ago');
    vi.advanceTimersByTime(STATUS_NEW_MS - 1);
    expect(root.querySelector('.status-new')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(root.querySelector('.status-new')).toBeNull();
    expect(badge()).toBeNull();
    vi.advanceTimersByTime(3 * 60_000);
    expect(root.querySelector('.status-age')?.textContent).toBe('9 min ago');

    // An unread status keeps the badge after its New mark.
    show({ status: status('st-1', 'First.', { unread: true }) });
    expect(root.querySelector('.status-new')).toBeNull();
    expect(badge()).toBe('New');

    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-new')).not.toBeNull();
    // A redraw with the same status keeps the mark; opening it in the preview clears it.
    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-new')).not.toBeNull();
    root.querySelector<HTMLElement>('[data-action="status-open"]')!.click();
    expect(root.querySelector('.status-new')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(posted.filter((message) => message.type.startsWith('status'))).toEqual([{ type: 'status-open' }, { type: 'statuses' }]);

    // Another session's first status is not New.
    show({ scope: { ...SCOPE, sessionId: 's5' }, session: { ...SESSION, id: 's5' }, status: status('st-5', 'Other.', { sessionId: 's5' }) });
    expect(root.querySelector('.status-new')).toBeNull();
    vi.useRealTimers();
  });

  it('starts the minute of a status that became New while the page was hidden once the page is shown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    let hidden = false;
    const vscode = { postMessage: () => undefined, getState: () => ({ open: [], scroll: null, tab: 'status' }), setState: () => undefined };
    const show = (markdown: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state({ status: status('st-1', markdown) }) } }));

    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'));
    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show('First.');
    hidden = true;
    show('First, updated.');
    vi.advanceTimersByTime(5 * STATUS_NEW_MS);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.querySelector('.status-new')).not.toBeNull();
    vi.advanceTimersByTime(STATUS_NEW_MS);
    expect(root.querySelector('.status-new')).toBeNull();
    expect(root.querySelector('.status-tab')?.getAttribute('role')).toBe('region');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports the status seen once the Status tab showed it in a focused window for a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) };
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    send({ type: 'focus', focused: true });
    send({ type: 'state', state: state({ status: status('st-1', 'Done.', { unread: true }) }) });
    vi.advanceTimersByTime(5_000);
    expect(posted.filter((message) => message.type === 'seen')).toEqual([]);
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    vi.advanceTimersByTime(1_000);
    expect(posted.filter((message) => message.type === 'seen')).toEqual([{ type: 'seen', ids: ['st-1'], target: { scopeGen: 1, sessionId: 's2' } }]);
    vi.useRealTimers();
  });
});

describe('the tab strip', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [reply('r1', T0)], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });

  it('draws Conversation, Status and Artifacts under the header as tabs, the selected one alone in the panel, and none for a window with no work item', () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state(), new Set(), T0);

    const tabs = [...root.querySelectorAll<HTMLElement>('.tabs[role="tablist"] > [role="tab"]')];

    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected'), tab.tabIndex])).toEqual([
      ['Conversation', 'true', 0],
      ['Status', 'false', -1],
      ['Artifacts', 'false', -1],
    ]);
    expect(root.querySelector('[role="tabpanel"]')?.className).toBe('scroll');
    expect(root.querySelector('.timeline')).not.toBeNull();

    root.innerHTML = renderConversation(state(), new Set(), T0, false, on('artifacts'));
    expect(root.querySelector('[role="tab"].selected')?.textContent).toBe('Artifacts');
    expect(root.querySelector('.timeline')).toBeNull();
    expect(root.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe('tab-artifacts');

    expect(renderConversation({ ...state(), scope: null }, new Set(), T0)).not.toContain('tablist');
  });

  it('switches tabs by click and by the arrow, Home and End keys, keeps the tab and the scroll position, and shows the composer only on the Conversation tab', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    let saved: unknown = { open: [], scroll: null, tab: 'status' };
    const vscode = { postMessage: () => undefined, getState: () => saved, setState: (next: unknown) => (saved = next) };
    const selected = () => root.querySelector('[role="tab"].selected')?.getAttribute('data-tab');

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state() } }));
    // A reloaded page shows the tab it showed before.
    expect(selected()).toBe('status');
    expect(document.body.dataset['tab']).toBe('status');

    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    expect(selected()).toBe('conversation');
    expect(document.body.dataset['tab']).toBe('conversation');
    expect(saved).toMatchObject({ tab: 'conversation' });

    const key = (name: string) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

    expect(document.activeElement?.getAttribute('data-tab')).toBe('conversation');
    key('ArrowRight');
    expect(selected()).toBe('status');
    key('End');
    expect(selected()).toBe('artifacts');
    key('ArrowRight');
    expect(selected()).toBe('artifacts');
    key('Home');
    expect(selected()).toBe('conversation');
    key('ArrowLeft');
    expect(selected()).toBe('conversation');

    // The conversation's scroll position comes back with its tab.
    const scroller = root.querySelector<HTMLElement>('.scroll')!;

    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event('scroll'));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="artifacts"]')!.click();
    expect(saved).toMatchObject({ tab: 'artifacts', scroll: 300 });
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    expect(root.querySelector<HTMLElement>('.scroll')!.scrollTop).toBe(300);
  });

  it('keeps the focused tab or button, the Status and Artifacts scroll position and the New messages pill over redraws and tab changes', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    let saved: unknown = null;
    const vscode = { postMessage: () => undefined, getState: () => saved, setState: (next: unknown) => (saved = next) };
    const send = (shown: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: shown } }));
    const tall = (element: HTMLElement) => {
      Object.defineProperty(element, 'scrollHeight', { value: 1_000, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: 100, configurable: true });
    };
    const withStatus = state({ status: { id: 'st-1', sessionId: 's2', at: T0, markdown: 'Long.', fallback: false, unread: false } });

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    send(withStatus);

    // The keys keep working after a state arrives while a tab has the focus.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(document.activeElement?.getAttribute('data-tab')).toBe('status');
    send(withStatus);
    expect(document.activeElement?.getAttribute('data-tab')).toBe('status');

    // So does a focused button on the tab, and the tab's scroll position.
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.focus();
    root.querySelector<HTMLElement>('.panel')!.scrollTop = 250;
    send(withStatus);
    expect(document.activeElement?.getAttribute('data-action')).toBe('statuses');
    expect(root.querySelector<HTMLElement>('.panel')!.scrollTop).toBe(250);
    // Another tab starts at its top.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="artifacts"]')!.click();
    expect(root.querySelector<HTMLElement>('.panel')!.scrollTop).toBe(0);

    // A reply that comes while another tab is shown and the conversation is scrolled up brings the pill back with it.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    tall(root.querySelector<HTMLElement>('.scroll')!);
    root.querySelector<HTMLElement>('.scroll')!.scrollTop = 300;
    root.querySelector<HTMLElement>('.scroll')!.dispatchEvent(new Event('scroll'));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    send(state({ items: [reply('r1', T0), reply('r2', T0 + 1)] }));
    const scroller = root.querySelector<HTMLElement>('.scroll');

    expect(scroller).toBeNull();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    expect(root.querySelector<HTMLElement>('.scroll')!.scrollTop).toBe(300);
    expect(root.querySelector('.pill')?.textContent).toBe('New messages');
    vi.restoreAllMocks();
  });
});

describe('several conversations in a window (architecture.md § Conversation view)', () => {
  const HOSTED = { workItemId: 9, title: 'New session', primary: false, sessionId: 's9', state: 'idle' as const, conversation: 'full' as const, unread: 2 };
  const TWO: ScopeView = { ...SCOPE, conversations: [SCOPE.conversations[0]!, HOSTED] };
  const base = (patch: Partial<ConversationState> = {}): ConversationState => ({ ...EMPTY_CONVERSATION, scope: TWO, session: SESSION, connected: true, ...patch });

  it('keeps each conversation unread count, badges their sum, and takes the dropdown from conversations events', () => {
    let state = base({ unread: 1 });

    expect(totalUnread(state)).toBe(3);
    state = applyEvent(state, { type: 'unread', workItemId: 9, count: 5 });
    expect(state.unread).toBe(1);
    expect(state.scope?.conversations.map((entry) => entry.unread)).toEqual([0, 5]);
    expect(totalUnread(state)).toBe(6);
    state = applyEvent(state, { type: 'conversations', conversations: [SCOPE.conversations[0]!, { ...HOSTED, title: 'Why does the build fail?', unread: 0 }] });
    expect(selectedEntry(state)?.workItemId).toBe(2);
    expect(state.scope?.conversations[1]).toMatchObject({ title: 'Why does the build fail?', unread: 0 });
    expect(totalUnread(state)).toBe(1);
    expect(applyEvent(EMPTY_CONVERSATION, { type: 'conversations', conversations: [HOSTED] })).toBe(EMPTY_CONVERSATION);
  });

  it('draws the selected title as a dropdown that lists every conversation with its state and unread count, and a plus button', () => {
    const closed = renderConversation(base(), new Set(), T0);

    expect(closed).toContain('data-action="new"');
    expect(closed).toContain('class="picker" data-action="picker" aria-haspopup="listbox" aria-expanded="false" title="Fix the &#60;inbox&#62; badge"');
    expect(closed).not.toContain('role="listbox"');

    const opened = renderConversation(base({ scope: { ...TWO, workItemId: 9, sessionId: 's9' } }), new Set([PICKER]), T0);

    expect(opened).toContain('aria-expanded="true" title="New session"');
    expect(opened.match(/role="option"/g)).toHaveLength(2);
    expect(opened).toContain('<li role="option" aria-selected="true"><button type="button" data-action="select" data-work-item="9" class="selected">');
    expect(opened).toContain('<span class="count" title="2 unread">2</span>');
    expect(opened).toContain('codicon-check');

    // Each option shows its session's provider mark after its title; an entry with no provider shows none.
    const marked = renderConversation(base({ scope: { ...TWO, conversations: [{ ...SCOPE.conversations[0]!, provider: 'claude' }, { ...HOSTED, provider: 'codex' }] } }), new Set([PICKER]), T0);
    const list = document.createElement('div');

    list.innerHTML = marked;
    expect([...list.querySelectorAll('.conversation-list button')].map((button) => [...button.children].map((child) => child.getAttribute('aria-label') ?? child.className))).toEqual([
      ['Working', 'title', 'Claude'],
      [expect.any(String), 'title', 'Codex', 'count'],
    ]);
    list.innerHTML = opened;
    expect(list.querySelector('.conversation-list .provider')).toBeNull();
  });

  it('draws a folder window with no conversation as its folder name, the plus and a note, with no composer', () => {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const empty = base({ scope: { ...SCOPE, kind: 'folder', title: 'support<3>', workItemId: null, sessionId: null, cwd: null, conversations: [] }, session: null });
    const html = renderConversation(empty, new Set(), T0);

    expect(html).toContain('<span class="title" title="support&#60;3&#62;">support&#60;3&#62;</span>');
    expect(html).toContain('data-action="new"');
    expect(html).toContain('No Switchboard session in this folder yet.');
    expect(html).not.toContain('data-action="picker"');
    expect(html).not.toContain('data-action="terminal"');

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string }> = [];

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: { type: string }) => posted.push(message), getState: () => null, setState: () => {} }, host);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: empty } }));
    expect(host.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('button[data-action="new"]')!.click();
    expect(posted.filter((message) => message.type === 'new')).toEqual([{ type: 'new' }]);

    // Once it has a conversation, the composer comes back.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: base({ scope: { ...TWO, kind: 'folder' } }) } }));
    expect(host.hidden).toBe(false);
  });

  it('posts a choice from the list and the plus, and keeps a draft and a late refusal for each conversation', () => {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) }, host);

    const input = host.querySelector('textarea')!;
    const error = host.querySelector<HTMLElement>('.composer-error')!;
    const show = (next: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: next } }));
    const unsent = (text: string, why: string, workItemId: number) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'unsent', returned: [{ text, error: why, workItemId }] } }));
    const hosted = base({ scope: { ...TWO, workItemId: 9, sessionId: 's9', scopeGen: 2 }, session: { ...SESSION, id: 's9' } });

    show(base());
    root.querySelector<HTMLButtonElement>('button.picker')!.click();
    root.querySelector<HTMLButtonElement>('button[data-work-item="9"]')!.click();
    expect(posted.filter((message) => message.type === 'select')).toEqual([{ type: 'select', workItemId: 9 }]);
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('button[data-action="new"]')!.click();
    expect(posted.filter((message) => message.type === 'new')).toEqual([{ type: 'new' }]);

    // A draft stays with its conversation.
    input.value = 'Draft for the work item';
    show(hosted);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Message New session…');
    input.value = 'Draft for the new session';

    // A message of the work item's conversation that was not sent goes back to that draft only.
    unsent('Sent from the work item', 'The session has ended.', 2);
    expect(input.value).toBe('Draft for the new session');
    expect(error.hidden).toBe(true);

    show(base());
    expect(input.value).toBe('Draft for the work item\n\nSent from the work item');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('The session has ended.');
    show(hosted);
    expect(input.value).toBe('Draft for the new session');
    expect(error.hidden).toBe(true);
  });

  it('keeps a message being sent with its own conversation, and a refusal that comes back meanwhile out of the other one', () => {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    let kept: unknown = null;

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: { type: string }) => posted.push(message), getState: () => kept, setState: (next: unknown) => void (kept = next) }, host);

    const input = host.querySelector('textarea')!;
    const show = (next: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: next } }));
    const sent = (id: number, error: string | null) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sent', id, error } }));
    const unsent = (text: string, why: string, workItemId: number) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'unsent', returned: [{ text, error: why, workItemId }] } }));
    const hosted = base({ scope: { ...TWO, workItemId: 9, sessionId: 's9', scopeGen: 2 }, session: { ...SESSION, id: 's9' } });

    show(base());
    input.value = 'Second';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);

    // An earlier message of this conversation was not sent while the second one is being sent; then the operator switches away.
    unsent('First', 'The session has ended.', 2);
    show(hosted);
    expect(input.value).toBe('');
    expect(input.readOnly).toBe(false);
    sent(1, null);
    expect(input.value).toBe('');

    // Back in the work item's conversation: the sent text is gone and the earlier one is back in its draft.
    show(base());
    expect(input.value).toBe('First');
    expect(input.readOnly).toBe(false);

    // While a message is being sent, its conversation's box stays read-only when the operator comes back to it.
    input.value = 'Third';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    show(hosted);
    show(base());
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('Third');
    sent(2, null);
    expect(input.value).toBe('');

    // A refusal of an earlier message that comes while a later one of its conversation is being sent, elsewhere, goes back alone.
    input.value = 'Fourth';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    show(hosted);
    unsent('Third', 'The session was resumed.', 2);
    sent(3, null);
    show(base());
    expect(input.value).toBe('Third');
    expect(input.readOnly).toBe(false);

    // And one that comes before its conversation is visited again is not lost.
    input.value = 'Fifth';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    show(hosted);
    unsent('Fourth', 'The session has ended.', 2);
    show(base());
    expect(input.value).toBe('Fifth');
    sent(4, null);
    expect(input.value).toBe('Fourth');
  });
});

describe('redraws and following the end (architecture.md § Conversation view)', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ ...applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)])), ...patch });
  const send = (shown: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: shown } }));
  const sized = (element: HTMLElement, height: number) => {
    Object.defineProperty(element, 'scrollHeight', { value: height, configurable: true });
    Object.defineProperty(element, 'clientHeight', { value: 100, configurable: true });
  };

  it('keeps the nodes a state does not change, with the focus on a reply\'s button and the conversation\'s own scroller', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: () => undefined, getState: () => null, setState: () => undefined });
    send(state());

    const scroller = root.querySelector('.scroll');
    const copy = root.querySelector<HTMLElement>('li[data-id="r1"] [data-action="copy-reply"]')!;

    copy.focus();
    send(state({ items: [reply('r1', T0), reply('r2', T0 + 60_000)] }));
    expect(root.querySelector('.scroll')).toBe(scroller);
    expect(root.querySelector('li[data-id="r1"] [data-action="copy-reply"]')).toBe(copy);
    expect(document.activeElement).toBe(copy);
    expect(root.querySelectorAll('.timeline > li')).toHaveLength(2);
    // Another conversation gets a scroller of its own.
    send(applyEvent(EMPTY_CONVERSATION, hello([reply('r9', T0)], { scope: { ...SCOPE, scopeGen: 2 } })));
    expect(root.querySelector('.scroll')).not.toBe(scroller);
  });

  it('follows the end from the first state on, through items and size changes, until the operator scrolls away, and then shows the pill above the composer', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: () => undefined, getState: () => null, setState: () => undefined });
    send(state());

    const scroller = root.querySelector<HTMLElement>('.scroll')!;

    // The composer or a banner grew after the first draw, so the end moved 95 px down with no scroll by the operator: the next state follows it.
    sized(scroller, 195);
    send(state({ items: [reply('r1', T0), reply('r2', T0 + 1)] }));
    expect(scroller.scrollTop).toBe(195);
    // The page's own scroll event never stops the following, even when it comes after more items.
    sized(scroller, 400);
    scroller.dispatchEvent(new Event('scroll'));
    send(state({ items: [reply('r1', T0), reply('r2', T0 + 1), reply('r3', T0 + 2)] }));
    expect(scroller.scrollTop).toBe(400);
    expect(root.querySelector<HTMLElement>('.pill')!.hidden).toBe(true);

    // Scrolled up by the operator: new items stay below, and the pill, inside the conversation's area over the composer, takes them to the end.
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('scroll'));
    sized(scroller, 600);
    send(state({ items: [reply('r1', T0), reply('r2', T0 + 1), reply('r3', T0 + 2), reply('r4', T0 + 3)] }));
    expect(scroller.scrollTop).toBe(100);

    const pill = root.querySelector<HTMLElement>('.pill')!;

    expect(pill.hidden).toBe(false);
    expect(pill.parentElement?.classList.contains('scroll-area')).toBe(true);
    pill.click();
    expect(scroller.scrollTop).toBe(600);
    expect(pill.hidden).toBe(true);
    // Following again.
    sized(scroller, 900);
    send(state({ items: [reply('r1', T0), reply('r5', T0 + 4)] }));
    expect(scroller.scrollTop).toBe(900);
  });
});
