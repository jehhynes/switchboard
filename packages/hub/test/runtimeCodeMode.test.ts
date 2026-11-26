import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeRunner, CODE_MODE_IDLE_MS, conversationRules, markerState, projectSlug, readMarkers, rosterState } from '@switchboard/claude';
import type { RosterEntry } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec, ExecResult } from '@switchboard/claude';
import { BACKOFF_MS, CLI_MARGIN_MS, CONTINUE_TEXT, CONVERSATION_RETENTION, DEFAULT_SETTINGS, launchOptions, MESSAGES, parsePlaybook, QUESTION_CARD, Store, toneSection, toneVersion, UNCONFIRMED_DONE } from '@switchboard/core';
import { recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { NotWritten } from '@switchboard/conversation';
import { markOf } from '@switchboard/core/group';
import type { ContextResult, CopyRelation, Playbook, PolledTicket, PollResult, PullRequestStatus, Session, SessionRunner, Settings, Source, StartAction, Ticket } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { HolderConnection } from '../src/holder.js';
import { ConversationService } from '../src/conversation.js';
import { WindowScopes } from '../src/windows.js';
import { ATTACH_RESERVATION_MS, INPUT_SETTLE_MS, PULL_REQUESTS_FOCUS_MS, questionCardOpen, REPORT_CHECK_MS, MARKER_MS, RECHECK_MS, MARKER_WATCH_RETRY_MS, repoKeysOf, Runtime, SESSION_ENDED, SESSION_RELAUNCHED, triageText, WAKE_MS } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { controlsOf, doneSince } from '../src/rows.js';
import { dockView } from '../src/dock.js';
import { questionIndex, QUESTIONS_SINCE } from '../src/questions.js';
import { T0, home, config, fail, issue, deferred, setup, fakeRunner, twoSessions, transcriptSession } from './runtimeFixtures.js';

describe('Code Mode sessions (PRD R93-R95)', () => {

  it('starts a Code Mode session with the Code Mode runner and records its launch', async () => {
    const claude = fakeRunner();
    const codeMode = fakeRunner();
    const { runtime, store } = setup(config(), () => T0, { claude, codeMode });

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: false });
    const session = { id: 's9', workItemId: 1, kind: 'task' as const, provider: 'claude' as const, cwd: 'D:/git/widgets', state: 'starting' as const, stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: null, shortId: null, codeMode: true, launchId: null };

    store.insertSession(session);
    await runtime['run']({ type: 'start-session', sessionId: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'auto', model: null, codeMode: true });

    expect(codeMode.starts).toEqual(['s9']);
    expect(claude.starts).toEqual([]);
    expect(store.session('s9')).toMatchObject({ state: 'running', nativeSessionId: 's9-native', launchId: 's9-launch' });
    runtime.stop();
  });

  it('starts new Claude sessions with the Code Mode runner while sessions.codeMode is on, with the IDs stored before the start', async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const claude = fakeRunner();
    const seen: { action: StartAction; stored: Session | null }[] = [];
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { claude, codeMode });

    codeMode.start = async (action) => {
      seen.push({ action, stored: context.store.session(action.sessionId) });
      return { shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! };
    };
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    expect(claude.starts).toEqual([]);
    expect(seen).toHaveLength(1);
    const [{ action, stored }] = seen as [(typeof seen)[number]];
    expect(action).toMatchObject({ provider: 'claude', codeMode: true, nativeSessionId: expect.stringMatching(UUID), launchId: expect.stringMatching(UUID) });
    expect(action.nativeSessionId).not.toBe(action.launchId);
    expect(stored).toMatchObject({ state: 'starting', codeMode: true, nativeSessionId: action.nativeSessionId, launchId: action.launchId });
    expect(context.store.session(action.sessionId)).toMatchObject({ state: 'running', shortId: action.nativeSessionId!.slice(0, 8) });
    context.runtime.stop();
  });

  it('defers a held turn end until a conversation read only asynchronously is in, and drops it for a newer state (PRD R103)', async () => {
    const codeMode = fakeRunner();
    const { runtime, store } = setup(config({ codeMode: true }), () => T0, { codeMode });

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const id = store.activeSessions()[0]!.id;
    let release = (): void => {};
    let held = true;
    runtime.setConversationReader({
      read: () => {},
      catchUp: () => (held ? new Promise<void>((resolve) => { release = () => { held = false; resolve(); }; }) : null),
    });

    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(store.session(id)?.state).toBe('running');
    store.addReply({ id: 'r1', sessionId: id, workItemId: 1, at: T0, kind: 'reply', answers: null, opening: '1. Which?\n   - A) One\n   - B) Two', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: 'r1' });
    release();
    await runtime.settled();
    expect(store.session(id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');

    // A held idle marker that a newer state overtook is dropped.
    held = true;
    runtime.send({ type: 'marker', sessionId: id, state: 'running', detail: null });
    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    const deferredRelease = release;
    held = false;
    runtime.send({ type: 'marker', sessionId: id, state: 'waiting', detail: null });
    deferredRelease();
    await runtime.settled();
    expect(store.session(id)?.state).toBe('waiting');
    runtime.stop();
  });

  it.each([false, true])('drops a deferred turn end after shutdown, including a rejected read (%s)', async (reject) => {
    const { runtime, store, logs } = setup(config({ codeMode: true }), () => T0, { codeMode: fakeRunner() });
    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const id = store.activeSessions()[0]!.id;
    let finish = (): void => {};
    runtime.setConversationReader({
      read: () => {},
      catchUp: () => new Promise<void>((resolve, fail) => { finish = () => reject ? fail(new Error('disconnected')) : resolve(); }),
    });
    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    runtime.stop();
    store.close();
    logs.length = 0;
    finish();
    await runtime.settled();
    expect(logs).toEqual([]);
  });

  it('keeps a question open across more replies than one page and an unrelated message, until it is answered or withdrawn (PRD R103)', () => {
    const store = Store.open(':memory:');
    const reply = (id: string, opening: string, at: number, kind: 'reply' | 'aside' = 'reply') => store.addReply({ id, sessionId: 's1', workItemId: 1, at, kind, answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });
    const message = (id: string, text: string, at: number, answers: Array<{ replyId: string; slug: string; letters: string[]; other: string; via: 'card' | 'typed' | 'voice' }> | null = []) =>
      store.addMessage({ id, sessionId: 's1', workItemId: 1, at, origin: 'typed', text, transcriptUuid: id, provisional: false, withdrawn: false, delivery: 'sent', error: null, opId: null, pastedAt: null, answers });
    const since = T0;

    message('m1', 'Go', T0);
    reply('card', '1. Which port? {#port-choice}\n   - A) One\n   - B) Two\n2. Keep the route? {#keep-route}\n   - A) Yes\n   - B) No', T0 + 1);
    for (let index = 0; index < 150; index++) reply(`r${index}`, `Step ${index}.`, T0 + 2 + index, 'aside');
    expect(questionCardOpen(store, 's1', since)).toBe(true);

    // A message that answers nothing, and a reply with text, leave both open; a status never asks.
    message('m2', 'Hold off on the route for now.', T0 + 200);
    reply('later', 'Working on the rest.', T0 + 201);
    expect(questionCardOpen(store, 's1', since)).toBe(true);

    // A stored answer settles one; a withdraw line the other.
    message('m3', '[answers]\n- port-choice: Which port? → A) One', T0 + 300, [{ replyId: 'card', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }]);
    expect(questionCardOpen(store, 's1', since)).toBe(true);
    reply('done', 'Dropping that.\n[withdraw: keep-route]', T0 + 301);
    expect(questionCardOpen(store, 's1', since)).toBe(false);

    // A question the operator dismissed no longer counts.
    reply('again', '1. Which colour? {#colour-choice}\n   - A) Red\n   - B) Blue', T0 + 400);
    expect(questionCardOpen(store, 's1', since)).toBe(true);
    store.addDismissal('s1', 'again', 'colour-choice', T0 + 401);
    expect(questionCardOpen(store, 's1', since)).toBe(false);
    store.close();
  });

  it('keeps an unanswered question past the conversation\'s retention and a restart, until it is answered (PRD R103)', () => {
    const file = join(home, 'carry.db');
    let store = Store.open(file);
    let at = T0;
    const reply = (id: string, opening: string, kind: 'reply' | 'aside' = 'reply') =>
      store.addReply({ id, sessionId: 's1', workItemId: 1, at: ++at, kind, answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });
    const answer = (id: string, delivery: 'open' | 'not-sent') =>
      store.addMessage({ id, sessionId: 's1', workItemId: 1, at: ++at, origin: 'typed', text: '[answers]', transcriptUuid: null, provisional: true, withdrawn: false, delivery, error: null, opId: null, pastedAt: null, answers: [{ replyId: 'card', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }] });
    // In one transaction, so the file store does not sync each of hundreds of writes to disk.
    const asides = (count: number) =>
      store.transaction(() => {
        for (let index = 0; index < count; index++) reply(`a${at}`, 'Step.', 'aside');
      });

    store.setPagePref(QUESTIONS_SINCE, String(T0));
    questionIndex(store, () => at);
    reply('card', '1. Which port? {#port-choice}\n   - A) One\n   - B) Two\n2. Keep the route? {#keep-route}\n   - A) Yes\n   - B) No');
    store.addDismissal('s1', 'card', 'keep-route', ++at, 'card');
    asides(CONVERSATION_RETENTION + 20);
    expect(store.reply('card')).toBeNull();
    expect(questionCardOpen(store, 's1', T0)).toBe(true);
    // The dismissal is kept too, so the next answer message still tells the session.
    expect([...questionIndex(store).ledger('s1', T0).questions.values()].map((one) => [one.key, one.state])).toEqual([
      ['reply:card#port-choice', 'open'],
      ['reply:card#keep-route', 'dismissed'],
    ]);

    store.close();
    store = Store.open(file);
    expect(questionCardOpen(store, 's1', T0)).toBe(true);
    // An answer that was not sent leaves it open; one on its way settles it while later items arrive, and once its transcript line is read and
    // retention deletes it too, it stays settled.
    answer('failed', 'not-sent');
    expect(questionCardOpen(store, 's1', T0)).toBe(true);
    answer('sent', 'open');
    expect(questionCardOpen(store, 's1', T0)).toBe(false);
    asides(20);
    expect(questionCardOpen(store, 's1', T0)).toBe(false);
    store.updateMessage('sent', { provisional: false, delivery: 'sent', transcriptUuid: 'sent' });
    store.placeLast('sent');
    expect(questionCardOpen(store, 's1', T0)).toBe(false);
    asides(CONVERSATION_RETENTION);
    expect(store.message('sent')).toBeNull();
    expect(questionCardOpen(store, 's1', T0)).toBe(false);
    expect((store.questionCarry('s1') as Array<{ key: string }>).map((one) => one.key)).toEqual(['reply:card#keep-route']);
    store.close();
  });

  it('keeps the old rules for a card asked before the cutover: the next message settles it (PRD R103)', () => {
    const store = Store.open(':memory:');

    store.addReply({ id: 'old', sessionId: 's1', workItemId: 1, at: T0, kind: 'reply', answers: null, opening: '1. Which?\n   - A) One\n   - B) Two', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: 'old' });
    expect(questionCardOpen(store, 's1', T0 + 1000)).toBe(true);
    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: T0 + 1, origin: 'terminal', text: 'something else', transcriptUuid: 'm1', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    expect(questionCardOpen(store, 's1', T0 + 1000)).toBe(false);
    // The same card after the cutover stays open.
    expect(questionCardOpen(store, 's1', T0 - 1)).toBe(true);
    store.close();
  });

  it('ends a wait on questions when the operator dismisses the last one outside a turn (PRD R103)', async () => {
    const codeMode = fakeRunner();
    const { runtime, store } = setup(config({ codeMode: true }), () => T0, { codeMode });

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const id = store.activeSessions()[0]!.id;

    runtime.setConversationReader({ read: () => {}, catchUp: () => null });
    store.addReply({ id: 'r1', sessionId: id, workItemId: 1, at: T0 + 10, kind: 'reply', answers: null, opening: '1. Which? {#which-port}\n   - A) One\n   - B) Two', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: 'r1' });
    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    await runtime.settled();
    expect(store.session(id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });

    // Nothing settled yet: the wait stays.
    runtime.questionsSettled(id);
    expect(store.session(id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    store.addDismissal(id, 'r1', 'which-port', T0 + 20);
    runtime.questionsSettled(id);
    await runtime.settled();
    expect(store.session(id)).toMatchObject({ state: 'idle', stateDetail: null });
    runtime.stop();
  });

  it('reads the conversation before a held turn ends, so a question card written last keeps its work item waiting on the answer (PRD R103)', async () => {
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { codeMode });
    const { runtime, store } = context;
    const reads: string[][] = [];

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const session = store.activeSessions()[0]!;
    const reply = (id: string, opening: string) => store.addReply({ id, sessionId: session.id, workItemId: 1, at: T0, kind: 'reply', answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });

    store.addMessage({ id: 'm1', sessionId: session.id, workItemId: 1, at: T0, origin: 'terminal', text: 'Start', transcriptUuid: 'm1', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    // The card reaches the store only through the read the turn's end asks for, as a transcript line read between polls does.
    runtime.setConversationReader({
      read: (ids) => {
        reads.push([...ids]);
        reply('r1', 'Before I go on:\n\n1. Which port?\n   - A) 8765\n   - B) 8799');
      },
      catchUp: () => null,
    });
    runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });

    expect(reads).toEqual([[session.id]]);
    expect(store.session(session.id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');
    expect(markOf({ ...store.workItem(1)!, sessions: store.sessionsFor(1), triage: null, approvalSends: false })).toBe('question');

    // The marker keeps reading idle while the card waits; that is no change to send again.
    codeMode.markers = () => new Map([[session.nativeSessionId!, { at: 1, observed: { state: 'idle' as const, detail: null }, recheck: false }]]);
    const sent = vi.spyOn(runtime, 'send');
    runtime.readMarkers();
    expect(sent).not.toHaveBeenCalled();
    // A session already idle needs no read before the flow decides.
    runtime.send({ type: 'roster', sessions: [{ sessionId: session.id, state: 'idle', detail: null }] });
    expect(reads).toHaveLength(1);

    // Once a message answers the card, the next idle reading settles the turn as before: this prompt offers done, so it blocks.
    store.addMessage({ id: 'm2', sessionId: session.id, workItemId: 1, at: T0 + 1, origin: 'terminal', text: '1A', transcriptUuid: 'm2', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    runtime.send({ type: 'roster', sessions: [{ sessionId: session.id, state: 'idle', detail: null }] });
    expect(store.session(session.id)?.stateDetail).toBeNull();
    expect(store.workItem(1)?.status).toBe('blocked');
    runtime.stop();
  });


  it("holds a Code Mode turn end until the transcript's turn end is written, so a question card written last keeps its work item running (PRD R103)", async () => {
    const { runtime, store, service, session, sleeps, lines, append } = await transcriptSession();

    runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });
    expect(store.session(session.id)?.state).toBe('running');
    append(lines.question, lines.hooks, lines.duration);
    await runtime.settled();

    expect(sleeps.length).toBeGreaterThan(0);
    expect(store.session(session.id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');
    expect(markOf({ ...store.workItem(1)!, sessions: store.sessionsFor(1), triage: null, approvalSends: false })).toBe('question');

    // The next turn end, its lines already written, is decided at once.
    append(lines.prompt.replace('u1', 'u2'), lines.question.replace('a1', 'a2'), lines.hooks.replace('s1', 's3'));
    runtime.send({ type: 'marker', sessionId: session.id, state: 'running', detail: null });
    const waited = sleeps.length;
    runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });
    expect(store.session(session.id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(sleeps.length).toBe(waited);
    runtime.stop();
    service.stop();
  });

  it('applies a Code Mode turn end after about 2 s when the transcript never shows the turn ending (PRD R103)', async () => {
    const { runtime, store, service, session, sleeps, lines, append } = await transcriptSession();

    runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });
    append(lines.question);
    expect(store.session(session.id)?.state).toBe('running');
    await runtime.settled();

    expect(sleeps).toEqual(Array.from({ length: 40 }, () => 50));
    expect(store.session(session.id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');
    runtime.stop();
    service.stop();
  });

  it('gives a Code Mode session the conversation rules after a resume and with its contract after a compaction', async () => {
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { codeMode });

    codeMode.start = async (action) => ({ shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;

    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toBe(conversationRules(join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`)));
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toContain(`artifact folder, \`${join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`)}\``);
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toMatch(/^Report to Switchboard with these commands:\n[\s\S]*\n\n## Conversation view\n/);
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).not.toContain('## Spoken replies');

    // With voice on, the rules carry the spoken-reply section, after a resume and after a compaction.
    const voiced = config({ codeMode: true });

    context.runtime.reload({ ...voiced, settings: { ...voiced.settings, voice: { ...voiced.settings.voice, enabled: true } } });
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toBe(conversationRules(join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`), true));
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toContain('## Spoken replies');
    context.runtime.stop();
  });

  it("gives a Code Mode session its persona's tone section last, as the settings have it now, and records it (architecture.md § Personas)", async () => {
    const codeMode = fakeRunner();
    const base = config({ codeMode: true });
    const nova = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and direct.' } as const;
    const orion = { id: 'orion', name: 'Orion', voice: 'ash', style: 'none', personality: 'Terse.' } as const;
    const voiced = { ...base, settings: { ...base.settings, voice: { ...base.settings.voice, enabled: true, personas: [nova, orion] } } };
    const context = setup(voiced, () => T0, { codeMode });
    const starts: StartAction[] = [];

    codeMode.start = async (action) => (starts.push(action), { shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;

    expect(starts[0]?.tone).toBe(toneSection(nova));
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toMatch(/\n\n## Persona\nIn this session you are Nova\. Warm and direct\.\n[^#]*$/);

    // A persona changed since the launch, as an older hub's pin left it, waits for the hook, which records the section it gave.
    context.store.updateSession(session.id, { personaId: 'orion' });
    expect(context.store.session(session.id)?.personaVersion).toBe(toneVersion(toneSection(nova)));
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toContain('In this session you are Orion. Terse.');
    expect(context.store.session(session.id)?.personaVersion).toBe(toneVersion(toneSection(orion)));

    // With voice off, a reset in place of the section the launch's prompt may still carry.
    context.runtime.reload(base);
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toMatch(/\n\n## Persona\nNo persona applies in this session any more: ignore any earlier Persona section\.$/);
    expect(context.store.session(session.id)?.personaVersion).toBeNull();
    context.runtime.stop();
  });

  it('gives a session Switchboard does not hold nothing after a resume, which keeps its contract, and only its contract after a compaction', async () => {
    const { source, runtime, store } = setup();

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s1', { codeMode: false, launchId: null });

    const native = store.session('s1')!.nativeSessionId!;

    expect(runtime.contract(native, 'resume')).toBeNull();
    expect(runtime.contract(native, 'compact')).not.toContain('## Conversation view');
    runtime.stop();
  });

  it('applies the Claude roster\'s observation when the holder read fails, and changes no held session', async () => {
    const codeMode = fakeRunner({ observe: async () => ({ error: 'The terminal holder did not answer.' }) });
    const { runtime, store, claude, logs } = await twoSessions(codeMode);

    claude.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    await runtime.readRoster();

    // The roster's turn end applied; a session Switchboard does not hold is never stopped.
    expect(claude.stops).toEqual([]);
    expect(store.session('s1')).toMatchObject({ state: 'idle' });
    expect(store.session('s2')).toMatchObject({ state: 'running', released: false });
    expect(logs).toContain('sessions: could not list running Code Mode sessions: The terminal holder did not answer; trying again');
    runtime.stop();
  });

  it('ends the sessions of a gone holder with the cause, not as finished runs', async () => {
    const codeMode = fakeRunner({ observe: async () => ({ sessions: [], forks: [], gone: true }) });
    const { runtime, store } = await twoSessions(codeMode);

    await runtime.readRoster();

    expect(store.session('s2')).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'The terminal holder stopped.' });
    expect(store.workItem(store.session('s2')!.workItemId)).toMatchObject({ status: 'blocked', error: 'The terminal holder stopped.' });
    expect(store.session('s1')).toMatchObject({ state: 'running' });
    runtime.stop();
  });

  it('defers the idle end of a held session while a terminal is attached, then ends it at a later read', async () => {
    let clients = 1;
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients, lastInputAt: null }) });
    const { runtime, store, logs } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })), idle: ['s2'] });
    await runtime.readRoster();
    await runtime.settled();

    expect(store.session('s2')).toMatchObject({ state: 'idle', releasing: true, released: false });
    expect(codeMode.stops).toEqual([]);
    expect(logs).toContain('end of held session s2 deferred: 1 terminal is attached');

    clients = 0;
    await runtime.readRoster();
    await runtime.settled();

    expect(codeMode.stops).toEqual(['s2']);
    expect(store.session('s2')).toMatchObject({ state: 'ended', released: true, releasing: false });
    runtime.stop();
  });

  it('drops a deferred end once a new turn cancels it', async () => {
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 1, lastInputAt: null }) });
    const { runtime, store, logs } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })), idle: ['s2'] });
    await runtime.readRoster();
    await runtime.settled();
    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) });
    await runtime.readRoster();
    await runtime.settled();

    await runtime.readRoster();
    await runtime.settled();

    expect(store.session('s2')).toMatchObject({ state: 'running', releasing: false, released: false });
    expect(codeMode.stops).toEqual([]);
    expect(logs.filter((line) => line.startsWith('end of held session s2'))).toEqual(['end of held session s2 deferred: 1 terminal is attached']);
    runtime.stop();
  });

  it('ends the held sessions when a holder lookup finds none, as before a start replaces it, but not a starting one', async () => {
    const { runtime, store, logs } = await twoSessions(fakeRunner());

    store.updateSession('s1', { codeMode: true, state: 'starting' });
    expect(await runtime['holder'].find(false)).toEqual({ gone: true });

    expect(store.session('s2')).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'The terminal holder stopped.' });
    expect(store.session('s1')).toMatchObject({ state: 'starting' });
    expect(logs).toContain('session s2 ended: the terminal holder stopped');
    runtime.stop();
  });

  it('defers an end while input after the turn may be a prompt not yet observed, and ends it only once that input is an idle limit old (PRD R95)', async () => {
    let now = T0;
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }) });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    claude.observe = codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    now = T0 + 2_000;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: input arrived after its turn');

    // Input a minute old is no longer a prompt on its way, but the operator was there: the end waits for the idle limit from it.
    now = T0 + 1_000 + INPUT_SETTLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);

    now = T0 + 1_000 + CODE_MODE_IDLE_MS - 1;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);

    now = T0 + 1_000 + CODE_MODE_IDLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual(['s1']);
    context.runtime.stop();
  });

  it('measures input against the turn end its marker records, not when the hub applied it, and skips an end the marker shows a new turn for', async () => {
    let now = T0 + 3_000;
    let marker = { at: T0, observed: { state: 'idle' as const, detail: null }, recheck: false };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0 + 2_000, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: input arrived after its turn');

    marker = { at: T0 + 1_500, observed: { state: 'running', detail: null } as never, recheck: false };
    now = T0 + 1_000 + INPUT_SETTLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 skipped: its last marker is not a turn end');
    context.runtime.stop();
  });

  it('ends a session whose last marker is a manual compaction once its input and output are an idle limit old', async () => {
    let now = T0 + 3_000;
    const marker = { at: T0 + 2_000, observed: null, recheck: false, compacted: true as const };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000, lastOutputAt: T0 + 2_500 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);

    now = T0 + 2_500 + CODE_MODE_IDLE_MS - 1;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);

    now = T0 + 2_500 + CODE_MODE_IDLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual(['s1']);
    context.runtime.stop();
  });

  it('defers an end when a turn began and ended after the read that found the session idle, until the idle limit passes from that turn end (PRD R95)', async () => {
    let now = T0 + CODE_MODE_IDLE_MS;
    let marker = { at: T0, observed: { state: 'idle' as const, detail: null }, recheck: false };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    // A wakeup ran a whole turn between the idle read and the end.
    marker = { at: now - 1_000, observed: { state: 'idle', detail: null }, recheck: false };
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: it was active within the idle limit');

    now = marker.at + CODE_MODE_IDLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual(['s1']);
    context.runtime.stop();
  });

  it('keeps a session whose end was deferred once a usage limit is found, however long it has been idle (PRD R95, R111)', async () => {
    const now = T0 + 2 * CODE_MODE_IDLE_MS;
    const marker = { at: T0, observed: { state: 'idle' as const, detail: null }, recheck: false };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', {
      codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true,
      rateLimit: { kind: 'usage', window: null, message: null, resetsAt: now + 60_000, exact: true, cli: false, since: now, at: now, launchId: 'launch-1', attempts: 0, nextAt: now + 60_000 },
    });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: it waits on its usage limit');
    context.runtime.stop();
  });

  it('skips an end when a marker with no state, such as a PreToolUse that replaced the prompt marker, is newer than the input', async () => {
    const now = T0 + 3_000;
    const marker = { at: T0 + 2_000, observed: null, recheck: true };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 skipped: its last marker is not a turn end');
    context.runtime.stop();
  });

  it('ends a held session a stopped hub left waiting to end, once, at the next roster read', async () => {
    let answer = () => {};
    const codeMode = fakeRunner({ heldActivity: () => new Promise((done) => (answer = () => done({ clients: 0, lastInputAt: null }))) });
    const { runtime, store } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    store.updateSession('s2', { state: 'idle', releasing: true });
    const first = runtime.readRoster();

    await first;
    await runtime.readRoster();
    answer();
    await runtime.settled();

    expect(codeMode.stops).toEqual(['s2']);
    expect(store.session('s2')).toMatchObject({ state: 'ended', released: true });
    runtime.stop();
  });

  it('ends a Code Mode session that finishes starting after Delete removed its work item', async () => {
    let started = () => {};
    const codeMode = fakeRunner();
    const { runtime, store, logs } = setup(config(), () => T0, { claude: fakeRunner(), codeMode });

    codeMode.start = (action) => new Promise((done) => (started = () => done({ shortId: 'short', nativeSessionId: 'native', launchId: 'launch' })));
    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: false });
    store.insertSession({ id: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', state: 'starting', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: null, shortId: null, codeMode: true, launchId: null });

    const start = runtime['run']({ type: 'start-session', sessionId: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'auto', model: null, codeMode: true });

    expect(runtime.send({ type: 'delete', workItemId: 1 }).refused).toBeNull();
    await runtime.settled();
    started();
    await start;

    expect(store.session('s9')).toBeNull();
    expect(codeMode.stops).toEqual(['s9', 's9']);
    expect(logs).toContain('session s9 started after its work item was deleted; ended it');
    runtime.stop();
  });

  it('refuses to register the new ID of a held session after /clear', async () => {
    const codeMode = fakeRunner({ heldBy: (nativeSessionId, sessions) => (nativeSessionId === 'cleared-uuid' ? (sessions.find((session) => session.id === 's2') ?? null) : null) });
    const { runtime, store } = await twoSessions(codeMode);
    const key = (() => {
      const ticket = store.ticket(store.workItem(store.session('s2')!.workItemId)!.ticketId)!;

      return `${ticket.source} ${ticket.sourceKey}`;
    })();

    expect(await runtime.register('cleared-uuid', 'Mine')).toEqual({ refused: `This session already belongs to work item ${key}.` });
    runtime.stop();
  });

  it('refuses a report from another Claude session ID than the held session\'s', async () => {
    const { runtime, store } = await twoSessions(fakeRunner());

    expect(await runtime.report({ sessionId: 's2', kind: 'stage', stage: 'testing' } as never, 'other-native-uuid')).toEqual({ refused: 'Session other-na is not the session Switchboard started, so the report was not recorded.' });
    expect(await runtime.report({ sessionId: 's2', kind: 'stage', stage: 'testing' } as never, 's2-native')).toEqual({ refused: null });
    expect(store.workItemState(store.session('s2')!.workItemId)?.headline).toBe('testing');
    runtime.stop();
  });
});
