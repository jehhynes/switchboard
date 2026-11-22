import { readFileSync } from 'node:fs';
import { DEVICE_OFF_TIP, MIC_START_TIMEOUT, MIC_STARTING_TIP, MicStart, REPLAY_TIP, SPEAKING_TIP } from '@switchboard/conversation/voiceControls';
import type { ArtifactView, ItemView, MessageView, ReplyView, SessionView, StatusView, ScopeView, VoiceView } from '@switchboard/hub';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY_CONVERSATION, isWorking, lastSpokenReply, limitText, micOn, selectedEntry, stateIcon, statusLine, timeline, totalUnread, voiceStatus, withEarlier } from '../src/conversationModel.js';
import type { ConversationState, Entry } from '../src/conversationModel.js';
import { linkTarget, previewLinks, supportsSecondarySidebar } from '../src/links.js';
import { SENT_NOTE_MS, startConversation, STATUS_NEW_MS } from '../src/webview/conversationMain.js';
import { ago, linkAllowed, personaButton, PICKER, renderConversation, renderMarkdown, renderMicButton, renderVoiceControls, withoutQuestions } from '../src/webview/conversationRender.js';
import type { Tab } from '../src/webview/conversationRender.js';

/** The page's extras for a tab. */
const on = (tab: Tab, unopened: string[] = []) => ({ tab, unopened: new Set(unopened) });

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: ScopeView = { kind: 'item', workItemId: 2, key: 'k1', folder: 'D:/w', title: 'Fix the <inbox> badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2', conversations: [{ workItemId: 2, title: 'Fix the <inbox> badge', primary: true, sessionId: 's2', state: 'running', conversation: 'full', unread: 0 }] };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'running', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, persona: null, background: null };

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
    // The provider's own mark in the text colour, inside the dropdown's button, its name as the tooltip and the accessible name.
    expect(root.querySelector('.header button.picker > .provider')?.getAttribute('aria-label')).toBe('Codex');
    expect(root.querySelector('.header button.picker > .provider')?.getAttribute('title')).toBe('Codex');
    expect(root.querySelector('.header button.picker > .provider svg path')?.getAttribute('fill')).toBe('currentColor');
    expect(root.querySelector('.header > .provider')).toBeNull();
    const codexMark = root.querySelector('.header button.picker > .provider svg path')?.getAttribute('d');
    const next = applyEvent(first, hello([], { sessions: [{ ...SESSION, id: 'claude-session', provider: 'claude' }] }));
    root.innerHTML = renderConversation(next);
    expect(root.querySelector('.header button.picker > .provider')?.getAttribute('aria-label')).toBe('Claude');
    expect(root.querySelector('.header button.picker > .provider svg path')?.getAttribute('d')).not.toBe(codexMark);
    root.innerHTML = renderConversation(applyEvent(next, hello([], { sessions: [] })));
    expect(root.querySelector('.provider')).toBeNull();
  });
  it('says how many background agents run after the turn ended, with the spinner, when no turn row is due', () => {
    const background = { ...SESSION, state: 'running' as const, background: { agents: 3, shells: 0, other: 0 } };
    const root = document.createElement('div');

    root.innerHTML = renderConversation(applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Go'), reply('r1', T0 + 1)], { sessions: [background] })));
    const row = root.querySelector('.timeline > li.working.background');

    expect(row?.querySelector('.working-label')?.textContent).toBe('3 agents running');
    expect(row?.querySelector('[role="status"]')?.textContent).toBe('3 agents running');
    expect(row?.querySelector('.codicon-modifier-spin')).not.toBeNull();
    expect(root.querySelector('.timeline > li:last-child')).toBe(row);
    // A message sent while they run shows Thinking until its reply, in place of the background line.
    const sent = renderConversation(applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Go'), reply('r1', T0 + 1), message('m2', T0 + 2, 'And?')], { sessions: [background] })));

    expect(sent).toContain('Thinking');
    expect(sent).not.toContain('agents running');
    // A working session shows Thinking and no background line; an idle one neither.
    expect(renderConversation(applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Go')], { sessions: [SESSION] })))).not.toContain('li class="working background"');
    expect(renderConversation(applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Go'), reply('r1', T0 + 1)], { sessions: [{ ...SESSION, state: 'idle', background: null }] })))).not.toContain('class="working');
  });

  it('renders native Codex requests and unknown delivery without exposing a request as a chat answer', () => {
    const uncertain = message('m-unknown', T0, 'Check delivery', { origin: 'typed', delivery: 'uncertain', error: 'Check the terminal before resending.' });
    const native = { ...SESSION, provider: 'codex' as const, state: 'waiting' as const, waitingFor: 'question' as const, requests: [{id:'1:0',kind:'question' as const,title:'Choose <red> or blue',questions:[{id:'color',question:'Which color?',options:['Red','Blue']}],decisions:[]}] };
    const state = applyEvent(EMPTY_CONVERSATION, hello([uncertain], { sessions: [native] }));
    const html = renderConversation(state);
    expect(html).toContain('data-action="request-answer" data-request="1:0"');
    // A card at the end of the conversation, in place of the turn row.
    expect(html).not.toContain('Thinking');
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
    // A permission's decisions are buttons in its card; a click answers with no dialog.
    root.querySelector<HTMLElement>('[data-action="request-decision"][data-decision="accept"]')!.click();
    expect(posted.at(-1)).toMatchObject({type:'answer-request',requestId:'1:0',answer:'accept',target:{sessionId:'s2',scopeGen:1}});
    expect(root.querySelector<HTMLButtonElement>('[data-action="request-decision"]')!.disabled).toBe(true);
    // A refusal shows in the card and lets the operator try again.
    window.dispatchEvent(new MessageEvent('message',{data:{type:'answered',id:(posted.at(-1) as {id:number}).id,error:'This Codex request is no longer pending.'}}));
    expect(root.querySelector('.request .question-error')?.textContent).toBe('This Codex request is no longer pending.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="request-decision"]')!.disabled).toBe(false);
  });
  it('answers a Codex question from its card with a picked option or a typed answer, and offers Open in terminal for one it cannot answer', () => {
    const root=document.createElement('div');const live=document.createElement('div');const posted:Array<Record<string,unknown>>=[];
    document.body.replaceChildren(root,live);
    startConversation(root,live,{postMessage:(message:unknown)=>posted.push(message as Record<string,unknown>),getState:()=>null,setState:()=>{}});
    const native={...SESSION,provider:'codex' as const,state:'waiting' as const,waitingFor:'question' as const,requests:[{id:'1:0',kind:'question' as const,title:'Codex has a question',questions:[{id:'color',question:'Which color?',options:['Red','Blue']},{id:'name',question:'Name?',options:[]}],decisions:[]}]};
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:applyEvent(EMPTY_CONVERSATION,hello([],{sessions:[native]}))}}));
    const submit=()=>root.querySelector<HTMLButtonElement>('[data-action="request-answer"]')!;
    expect(submit().disabled).toBe(true);
    root.querySelector<HTMLElement>('[data-action="request-option"][data-value="Blue"]')!.click();
    const field=root.querySelector<HTMLInputElement>('.request-field[data-field="1:0:name"]')!;
    field.value='Ada';
    field.dispatchEvent(new Event('input',{bubbles:true}));
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(posted.at(-1)).toMatchObject({type:'answer-request',requestId:'1:0',answer:{color:'Blue',name:'Ada'}});
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:applyEvent(EMPTY_CONVERSATION,hello([],{sessions:[{...native,requests:[{...native.requests[0]!,kind:'unsupported' as const}]}]}))}}));
    root.querySelector<HTMLElement>('.request [data-action="terminal"]')!.click();
    expect(posted.at(-1)).toEqual({type:'terminal'});
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

    expect(moved).toEqual({ scope: { ...SCOPE, workItemId: 3, sessionId: null }, session: null, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, questions: null });

    // A session's questions, from hello and its own questions events only (PRD R103).
    const questions = { sessionId: 's2', since: 1, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };
    const asked = applyEvent(state, { type: 'questions', questions });

    expect(asked.questions).toEqual(questions);
    expect(applyEvent(asked, { type: 'questions', questions: { ...questions, sessionId: 'other', open: 9 } }).questions).toEqual(questions);
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
    expect(voiceStatus({ ...voice, here: false })).toEqual({ text: '$(circle-slash) Voice not here', tooltip: 'Click to use voice for this session.', command: 'switchboard.talkHere', warning: false });
    expect(voiceStatus({ ...voice, error: 'no device' })).toMatchObject({ text: '$(warning) Voice', command: 'switchboard.showVoiceLog', warning: true });
    // After the phone left: the voice is off until Talk here takes it back.
    expect(voiceStatus({ ...voice, deviceOff: true as const })).toEqual({ text: '$(circle-slash) Voice off', tooltip: DEVICE_OFF_TIP, command: 'switchboard.talkHere', warning: true });
    expect(voiceStatus({ ...voice, speaking: 'r1' })).toMatchObject({ text: '$(unmute) Speaking', command: 'switchboard.stopSpeaking' });
    // The mic (architecture.md § Dictation).
    expect(voiceStatus(voice)).toEqual({ text: '$(mic) Mic off', tooltip: 'Click to turn the mic on.', command: 'switchboard.toggleMicrophone', warning: false });
    expect(voiceStatus({ ...voice, mic: 'idle-off' })).toMatchObject({ text: '$(mic) Mic off', tooltip: 'Mic turned off after inactivity. Click to turn it on.' });
    expect(voiceStatus({ ...voice, mic: 'listening' })).toMatchObject({ text: '$(mic-filled) Listening', command: 'switchboard.toggleMicrophone' });
    expect(voiceStatus({ ...voice, mic: 'hearing' })).toMatchObject({ text: '$(mic-filled) Listening' });
    expect(voiceStatus({ ...voice, mic: 'typing' })).toMatchObject({ text: '$(mic-filled) Typing' });
    expect(voiceStatus({ ...voice, mic: 'starting' })).toMatchObject({ text: '$(mic-filled) Mic starting' });
    expect(voiceStatus({ ...voice, mic: 'paused-other-app' })).toEqual({ text: '$(mic) Mic paused', tooltip: 'Paused: another app is using the microphone. Click to show the voice log.', command: 'switchboard.showVoiceLog', warning: false });
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
    expect(voiceStatus({ ...voice, mic: 'listening', roomHold: true })).toEqual({ text: '$(mic-filled) Dictation waiting', tooltip: 'Dictation is waiting after another voice was detected. Press Enter to send it. Click to turn the mic off.', command: 'switchboard.toggleMicrophone', warning: false });
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
    expect(stateIcon(SESSION)).toMatchObject({ icon: 'loading~spin', text: 'Working' });
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'question' }).icon).toBe('question');
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'permission' }).icon).toBe('shield');
    // The dock's Idle mark; `check` is Done's.
    expect(stateIcon({ ...SESSION, state: 'idle' })).toMatchObject({ icon: 'circle-large-outline', text: 'Idle' });
    expect(stateIcon({ ...SESSION, state: 'ended' })).toMatchObject({ icon: 'stop-circle', tone: 'muted' });
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'permission' }).tone).toBe('attention');
    expect(stateIcon({ ...SESSION, state: 'starting' }).icon).toBe('loading~spin');
    expect(stateIcon(null)).toMatchObject({ icon: 'circle-slash', text: 'No session' });
  });

  it('shows a session waiting for a usage limit to reset with a watch and when it resumes (architecture.md § Rate limits)', () => {
    const until = new Date(2026, 10, 20, 13, 21).getTime();

    // stateIcon reads the clock: the reset is later the same day.
    vi.useFakeTimers({ toFake: ['Date'], now: until - 3_600_000 });

    try {
      expect(stateIcon({ ...SESSION, state: 'idle', limit: { until, retry: false } })).toMatchObject({ icon: 'watch', text: 'Rate limited · resumes 1:21 PM' });
    } finally {
      vi.useRealTimers();
    }

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
    expect([...root.querySelector('.header button.picker')!.children].map((child) => child.className)).toEqual(['codicon codicon-loading codicon-modifier-spin state-icon tone-muted', 'title', 'codicon codicon-chevron-down']);
    expect(root.querySelector('.header > .codicon')).toBeNull();
    expect(root.querySelector('.header .title')?.textContent).toBe('Fix the <inbox> badge');
    expect(root.querySelector('.message .box')?.textContent).toBe('Is <b>it</b> fixed?');
    root.innerHTML = renderConversation(state([message('m1', T0, 'Sent', { provisional: true })]));
    expect(root.querySelector('.message')?.className).toBe('message provisional');
    root.innerHTML = html;
    // The session is still in its turn, so the turn row follows its reply.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['day', 'message', 'reply reply', 'reply aside', 'note', 'working']);
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
    // An icon only, at every width: the name is in its tooltip and accessible name.
    expect(button.textContent).toBe('');
    expect(button.title).toBe('Persona: Nova <N>. Click to choose another.');
    expect(button.getAttribute('aria-label')).toBe('Persona: Nova <N>. Click to choose another.');
    expect(button.querySelector('.codicon-person')).not.toBeNull();
    // After the conversation dropdown, before Open in terminal.
    expect(button.parentElement?.previousElementSibling?.classList.contains('picker-anchor')).toBe(true);
    expect(button.parentElement?.nextElementSibling?.getAttribute('data-action')).toBe('terminal');

    const pinned = personaButton({ id: 'nova', name: 'Nova', pinned: true, tonePending: true });

    expect(pinned).toContain('class="persona pending"');
    expect(pinned).toContain('codicon-pinned');
    expect(pinned).toContain('title="Persona: Nova, pinned to this session. Its tone changes when the session next resumes or compacts. Click to choose another."');
    expect(personaButton(null)).toBe('');
    expect(renderConversation(state([]))).not.toContain('class="persona');
  });

  it('shows a plain persona button for a session with none that can take a pin, and none for one that cannot (architecture.md § Personas)', () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([], { session: { ...SESSION, persona: null, canPin: true } }));

    const button = root.querySelector<HTMLButtonElement>('header button.persona')!;

    expect(button.dataset['action']).toBe('persona');
    expect(button.className).toBe('persona');
    expect(button.title).toBe('No persona. Click to choose one.');
    expect(button.getAttribute('aria-label')).toBe('No persona. Click to choose one.');
    expect(button.querySelector('.codicon-person')).not.toBeNull();
    expect(button.querySelector('.codicon-pinned')).toBeNull();
    expect(renderConversation(state([], { session: { ...SESSION, persona: null, canPin: false } }))).not.toContain('class="persona');
  });

  it('says why the view cannot talk to a session, and when there is nothing to show', () => {
    const ended = renderConversation(state([], { session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' } }));

    expect(ended).toContain('The session has ended. Open it in the terminal to resume it.');
    // Every session is read with the current rules, so no rules note shows.
    expect(ended).not.toContain('conversation rules');
    expect(ended).toContain('No messages yet.');
    expect(renderConversation(state([], { session: { ...SESSION, conversation: 'none', reason: 'background' } }))).not.toContain('data-action="terminal"');
    expect(renderConversation({ ...EMPTY_CONVERSATION, connected: true })).toContain('No Switchboard conversation in this window. Open a work item from the dock to work on it here.');
    expect(renderConversation(EMPTY_CONVERSATION)).toContain('Connecting to Switchboard');
    expect(renderConversation(state([reply('r1', T0)], { more: true }))).toContain('data-action="earlier"');
  });

  it('keeps its spinners spinning under vscode-reduce-motion, as the web page and the dock do, and stops only the mic pulse', () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    // Each rule whose selector names vscode-reduce-motion, wherever it starts and however many lines it takes.
    const reduced = (css.match(/[^{}]*vscode-reduce-motion[^{}]*\{[^}]*\}/g) ?? []).map((rule) => rule.trim().replace(/\s+/g, ' '));

    expect(css).toContain('.codicon.state-icon.codicon-modifier-spin { animation: codicon-spin 1.1s linear infinite; }');
    expect(reduced).toEqual(['body.vscode-reduce-motion .composer .mic .codicon { animation: none; }']);
  });

  it("draws the composer from the composer.css it shares with the web page: a fill between the side bar and the input colour, and no rule of its own for the box", () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    const shared = readFileSync(require.resolve('@switchboard/conversation/composer.css'), 'utf8');
    const rule = (text: string, selector: string) => text.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

    expect(shared).toContain('--sb-composer-background: color-mix(in srgb, var(--vscode-foreground) 7%, var(--vscode-sideBar-background));');
    expect(rule(shared, 'body.vscode-light')).toContain('--sb-composer-background: color-mix(in srgb, var(--vscode-input-background) 50%, var(--vscode-sideBar-background));');
    expect(rule(shared, 'body.vscode-high-contrast, body.vscode-high-contrast-light')).toContain('--sb-composer-background: var(--vscode-input-background);');
    expect(rule(shared, '.composer')).toContain('background: var(--sb-composer-background);');
    expect(rule(shared, '.composer')).toContain('border-radius: 8px;');
    expect(rule(shared, '.composer-footer')).toContain('border-top: 0.5px solid var(--sb-composer-border);');
    expect(rule(shared, '.composer-tool')).toContain('color: var(--vscode-descriptionForeground);');
    expect(css).not.toMatch(/(^|\n)\.composer \{[^}]*(background|border|border-radius)\s*:/);
    expect(css).not.toMatch(/(^|\n)\.composer-footer \{/);
  });

  it('draws the conversation dropdown from the picker.css it shares with the web page: one filled control, its hovered row grey and the selected one blue', () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    const shared = readFileSync(require.resolve('@switchboard/conversation/picker.css'), 'utf8');
    const rule = (text: string, selector: string) => text.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

    expect(rule(shared, 'button.picker')).toContain('background: var(--sb-picker-background);');
    expect(rule(shared, 'button.picker')).not.toContain('border:');
    expect(shared).toContain('--sb-picker-background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);');
    expect(rule(shared, '.conversation-menu .menu-row:hover, .conversation-menu .menu-row:focus')).toContain('background: var(--vscode-list-hoverBackground');
    expect(rule(shared, '.conversation-row[aria-checked="true"], .conversation-row[aria-checked="true"]:hover, .conversation-row[aria-checked="true"]:focus')).toContain('background: var(--sb-picker-selected);');
    expect(shared).toContain('--sb-picker-selected: color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent);');
    // The view's own CSS leaves the button's fill and the selected row to the shared file.
    expect(rule(css, 'button.picker')).not.toMatch(/background|border-radius/);
    expect(css).not.toMatch(/(^|\n)button\.picker:hover \{/);
    expect(css).not.toMatch(/(^|\n)\.conversation-row\[aria-checked="true"\]:not/);
  });

  it('draws our messages as bubbles on the right, at most 85% wide in the web page\'s message blue with a smaller bottom-right corner, with its marks and time on one line under them', () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    const shared = readFileSync(require.resolve('@switchboard/conversation/bubbles.css'), 'utf8');
    const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

    expect(rule('.message')).toContain('align-items: flex-end;');
    expect(rule('.message .bubble')).toContain('max-width: 85%;');
    expect(rule('.message .box')).toContain('border-radius: 12px 12px 4px 12px;');
    expect(rule('.message .box')).toContain('background: var(--sb-message-bubble);');
    expect(shared).toContain('--sb-message-bubble: color-mix(in srgb, var(--vscode-button-background, #0078d4) 15%, transparent);');
    expect(rule('.message .box')).toContain('border: 1px solid var(--vscode-contrastBorder, transparent);');
    expect(rule('.message .box')).toContain('color: var(--vscode-foreground);');
    expect(rule('body.vscode-high-contrast .message .box, body.vscode-high-contrast-light .message .box')).toContain('background: transparent;');

    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([typed('t1', 'not-sent', 'The session has ended.')]), new Set(), T0);
    // One line under the bubble, never over it: the state at its left edge, the time at its right, so the times stay flush right.
    expect([...root.querySelector('li[data-id="t1"] > .bubble')!.children].map((child) => child.className)).toEqual(['box', 'meta']);
    expect([...root.querySelector('li[data-id="t1"] .meta')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    expect(root.querySelector('li[data-id="t1"] .meta-marks')!.innerHTML).toContain('class="delivery not-sent"');
    expect(rule('.meta .stamp')).toContain('margin-left: auto;');
    // The notes above the composer and its error take its corners and sit 8 px above it.
    expect(readFileSync(require.resolve('@switchboard/conversation/composer.css'), 'utf8')).toMatch(/\n\.composer \{[^}]*border-radius: 8px;/);
    for (const selector of ['.session-note', '.terminal-question', '.composer-error']) {
      expect(rule(selector)).toMatch(/margin: 0 (auto|0) 8px;/);
      expect(rule(selector)).toContain('border-radius: 8px;');
    }
  });

  it('shows the time only on the first item after a day divider, each timed item\'s with message details on, and the rest as a tooltip', () => {
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

    const stamps = (id: string) => root.querySelector(`li[data-id="${id}"] .meta .stamp`)?.textContent ?? null;

    expect(['m1', 'r1', 'n1', 'r2', 'r3', 'm2', 'r4'].map(stamps)).toEqual(['1:47 PM', null, null, null, null, null, null]);
    // A reply with no time keeps its line for its copy button, with its time as the line's tooltip; a message with no marks has no line, and its
    // bubble has the tooltip.
    expect(root.querySelector('li[data-id="r1"] > .meta .stamp')).toBeNull();
    expect(root.querySelector('li[data-id="r1"] > .meta > .meta-marks > .copy')).not.toBeNull();
    expect(root.querySelector('li[data-id="r1"] > .meta')!.getAttribute('title')).toMatch(/^2026-11-19 13:47:40 \S+$/);
    expect([...root.querySelector('li[data-id="m2"] > .bubble')!.children].map((child) => child.className)).toEqual(['box']);
    expect(root.querySelector('li[data-id="m2"] > .bubble')!.getAttribute('title')).toMatch(/^2026-11-19 13:59:30 \S+$/);

    // With message details on, every item but a note shows its time.
    root.innerHTML = renderConversation(state([message('m1', at(47, 5), 'a'), reply('r1', at(47, 40)), reply('n1', at(48), { kind: 'note', opening: 'Note.' }), message('m2', at(59, 30), 'b')]), new Set(), at(61), false, { tab: 'conversation', unopened: new Set(), details: true });
    expect(['m1', 'r1', 'n1', 'm2'].map(stamps)).toEqual(['1:47 PM', '1:47 PM', null, '1:59 PM']);
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
      false,
      { tab: 'conversation', unopened: new Set(), details: true },
    );

    const stamps = (id: string) => root.querySelector(`li[data-id="${id}"] .meta .stamp`)?.textContent ?? null;

    expect(['m1', 'r1', 'n1', 'a1', 'm2', 'r2'].map(stamps)).toEqual(['1:46 PM', '1:47 PM', null, '2:05 PM', '9:00 AM', '9:30 PM']);
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('datetime')).toBe(new Date(at(19, 13, 46)).toISOString());
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('title')).toMatch(/^2026-11-19 13:46:00 \S+$/);
    // The time sits under a message's bubble, as under a reply, and a slash command shows in the editor font.
    expect([...root.querySelector('li[data-id="m1"] > .bubble')!.children].map((child) => child.className)).toEqual(['box command', 'meta']);
    expect([...root.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
    expect(root.querySelector('li[data-id="m2"] .box')?.className).toBe('box');
    // A divider before the first turn and before the turn on the next day, which the keys skip: Yesterday and Today.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'm1', 'r1', 'n1', 'a1', 'day', 'm2', 'r2', 'working']);
    expect([...root.querySelectorAll('.day')].map((day) => day.textContent)).toEqual(['Yesterday', 'Today']);
    expect(root.querySelector('.day')?.getAttribute('role')).toBe('separator');

    // A reply after midnight in the same turn gets no divider, the next turn does; a turn in an earlier year shows its year.
    root.innerHTML = renderConversation(state([message('m1', at(19, 23, 50), 'Late'), reply('r1', at(20, 0, 10)), message('m2', at(20, 0, 20), 'Still')], { session: { ...SESSION, state: 'idle' } }), new Set(), at(20, 1, 0));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'm1', 'r1', 'day', 'm2']);
    root.innerHTML = renderConversation(state([message('m1', new Date(2026, 11, 30, 9).getTime(), 'Old'), message('m2', new Date(2026, 11, 31, 9).getTime(), 'New')]), new Set(), new Date(2027, 2, 1).getTime());
    expect([...root.querySelectorAll('.day')].map((day) => day.textContent)).toEqual(['Wed, Dec 30, 2026', 'Thu, Dec 31, 2026']);
    // Earlier this year: the weekday and date, without the year; the times stay time-only.
    root.innerHTML = renderConversation(state([message('m1', at(17, 9, 5), 'Older')]), new Set(), at(20, 9, 0));
    expect(root.querySelector('.day')?.textContent).toBe('Tue, Nov 17');
    expect(root.querySelector('li[data-id="m1"] .stamp')?.textContent).toBe('9:05 AM');
    // A message dated before the items above it, such as one queued days ago and placed last, starts no divider back in time.
    root.innerHTML = renderConversation(state([message('m1', at(19, 9, 0), 'First'), message('m2', at(20, 9, 0), 'Second'), message('m0', at(17, 21, 0), 'Old notice')], { session: { ...SESSION, state: 'idle' } }), new Set(), at(20, 12, 0));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'm1', 'day', 'm2', 'm0']);
  });

  it('shows a spinner after the newest item while the session is in a turn, also after its reply, gone when the turn or the session ends', () => {
    const root = document.createElement('div');
    const asked = [reply('r1', T0, { opening: 'Hi' }), message('m1', T0 + 1, 'Why?'), reply('a1', T0 + 2, { kind: 'aside', opening: 'Reading' })];

    root.innerHTML = renderConversation(state(asked));
    // Progress written mid-turn shows above it, as an artifact written since does.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['day', 'reply reply', 'message', 'reply aside', 'working']);
    root.innerHTML = renderConversation(state([...asked, reply('a2', T0 + 3, { kind: 'aside', opening: 'Writing' })], { artifacts: [{ path: 'chat/a.md', owner: 'chat', kind: 'page', title: 'Page', ext: 'md', type: 'markdown', updatedAt: T0 + 4 }] }));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'r1', 'm1', 'a1', 'a2', 'artifact:chat/a.md', 'working']);
    expect(root.querySelector('.working .codicon')?.className).toBe('working-icon codicon codicon-loading codicon-modifier-spin');
    // "Thinking…" beside it, as in Claude Code's panel, which a screen reader hears once, as "Thinking".
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Thinking…');
    expect(root.querySelector('.working .working-label')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.working')?.getAttribute('data-id')).toBeNull();
    expect(root.querySelector('.working [role="status"]')?.textContent).toBe('Thinking');
    expect(root.querySelector('.working .codicon')?.getAttribute('aria-hidden')).toBe('true');

    // A reply mid-turn, or a turn a task notification started, leaves the turn row after it (session 311b1ad4).
    root.innerHTML = renderConversation(state([...asked, reply('r2', T0 + 3)]));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['day', 'r1', 'm1', 'a1', 'r2', 'working']);
    // Only background tasks left: `running`, but in no turn.
    root.innerHTML = renderConversation(state([...asked, reply('r2', T0 + 3)], { session: { ...SESSION, background: { agents: 1, shells: 0, other: 0 } } }));
    expect(root.querySelector('.working:not(.background)')).toBeNull();
    expect(root.querySelector('.working.background .working-label')?.textContent).toBe('1 agent running');
    // An older hub sends no `background`: the row goes with the reply, as before.
    root.innerHTML = renderConversation(state([...asked, reply('r2', T0 + 3)], { session: (({ background: _, ...older }) => older)(SESSION) }));
    expect(root.querySelector('.working')).toBeNull();
    // A message sent then still waits for its reply.
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, background: { agents: 1, shells: 0, other: 0 } } }));
    expect(root.querySelector('.working .working-label')?.textContent).toBe('Thinking…');
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
    const response = root.querySelector<HTMLButtonElement>('li[data-id="r1"] > .meta > .meta-marks > button.copy[data-action="copy-reply"]:first-child')!;

    expect(code.nextElementSibling?.tagName).toBe('PRE');
    expect(code.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    expect(response.getAttribute('aria-label')).toBe('Copy response to clipboard');
    expect(root.querySelector('li[data-id="r2"] .copy')).toBeNull();
    expect(root.querySelector('li[data-id="n1"] .meta')).toBeNull();

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
    // The Status tab has the unread dot, not a New badge, from any tab.
    expect(root.querySelector('[data-tab="status"] .unread-dot')?.getAttribute('title')).toBe('Unread');
    expect(root.querySelector('[data-tab="status"]')?.getAttribute('aria-label')).toBe('Status, unread');
    expect(root.querySelector('[data-tab="status"] .tab-badge')).toBeNull();

    root.innerHTML = renderConversation(state([], { status: status('stage-2', { fallback: true, unread: true }) }), new Set(), T0, false, on('status'));
    expect(root.querySelector('[data-unread]')).toBeNull();
    expect(root.querySelector('.tab-badge')).toBeNull();
    expect(root.querySelector('.unread-dot')).toBeNull();
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

  it('shows message details while the extension says so in its state message', () => {
    const { root } = page();
    const shown = state([reply('r1', T0, { opening: 'Fixed.', tone: 'calm' }), reply('r2', T0 + 120_000, { opening: 'Again.' })]);
    const post = (details?: boolean) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: shown, ...(details === undefined ? {} : { details }) } }));

    post(true);
    expect(root.querySelector('li[data-id="r1"] .tone')?.textContent).toBe('calm');
    expect(root.querySelector('li[data-id="r2"] .stamp')).not.toBeNull();
    post();
    expect(root.querySelector('li[data-id="r1"] .tone')).toBeNull();
    expect(root.querySelector('li[data-id="r2"] .stamp')).toBeNull();
  });

  it('shows a reply with a passage as the passage first, the whole reply behind Show more, and whole with voice.expandReplies', () => {
    const passage = reply('r1', T0, { opening: 'Fixed the **badge**.\n\n- one\n- two', speak: 'Fixed the **badge**.', tone: 'calm' });
    const { root, show } = page();

    show(state([passage, reply('r2', T0 + 1, { opening: 'Same.', speak: 'Same.' }), reply('r3', T0 + 2, { opening: 'Plain.' })]));

    const first = root.querySelector<HTMLElement>('li[data-id="r1"]')!;

    expect(first.querySelector('.body')!.innerHTML).toContain('<strong>badge</strong>');
    expect(first.querySelector('.body ul')).toBeNull();
    // The tone shows only with message details on.
    expect(first.querySelector('.tone')).toBeNull();
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

    // Nor does a reply whose only other text is the questions its card draws; questions mid-message stay in the text, so that one has.
    show(state([reply('r4', T0 + 3, { opening: 'Fixed it.\n\n1. Ship it?\n   - A) Yes\n   - B) No', speak: 'Fixed it.' }), reply('r5', T0 + 4, { opening: 'Fixed it.\n\n1. Ship it?\n   - A) Yes\n   - B) No\n\nMore after.', speak: 'Fixed it.' })]));
    expect(root.querySelector('li[data-id="r4"] .question-card')).not.toBeNull();
    expect(root.querySelector('li[data-id="r4"] .show-more')).toBeNull();
    expect(root.querySelector('li[data-id="r5"] .show-more')).not.toBeNull();
  });

  it('draws a passage as a bubble on the left, once, in its place when the whole reply shows, and a reply that is all passage as only its bubble', () => {
    const { root, show } = page();
    const bodyOf = (id: string) => root.querySelector(`li[data-id="${id}"] > .body`)!;
    const kinds = (id: string) => [...bodyOf(id).children].map((child) => (child.classList.contains('speech-bubble') ? `bubble:${child.textContent!.trim()}` : child.tagName.toLowerCase()));

    show(state([reply('r1', T0, { opening: 'Before.\n\nFixed it.\n\n- one', speak: 'Fixed it.' }), reply('r2', T0 + 1, { opening: 'Same.', speak: 'Same.' }), reply('r3', T0 + 2, { opening: 'Plain.' })]));

    expect(kinds('r1')).toEqual(['bubble:Fixed it.', 'button']);
    expect(kinds('r2')).toEqual(['bubble:Same.']);
    expect(bodyOf('r3').querySelector('.speech-bubble')).toBeNull();
    root.querySelector<HTMLButtonElement>('li[data-id="r1"] .show-more')!.click();
    // The text around the passage shows as smaller details, and the passage is not shown a second time.
    expect(kinds('r1')).toEqual(['div', 'bubble:Fixed it.', 'div', 'button']);
    expect([...bodyOf('r1').querySelectorAll(':scope > .reply-details')].map((details) => details.firstElementChild!.tagName.toLowerCase())).toEqual(['p', 'ul']);
    expect(bodyOf('r1').textContent!.match(/Fixed it\./g)).toHaveLength(1);
    // The metadata line stays one line under the whole reply.
    expect([...root.querySelector('li[data-id="r1"]')!.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);

    const css = readFileSync(require.resolve('@switchboard/conversation/bubbles.css'), 'utf8');
    const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

    expect(rule('.speech-bubble')).toContain('max-width: 80%;');
    expect(rule('.reply-details')).toContain('font-size: 92%;');
    expect(rule('.speech-bubble')).toContain('border-radius: 12px 12px 12px 4px;');
    expect(rule('.speech-bubble')).toContain('background: var(--sb-speech-bubble);');
    // The spoken passage reads at 110% of the reply's text, and the dot moves down by half of what that adds to the first line.
    expect(rule('.speech-bubble')).toContain('font-size: 110%;');
    expect(rule('.reply:has(> .body > .speech-bubble:first-child)')).toContain('--dot-shift: calc(7px + 0.075em);');
    // Our messages' bubbles, slash commands included, read at the same 110%, so every bubble's text is one size.
    expect(rule('.message .box')).toBe('.message .box { font-size: 110%; }');
    expect(css).not.toContain('.message .box.command');
    // That 110% is of the theme's size only while the reply and the message around a bubble keep it.
    const view = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');

    expect(view).toMatch(/\nbody \{[^}]*font-size: var\(--vscode-font-size\);/);
    for (const parent of [".timeline",".timeline > li",".reply",".reply .body",".message",".message .bubble",".message .box"]) {
      expect(view.split('\n').filter((line) => line.startsWith(`${parent} {`)).join(' ')).not.toContain('font-size');
    }
    // The view's own command rule sets only the font, so a slash command's bubble keeps the shared 110%.
    expect(view.split('\n').filter((line) => line.startsWith('.message .box.command {')).join(' ')).not.toContain('font-size');
    expect(css).toContain('--sb-speech-bubble: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.2)) 75%, var(--vscode-sideBar-background));');
    expect(rule('body.vscode-high-contrast .speech-bubble, body.vscode-high-contrast-light .speech-bubble')).toContain('background: transparent;');
  });

  it("puts all of a reply's metadata on one line under it: the copy button first, the tone and Not spoken, and the time at the right", () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([reply('r1', T0, { opening: 'Fixed it.', tone: 'calm and brief', spoken: { state: 'failed', atMs: null, saidChars: null } })]), new Set(), Date.now(), false, { tab: 'conversation', unopened: new Set(), details: true });
    const item = root.querySelector('li[data-id="r1"]')!;

    expect([...item.children].map((child) => child.className)).toEqual(['dot', 'body', 'meta']);
    expect([...item.querySelector('.meta-marks')!.children].map((child) => child.className)).toEqual(['copy', 'tone', 'spoken failed']);
    expect(item.querySelector('.meta > :last-child')?.className).toBe('stamp');
    expect(item.querySelector('.tone')?.getAttribute('title')).toBe('How the reply sounds when spoken: calm and brief');
  });

  it('dims the part of an interrupted passage not heard, and says Not spoken only when speech failed, with message details on', () => {
    const spoken = (state_: ReplyView['spoken']['state'], atMs: number | null = null, saidChars: number | null = null, details = true) =>
      renderConversation(state([reply('r1', T0, { opening: 'Fixed it. More.', speak: 'Fixed it.', spoken: { state: state_, atMs, saidChars } })]), new Set(), Date.now(), false, { tab: 'conversation', unopened: new Set(), details });

    expect(spoken('interrupted', 7_400, 3)).toContain('<div class="speech-bubble"><p class="passage">Fix<span class="unheard">ed it.</span></p></div>');
    expect(spoken('interrupted', 7_400, 3)).not.toContain('0:07');
    expect(spoken('failed')).toContain('<span>Not spoken</span>');
    // Not spoken is a message detail; the dimmed part of an interrupted passage is not.
    expect(spoken('failed', null, null, false)).not.toContain('class="spoken');
    expect(spoken('interrupted', 7_400, 3, false)).toContain('<span class="unheard">ed it.</span>');
    // Routine states show nothing: no line under the reply, and a playing passage is not dimmed.
    expect(spoken('playing', 100, 3)).not.toContain('class="unheard"');

    for (const routine of ['playing', 'interrupted', 'stopped-moved', 'played', 'queued', 'skipped'] as const) {
      expect(spoken(routine, 100, 3)).not.toContain('class="spoken');
    }
  });

  it('offers Speak replies and Stop as icon buttons, Talk here only while the voice is elsewhere, R to replay a reply and Escape to stop', () => {
    const { root, host, posted, show } = page();
    const controls = () => host.querySelector<HTMLElement>('.voice-controls')!;

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, enabled: false } }));
    expect(controls().innerHTML).toBe('');

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, here: false } }));
    // While the voice is elsewhere, one Talk here takes the whole cluster's place: no speaker, no mic.
    expect(controls().textContent).toBe('Talk here');
    expect(controls().querySelector('[data-voice="speak-replies"]')).toBeNull();
    expect(host.querySelector('[data-voice="mic"]')).toBeNull();
    // The cluster sits beside the mic and Send, in one group after the message tools, which wraps whole on a narrow footer.
    expect(controls().parentElement?.classList.contains('composer-end')).toBe(true);
    expect(controls().parentElement?.parentElement?.classList.contains('composer-footer')).toBe(true);
    expect(controls().parentElement?.lastElementChild?.classList.contains('send')).toBe(true);
    expect(controls().nextElementSibling?.classList.contains('mic-slot')).toBe(true);
    controls().querySelector<HTMLButtonElement>('[data-voice="talk-here"]')!.click();

    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: VOICE }));
    // Here: Speak replies is a speaker toggle that says its state in its tooltip, and the mic follows it.
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe('Speak replies: on. Click to stop speaking replies.');
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(controls().querySelector('[data-voice="speak-replies"] .codicon-unmute')).not.toBeNull();
    expect(host.querySelectorAll('[data-voice="mic"]')).toHaveLength(1);
    controls().querySelector<HTMLButtonElement>('[data-voice="speak-replies"]')!.click();

    // A session the voice cannot speak for, such as an ended one, offers no Talk here, which the hub would refuse.
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended.' }, voice: { ...VOICE, here: false } }));
    expect(controls().querySelector('[data-voice="talk-here"]')).toBeNull();
    expect(controls().innerHTML).toBe('');
    expect(host.querySelector('[data-voice="mic"]')).toBeNull();

    // While a reply plays there is no Stop button: the speaker stops it. On, its click turns Speak replies off, which stops the reply playing.
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, speaking: 'r1' } }));
    expect(controls().querySelectorAll('button')).toHaveLength(1);
    expect(controls().querySelector('.codicon-debug-stop')).toBeNull();
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe(SPEAKING_TIP);
    controls().querySelector<HTMLButtonElement>('[data-voice="speak-replies"]')!.click();

    // Off, a reply plays only as a Replay, which the speaker's click stops, leaving Speak replies off; once it ends, the click turns it on.
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, speaking: 'r1', speakReplies: false } }));
    expect(controls().textContent).toBe('');
    expect(controls().querySelector('[data-voice="talk-here"]')).toBeNull();
    expect(controls().querySelectorAll('button')).toHaveLength(1);
    expect(controls().querySelector('[data-voice="speak-replies"]')).toBeNull();
    expect(controls().querySelector('[data-voice="stop"] .codicon-mute')).not.toBeNull();
    expect(controls().querySelector('[data-voice="stop"]')!.getAttribute('title')).toBe(REPLAY_TIP);
    controls().querySelector<HTMLButtonElement>('[data-voice="stop"]')!.click();
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, speakReplies: false } }));
    expect(controls().querySelector('[data-voice="speak-replies"] .codicon-mute')).not.toBeNull();
    expect(controls().querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe('Speak replies: off. Click to speak replies.');
    controls().querySelector<HTMLButtonElement>('[data-voice="speak-replies"]')!.click();
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, speaking: 'r1', speakReplies: false } }));

    const item = root.querySelector<HTMLElement>('li[data-id="r1"]')!;

    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(posted.filter((message) => message.type !== 'ready' && message.type !== 'seen' && message.type !== 'composer')).toEqual([
      { type: 'talk-here' },
      { type: 'speak-replies', on: false },
      { type: 'speak-replies', on: false },
      { type: 'stop-speaking' },
      { type: 'speak-replies', on: true },
      { type: 'replay', replyId: 'r1' },
      { type: 'stop-speaking' },
      { type: 'stop-speaking' },
    ]);
    // Capture's error is the mic button's tooltip, not text in the footer.
    expect(renderVoiceControls({ ...VOICE, mic: 'unavailable', error: 'no <device>' })).not.toContain('device');

    // After the phone left, a voice here with no device says so beside Speak replies, and its click is Talk here.
    show(state([reply('r1', T0, { opening: 'Done. More.', speak: 'Done.' })], { voice: { ...VOICE, deviceOff: true as const } }));
    const off = controls().querySelector<HTMLButtonElement>('[data-voice="talk-here"]')!;

    expect(off.textContent).toBe('Talk here');
    expect(off.getAttribute('title')).toBe(DEVICE_OFF_TIP);
    expect(controls().querySelector('[data-voice="speak-replies"]')).not.toBeNull();
    off.click();
    expect(posted.at(-1)).toEqual({ type: 'talk-here' });
    expect(renderVoiceControls({ ...VOICE, deviceOff: true, here: false })).not.toContain('Voice is off');
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
      Date.now(),
      false,
      { tab: 'conversation', unopened: new Set(), details: true },
    );

    expect(html).toContain('<span class="voice-mark" title="Dictated in 2 pieces:\nfix the\n(dropped) login · match 0.82 · 118 Hz"><span class="codicon codicon-mic" aria-hidden="true"></span><span>dictated</span></span>');
    expect(html).toContain('<span class="voice-mark" title="Dictated"><span class="codicon codicon-mic" aria-hidden="true"></span><span>partial</span></span>');
    expect(html.match(/voice-mark/g)).toHaveLength(2);
    // Without message details, no Dictated mark.
    expect(renderConversation(state([message('v1', T0, 'fix the login', { origin: 'voice', delivery: 'sent', pieces })]))).not.toContain('voice-mark');

    const over = renderConversation(
      state([
        message('v3', T0, 'hold on', { origin: 'voice', delivery: 'sent', interrupted: { replyId: 'r1', said: 'The session token', rest: 'is refreshed.' } }),
        message('v4', T0 + 1, 'stop', { origin: 'voice', delivery: 'sent', interrupted: { replyId: 'r2', said: '', rest: 'Done.' } }),
      ]),
      new Set(),
      Date.now(),
      false,
      { tab: 'conversation', unopened: new Set(), details: true },
    );

    expect(over).toContain('<span class="voice-mark" title="Dictated\nYou interrupted the reply after &#34;The session token&#34;."><span class="codicon codicon-mic" aria-hidden="true"></span><span>dictated · interrupted the reply</span></span>');
    expect(over).toContain('title="Dictated\nYou interrupted the reply before it played."');
  });

  it('draws one mic button whose glyph and tooltip carry the mic state, and nothing with voice off (architecture.md § Dictation)', () => {
    const glyph = (voice: VoiceView): string => /<span class="mic-glyph ([a-z]+)">(.*)<\/span><\/button>$/.exec(renderMicButton(voice))!.slice(1).join(' ');

    expect(renderMicButton(null)).toBe('');
    expect(renderMicButton({ ...VOICE, enabled: false })).toBe('');
    // Elsewhere: no mic, since Talk here takes the cluster's place; off, after the idle timeout and unavailable: a mic with a slash.
    expect(renderMicButton({ ...VOICE, here: false })).toBe('');
    expect(renderMicButton(VOICE)).toMatch(/class="mic off".*data-on="true".*aria-pressed="false"/);
    expect(glyph(VOICE)).toMatch(/^off /);
    // After the idle timeout: an outlined mic, apart from off.
    expect(glyph({ ...VOICE, mic: 'idle-off' })).toMatch(/^outline .*codicon-mic"/);
    expect(renderMicButton({ ...VOICE, mic: 'idle-off' })).toContain('class="mic idle"');
    expect(renderMicButton({ ...VOICE, mic: 'idle-off' })).toContain('Mic turned off after inactivity.');
    expect(glyph({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toMatch(/^off /);
    // The mic is on but cannot run: the click turns it off, never only tries again.
    expect(renderMicButton({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toContain('Mic on but unavailable: No &#60;model&#62;. Click to turn the mic off.');
    expect(renderMicButton({ ...VOICE, mic: 'unavailable', error: 'No <model>.' })).toContain('data-on="false"');
    // Listening: filled, in the accent colour and pulsing by its class; hearing: the same, pulsing faster.
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).toMatch(/class="mic listening".*data-on="false".*aria-pressed="true"/);
    expect(glyph({ ...VOICE, mic: 'listening' })).toMatch(/^filled .*codicon-mic-filled"/);
    expect(renderMicButton({ ...VOICE, mic: 'hearing' })).toContain('class="mic hearing"');
    expect(glyph({ ...VOICE, mic: 'hearing' })).toMatch(/^filled .*codicon-mic-filled"/);
    expect(renderMicButton({ ...VOICE, mic: 'starting' })).toContain('class="mic starting"');
    expect(glyph({ ...VOICE, mic: 'starting' })).toMatch(/^filled .*codicon-mic-filled".*<span class="mic-ring" aria-hidden="true">/);
    // Typing and another app recording: a mic with a pause badge.
    expect(renderMicButton({ ...VOICE, mic: 'typing' })).toContain('Mic paused while you type');
    expect(renderMicButton({ ...VOICE, mic: 'typing' })).toContain('<span class="mic-glyph outline"><span class="codicon codicon-mic" aria-hidden="true"></span><span class="mic-badge pause" aria-hidden="true"><span class="codicon codicon-debug-pause">');
    expect(renderMicButton({ ...VOICE, mic: 'paused-other-app' })).toContain('Mic paused: another app is using the microphone.');
    expect(renderMicButton({ ...VOICE, mic: 'paused-other-app' })).toContain('class="mic paused"');
    // Half-duplex capture says why listening pauses while a reply plays, only while it listens or hears.
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).not.toContain('Listening pauses');
    const halfDuplex = { ...VOICE, halfDuplex: 'no echo cancellation on Remote Audio' };
    expect(renderMicButton({ ...halfDuplex, mic: 'listening' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, fullDuplex: 'echo check: none heard', mic: 'listening' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Full duplex (echo check: none heard): talking over a reply stops it. Click to turn the mic off."');
    // Held for a reply playing: its own speaker badge, and why.
    expect(renderMicButton({ ...halfDuplex, mic: 'listening', speaking: 'r1' })).toMatch(/class="mic held"[\s\S]*mic-badge held[\s\S]*codicon-unmute/);
    expect(renderMicButton({ ...halfDuplex, mic: 'listening', speaking: 'r1' })).toContain('Mic on, held while the reply plays (no echo cancellation on Remote Audio)');
    expect(renderMicButton({ ...VOICE, mic: 'listening', speaking: 'r1' })).toContain('class="mic listening"');
    expect(renderMicButton({ ...halfDuplex, mic: 'hearing' })).toContain('title="Mic on: hearing you. Listening pauses while a reply plays (no echo cancellation on Remote Audio), so talking over it does not stop it. Click to turn the mic off."');
    // Where recognition runs, once the recogniser loaded.
    expect(renderMicButton({ ...VOICE, mic: 'listening', recognizer: 'gpu' })).toContain('title="Mic on: listening. Dictation sends when you stop talking. Speech recognition runs on the GPU. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, mic: 'hearing', recognizer: 'cpu' })).toContain('Speech recognition runs on the CPU.');
    expect(renderMicButton({ ...VOICE, mic: 'listening' })).not.toContain('Speech recognition');
    // Paused by "stop listening": a pause badge, and a click listens again.
    expect(renderMicButton({ ...VOICE, mic: 'paused-by-voice' })).toContain('title="Mic paused: you said &#34;stop listening&#34;. Say &#34;start listening&#34;, or click to listen again."');
    expect(renderMicButton({ ...VOICE, mic: 'paused-by-voice' })).toMatch(/class="mic paused".*data-on="true"/);
    // A room hold says spoken turns stay in the box.
    expect(renderMicButton({ ...VOICE, mic: 'listening', roomHold: true })).toContain('title="Mic on: listening. Dictation is waiting after another voice was detected. Press Enter to send it. Click to turn the mic off."');
    expect(renderMicButton({ ...VOICE, mic: 'hearing', roomHold: true })).toContain('title="Mic on: hearing you. Dictation is waiting after another voice was detected. Press Enter to send it. Click to turn the mic off."');
  });
});

describe('the mic start', () => {
  const VOICE = { enabled: true, here: true, mic: 'off' as const, speaking: null, speakReplies: true, error: null, recognizer: null };

  it('shows starting with a ring from the tap until the voice listens, and the tap\'s error until the next tap', () => {
    const starting = renderMicButton(VOICE, 'starting');

    expect(starting).toMatch(/class="mic starting".*data-on="false".*aria-busy="true"/);
    expect(starting).toContain(`aria-label="${MIC_STARTING_TIP}"`);
    expect(starting).toContain('class="mic-ring"');
    // Still starting while the hub has the mic off or idle, or the voice process opens capture; the voice view's state once it listens.
    expect(renderMicButton({ ...VOICE, mic: 'idle-off' }, 'starting')).toContain('class="mic starting"');
    // A pause by voice is not hidden: a click listens again at once.
    expect(renderMicButton({ ...VOICE, mic: 'paused-by-voice' }, 'starting')).toContain('class="mic paused"');
    expect(renderMicButton({ ...VOICE, mic: 'listening' }, 'starting')).toContain('class="mic listening"');
    expect(renderMicButton({ ...VOICE, mic: 'unavailable', error: 'No model.' }, 'starting')).toContain('Mic on but unavailable: No model.');
    // Failed: a slashed mic in the warning colour with why, whose click tries again.
    const failed = renderMicButton(VOICE, { error: 'Microphone access was not allowed on this device.' });

    expect(failed).toMatch(/class="mic unavailable".*data-on="true"/);
    expect(failed).toContain('title="The mic did not start: Microphone access was not allowed on this device. Click to try again."');
    expect(renderMicButton({ ...VOICE, here: false }, 'starting')).toBe('');
    // A start that timed out shows its failure though the voice process still says starting.
    expect(renderMicButton({ ...VOICE, mic: 'starting' }, { error: MIC_START_TIMEOUT })).toContain('class="mic unavailable"');
  });

  it('ends a pending start once the voice view confirms or ends it, or after its limit', () => {
    vi.useFakeTimers();

    try {
      const changed = vi.fn();
      const start = new MicStart(changed, 1_000);

      start.start();
      start.view('off');
      start.view('idle-off');
      expect(start.pending).toBe('starting');
      start.view('listening');
      expect(start.pending).toBeNull();
      // The voice process said starting, then off: it failed, and the voice view shows.
      start.start();
      start.view('starting');
      expect(start.pending).toBe('starting');
      start.view('off');
      expect(start.pending).toBeNull();
      // Off before the voice process said starting is the hub not having heard of the tap yet; a start never confirmed fails at its limit.
      start.start();
      start.view('off');
      vi.advanceTimersByTime(999);
      expect(start.pending).toBe('starting');
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(start.pending).toEqual({ error: MIC_START_TIMEOUT });
      expect(changed).toHaveBeenCalledOnce();
      // A failure stays until the mic is on or the next tap, and its limit does not end it.
      start.start();
      start.fail('No.');
      vi.advanceTimersByTime(5_000);
      expect(start.pending).toEqual({ error: 'No.' });
      start.view('off');
      expect(start.pending).toEqual({ error: 'No.' });
      start.view('hearing');
      expect(start.pending).toBeNull();
      // A failure answered for an earlier attempt, or after Mic off, changes nothing.
      const first = start.start();

      start.start();
      expect(start.fail('Late.', first)).toBe(false);
      expect(start.pending).toBe('starting');
      start.clear();
      start.fail('Late.');
      expect(start.pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
      // Mic on shows starting at the click, before the hub answers, until the voice listens; the extension's refusal shows on the button.
      show({ ...state(), voice: { ...voice, mic: 'off' } });
      host.querySelector<HTMLButtonElement>('.mic-slot button')!.click();
      expect(posted.at(-1)).toEqual({ type: 'mic', on: true });
      expect(host.querySelector('.mic-slot button.mic.starting')?.getAttribute('aria-label')).toBe(MIC_STARTING_TIP);
      show({ ...state(), voice: { ...voice, mic: 'off' } });
      expect(host.querySelector('.mic-slot button.mic.starting')).not.toBeNull();
      post({ type: 'mic-failed', error: 'The hub did not answer.' });
      expect(host.querySelector('.mic-slot button.mic.unavailable')?.getAttribute('title')).toBe('The mic did not start: The hub did not answer. Click to try again.');
      // Toggle Microphone from the keyboard starts it through the extension.
      post({ type: 'mic-start' });
      expect(host.querySelector('.mic-slot button.mic.starting')).not.toBeNull();
      show({ ...state(), voice: { ...voice, mic: 'starting' } });
      show({ ...state(), voice });
      expect(host.querySelector('.mic-slot button.mic.listening')).not.toBeNull();
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
    // The same short placeholder in every conversation: the header already names it.
    expect(input.placeholder).toBe('Message…');

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
    const send = host.querySelector<HTMLButtonElement>('.composer > .composer-footer > .composer-end > button.send')!;
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
          // With message details on every message shows its time; one in error shows its state before it.
          at(typed('m4', 'sent'), minute(3)),
          at(typed('m5', 'open'), minute(3)),
          at(typed('m6', 'not-sent', 'The session has ended.'), minute(3)),
        ],
      }),
      new Set(),
      Date.now(),
      false,
      { tab: 'conversation', unopened: new Set(), details: true },
    );

    const line = (id: string) => root.querySelector(`li[data-id="${id}"] .meta`);
    const delivery = (id: string) => line(id)?.querySelector('.delivery') ?? null;

    expect(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => delivery(id)?.textContent ?? null)).toEqual([null, null, null, 'not sent', null, null, 'not sent']);
    expect([...line('m1')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect([...line('m2')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect([...line('m3')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    expect(delivery('m3')?.getAttribute('title')).toBe('not sent · The session has <ended>.');
    expect(line('m3')?.textContent).toMatch(/^not sent\d+:\d\d [AP]M$/);
    expect([...line('m4')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect([...line('m6')!.children].map((child) => child.className)).toEqual(['meta-marks', 'stamp']);
    // Nothing over a bubble: the line, when there is one, is under it.
    expect([...root.querySelectorAll('.message .bubble')].map((bubble) => bubble.firstElementChild?.className)).toEqual(['box', 'box', 'box', 'box', 'box', 'box', 'box']);

    // Without message details only the first message after the divider shows its time; an error state shows alone.
    root.innerHTML = renderConversation(state({ items: [message('m0', minute(0), 'first'), at(typed('m4', 'sent'), minute(3)), at(typed('m6', 'not-sent', 'The session has ended.'), minute(3))] }));
    expect([...line('m0')!.children].map((child) => child.className)).toEqual(['stamp']);
    expect(line('m4')).toBeNull();
    expect([...line('m6')!.children].map((child) => child.className)).toEqual(['meta-marks']);
  });
});

describe('reply links and the secondary side bar', () => {
  it('opens web pages, and files at their line relative to the session folder, and drops other schemes', () => {
    expect(linkTarget('https://github.com/o/r/pull/1', 'D:/w')).toEqual({ url: 'https://github.com/o/r/pull/1' });
    expect(linkTarget('./src/a.ts#L42', 'D:/w')).toMatchObject({ line: 42 });
    expect((linkTarget('./src/a.ts#L42', 'D:/w') as { file: string }).file.replaceAll('\\', '/')).toBe('D:/w/src/a.ts');
    expect(linkTarget('src/b.ts#L4-L9', 'D:/w')).toMatchObject({ line: 4 });
    expect(linkTarget(process.platform === 'win32' ? 'D:/x/c.ts' : '/x/c.ts', null)).toEqual({ file: process.platform === 'win32' ? 'D:/x/c.ts' : '/x/c.ts', line: null });
    expect(linkTarget('src/d.ts', null)).toBeNull();
    expect(linkTarget('javascript:alert(1)', 'D:/w')).toBeNull();
    expect(linkTarget('mailto:x@y.z', 'D:/w')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('opens a file: URL, a drive-letter path and a path with spaces at their line', () => {
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

  it.runIf(process.platform !== 'win32')('opens POSIX files and file URLs at their line', () => {
    expect(linkTarget('/repo/a.ts#L3', null)).toEqual({ file: '/repo/a.ts', line: 3 });
    expect(linkTarget('file:///repo/a%20b.ts#L7', null)).toEqual({ file: '/repo/a b.ts', line: 7 });
    expect(linkTarget('file://localhost/repo/a.ts#L7-L9', null)).toEqual({ file: '/repo/a.ts', line: 7 });
    expect(linkTarget('./my%20dir/a.ts#L2', '/repo')).toEqual({ file: '/repo/my dir/a.ts', line: 2 });
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
    expect(root.querySelector('.status-time')?.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/);
    expect(root.querySelector('.status-time')?.textContent).toBe(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(T0));
    expect(root.querySelector('.status-age')?.textContent).toBe('4 min ago');
    expect(root.querySelector('.status-body h2')?.textContent).toBe('Done <img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.status-body table')).not.toBeNull();
    expect(root.querySelector('[data-action="status-open"]')).not.toBeNull();
    expect(root.querySelector('[data-action="statuses"]')).not.toBeNull();
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
    expect(root.querySelector('.timeline')).toBeNull();

    root.innerHTML = renderConversation(state({ status: status('st-1', 'x') }), new Set(), T0, true, on('status'));
    expect(root.querySelector('.status-head .unread-dot')?.getAttribute('aria-label')).toBe('Updated');
    expect(root.querySelector('.status-head')?.textContent).not.toContain('New');
    expect(root.querySelector('[data-tab="status"] .unread-dot')?.getAttribute('aria-label')).toBe('Updated');
    expect(root.querySelector('[data-tab="status"]')?.getAttribute('aria-label')).toBe('Status, updated');
    expect(root.querySelector('[data-tab="status"] .tab-badge')).toBeNull();
    // A New status that is also unread is named Unread, on the tab and in its head.
    root.innerHTML = renderConversation(state({ status: status('st-1', 'x', { unread: true }) }), new Set(), T0, true, on('status'));
    expect(root.querySelector('.status-head .unread-dot')?.getAttribute('aria-label')).toBe('Unread');
    expect(root.querySelector('[data-tab="status"]')?.getAttribute('aria-label')).toBe('Status, unread');

    // Not on the Conversation tab any more.
    root.innerHTML = renderConversation(state({ status: status('st-1', 'x') }), new Set(), T0, true);
    expect(root.querySelector('.status-tab')).toBeNull();
    expect(root.querySelector('[data-tab="status"] .unread-dot')?.getAttribute('aria-label')).toBe('Updated');

    // The stage stands in, dimmed, with nothing to open; with neither, a line says so.
    root.innerHTML = renderConversation(state({ status: status('stage-2', 'Reading the inbox code', { fallback: true }) }), new Set(), T0, false, on('status'));
    expect(root.querySelector('.status-tab.fallback .status-body')?.textContent).toBe('Reading the inbox code\n');
    expect(root.querySelector('.status-tab.fallback .empty')?.textContent).toBe("No status yet. Until the session reports one, the work item's stage:");
    expect(root.querySelector('[data-action="status-open"]')).toBeNull();
    root.innerHTML = renderConversation(state(), new Set(), T0, false, on('status'));
    expect(root.querySelector('.panel > .empty')?.textContent).toBe('No status yet. It appears here when the session reports one.');
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
    const badge = () => root.querySelector('[data-tab="status"] .unread-dot')?.getAttribute('aria-label') ?? null;

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show({ status: status('stage-2', 'Reading', { fallback: true }) });
    expect(badge()).toBeNull();

    // The first status after the stage, and each that replaces it, is New; on another tab it stays New, however long.
    show({ status: status('st-1', 'First.') });
    expect(badge()).toBe('Updated');
    expect(live.textContent).toBe('New status: First.');
    vi.advanceTimersByTime(5 * STATUS_NEW_MS);
    expect(badge()).toBe('Updated');

    // Shown on the Status tab, it is New for a minute.
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(root.querySelector('.status-head .unread-dot')).not.toBeNull();
    expect(root.querySelector('.status-age')?.textContent).toBe('5 min ago');
    vi.advanceTimersByTime(STATUS_NEW_MS - 1);
    expect(root.querySelector('.status-head .unread-dot')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
    expect(badge()).toBeNull();
    vi.advanceTimersByTime(3 * 60_000);
    expect(root.querySelector('.status-age')?.textContent).toBe('9 min ago');

    // An unread status keeps the tab's dot after its New mark.
    show({ status: status('st-1', 'First.', { unread: true }) });
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
    expect(badge()).toBe('Unread');

    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-head .unread-dot')).not.toBeNull();
    // A redraw with the same status keeps the mark; opening it in the preview clears it.
    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-head .unread-dot')).not.toBeNull();
    root.querySelector<HTMLElement>('[data-action="status-open"]')!.click();
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(posted.filter((message) => message.type.startsWith('status'))).toEqual([{ type: 'status-open', statusId: null }, { type: 'statuses', id: expect.any(Number), before: 'st-2' }]);

    // Another session's first status is not New.
    show({ scope: { ...SCOPE, sessionId: 's5' }, session: { ...SESSION, id: 's5' }, status: status('st-5', 'Other.', { sessionId: 's5' }) });
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
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
    expect(root.querySelector('.status-head .unread-dot')).not.toBeNull();
    vi.advanceTimersByTime(STATUS_NEW_MS);
    expect(root.querySelector('.status-head .unread-dot')).toBeNull();
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

  it('draws the selected conversation as a dropdown that lists every conversation with its state and provider, then New conversation…', () => {
    const closed = renderConversation(base(), new Set(), T0);

    // The plus left the header: New conversation… is in the dropdown.
    expect(closed).not.toContain('data-action="new" title="New conversation" aria-label="New conversation"');
    expect(closed).toContain('class="picker" data-action="picker" aria-haspopup="menu" aria-expanded="false" title="Fix the &#60;inbox&#62; badge"');
    expect(closed).not.toContain('role="menu"');

    const opened = renderConversation(base({ scope: { ...TWO, workItemId: 9, sessionId: 's9' } }), new Set([PICKER]), T0);
    const menu = document.createElement('div');

    menu.innerHTML = opened;
    expect(menu.querySelectorAll('.conversation-menu [role="menuitemradio"]')).toHaveLength(2);
    expect(menu.querySelector('.conversation-menu [aria-checked="true"]')?.getAttribute('data-work-item')).toBe('9');
    // The selected row is highlighted, not checked; no row shows an unread count.
    expect(menu.querySelector('.conversation-row .menu-gutter')).toBeNull();
    expect(menu.querySelector('.conversation-row [aria-checked="true"]')).toBeNull();
    expect(menu.querySelector('.conversation-row[aria-checked="true"]')?.querySelectorAll('.codicon-check')).toHaveLength(0);
    expect(renderConversation({ ...base({ scope: { ...TWO, workItemId: 9, sessionId: 's9' } }), unread: 2 }, new Set([PICKER]), T0)).not.toContain('class="count"');
    // The unread dot marks only a conversation not selected, and the button while one has it; the selected one's own unread items mark nothing here.
    expect(menu.querySelector('.unread-dot')).toBeNull();
    menu.innerHTML = renderConversation({ ...base(), unread: 4 }, new Set([PICKER]), T0);
    expect([...menu.querySelectorAll('.conversation-row')].map((row) => row.querySelector('.unread-dot') !== null)).toEqual([false, true]);
    expect(menu.querySelector('.conversation-row .unread-dot')?.getAttribute('aria-label')).toBe('Unread replies or status');
    expect(menu.querySelector('button.picker .unread-dot')).not.toBeNull();
    menu.innerHTML = renderConversation(base({ scope: { ...TWO, conversations: [SCOPE.conversations[0]!, { ...HOSTED, unread: 0 }] } }), new Set([PICKER]), T0);
    expect(menu.querySelector('.unread-dot')).toBeNull();
    // A separator, then New conversation… last.
    expect([...menu.querySelectorAll('.conversation-menu > li')].slice(-2).map((li) => li.className || li.textContent)).toEqual(['menu-separator', 'New conversation…']);
    expect(menu.querySelector('.conversation-menu > li:last-child button')?.getAttribute('data-action')).toBe('new');

    // Each option shows its session's provider mark after its title; an entry with no provider shows none.
    const marked = renderConversation(base({ scope: { ...TWO, conversations: [{ ...SCOPE.conversations[0]!, provider: 'claude' }, { ...HOSTED, provider: 'codex', unread: 0 }] } }), new Set([PICKER]), T0);
    const list = document.createElement('div');

    list.innerHTML = marked;
    expect([...list.querySelectorAll('.conversation-menu [role="menuitemradio"]')].map((button) => [...button.children].map((child) => child.getAttribute('aria-label') ?? child.className))).toEqual([
      ['Working', 'title', 'Claude'],
      [expect.any(String), 'title', 'Codex'],
    ]);
    // The button shows the selected conversation from the same renderer as its row, then the chevron.
    const row = list.querySelector('.conversation-menu [aria-checked="true"]')!;
    const button = list.querySelector('button.picker')!;

    expect(button.innerHTML).toBe(`${row.innerHTML}<span class="codicon codicon-chevron-down" aria-hidden="true"></span>`);
    list.innerHTML = opened;
    expect(list.querySelector('.conversation-menu .provider')).toBeNull();
  });

  it('draws a folder window with no conversation as its folder name, the plus and a note, with no composer', () => {
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const empty = base({ scope: { ...SCOPE, kind: 'folder', title: 'support<3>', workItemId: null, sessionId: null, cwd: null, conversations: [] }, session: null });
    const html = renderConversation(empty, new Set(), T0);

    // The dropdown with the folder's name, whose menu holds New conversation….
    expect(html).toContain('title="support&#60;3&#62;"><span class="codicon codicon-folder" aria-hidden="true"></span><span class="title">support&#60;3&#62;</span>');
    expect(renderConversation(empty, new Set([PICKER]), T0)).toContain('data-action="new"');
    expect(html).toContain('No conversation in this folder yet. Start one with New conversation… in the menu above.');
    expect(html).not.toContain('data-action="terminal"');

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string }> = [];

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: { type: string }) => posted.push(message), getState: () => null, setState: () => {} }, host);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: empty } }));
    expect(host.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('button.picker')!.click();
    root.querySelector<HTMLButtonElement>('button[data-action="new"]')!.click();
    expect(posted.filter((message) => message.type === 'providers')).toHaveLength(1);

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
    expect(root.querySelector('.conversation-menu')).toBeNull();
    // New conversation… in the dropdown opens a menu of providers under it; a choice posts new with it.
    root.querySelector<HTMLButtonElement>('button.picker')!.click();
    root.querySelector<HTMLButtonElement>('button[data-action="new"]')!.click();
    expect(root.querySelector('.conversation-menu')).toBeNull();

    const asked = posted.find((message) => message.type === 'providers')!;

    expect(root.querySelector('.header-menu')?.textContent).toBe('Loading…');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'menu', id: asked['id'], items: [{ value: 'codex', label: 'Codex', note: 'Default', current: false }, { value: 'claude', label: 'Claude', note: '', current: false }], error: null } }));
    expect([...root.querySelectorAll('.header-menu button')].map((one) => one.textContent)).toEqual(['CodexDefault', 'Claude']);
    root.querySelector<HTMLButtonElement>('.header-menu button[data-value="claude"]')!.click();
    expect(posted.filter((message) => message.type === 'new')).toEqual([{ type: 'new', provider: 'claude' }]);
    expect(root.querySelector('.header-menu')).toBeNull();

    // A draft stays with its conversation.
    input.value = 'Draft for the work item';
    show(hosted);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Message…');
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
    expect(root.querySelectorAll('.timeline > li[data-id]')).toHaveLength(2);
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

describe('the conversation dropdown (architecture.md § Conversation view)', () => {
  it('closes on a press outside the header and on Escape, and stays open for a press inside it', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const two: ScopeView = { ...SCOPE, conversations: [...SCOPE.conversations, { ...SCOPE.conversations[0]!, workItemId: 3, title: 'Side', primary: false }] };

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: () => undefined, getState: () => null, setState: () => undefined });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)], { scope: two })) } }));

    const toggle = () => root.querySelector<HTMLElement>('button.picker')!.click();
    const press = (element: Element) => element.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    toggle();
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    press(root.querySelector('.conversation-menu')!);
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    press(root.querySelector('.timeline')!);
    expect(root.querySelector('.conversation-menu')).toBeNull();
    toggle();
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.conversation-menu')).toBeNull();
    expect(document.activeElement?.classList.contains('picker')).toBe(true);
  });
});

describe('the composer on every tab (architecture.md § Conversation view)', () => {
  it('keeps the composer on the Status and Artifacts tabs, stays on the tab after a send there with a short Sent line, and shows an ended session\'s note with Resume above it', () => {
    vi.useFakeTimers();

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<Record<string, unknown>> = [];

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, { postMessage: (message: unknown) => posted.push(message as Record<string, unknown>), getState: () => null, setState: () => undefined }, host);

    const show = (shown: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: shown } }));

    show(applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)])));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(host.hidden).toBe(false);

    const input = host.querySelector('textarea')!;

    input.value = 'From the status';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const send = posted.find((one) => one['type'] === 'send')!;

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sent', id: send['id'], error: null } }));
    expect(document.body.dataset['tab']).toBe('status');
    expect(host.querySelector<HTMLElement>('.composer-sent')!.hidden).toBe(false);
    vi.advanceTimersByTime(SENT_NOTE_MS);
    expect(host.querySelector<HTMLElement>('.composer-sent')!.hidden).toBe(true);

    // An ended session: its reason just above the composer on every tab, with Resume, and not at the top of the conversation.
    show(applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)], { sessions: [{ ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' }] })));
    expect(root.lastElementChild?.classList.contains('session-note')).toBe(true);
    expect(root.querySelector('.session-note-text')?.textContent).toBe('The session has ended. Open it in the terminal to resume it.');
    root.querySelector<HTMLElement>('.session-note [data-action="terminal"]')!.click();
    expect(posted.at(-1)).toEqual({ type: 'terminal' });
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    expect(root.querySelector('.notice')).toBeNull();
    expect(root.lastElementChild?.classList.contains('session-note')).toBe(true);
    vi.useRealTimers();
  });
});

