import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeRunner, conversationRules, markerState, projectSlug, readMarkers, rosterState } from '@switchboard/claude';
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
import { T0, home, playbook, PLAYBOOKS, config, ok, fail, FakeSource, issue, deferred, FakeCodex, setup } from './runtimeFixtures.js';

describe('focus (PRD R79)', () => {
  const ISSUE = 'https://github.com/o/r/issues/7';
  const COMMENT = `${ISSUE}#issuecomment-1`;
  const LATER = `${ISSUE}#issuecomment-2`;
  const focused = (focus: string) => ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', focus } }));
  const waiting = (): Config => ({
    ...config(),
    playbooks: new Map([playbook('triage:github', { description: 'Triage', kind: 'triage', template: 'Classify.' }), playbook('dev:develop', { description: 'Build it', focus: 'ticket', template: 'Build {{ticket.sourceKey}}.' })]),
  });

  it("offers the source's anchor ids, focuses the ticket after a failed triage, and stores the chosen comment's URL from Retry's triage", async () => {
    const { store, cli, source, runtime } = setup(waiting());
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    source.context = async () => {
      return {
        context: 'Issue 7 [ticket]\n### alice, 2026-10-01 [c1]\nPlease fix.\n### bob, 2026-10-02 [c2]\nStill broken.',
        anchors: [
          { id: 'ticket', url: ISSUE, page: 'ticket' },
          { id: 'c1', url: COMMENT, page: 'ticket' },
          { id: 'c2', url: LATER, page: 'ticket' },
        ],
      };
    };
    cli.classifyResult = fail('API Error: 529');

    await runtime.pollSource('github');
    await runtime.settled();

    const schema = JSON.parse(cli.calls.find((call) => call[1] === '-p')![5]!);
    expect(schema.properties.focus).toEqual({ type: 'string', enum: ['ticket', 'c1', 'c2'] });
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'failed', focus: ISSUE });

    cli.classifyResult = focused('c1');
    runtime.send({ type: 'retry', workItemId: 1 });
    await runtime.settled();
    expect(store.triage(2)?.focus).toBe(COMMENT);
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'unstarted', focus: COMMENT });
  });

  it("lists the playbook choices of an unstarted work item, and keeps its focus when Start chooses another (PRD R35)", async () => {
    const cfg = waiting();
    cfg.playbooks.set('dev:other', { ...cfg.playbooks.get('dev:develop')!, name: 'dev:other' });
    const { cli, source, runtime } = setup(cfg);
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    source.context = async () => ({ context: 'Issue 7 [ticket]\n### alice, 2026-10-01 [c1]\nPlease fix.', anchors: [{ id: 'ticket', url: ISSUE, page: 'ticket' }, { id: 'c1', url: COMMENT, page: 'ticket' }] });
    cli.classifyResult = focused('c1');

    await runtime.pollSource('github');
    await runtime.settled();
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'unstarted', playbook: 'dev:develop', playbookChoices: ['dev:develop', 'dev:other'] });

    expect(runtime.send({ type: 'start', workItemId: 1, playbook: 'dev:other' }).refused).toBeNull();
    expect(runtime.snapshot().workItems[0]).toMatchObject({ playbook: 'dev:other', playbookChoices: [], focus: COMMENT });
  });

  it('focuses the ticket when the source tags no anchors', async () => {
    const { store, cli, source, runtime } = setup(waiting());
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    cli.classifyResult = focused('c1');

    await runtime.pollSource('github');
    await runtime.settled();

    expect(JSON.parse(cli.calls.find((call) => call[1] === '-p')![5]!).properties).not.toHaveProperty('focus');
    expect(store.triage(1)?.focus).toBeNull();
    expect(runtime.snapshot().workItems[0]?.focus).toBe(ISSUE);
  });
});

describe('activity since the earlier work item (PRD R80)', () => {
  const NOTE = 'Earlier work: a dev:question work item for this ticket handled the activity up to 2026-10-03 12:00 UTC, so that activity is background.';

  /** Marks issue 7's first work item done at T0, then reassigns it an hour later, so work item 2 triages to the auto-starting dev:develop. */
  async function reassigned(activityAt: number | null | undefined) {
    let now = T0;
    const cfg = { ...config(), playbooks: new Map([...PLAYBOOKS, playbook('dev:question', { description: 'Answer it', template: 'Answer {{ticket.sourceKey}}.' })]) };
    const env = setup(cfg, () => now);
    env.source.result = { tickets: [issue('7')] };
    env.source.context = async () => ({ context: 'Issue 7 text', ...(activityAt === undefined ? {} : { activityAt }) });
    env.cli.classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:question' } }));

    await env.runtime.pollSource('github');
    await env.runtime.settled();
    env.runtime.send({ type: 'mark-done', workItemId: 1 });
    env.source.result = { tickets: [] };
    await env.runtime.pollSource('github');

    now = T0 + 60 * 60_000;
    env.cli.classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop' } }));
    env.source.result = { tickets: [issue('7')] };
    await env.runtime.pollSource('github');
    await env.runtime.settled();

    return env;
  }

  it('tells triage that nothing is newer and leaves an auto-starting playbook unstarted when no activity is newer, or there is none', async () => {
    for (const activityAt of [T0 - 60_000, T0, null]) {
      const { store } = await reassigned(activityAt);

      expect(store.triage(2)?.context).toBe(`Current time: 2026-10-03 13:00 UTC\n\n${NOTE} Nothing from anyone else in the activity below is newer, so nothing new asks for an action.\n\nIssue 7 text`);
      expect({ activityAt, ...store.workItem(2) }).toMatchObject({ activityAt, status: 'unstarted', playbook: 'dev:develop' });
      expect(store.ticketHistory(1)?.events.find((event) => event.type === 'triage-succeeded' && event.workItemId === 2)?.detail).toMatchObject({ playbook: 'dev:develop', stale: true });
    }
  });

  it('starts the playbook, naming the earlier work item without saying nothing is newer, when activity is newer or the source reports none', async () => {
    for (const activityAt of [T0 + 1, undefined]) {
      const { store } = await reassigned(activityAt);

      expect(store.triage(2)?.context).toBe(`Current time: 2026-10-03 13:00 UTC\n\n${NOTE}\n\nIssue 7 text`);
      expect({ activityAt, status: store.workItem(2)?.status }).toEqual({ activityAt, status: 'running' });
      expect(store.ticketHistory(1)?.events.find((event) => event.type === 'triage-succeeded' && event.workItemId === 2)?.detail).not.toHaveProperty('stale');
    }
  });
});

