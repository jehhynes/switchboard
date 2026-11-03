import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, RESUME_PROMPT, Store } from '@switchboard/core';
import type { ObservedSession, Session, SessionRunner } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { until } from './helpers.js';
import { MOVE_EXIT_MS, RESUME_CONFIRM_MS, Runtime } from '../src/runtime.js';

const T0 = Date.UTC(2026, 10, 3, 12);
const NATIVE = '0f1e2d3c-0000-4000-8000-000000000001';
const SHORT = '0f1e2d3c';
const PID = 4242;
const LABEL = 'switchboard · ad-hoc · adhoc 1';
/** The window's extension host, the parent of its Claude tab's process. */
const HOST = 4100;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-background-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function config(): Config {
  return {
    settings: { ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions, installHooks: false }, sources: {} },
    settingsError: null,
    playbooks: new Map(),
    playbookErrors: [],
  };
}

type Tab = Awaited<ReturnType<NonNullable<SessionRunner['tab']>>>;
type Launch = Awaited<ReturnType<NonNullable<SessionRunner['resume']>>>;
type Listed = Awaited<ReturnType<NonNullable<SessionRunner['background']>>>;

/** A Claude runner whose answers the test sets, recording the resumes and stops it was asked for. */
class StandIn {
  tabResult: Tab = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }], others: 0 };
  launch: Launch = { copy: null };
  /** Each roster read for the background process takes the next answer, then repeats the last. */
  listed: Listed[] = [{ shortId: SHORT }];
  resumes: [string, string, string][] = [];
  stops: string[] = [];
  /** When set, a resume waits for it before it answers. */
  held: Promise<void> | null = null;
  /** When set, the next roster read waits for it, then lists `first`; later reads list `later`. */
  observeGate: Promise<void> | null = null;
  first: ObservedSession[] = [];
  later: ObservedSession[] = [];

  runner(): SessionRunner {
    return {
      start: async () => ({ shortId: SHORT, nativeSessionId: NATIVE }),
      observe: async () => {
        const gate = this.observeGate;

        if (gate === null) {
          return { sessions: this.later };
        }

        this.observeGate = null;
        await gate;
        return { sessions: this.first };
      },
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async (target) => {
        this.stops.push(target.shortId!);
        return null;
      },
      reconcile: async () => [],
      installHooks: async () => null,
      tab: async () => this.tabResult,
      resume: async (native, prompt, cwd) => {
        this.resumes.push([native, prompt, cwd]);
        await this.held;
        return this.launch;
      },
      background: async () => (this.listed.length > 1 ? this.listed.shift()! : this.listed[0]!),
    };
  }
}

/** A runtime whose clock moves only when it sleeps, with an ad-hoc session the operator resumed in a Claude tab, mid-turn. */
async function inTab(options: { exits?: boolean } = {}) {
  const store = Store.open(':memory:');
  const claude = new StandIn();
  const logs: string[] = [];
  const live = new Set([PID]);
  let now = T0;
  let sleeps = 0;
  const runtime = new Runtime(
    {
      home,
      store,
      exec: async () => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false }),
      makeSource: () => null,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        // The tab's process exits on the first poll, unless the test keeps it.
        if (++sleeps >= 1 && options.exits !== false) {
          live.delete(PID);
        }
      },
      newSessionId: (() => {
        let ids = 0;
        return () => `s${++ids}`;
      })(),
      claudeSettings: join(home, '.claude', 'settings.json'),
      configDir: join(home, 'cfg'),
      runners: { claude: claude.runner() },
      alive: (pid) => live.has(pid),
      log: (line) => logs.push(line),
    },
    config(),
  );

  runtime.send({ type: 'adhoc', prompt: 'Fix it', repoRoot: 'D:/git/widgets', start: true });
  await runtime.settled();
  const session = store.activeSessions()[0]!;
  // The tab holds the session from now on, so every roster read lists it as interactive.
  claude.later = [{ sessionId: session.id, state: 'running', detail: null, interactive: true }];
  // The turn ends, the release stops the background process, and the operator resumes the session in a tab (PRD R39).
  runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });
  await runtime.settled();
  claude.stops.length = 0;
  runtime.send({ type: 'roster', sessions: [{ sessionId: session.id, state: 'running', detail: null, interactive: true }] });
  await runtime.settled();

  return { store, runtime, claude, logs, live, session: session.id, now: () => now, item: () => store.workItem(session.workItemId)! };
}