describe('inline menus and lists instead of quick picks (architecture.md § Conversation view)', () => {
  const start = () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<Record<string, unknown>> = [];

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: (message: unknown) => posted.push(message as Record<string, unknown>), getState: () => null, setState: () => undefined });

    return { root, posted, send: (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data })) };
  };

  it('opens the persona roster as a menu under the header, pins or clears from it with the keys, and closes on Escape', () => {
    const { root, posted, send } = start();
    const persona = { id: 'nova', name: 'Nova', pinned: true, tonePending: false };

    send({ type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)], { sessions: [{ ...SESSION, persona }] })) });

    const button = root.querySelector<HTMLButtonElement>('button.persona')!;

    button.focus();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');

    const asked = posted.find((one) => one['type'] === 'personas')!;

    send({ type: 'menu', id: asked['id'], items: [{ value: 'nova', label: 'Nova', note: 'Pinned', current: true }, { value: 'iris', label: 'Iris', note: '', current: false }, { value: '', label: 'Clear pin', note: '', current: false }], error: null });
    // The first choice takes the focus, Down moves, Enter on a button picks.
    expect(document.activeElement?.getAttribute('data-value')).toBe('nova');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-value')).toBe('iris');
    (document.activeElement as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: 'persona', personaId: 'iris', target: { scopeGen: 1, sessionId: 's2' } });
    expect(root.querySelector('.header-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('button.persona'));

    root.querySelector<HTMLButtonElement>('button.persona')!.click();
    send({ type: 'menu', id: posted.at(-1)!['id'], items: [{ value: '', label: 'Clear pin', note: '', current: false }], error: null });
    root.querySelector<HTMLButtonElement>('.header-menu button')!.click();
    expect(posted.at(-1)).toMatchObject({ type: 'persona', personaId: null });

    // Escape closes it; a reply for a menu no longer open is dropped; a refusal shows in the menu.
    root.querySelector<HTMLButtonElement>('button.persona')!.click();
    const third = posted.at(-1)!['id'];

    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.header-menu')).toBeNull();
    send({ type: 'menu', id: third, items: [], error: null });
    expect(root.querySelector('.header-menu')).toBeNull();
    root.querySelector<HTMLButtonElement>('button.persona')!.click();
    send({ type: 'menu', id: posted.at(-1)!['id'], items: [], error: 'The hub did not answer.' });
    expect(root.querySelector('.header-menu')?.textContent).toBe('The hub did not answer.');
  });

  it('opens the roster from the plain persona button of a session with none and pins the one picked', () => {
    const { root, posted, send } = start();

    send({ type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)], { sessions: [{ ...SESSION, persona: null, canPin: true }] })) });
    root.querySelector<HTMLButtonElement>('button.persona')!.click();

    const asked = posted.find((one) => one['type'] === 'personas')!;

    send({ type: 'menu', id: asked['id'], items: [{ value: 'nova', label: 'Nova', note: '', current: false }], error: null });
    expect(root.querySelector('.header-menu [aria-checked="true"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('.header-menu button')!.click();
    expect(posted.at(-1)).toEqual({ type: 'persona', personaId: 'nova', target: { scopeGen: 1, sessionId: 's2' } });
  });

  it('lists the earlier statuses in a menu under the history button, pages back with Older statuses, and opens one in the preview', () => {
    const { root, posted, send } = start();
    const status = (id: string, at: number, markdown: string): StatusView => ({ id, sessionId: 's2', at, markdown, fallback: false, unread: false });

    send({ type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([], { status: status('st-9', T0, 'Now.') })) });
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(posted.at(-1)).toMatchObject({ type: 'statuses', before: 'st-9' });
    expect(root.querySelector('.status-actions .menu-anchor > .earlier-menu.menu')?.textContent).toContain('Loading…');
    send({ type: 'statuses', id: posted.at(-1)!['id'], statuses: [status('st-8', T0 - 60_000, '## Built it'), status('st-7', T0 - 120_000, 'Started.')], more: true, error: null });
    expect([...root.querySelectorAll('.earlier-status .title')].map((one) => one.textContent)).toEqual(['Built it', 'Started.']);
    // Each row's time is its note at the right; Older statuses follows a separator.
    expect(root.querySelector('.earlier-status .menu-note')?.textContent).toMatch(/\d:\d\d [AP]M$/);
    expect(root.querySelector('[data-action="statuses-more"]')?.closest('li')?.previousElementSibling?.className).toBe('menu-separator');
    root.querySelector<HTMLElement>('[data-action="statuses-more"]')!.focus();
    root.querySelector<HTMLElement>('[data-action="statuses-more"]')!.click();
    expect(posted.at(-1)).toMatchObject({ type: 'statuses', before: 'st-7' });
    send({ type: 'statuses', id: posted.at(-1)!['id'], statuses: [status('st-6', T0 - 180_000, 'Planned.')], more: false, error: null });
    // Older statuses gave way to Loading…; the focus lands on the first status it brought.
    expect((document.activeElement as HTMLElement | null)?.dataset['status']).toBe('st-6');
    expect(root.querySelectorAll('.earlier-status')).toHaveLength(3);
    expect(root.querySelector('[data-action="statuses-more"]')).toBeNull();
    root.querySelector<HTMLElement>('.earlier-status[data-status="st-8"]')!.click();
    expect(posted.at(-1)).toEqual({ type: 'status-open', statusId: 'st-8' });
    // The history button closes the menu again, as Escape and a press outside it do.
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(root.querySelector('.earlier-menu')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(root.querySelector('.earlier-menu')).not.toBeNull();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.earlier-menu')).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset['action']).toBe('statuses');
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    root.querySelector('.status-body')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.earlier-menu')).toBeNull();

    // Escape that closes the menu leaves a reply being spoken alone.
    send({ type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([], { status: status('st-9', T0, 'Now.'), voice: { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null, recognizer: null } })) });
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.earlier-menu')).toBeNull();
    expect(posted.some((message) => message.type === 'stop-speaking')).toBe(false);
  });
  it("opens a menu down and to the right of its button, and to the left only where the view has no room, from the menu.css it shares with the web page", () => {
    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');
    const shared = readFileSync(require.resolve('@switchboard/conversation/menu.css'), 'utf8');
    let anchorLeft = 40;

    expect(shared).toMatch(/\n\.menu \{[^}]*top: calc\(100% \+ 2px\); left: 0;/);
    expect(css).not.toMatch(/(^|\n)\.menu \{|align-right/);
    expect(readFileSync(join(__dirname, '../esbuild.js'), 'utf8')).toContain("'@switchboard/conversation/menu.css'");
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    const rect = (element: HTMLElement): DOMRect => {
      // A menu in its default place: under its anchor, left edges lined up.
      const anchor = element.classList.contains('menu') ? rect(element.parentElement!) : null;
      const left = anchor?.left ?? anchorLeft;
      const top = anchor === null ? 8 : anchor.bottom + 2;
      const [width, height] = anchor === null ? [24, 24] : [200, 120];

      return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    };

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this);
    });

    try {
      const { root, send } = start();

      send({ type: 'state', state: applyEvent(EMPTY_CONVERSATION, hello([], { status: { id: 'st-9', sessionId: 's2', at: T0, markdown: 'Now.', fallback: false, unread: false } })) });
      root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
      root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
      expect(root.querySelector('.earlier-menu')!.className).toBe('glass menu earlier-menu');
      expect(root.querySelector<HTMLElement>('.earlier-menu')!.style.maxWidth).toBe('360px');
      anchorLeft = 770;
      window.dispatchEvent(new Event('resize'));
      expect(root.querySelector('.earlier-menu')!.className).toBe('glass menu earlier-menu flip-x');
      // A scroll that moves the button is followed; the menu's own scrolling is not.
      anchorLeft = 40;
      root.querySelector('.earlier-menu')!.dispatchEvent(new Event('scroll'));
      expect(root.querySelector('.earlier-menu')!.className).toBe('glass menu earlier-menu flip-x');
      root.dispatchEvent(new Event('scroll'));
      expect(root.querySelector('.earlier-menu')!.className).toBe('glass menu earlier-menu');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('review round 1 (cross-check)', () => {
  const extension = () => {
    const root = document.createElement('div');
    const live = document.createElement('div');

    document.body.replaceChildren(root, live);
    startConversation(root, live, { postMessage: () => undefined, getState: () => null, setState: () => undefined });

    return { root, show: (patch: Partial<ConversationState> = {}) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: { ...applyEvent(EMPTY_CONVERSATION, hello([reply('r1', T0)])), ...patch } } })) };
  };
  const waiting: SessionView = { ...SESSION, state: 'waiting', waitingFor: 'question', persona: { id: 'p', name: 'Persona', pinned: false, tonePending: false } };

  it('keeps the text between two runs of questions, folding the first and leaving out the last, which ends the message', () => {
    const html = withoutQuestions('1. First?\n - A) One\n - B) Two\n\nIMPORTANT MIDDLE PARAGRAPH\n\n2. Second?\n - A) Three\n - B) Four', 'reply:r', new Set());
    const host = document.createElement('div');

    host.innerHTML = html;
    expect(host.textContent).toContain('IMPORTANT MIDDLE PARAGRAPH');
    expect(host.querySelectorAll('details.questions-fold')).toHaveLength(1);
    expect(host.querySelector('details.questions-fold')?.textContent).toContain('First?');
    expect(host.textContent).not.toContain('Second?');
  });

  it('opens one header menu at a time', () => {
    const { root, show } = extension();

    show({ session: waiting });
    root.querySelector<HTMLElement>('[data-action="persona"]')!.click();
    root.querySelector<HTMLElement>('[data-action="picker"]')!.click();
    expect(root.querySelectorAll('.conversation-menu')).toHaveLength(1);
    expect(root.querySelector('.header-menu')).toBeNull();
  });

  it("keeps each Codex request's typed answer with its own request when another goes", () => {
    const { root, show } = extension();
    const request = (id: string) => ({ id, kind: 'question' as const, title: id, decisions: [], questions: [{ id: 'answer', question: id, options: [] }] });

    show({ session: { ...waiting, requests: [request('a'), request('b')] } });

    const first = root.querySelector<HTMLInputElement>('.request-field')!;

    first.focus();
    first.value = 'Answer for a';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    show({ session: { ...waiting, requests: [request('b')] } });
    expect(root.querySelector<HTMLInputElement>('.request-field')!.value).toBe('');
  });

  it('follows a height change smaller than the at-end margin to the actual end', () => {
    const { root, show } = extension();

    show();

    const scroll = root.querySelector<HTMLElement>('.scroll')!;
    let top = 100;
    let height = 200;

    Object.defineProperties(scroll, { scrollHeight: { get: () => height }, clientHeight: { get: () => 100 }, scrollTop: { get: () => top, set: (value: number) => void (top = Math.min(value, height - 100)) } });
    show();
    height = 212;
    show();
    expect(scroll.scrollTop).toBe(112);
  });

  it('keeps the ended note and Resume for an ended Codex session, whose reason is null since a message resumes it', () => {
    const { root, show } = extension();

    show({ session: { ...SESSION, provider: 'codex', state: 'ended', waitingFor: null, conversation: 'full', reason: null } });
    expect(root.querySelector('.session-note [data-action="terminal"]')?.textContent).toBe('Resume');
    expect(root.querySelector('.session-note-text')?.textContent).toBe('The session has ended. A message or Resume continues it.');
  });
});