describe('forks (PRD R78)', () => {
  const FORK = { nativeSessionId: '9e8d7c6b-0000', shortId: '9e8d7c6b' };

  /** A Claude runner whose roster, markers and transcript answers the test sets. */
  function forking() {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    const state = {
      reads: 0,
      listed: true,
      forks: [] as { sessionId: string; nativeSessionId: string; shortId: string; state: 'running' | 'idle'; detail: null }[],
      markers: new Map<string, { at: number; cwd: string | null; observed: null; recheck: false }>(),
      relation: 'unrelated' as 'newer' | 'older' | 'unrelated',
      forkOf: null as Session | null,
    };
    const runner: SessionRunner = Object.assign(Object.create(real) as SessionRunner, {
      start: async () => ({ shortId: 'abc12345', nativeSessionId: 'native-1' }),
      isBackground: async () => true,
      stop: async () => null,
      markers: () => state.markers,
      observe: async (sessions: Session[]) => {
        state.reads += 1;
        return { sessions: state.listed ? sessions.filter((session) => session.state !== 'ended').map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) : [], forks: state.forks };
      },
      relation: () => state.relation,
      forkOf: () => state.forkOf,
    });

    return { runner, state };
  }

  /** A session Switchboard does not hold, which Claude's roster follows, as a registered one is (PRD R81), whose turn ended. */
  async function released() {
    const fake = forking();
    const setUp = setup(config(), () => T0, { claude: fake.runner, codeMode: fake.runner });

    setUp.runtime.send({ type: 'adhoc', prompt: 'test', repoRoot: 'D:/git/widgets', start: true });
    await setUp.runtime.settled();
    // Registered, so its process is the operator's and already released (PRD R81).
    setUp.store.updateSession('s1', { codeMode: false, launchId: null, released: true });
    // The turn ends.
    await setUp.runtime.readRoster();
    await setUp.runtime.settled();
    fake.state.listed = false;
    expect(setUp.store.session('s1')).toMatchObject({ nativeSessionId: 'native-1', released: true, releasing: false });

    return { ...setUp, ...fake };
  }

  it("sends the runner's forks with the roster, and the flow continues the session as the fork", async () => {
    const { runtime, store, state } = await released();

    state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ ...FORK, retiredIds: ['native-1'], state: 'running' });
    runtime.stop();
  });

  it("reads the roster when an unknown copy's marker changes in a session's project directory", async () => {
    const { runtime, state } = await released();
    const reads = async () => {
      runtime.readMarkers();
      await new Promise((done) => setImmediate(done));
      return state.reads;
    };
    const before = state.reads;

    state.markers.set(FORK.nativeSessionId, { at: 1, cwd: 'd:\\git\\widgets', observed: null, recheck: false });
    expect(await reads()).toBe(before + 1);
    expect(await reads()).toBe(before + 1);
    state.markers.set(FORK.nativeSessionId, { at: 2, cwd: 'd:\\git\\widgets', observed: null, recheck: false });
    expect(await reads()).toBe(before + 2);
    state.markers.set('other', { at: 1, cwd: 'D:/git/other', observed: null, recheck: false });
    state.markers.set('old', { at: 1, cwd: null, observed: null, recheck: false });
    expect(await reads()).toBe(before + 2);
    runtime.stop();
  });

  it('refuses a report from a retired copy, records one from a newer fork and reads the roster, and records one from an unrelated copy', async () => {
    const { runtime, store, state } = await released();
    const before = state.reads;

    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'old-copy')).toEqual({ refused: 'Session old-copy was replaced by fork abc12345, so the report was not recorded.' });
    expect(store.workItemState(1)).toBeNull();

    state.relation = 'newer';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'new-copy')).toEqual({ refused: null });
    expect(state.reads).toBe(before + 1);

    state.relation = 'unrelated';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' }, 'other')).toEqual({ refused: null });
    // The current copy, or a report without a copy, is not resolved.
    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' }, 'native-1')).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' })).toEqual({ refused: null });
    runtime.stop();
  });

  it('refuses a report from the copy a fork retired while its worktree check ran', async () => {
    const { runtime, store, state, cli } = await released();
    const gate = deferred();
    const entered = deferred();

    cli.gitGate = gate.promise;
    cli.gitEntered = entered.resolve;
    const report = runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:/git/widgets-wt/7-fix' }, 'native-1');
    await entered.promise;
    state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    state.relation = 'older';
    await runtime.readRoster();
    gate.resolve();

    expect(await report).toEqual({ refused: 'Session native-1 was replaced by fork 9e8d7c6b, so the report was not recorded.' });
    expect(store.worktreeFor(1)).toBeNull();
    runtime.stop();
  });

  it('refuses a done report from the copy a fork retired while the assignment read ran', async () => {
    const fake = forking();
    const { runtime, store, source } = setup(config(), () => T0, { claude: fake.runner, codeMode: fake.runner });
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s1', { codeMode: false, launchId: null });
    await runtime.readRoster();
    await runtime.settled();
    fake.state.listed = false;
    const gate = deferred();

    source.gate = gate.promise;
    const report = runtime.report({ sessionId: 's1', kind: 'done' }, 'native-1');
    await new Promise((done) => setImmediate(done));
    fake.state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    fake.state.relation = 'older';
    await runtime.readRoster();
    gate.resolve();

    expect(await report).toEqual({ refused: 'Session native-1 was replaced by fork 9e8d7c6b, so the report was not recorded.' });
    expect(store.session('s1')).toMatchObject({ ...FORK, outcome: null });
    expect(store.workItem(1)?.status).toBe('running');
    runtime.stop();
  });

  it("ignores the Claude copy a Codex session's report names, which it inherited", async () => {
    const { runtime, store, state } = await released();

    store.updateSession('s1', { provider: 'codex' });
    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'inherited')).toEqual({ refused: null });
    runtime.stop();
  });

  it('restores the contract of a session to a newer fork that compacts before it is adopted', async () => {
    const { runtime, store, state } = await released();

    expect(runtime.contract(FORK.nativeSessionId)).toBeNull();
    state.forkOf = store.session('s1');
    expect(runtime.contract(FORK.nativeSessionId)).toContain('report stage s1');
    runtime.stop();
  });

  it('names the copy a stop targeted in its result', async () => {
    const { runtime, store } = await released();
    const send = vi.spyOn(runtime, 'send');

    store.updateSession('s1', { state: 'idle', released: false });
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(send).toHaveBeenCalledWith({ type: 'stop-succeeded', sessionId: 's1', reason: 'operator', shortId: 'abc12345' });
    runtime.stop();
  });
});