const current = (store: Store, id: string): Session => store.session(id)!;

describe('Continue in Background in the hub (PRD R89)', () => {
  it('stores the move before it answers, waits for the tab process, then resumes the session with no flags and confirms it by its roster entry', async () => {
    const h = await inTab();

    expect(current(h.store, h.session)).toMatchObject({ released: true, state: 'running' });
    expect(await h.runtime.background(LABEL, HOST, [h.item().id])).toEqual({ pid: PID });
    expect(current(h.store, h.session).move).toMatchObject({ pid: PID });

    await h.runtime.settled();
    expect(h.claude.resumes).toEqual([[NATIVE, RESUME_PROMPT, 'D:/git/widgets']]);
    expect(current(h.store, h.session)).toMatchObject({ move: null, shortId: SHORT, released: false, state: 'running' });
    expect(h.item().status).toBe('running');
    expect(h.claude.stops).toEqual([]);
  });

  it('answers the roster’s error, and refuses a session that never ran in the background, or none or several of the window’s', async () => {
    const h = await inTab();
    const other = { nativeSessionId: 'someone-else', pid: 7, background: true, busy: true };

    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: false, busy: true }], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [1])).toEqual({ refused: 'This session never ran in the background, so it cannot continue there.' });
    h.claude.tabResult = { error: 'claude agents timed out' };
    expect(await h.runtime.background(LABEL, HOST, [1])).toEqual({ refused: 'claude agents timed out' });
    h.claude.tabResult = { candidates: [other], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [1])).toEqual({ refused: "This session is not one of Switchboard's work items." });
    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [2])).toEqual({ refused: "This session is not one of Switchboard's work items." });

    // Two Claude sessions of this window share a cut label, so neither is chosen, even though only the first is this window's work.
    h.runtime.send({ type: 'adhoc', prompt: 'Other work', repoRoot: 'D:/git/widgets' });
    h.store.insertSession({ ...current(h.store, h.session), id: 'second', workItemId: 2, nativeSessionId: 'second-native', startedAt: 0 });
    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }, { nativeSessionId: 'second-native', pid: 8, background: true, busy: true }], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [1])).toEqual({ refused: `Several Claude sessions in this window are named "${LABEL}", so Switchboard cannot tell which one this tab holds.` });

    // Another session in the window, such as one in its Claude sidebar, would end with it (review round 1, goal-2).
    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }], others: 1 };
    expect(await h.runtime.background(LABEL, HOST, [1])).toEqual({ refused: 'Another Claude session runs in this window; closing the window would end it.' });

    await h.runtime.settled();
    expect(h.claude.resumes).toEqual([]);
    expect(current(h.store, h.session).move).toBeNull();
  });

  it('tells the window whether the moving process is still its only Claude session, only while its move waits with time left', async () => {
    const h = await inTab();
    const waiting = (at: number) => h.store.updateSession(h.session, { move: { id: 'm1', pid: PID, phase: 'waiting', at, deadline: null } });

    expect(await h.runtime.windowAlone(HOST, PID)).toEqual({ error: 'The move is no longer waiting for the window to close.' });
    // 25 seconds into the 30-second wait leaves too little time for the process to exit.
    waiting(h.now() - 25_000);
    expect(await h.runtime.windowAlone(HOST, PID)).toEqual({ error: 'The move is no longer waiting for the window to close.' });
    // The roster has not revived the released session yet, so its state is still ended.
    h.store.updateSession(h.session, { state: 'ended' });
    waiting(h.now());
    expect(await h.runtime.windowAlone(HOST, PID)).toBe(true);
    expect(await h.runtime.windowAlone(HOST, 9)).toEqual({ error: 'The move is no longer waiting for the window to close.' });
    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }, { nativeSessionId: 'other-native', pid: 8, background: false, busy: true }], others: 0 };
    expect(await h.runtime.windowAlone(HOST, PID)).toBe(false);
    h.claude.tabResult = { error: 'claude agents timed out' };
    expect(await h.runtime.windowAlone(HOST, PID)).toEqual({ error: 'claude agents timed out' });
  });

  it('moves the window\'s one Claude session for the sidebar, and refuses when the window has several', async () => {
    const h = await inTab();

    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }, { nativeSessionId: 'other-native', pid: 8, background: true, busy: true }], others: 0 };
    expect(await h.runtime.background(null, HOST, [h.item().id])).toEqual({ refused: 'Several Claude sessions run in this window, so Switchboard cannot tell which one the sidebar holds.' });
    expect(current(h.store, h.session).move).toBeNull();

    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }], others: 0 };
    expect(await h.runtime.background(null, HOST, [h.item().id])).toEqual({ pid: PID });
    await h.runtime.settled();
    expect(h.claude.resumes).toHaveLength(1);
    expect(current(h.store, h.session)).toMatchObject({ move: null, released: false });
  });

  it('takes a tab the roster lists busy as running, so a turn it just started counts without hooks (review round 1, goal-1)', async () => {
    const h = await inTab();

    // The last read saw the turn end; the tab has started another since, which its roster entry shows as busy.
    h.runtime.send({ type: 'roster', sessions: [{ sessionId: h.session, state: 'idle', detail: null, interactive: true }] });
    expect(current(h.store, h.session).state).toBe('idle');

    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: false }], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [h.item().id])).toEqual({ refused: 'Continue in Background works while the session is running.' });

    h.claude.tabResult = { candidates: [{ nativeSessionId: NATIVE, pid: PID, background: true, busy: true }], others: 0 };
    expect(await h.runtime.background(LABEL, HOST, [h.item().id])).toEqual({ pid: PID });
    await h.runtime.settled();
    expect(h.claude.resumes).toHaveLength(1);
  });

  it('cancels the move when the tab process is still running after the wait, and launches nothing', async () => {
    const h = await inTab({ exits: false });

    await h.runtime.background(LABEL, HOST, [h.item().id]);
    await h.runtime.settled();

    expect(h.now() - T0).toBeGreaterThanOrEqual(MOVE_EXIT_MS);
    expect(h.claude.resumes).toEqual([]);
    expect(current(h.store, h.session)).toMatchObject({ move: null, state: 'running', released: true });
    expect(h.logs).toContain(`session ${h.session} stays in its tab: process ${PID} did not exit within 30 seconds`);
  });

  it('launches nothing when Stop ended the move while the tab process exited', async () => {
    const h = await inTab({ exits: false });

    await h.runtime.background(LABEL, HOST, [h.item().id]);
    h.runtime.send({ type: 'stop', workItemId: h.item().id });
    h.live.delete(PID);
    await h.runtime.settled();

    expect(h.claude.resumes).toEqual([]);
    expect(current(h.store, h.session)).toMatchObject({ move: null, state: 'ended', outcome: 'stopped' });
  });

  it('stops a copy and fails the move with the cause', async () => {
    const h = await inTab();

    h.claude.launch = { copy: '4df6b678' };
    await h.runtime.background(LABEL, HOST, [h.item().id]);
    await h.runtime.settled();

    expect(h.claude.stops).toEqual(['4df6b678']);
    expect(h.item()).toMatchObject({ status: 'blocked', error: 'Continue in Background failed: Claude started a copy as 4df6b678 instead of resuming the session, and Switchboard stopped it.' });
  });

  it('waits through failed reads and an entry without a process until the deadline, then fails with the launch error', async () => {
    const h = await inTab();

    h.claude.listed = [{ error: 'claude agents timed out' }, null, { shortId: SHORT }];
    await h.runtime.background(LABEL, HOST, [h.item().id]);
    await h.runtime.settled();
    expect(current(h.store, h.session)).toMatchObject({ move: null, released: false, shortId: SHORT });

    const late = await inTab();

    late.claude.launch = { error: 'Claude exited with code 1: no conversation found' };
    late.claude.listed = [null];
    await late.runtime.background(LABEL, HOST, [late.item().id]);
    await late.runtime.settled();
    expect(late.now() - T0).toBeGreaterThanOrEqual(RESUME_CONFIRM_MS);
    expect(late.item()).toMatchObject({ status: 'blocked', error: 'Continue in Background failed: Claude exited with code 1: no conversation found' });
  });

  it('stops a process resumed for a work item deleted during the launch', async () => {
    const h = await inTab();
    let release!: () => void;

    h.claude.held = new Promise<void>((resolve) => (release = resolve));
    await h.runtime.background(LABEL, HOST, [h.item().id]);
    await until(() => (h.claude.resumes.length === 1 ? true : null));
    h.runtime.send({ type: 'delete', workItemId: h.item().id });
    release();
    await h.runtime.settled();

    expect(h.store.session(h.session)).toBeNull();
    expect(h.claude.stops).toEqual([SHORT]);
    expect(h.logs).toContain(`session ${h.session} resumed in the background as ${SHORT} after its move ended; stopping it`);
  });

  it('after a restart, runs a waiting move again and only confirms a launching one', async () => {
    const h = await inTab();

    h.store.updateSession(h.session, { move: { id: 'm1', pid: PID, phase: 'waiting', at: T0, deadline: null } });
    h.live.delete(PID);
    await h.runtime.startup();
    await h.runtime.settled();
    expect(h.claude.resumes).toHaveLength(1);
    expect(current(h.store, h.session)).toMatchObject({ move: null, released: false });

    const launching = await inTab();

    launching.store.updateSession(launching.session, { move: { id: 'm2', pid: PID, phase: 'launching', at: T0, deadline: T0 + 10_000 } });
    launching.claude.listed = [null];
    await launching.runtime.startup();
    await launching.runtime.settled();
    expect(launching.claude.resumes).toEqual([]);
    expect(launching.item()).toMatchObject({ status: 'blocked', error: 'Continue in Background failed: The session did not appear in claude agents within 60 seconds.' });
  });

  it('leaves the move stored for the next hub when this one stops during the wait', async () => {
    const h = await inTab({ exits: false });

    await h.runtime.background(LABEL, HOST, [h.item().id]);
    h.runtime.stop();
    h.live.delete(PID);
    await h.runtime.settled();

    expect(h.claude.resumes).toEqual([]);
    expect(current(h.store, h.session).move).toMatchObject({ pid: PID, phase: 'waiting' });
  });

  it('drops a roster read that ran while the move ended, so the resumed session is not ended by it', async () => {
    const h = await inTab();
    let finish!: () => void;

    // The request's own roster read sees the tab; the read held here starts while the move waits.
    await h.runtime.background(LABEL, HOST, [h.item().id]);
    h.claude.observeGate = new Promise<void>((resolve) => (finish = resolve));
    h.claude.first = [];
    h.claude.later = [{ sessionId: h.session, state: 'running', detail: null, interactive: false }];

    const read = h.runtime.readRoster();
    await h.runtime.settled();
    expect(current(h.store, h.session)).toMatchObject({ move: null, released: false });

    finish();
    await read;

    expect(current(h.store, h.session)).toMatchObject({ state: 'running', released: false, endedAt: null });
    expect(h.item().status).toBe('running');
  });
});
