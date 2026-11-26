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
import { T0, config, issue, deferred, setup } from './runtimeFixtures.js';

describe('Runtime', () => {
  it('leaves a done report open while a fresh read lists the ticket as assigned, and blocks it when the recheck still does, without telling the session (PRD R10)', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: null });
    expect(store.session('s1')?.outcome).toBe('done');

    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    expect(source.polls).toBe(3);
    expect(store.workItem(1)?.error).toBe('The session reported done, but the ticket is still assigned to you.');
  });

  it('finishes a done report once the recheck lists the ticket unassigned, or fails to read (mechanics M34)', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(source.polls).toBe(2);
    source.result = { tickets: [] };
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('done'));
    expect(source.polls).toBe(3);

    const failed = setup();
    failed.source.result = { tickets: [issue('8')] };
    await failed.runtime.pollSource('github');
    await failed.runtime.settled();
    await failed.runtime.report({ sessionId: 's1', kind: 'done' });
    failed.source.result = { error: 'GitHub is down.' };
    failed.recheck.resolve();
    await vi.waitFor(() => expect(failed.store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' }));
  });

  it('rechecks at startup a done report the hub stopped before checking again', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s1', { outcome: 'done', outcomeDetail: `${UNCONFIRMED_DONE}; it was still assigned at 2026-10-13T16:25:13.183Z.` });

    await runtime.startup();
    expect(store.workItem(1)?.status).toBe('running');
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    expect(source.polls).toBe(2);
  });

  it('schedules one recheck for a done report that startup finds again', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(store.session('s1')?.outcomeDetail).toMatch(new RegExp(`^${UNCONFIRMED_DONE}`));

    await runtime.startup();
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    await runtime.settled();
    await new Promise((done) => setTimeout(done, 0));
    expect(source.polls).toBe(3);
  });

  it('rechecks a later done report while the recheck of an earlier one is still pending', async () => {
    let now = T0;
    const { store, source, runtime, recheck } = setup(config(), () => now);
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    await runtime.report({ sessionId: 's1', kind: 'done' });
    const first = store.session('s1')?.outcomeDetail;
    now += 1_000;
    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(store.session('s1')?.outcomeDetail).not.toBe(first);

    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
  });

  it('accepts a done report when the second read outlasts REPORT_CHECK_MS', async () => {
    const { store, source, runtime, recheck, late, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });

    source.gate = new Promise(() => {});
    recheck.resolve();
    await vi.waitFor(() => expect(source.polls).toBe(3));
    late.resolve();
    await vi.waitFor(() => expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' }));
    expect(logs).toContain('done report for #8 accepted unchecked: the second github read took over 6 seconds');
    expect(source.polls).toBe(3);
  });
  it('queues the recheck behind a read in flight, and skips it after the hub stops', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });

    // A scheduled read still lists the ticket and is in flight when the recheck fires.
    const slow = deferred();
    source.gate = slow.promise;
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(3));
    source.result = { tickets: [] };
    recheck.resolve();
    slow.resolve();
    await scheduled;
    await vi.waitFor(() => expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'unassigned' }));
    expect(source.polls).toBe(4);

    const stopped = setup();
    stopped.source.result = { tickets: [issue('8')] };
    await stopped.runtime.pollSource('github');
    await stopped.runtime.settled();
    await stopped.runtime.report({ sessionId: 's1', kind: 'done' });
    stopped.runtime.stop();
    stopped.recheck.resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(stopped.source.polls).toBe(2);

    // Stopped while the recheck waits behind a read in flight.
    const queued = setup();
    queued.source.result = { tickets: [issue('8')] };
    await queued.runtime.pollSource('github');
    await queued.runtime.settled();
    await queued.runtime.report({ sessionId: 's1', kind: 'done' });
    const held = deferred();
    queued.source.gate = held.promise;
    const inFlight = queued.runtime.pollSource('github');
    await vi.waitFor(() => expect(queued.source.polls).toBe(3));
    queued.recheck.resolve();
    await new Promise((done) => setTimeout(done, 0));
    queued.runtime.stop();
    held.resolve();
    await inFlight;
    await new Promise((done) => setTimeout(done, 0));
    expect(queued.source.polls).toBe(3);
  });

  it('does not read the source again after a done report the read accepts', async () => {
    const { source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { tickets: [] };
    await runtime.report({ sessionId: 's1', kind: 'done' });
    recheck.resolve();
    await runtime.settled();
    await new Promise((done) => setTimeout(done, 0));
    expect(source.polls).toBe(2);
  });

  it('finishes on a done report when a fresh read lists the ticket outside the assigned state', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { tickets: [{ ...issue('8'), assigned: false }] };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(store.ticket(1)?.assigned).toBe(false);
  });

  it('accepts a done report when the source read fails', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { error: 'GitHub is down.' };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');
    expect(runtime.snapshot().errors.sources).toEqual({ github: 'GitHub is down.' });
  });

  it('polls each source now on Refresh and restarts its interval, and refuses when no source is on', async () => {
    vi.useFakeTimers();
    try {
      const { source, runtime } = setup();
      runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(1);

      await vi.advanceTimersByTimeAsync(100_000);
      expect(runtime.pollNow()).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(2);

      // The 300-second interval counts from the refresh, not from the start.
      await vi.advanceTimersByTimeAsync(299_999);
      expect(source.polls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(source.polls).toBe(3);

      // A refresh during a read does not read again, and the interval still counts from the refresh.
      const slow = deferred();
      source.gate = slow.promise;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(source.polls).toBe(4);
      expect(runtime.pollNow()).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(4);
      slow.resolve();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(source.polls).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(source.polls).toBe(5);

      expect(runtime.setSourceEnabled('github', false)).toBeNull();
      expect(runtime.pollNow()).toBe('No source is polled. Turn one on in the header.');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(source.polls).toBe(5);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the build error on Refresh when the only source that is on cannot be built', () => {
    const cfg = config();
    cfg.settings.sources = { jira: { ...cfg.settings.sources['github']!, kind: 'jira' } };
    const { runtime } = setup(cfg);

    expect(runtime.pollNow()).toBe('jira: Switchboard has no source kind jira.');
  });

  it('drops a read that finishes after its source is turned off', async () => {
    const { store, source, runtime } = setup();
    const slow = deferred();
    source.gate = slow.promise;
    source.result = { error: 'The forum cannot be reached.' };
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(1));

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    slow.resolve();
    await scheduled;
    await runtime.settled();

    expect(runtime.snapshot().errors.sources).toEqual({});

    // A slow read of tickets is dropped as well.
    expect(runtime.setSourceEnabled('github', true)).toBeNull();
    source.result = { tickets: [issue('8')] };
    const second = deferred();
    source.gate = second.promise;
    const again = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    second.resolve();
    await again;
    await runtime.settled();

    expect(store.findTicket('github', '8')).toBeNull();
  });

  it('accepts a done report unchecked when the source read outlasts the check, and applies reads in order', async () => {
    const { store, source, runtime, logs, late } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const slow = deferred();
    source.gate = slow.promise;
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    source.result = { tickets: [] };
    const report = runtime.report({ sessionId: 's1', kind: 'done' });
    late.resolve();

    expect(await report).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(logs).toContain('done report for #8 accepted unchecked: the github read took over 6 seconds');

    // The scheduled poll, read before the ticket left, applies before the done check's read, so the ticket ends unassigned.
    slow.resolve();
    await scheduled;
    await vi.waitFor(() => expect(store.ticket(1)?.assigned).toBe(false));
    await runtime.settled();
    expect(store.workItemsForTicket(1)).toHaveLength(1);
  });
});