describe('registered sessions (PRD R81)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';

  /** A Claude runner whose roster lists `live` and whose transcripts relate a native ID to a session by `relation`. */
  function registering(live: Awaited<ReturnType<NonNullable<SessionRunner['live']>>>, relation: (native: string) => CopyRelation = () => 'unrelated') {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });

    return Object.assign(Object.create(real) as SessionRunner, { live: async () => live, relation });
  }

  it('registers a live session in its directory and answers its key and contract, which the compaction hook also gets', async () => {
    const { runtime, store } = setup(config(), () => T0, { claude: registering({ shortId: '9273f594', cwd: 'D:/git/widgets' }) });

    const result = await runtime.register(NATIVE, 'Fix the badge');

    expect(result).toEqual({ key: 'adhoc 1', already: false, contract: expect.stringMatching(/^Report to Switchboard with these commands:\n- node ".*hub\.js" report stage s1 /) });
    expect(runtime.contract(NATIVE)).toBe((result as { contract: string }).contract);
    expect(store.session('s1')).toMatchObject({ nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets', released: true, external: true });
    expect(runtime.snapshot().workItems).toMatchObject([{ status: 'running', ticket: { title: 'Fix the badge', repoRoot: 'D:/git/widgets' } }]);
  });

  it('refuses a session the roster does not list, a failed roster read, and a newer, older or retired copy of a Switchboard session, and answers a second registration again', async () => {
    const unlisted = setup(config(), () => T0, { claude: registering(null) });
    expect(await unlisted.runtime.register(NATIVE, 'x')).toEqual({ refused: `Claude does not list session ${NATIVE} as running.` });

    const failed = setup(config(), () => T0, { claude: registering({ error: 'claude agents timed out' }) });
    expect(await failed.runtime.register(NATIVE, 'x')).toEqual({ refused: 'claude agents timed out' });

    const copies: Record<string, CopyRelation> = { 'newer-copy': 'newer', 'older-copy': 'older' };
    const { runtime, store } = setup(config(), () => T0, { claude: registering({ shortId: '9273f594', cwd: 'D:/git/widgets' }, (native) => copies[native] ?? 'unrelated') });

    const first = await runtime.register(NATIVE, 'First');
    expect(await runtime.register(NATIVE, 'Again')).toEqual({ ...first, already: true });

    for (const copy of ['newer-copy', 'older-copy']) {
      expect(await runtime.register(copy, 'Copy')).toEqual({ refused: 'This session is a copy of adhoc 1, which Switchboard continues in its latest copy.' });
    }

    store.updateSession('s1', { retiredIds: ['retired-copy'] });
    expect(await runtime.register('retired-copy', 'Copy')).toEqual({ refused: 'This session is a copy of adhoc 1, which Switchboard continues in its latest copy.' });
    expect(store.tickets('adhoc')).toHaveLength(1);
    expect(unlisted.store.tickets('adhoc')).toEqual([]);
  });

  it('answers the same key and contract to a retry sent while the first registration still reads the roster', async () => {
    const reads: Array<() => void> = [];
    const claude = Object.assign(registering(null), {
      live: () => new Promise<{ shortId: string; cwd: string }>((done) => reads.push(() => done({ shortId: '9273f594', cwd: 'D:/git/widgets' }))),
    });
    const { runtime, store } = setup(config(), () => T0, { claude });

    const first = runtime.register(NATIVE, 'First');
    const retry = runtime.register(NATIVE, 'First');
    expect(reads).toHaveLength(2);
    reads[0]!();
    const answered = await first;
    reads[1]!();

    expect(answered).toMatchObject({ key: 'adhoc 1', already: false });
    expect(await retry).toEqual({ ...answered, already: true });
    expect(store.tickets('adhoc')).toHaveLength(1);
  });

  it("answers a retry whose own roster read fails once the first registered, and refuses a copy related to a session registered during its read", async () => {
    const reads: Array<(live: { shortId: string; cwd: string } | { error: string }) => void> = [];
    const related: Record<string, CopyRelation> = {};
    const claude = Object.assign(registering(null, (native) => related[native] ?? 'unrelated'), {
      live: () => new Promise<{ shortId: string; cwd: string } | { error: string }>((done) => reads.push(done)),
    });
    const { runtime, store } = setup(config(), () => T0, { claude });

    const first = runtime.register(NATIVE, 'First');
    const retry = runtime.register(NATIVE, 'First');
    const copy = runtime.register('newer-copy', 'Copy');
    expect(reads).toHaveLength(3);
    reads[0]!({ shortId: '9273f594', cwd: 'D:/git/widgets' });
    const answered = await first;
    related['newer-copy'] = 'newer';
    reads[1]!({ error: 'claude agents timed out' });
    reads[2]!({ shortId: 'newer-co', cwd: 'D:/git/widgets' });

    expect(await retry).toEqual({ ...answered, already: true });
    expect(await copy).toEqual({ refused: 'This session is a copy of adhoc 1, which Switchboard continues in its latest copy.' });
    expect(store.tickets('adhoc')).toHaveLength(1);
  });
});

describe('ticket reports (PRD R83)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const URL = 'https://github.com/o/r/issues/115';
  const found = (open = true) => ({ ticket: { sourceKey: '115', ref: '#115', repo: '', title: 'Snapshot wrapper', url: URL, open } });

  async function registered() {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    // `old-copy` is a copy a fork retired, and so is the registered copy once a fork named `fork-copy` continues it (PRD R78).
    const claude = Object.assign(Object.create(real) as SessionRunner, {
      live: async () => ({ shortId: '9273f594', cwd: 'D:/git/widgets' }),
      relation: (native: string, session: Session): CopyRelation => (native === 'old-copy' || (native === NATIVE && session.nativeSessionId === 'fork-copy') ? 'older' : 'unrelated'),
    });
    const harness = setup(config(), () => T0, { claude });

    await harness.runtime.register(NATIVE, 'Explore snapshots');

    return harness;
  }

  it('asks each enabled source until one has the issue on its board, refuses when none has, and treats a failed read as a refusal (PRD R83)', async () => {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    const claude = Object.assign(Object.create(real) as SessionRunner, { live: async () => ({ shortId: '9273f594', cwd: 'D:/git/widgets' }), relation: (): CopyRelation => 'unrelated' });
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, source, store } = setup(cfg, () => T0, { claude }, undefined, { personal });
    await runtime.register(NATIVE, 'Explore snapshots');
    const asked: string[] = [];
    source.ticketAt = async () => (asked.push('github'), null);
    personal.ticketAt = async () => (asked.push('personal'), { ticket: { ...found().ticket, sourceKey: 'o/r#115', ref: 'o/r#115', repo: 'o/r' } });

    expect(await runtime.ticket('s1', URL, null, NATIVE)).toMatchObject({ key: 'personal o/r#115' });
    expect(asked).toEqual(['github', 'personal']);
    expect(store.ticket(1)).toMatchObject({ source: 'personal', sourceKey: 'o/r#115', repo: 'o/r' });

    personal.ticketAt = async () => null;
    expect(await runtime.ticket('s1', 'https://github.com/o/r/issues/9', null, NATIVE)).toEqual({ refused: 'No enabled source has https://github.com/o/r/issues/9 on its board.' });

    // The owner of a stored issue answers for it; while it is off, no other source may store the issue again.
    expect(runtime.setSourceEnabled('personal', false)).toBeNull();
    source.ticketAt = async () => found();
    expect(await runtime.ticket('s1', URL.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com'), null, NATIVE)).toEqual({ refused: `${URL.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com')} belongs to personal, which is off. Turn it on in the header.` });
    expect(await runtime.handled('s1', URL, null, NATIVE)).toEqual({ refused: `${URL} belongs to personal, which is off. Turn it on in the header.` });
    expect(runtime.setSourceEnabled('personal', true)).toBeNull();
    source.ticketAt = async () => ({ error: 'offline' });
    expect(await runtime.ticket('s1', 'https://github.com/o/r/issues/9', null, NATIVE)).toEqual({ refused: 'offline' });
  });

  it("moves a registered session's work item onto the issue and answers its key and the playbook's contract, again for a retry and after compaction", async () => {
    const { runtime, source, store } = await registered();
    const urls: string[] = [];
    source.ticketAt = async (url) => {
      urls.push(url);
      return found();
    };

    const result = await runtime.ticket('s1', URL, 'dev:develop', NATIVE);

    expect(result).toEqual({ key: 'github 115', contract: expect.stringMatching(/^Report to Switchboard with these commands:\n/) });
    const { contract } = result as { contract: string };
    expect(contract).toContain('report approval s1 ');
    expect(contract).not.toContain('report paste s1 ');
    expect(runtime.contract(NATIVE)).toBe(contract);
    expect(urls).toEqual([URL]);
    expect(store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', title: 'Snapshot wrapper', url: URL, assigned: false, adhocKey: '1' });
    expect(runtime.snapshot().workItems).toMatchObject([{ playbook: 'dev:develop', status: 'running', moved: true, ticket: { source: 'github', sourceKey: '115' } }]);
    expect(await runtime.ticket('s1', URL, 'dev:develop', NATIVE)).toEqual(result);

    // Once the work is done, the issue's return to scope makes a work item of its own, which was not moved.
    runtime.send({ type: 'mark-done', workItemId: 1 });
    expect(runtime.snapshot().workItems.map((item) => [item.id, item.reopenable])).toEqual([[1, true]]);
    source.result = { tickets: [{ ...issue('115'), url: URL }] };
    await runtime.pollSource('github');
    await runtime.settled();
    // Only the ticket's latest work item, once done, can be reopened (PRD R86).
    expect(runtime.snapshot().workItems.map((item) => [item.id, item.moved, item.reopenable])).toEqual([
      [2, false, false],
      [1, true, false],
    ]);
  });

  it('refuses a URL no enabled source has, a closed issue, a failed or late lookup, an unknown session and a retired copy, and logs each refusal', async () => {
    const { runtime, source, store, late } = await registered();
    const refused = async (url = URL, native: string | null = NATIVE, sessionId = 's1') => ((await runtime.ticket(sessionId, url, null, native)) as { refused: string }).refused;

    expect(await refused()).toBe(`No enabled source has ${URL} on its board.`);
    source.ticketAt = async () => null;
    expect(await refused()).toBe(`No enabled source has ${URL} on its board.`);
    source.ticketAt = async () => found(false);
    expect(await refused()).toBe('#115 is closed.');
    source.ticketAt = async () => ({ error: 'Issue #115 was not found in o/r.' });
    expect(await refused()).toBe('Issue #115 was not found in o/r.');
    source.ticketAt = async () => {
      throw new Error('boom');
    };
    expect(await refused()).toBe('Error: boom');
    source.ticketAt = () => new Promise(() => {});
    const pending = refused();
    late.resolve();
    expect(await pending).toBe(`github did not answer within ${REPORT_CHECK_MS / 1000} seconds.`);
    expect(await refused(URL, null, 's9')).toBe('Unknown session s9.');

    source.ticketAt = async () => found();
    expect(await refused(URL, 'old-copy')).toBe('Session old-copy was replaced by fork 9273f594, so the report was not recorded.');
    // A roster read continues the session as a fork while the lookup runs.
    source.ticketAt = async () => {
      store.updateSession('s1', { nativeSessionId: 'fork-copy', shortId: 'f0f0f0f0' });
      return found();
    };
    expect(await refused()).toBe('Session 9273f594 was replaced by fork f0f0f0f0, so the report was not recorded.');
    store.updateSession('s1', { nativeSessionId: NATIVE, shortId: '9273f594' });
    // The operator turns the source off while the lookup runs.
    source.ticketAt = async () => {
      runtime.setSourceEnabled('github', false);
      return found();
    };
    expect(await refused()).toBe('The github source changed during the lookup. Send the report again.');

    expect(store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', adhocKey: null });
    expect(store.ticketHistory(1)!.events.filter((event) => event.refused !== null).map((event) => [event.detail, event.refused])).toEqual([
      [{ kind: 'ticket', url: URL }, `No enabled source has ${URL} on its board.`],
      [{ kind: 'ticket', url: URL }, `No enabled source has ${URL} on its board.`],
      [{ kind: 'ticket', url: URL }, '#115 is closed.'],
      [{ kind: 'ticket', url: URL }, 'Issue #115 was not found in o/r.'],
      [{ kind: 'ticket', url: URL }, 'Error: boom'],
      [{ kind: 'ticket', url: URL }, `github did not answer within ${REPORT_CHECK_MS / 1000} seconds.`],
      [{ kind: 'ticket', url: URL }, 'Session old-copy was replaced by fork 9273f594, so the report was not recorded.'],
      [{ kind: 'ticket', url: URL }, 'Session 9273f594 was replaced by fork f0f0f0f0, so the report was not recorded.'],
      [{ kind: 'ticket', url: URL }, 'The github source changed during the lookup. Send the report again.'],
    ]);
  });
});


describe('Codex app-server resume (PRD R107)', () => {
  async function stopped() {
    const h = setup(config({ provider: 'codex' }));
    h.runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();
    const started = h.store.session('s1')!;
    expect(started).toMatchObject({ execution: 'app-server' });
    h.runtime.send({ type: 'stop-succeeded', sessionId: 's1', reason: 'operator' });
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    return { ...h, started };
  }

  it('resumes an ended thread once with the start options, and holds it again under a new launch', async () => {
    const h = await stopped();
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockResolvedValue();
    expect(await Promise.all([h.runtime.resumeThread('s1'), h.runtime.resumeThread('s1')])).toEqual([null, null]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', released: false, endedAt: null });
    expect(h.store.session('s1')!.launchId).not.toBe(h.started.launchId);
    expect(h.logs).toContain('session s1 resumed in the Codex daemon');
    expect(h.runtime.codexAppServer.deps.resumeOptions?.(h.store.session('s1')!)).toEqual(launchOptions(config({ provider: 'codex' }).settings, null, 'task', 'codex'));
    // A live session is not resumed again.
    expect(await h.runtime.resumeThread('s1')).toBeNull();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(await h.runtime.resumeThread('missing')).toBe('No session missing.');
    h.runtime.stop(); h.store.close();
  });

  it('leaves the session ended with why when Codex refuses, and follows a resume another Codex client made', async () => {
    const h = await stopped();
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockRejectedValueOnce(new Error('thread not found'));
    expect(await h.runtime.resumeThread('s1')).toContain('thread not found');
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    configure.mockResolvedValue();
    h.runtime.threadResumedElsewhere('unknown-thread');
    h.runtime.threadResumedElsewhere(h.started.nativeSessionId!);
    await h.runtime.settled();
    expect(configure).toHaveBeenCalledTimes(2);
    expect(h.store.session('s1')).toMatchObject({ state: 'idle' });
    h.runtime.stop(); h.store.close();
  });

  it('waits for a Stop still running, and leaves the thread when a newer session started during the resume', async () => {
    const h = await stopped();
    let finish = (): void => undefined;
    const stopping = new Promise<void>((resolve) => { finish = resolve; });
    (h.runtime as unknown as { ending: Map<string, Promise<void>> }).ending.set('s1', stopping);
    const real = h.store.sessionsFor.bind(h.store);
    let newer = false;
    vi.spyOn(h.store, 'sessionsFor').mockImplementation((id) => (newer ? [...real(id), { ...real(id)[0]!, id: 's9' }] : real(id)));
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockImplementation(async () => { newer = true; });
    const stop = vi.spyOn(h.runtime.codexAppServer, 'stop').mockResolvedValue(null);
    const resumed = h.runtime.resumeThread('s1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(configure).not.toHaveBeenCalled();
    (h.runtime as unknown as { ending: Map<string, Promise<void>> }).ending.delete('s1');
    finish();
    expect(await resumed).toContain('A newer session');
    expect(configure).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ sessionId: 's1', shortId: h.started.nativeSessionId }, 'release');
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    h.runtime.stop(); h.store.close();
  });
});

describe("Codex terminals in the holder (architecture.md § Codex runner)", () => {
  async function codexSession(stop: SessionRunner['stop'] = async () => null) {
    const codexAppServer: SessionRunner = {
      start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop,
      reconcile: async () => [],
      installHooks: async () => null,
    };
    const h = setup(config({ provider: 'codex' }), () => T0, { codexAppServer });

    h.runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();
    expect(h.store.session('s1')).toMatchObject({ execution: 'app-server', nativeSessionId: 's1-thread' });

    const ends = vi.spyOn(h.runtime.codexTerminals, 'end').mockResolvedValue();
    const ensures = vi.spyOn(h.runtime.codexTerminals, 'ensure').mockResolvedValue();

    return { ...h, ends, ensures };
  }

  it("ends the session's terminal after a Stop, and not after a Stop that failed", async () => {
    let failure: { error: string } | null = { error: 'Codex has not identified its running turn; try Stop session again.' };
    const h = await codexSession(async () => failure);

    h.store.updateSession('s1', { state: 'running' });
    h.runtime.send({ type: 'stop', workItemId: h.store.session('s1')!.workItemId, sessionId: 's1' });
    await h.runtime.settled();
    expect(h.ends).not.toHaveBeenCalled();

    failure = null;
    h.runtime.send({ type: 'stop', workItemId: h.store.session('s1')!.workItemId, sessionId: 's1' });
    await h.runtime.settled();
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    expect(h.ends).toHaveBeenCalledWith('s1');
    h.runtime.stop(); h.store.close();
  });

  it('ends it with an idle release, and keeps it when the thread started a turn and the release was cancelled', async () => {
    let cancel = true;
    const h = await codexSession(async () => (cancel ? { error: 'The Codex thread started a new turn; release was cancelled.', cancelled: true } : null));

    h.runtime.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    h.runtime.send({ type: 'held-idle', sessionId: 's1' });
    await h.runtime.settled();
    expect(h.store.session('s1')).toMatchObject({ releasing: false, released: false });
    expect(h.ends).not.toHaveBeenCalled();

    cancel = false;
    h.runtime.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    h.runtime.send({ type: 'held-idle', sessionId: 's1' });
    await h.runtime.settled();
    expect(h.store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(h.ends).toHaveBeenCalledWith('s1');
    h.runtime.stop(); h.store.close();
  });

  it('ends it when its work item is deleted, even when the thread could not be left', async () => {
    const h = await codexSession(async () => ({ error: 'Codex operator failed: closed' }));

    h.runtime.send({ type: 'delete', workItemId: h.store.session('s1')!.workItemId });
    await h.runtime.settled();
    expect(h.store.session('s1')).toBeNull();
    expect(h.ends).toHaveBeenCalledWith('s1');
    h.runtime.stop(); h.store.close();
  });

  it("starts the terminal before a console views it, and lets the console's keys reserve the session", async () => {
    const h = await codexSession();

    await expect(h.runtime.viewHeld('s1', { onSize: () => {}, onData: () => {}, onReplayed: () => {}, onExit: () => {}, onClose: () => {} })).rejects.toThrow();
    expect(h.ensures).toHaveBeenCalledWith('s1');

    const reservation = await h.runtime.reserveInput('s1', h.store.session('s1')!.launchId ?? null);

    expect('release' in reservation).toBe(true);
    h.runtime.stop(); h.store.close();
  });

  it("stops only the terminal of a Codex session through holder stop, so the thread's turn runs on", async () => {
    const codexAppServer: SessionRunner = {
      start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: vi.fn(async () => null),
      reconcile: async () => [],
      installHooks: async () => null,
    };
    const entries: SessionEntry[] = [{ session: 's1', label: 'l', pid: 900, cwd: 'D:/repo', startedAt: T0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null }];
    const connection: HolderConnection = {
      welcome: { protocol: 1, build: 'b', pid: 4243 },
      compatible: true,
      spawn: async () => ({ session: 's', pid: 1 }),
      list: async () => entries,
      kill: async () => 0,
      screen: async () => ({ head: '', text: '' }),
      shutdown: async () => {},
      onClose: () => {},
      close: () => {},
    };

    mkdirSync(join(home, '.switchboard'), { recursive: true });
    writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));

    const h = setup(config({ provider: 'codex' }), () => T0, { codexAppServer }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });

    h.runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();

    const ends = vi.spyOn(h.runtime.codexTerminals, 'end').mockResolvedValue();

    expect(await h.runtime.stopHeld('s1')).toEqual({ stopped: 's1' });
    expect(ends).toHaveBeenCalledWith('s1');
    expect(codexAppServer.stop).not.toHaveBeenCalled();
    expect(h.store.session('s1')?.state).not.toBe('ended');
    h.runtime.stop(); h.store.close();
  });

  it("counts keys typed in the session's Codex terminal as use, so the idle release waits for them", async () => {
    let now = T0;
    const codexAppServer: SessionRunner = {
      start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async () => null,
      reconcile: async () => [],
      installHooks: async () => null,
    };
    const h = setup(config({ provider: 'codex' }), () => now, { codexAppServer });

    h.runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();
    h.runtime.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    vi.spyOn(h.runtime.codexTerminals, 'end').mockResolvedValue();
    const entries: SessionEntry[] = [{ session: 's1', label: 'l', pid: 900, cwd: 'D:/repo', startedAt: T0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null }];
    const reads = { count: 0 };
    const typedAt = { at: T0 + 30 * 60_000 };

    // The holder's fresh list, read before a release, holds a key typed after the cached one.
    (h.runtime as unknown as { heldEntries: SessionEntry[] }).heldEntries = entries;
    (h.runtime as unknown as { readHeld(): Promise<void> }).readHeld = async () => {
      reads.count++;
      (h.runtime as unknown as { heldEntries: SessionEntry[] }).heldEntries = [{ ...entries[0]!, lastInputAt: typedAt.at }];
    };

    now = T0 + 3_600_000;
    h.runtime.wake();
    await h.runtime.settled();
    expect(reads.count).toBe(1);
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', released: false });

    now = T0 + 90 * 60_000;
    h.runtime.wake();
    await h.runtime.settled();
    expect(h.store.session('s1')).toMatchObject({ state: 'ended', released: true });
    h.runtime.stop(); h.store.close();
  });

  it('ends again at the next holder read a Codex terminal still held for an ended session, and leaves a live session\'s alone', async () => {
    const codexAppServer: SessionRunner = {
      start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async () => null,
      reconcile: async () => [],
      installHooks: async () => null,
    };
    const live = (session: string): SessionEntry => ({ session, label: 'l', pid: 900, cwd: 'D:/repo', startedAt: T0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null });
    const connection: HolderConnection = {
      welcome: { protocol: 1, build: 'b', pid: 4243 },
      compatible: true,
      spawn: async () => ({ session: 's', pid: 1 }),
      list: async () => [live('s1'), live('s2'), live('s9')],
      kill: async () => 0,
      screen: async () => ({ head: '', text: '' }),
      shutdown: async () => {},
      onClose: () => {},
      close: () => {},
    };

    mkdirSync(join(home, '.switchboard'), { recursive: true });
    writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));

    const h = setup(config({ provider: 'codex', concurrency: 3 }), () => T0, { codexAppServer }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });

    h.runtime.send({ type: 'adhoc', prompt: 'one', repoRoot: 'D:/repo', start: true });
    h.runtime.send({ type: 'adhoc', prompt: 'two', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();

    const ends = vi.spyOn(h.runtime.codexTerminals, 'end').mockResolvedValue();

    h.store.updateSession('s1', { state: 'ended', released: true });
    // A release still running, as one a stopped hub left, is left to the release, which a new turn can cancel.
    h.store.updateSession('s2', { releasing: true });
    await h.runtime.listHeld();
    await h.runtime.settled();
    expect(ends.mock.calls).toEqual([['s1']]);

    // A terminal whose end failed after Delete removed its session is ended again; another held entry with no session is not.
    h.store.deleteWorkItem(h.store.session('s2')!.workItemId);
    vi.spyOn(h.runtime.codexTerminals, 'unended').mockImplementation((id) => id === 's2');
    ends.mockClear();
    h.store.updateSession('s1', { state: 'idle', released: false });
    await h.runtime.listHeld();
    await h.runtime.settled();
    expect(ends.mock.calls).toEqual([['s2']]);
    h.runtime.stop(); h.store.close();
  });
});

describe('rate limits (architecture.md § Rate limits)', () => {
  const RESET = T0 + 2 * 3_600_000;
  const prompt = { type: 'user', message: { role: 'user', content: 'Go.' }, origin: { kind: 'human' } };
  const usage = { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 2:00pm (America/New_York)" }] }, apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESET / 1000, rateLimitType: 'five_hour' } }, error: 'rate_limit', isApiErrorMessage: true };
  const grace = { type: 'user', message: { role: 'user', content: '[Usage limit reached; a short grace allowance remains …]' }, isMeta: true, usageLimitNote: 'wrap_up' };
  const wait = { type: 'system', subtype: 'informational', content: 'Usage limit reached · continuing automatically at 2:00pm · esc to cancel' };

  function runner(overrides: Partial<SessionRunner> = {}): SessionRunner & { starts: string[] } {
    const starts: string[] = [];

    return {
      start: async (action) => {
        starts.push(action.sessionId);
        return { shortId: `${action.sessionId}-short`, nativeSessionId: `${action.sessionId}-native`, ...(action.codeMode === true ? { launchId: `${action.sessionId}-launch` } : {}) };
      },
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: session.state === 'starting' ? ('running' as const) : (session.state as 'running'), detail: session.stateDetail })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async () => null,
      reconcile: async () => [],
      installHooks: async () => null,
      starts,
      ...overrides,
    };
  }

  /** A held session s1 of an ad-hoc work item whose transcript holds `lines`, and a marker reading the test sets. */
  async function heldWith(lines: unknown[], typed_: { keyAt: number | null } = { keyAt: null }) {
    let now = T0;
    let observed: { state: 'running' | 'idle' | 'failed'; detail: string | null } = { state: 'running', detail: null };
    const codeMode = runner({
      markers: (sessions) => new Map(sessions.filter((session) => session.nativeSessionId !== null).map((session) => [session.nativeSessionId!, { at: now, observed, recheck: false }])),
    });
    const context = setup(config({ codeMode: true }), () => now, { codeMode });
    const typed: string[] = [];
    const guards: Array<() => string | null> = [];

    // The holder's last key from an attached terminal, which the hub's own typing never sets.
    (context.runtime as unknown as { keyAt: () => Promise<number | null> }).keyAt = async () => typed_.keyAt;
    context.runtime.setConversationReader({ read: () => {}, catchUp: () => null, continueAfterLimit: (sessionId, text, guard) => (typed.push(`${sessionId}: ${text}`), guards.push(guard), null) });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;
    const dir = join(home, '.claude', 'projects', projectSlug(session.cwd));
    const path = join(dir, `${session.nativeSessionId}.jsonl`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    return {
      ...context,
      id: session.id,
      codeMode,
      typed,
      guards,
      key: (at: number | null) => (typed_.keyAt = at),
      append: (line: unknown) => writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(line) + '\n'),
      observe: (state: typeof observed) => (observed = state),
      at: (time: number) => (now = time),
    };
  }

  it('reads the reset time from the transcript when the marker shows the failed turn, and keeps the work item running', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)).toMatchObject({ state: 'failed', rateLimit: { kind: 'usage', resetsAt: RESET, exact: true, cli: false } });
    expect(t.store.workItem(1)?.status).toBe('running');
    t.runtime.stop();
  });

  it("finds Claude Code's own wait written after the turn's marker, and stops looking two minutes after the turn end", async () => {
    const t = await heldWith([prompt, grace]);

    t.observe({ state: 'idle', detail: null });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ resetsAt: null, cli: false });
    expect(t.store.workItem(1)?.status).toBe('running');

    t.append(wait);
    t.at(T0 + 5_000);
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ cli: true });
    expect(t.store.session(t.id)?.rateLimit?.resetsAt).not.toBeNull();

    const before = t.store.session(t.id)?.rateLimit;

    t.append(usage);
    t.at(T0 + 121_000);
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toEqual(before);
    t.runtime.stop();
  });

  it('types the continue text once the next attempt is due, and backs off after it', async () => {
    const t = await heldWith([prompt, usage, wait]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit?.nextAt).toBe(RESET + CLI_MARGIN_MS);

    t.at(RESET + CLI_MARGIN_MS - 1);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.at(RESET + CLI_MARGIN_MS);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([`${t.id}: ${CONTINUE_TEXT}`]);
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ attempts: 1, attemptedAt: RESET + CLI_MARGIN_MS, nextAt: RESET + CLI_MARGIN_MS + 5 * 60_000 });
    expect(t.logs.filter((line) => line.includes('usage limit'))).toEqual([`session ${t.id} continued after its usage limit, attempt 1`]);

    await t.runtime.continueLimited();
    expect(t.typed).toHaveLength(1);
    t.runtime.stop();
  });

  it('leaves the session to the operator who typed in its terminal during the wait', async () => {
    const t = await heldWith([prompt, usage], { keyAt: T0 + 60_000 });

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    expect(t.store.session(t.id)?.rateLimit ?? null).toBeNull();
    expect(t.store.workItem(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitSkipped });
    t.runtime.stop();
  });

  it('releases an idle Codex app-server thread an hour after its turn, but not one waiting on its usage limit (PRD R107)', async () => {
    let now = T0;
    const codexAppServer = runner();
    const context = setup(config({ provider: 'codex' }), () => now, { codexAppServer });

    context.runtime.send({ type: 'adhoc', prompt: 'one', repoRoot: 'D:/git/widgets', start: true });
    context.runtime.send({ type: 'adhoc', prompt: 'two', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.runtime.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    context.runtime.send({ type: 'marker', sessionId: 's2', state: 'failed', detail: 'rate_limit', limit: { kind: 'usage', window: null, resetsAt: T0 + 7_200_000, exact: true, cli: false, message: null } });

    now = T0 + 3_600_000 - 1;
    context.runtime.wake();
    await context.runtime.settled();
    expect(context.store.session('s1')?.state).toBe('idle');

    now = T0 + 3_600_000;
    context.runtime.wake();
    await context.runtime.settled();
    expect(context.store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(context.store.session('s2')).toMatchObject({ state: 'failed', released: false, releasing: false });
    context.runtime.stop();
  });

  it("passes a guard that refuses the typing once the session's limit or work item changed while it was queued", async () => {
    const t = await heldWith([prompt, usage, wait]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.at(RESET + CLI_MARGIN_MS);
    await t.runtime.continueLimited();

    const [guard] = t.guards;

    // The attempt itself moved nextAt, so the queued typing's guard now refuses; so does a new turn.
    expect(guard!()).toBe('The session no longer waits on that usage limit.');
    t.store.updateSession(t.id, { state: 'running' });
    expect(guard!()).toBe('The session no longer waits on that usage limit.');
    t.runtime.stop();
  });

  it('skips an attempt whose work item stopped running, and a key typed after a refused attempt still leaves it to the operator', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.store.updateWorkItem(1, { status: 'blocked' });
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.store.updateWorkItem(1, { status: 'running' });
    t.runtime.send({ type: 'limit-attempt', sessionId: t.id, error: 'The session is busy.' });
    t.key(RESET + 3_600_000 + 30_000);
    t.at(RESET + 3_600_000 + BACKOFF_MS[0]!);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    expect(t.store.workItem(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitSkipped });
    t.runtime.stop();
  });

  it('reads the limit when the roster settles the turn end before the marker pass does', async () => {
    const t = await heldWith([prompt, grace]);

    t.codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    await (t.runtime as unknown as { readRoster(): Promise<void> }).readRoster();
    expect(t.store.session(t.id)).toMatchObject({ state: 'idle', rateLimit: { kind: 'usage' } });
    expect(t.store.workItem(1)?.status).toBe('running');
    t.runtime.stop();
  });

  it('reads once after a hub start a turn end older than two minutes that has no limit yet', async () => {
    const t = await heldWith([prompt, grace]);

    t.store.updateSession(t.id, { state: 'idle', stateAt: T0 - 10 * 60_000, rateLimit: null });
    t.observe({ state: 'idle', detail: null });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ kind: 'usage' });
    t.runtime.stop();
  });

  it('does not continue a session resumed under another launch, or a background one', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.store.updateSession(t.id, { launchId: 'another' });
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.store.updateSession(t.id, { launchId: t.store.session(t.id)!.rateLimit!.launchId, codeMode: false });
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    t.runtime.stop();
  });
});
