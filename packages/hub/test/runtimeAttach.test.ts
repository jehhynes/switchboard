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
import { T0, home, config, fail, deferred, FakeCodex, setup, fakeRunner } from './runtimeFixtures.js';

describe('Code Mode sessions (PRD R93-R95)', () => {
  describe('attach (PRD R95)', () => {
    const HOLDER = { port: 4100, token: 'holder-token', session: 's1' };

    function held(session: string, exited = false): SessionEntry {
      return { session, label: 'l', pid: 900, cwd: 'D:/git/widgets', startedAt: T0, lastInputAt: null, lastOutputAt: null, exitedAt: exited ? T0 : null, exitCode: exited ? 0 : null, clients: 0, memoryBytes: null };
    }

    /** A held Code Mode session s1 and a holder whose list the test sets; `now` is settable. */
    async function attaching(codeMode: SessionRunner, cfg = config({ installHooks: true }), claude: SessionRunner = fakeRunner()) {
      const clock = { now: T0 };
      const entries: SessionEntry[] = [held('s1')];
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

      const context = setup(cfg, () => clock.now, { claude, codeMode }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });

      context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1' });

      return { ...context, clock, entries };
    }

    /** The session's process has exited and the flow has ended it. */
    function endIt(context: { store: Store; entries: SessionEntry[] }): void {
      context.entries.splice(0, context.entries.length, held('s1', true));
      context.store.updateSession('s1', { state: 'ended', endedAt: T0, released: true });
    }

    const idleObservation: SessionRunner['observe'] = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });

    function resumer(overrides: Partial<SessionRunner> = {}): SessionRunner & { stops: string[]; starts: string[]; resumes: Array<{ id: string; permissionMode: string; model: string | null; label: string }> } {
      const resumes: Array<{ id: string; permissionMode: string; model: string | null; label: string }> = [];

      return {
        ...fakeRunner({
          resumeHeld: async (session, permissionMode, model, label) => {
            resumes.push({ id: session.id, permissionMode, model, label });
            return { launchId: `launch-${resumes.length + 1}` };
          },
          leftovers: async () => [],
          ...overrides,
        }),
        resumes,
      };
    }

    it('answers the holder of a live session at once, without resuming it', async () => {
      const codeMode = resumer();
      const { runtime } = await attaching(codeMode);

      expect(await runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toEqual([]);
      runtime.stop();
    });

    it('refuses an unknown session with 404 and a background session with 409', async () => {
      const { runtime, store } = await attaching(resumer());

      expect(await runtime.attach('nope')).toEqual({ refused: 'No session nope.', status: 404 });
      store.updateSession('s1', { codeMode: false });
      expect(await runtime.attach('s1')).toEqual({ refused: 'Session s1-short is not held in the terminal holder.', status: 409 });
      runtime.stop();
    });

    describe('an ended registered session (PRD R81)', () => {
      const transcript = (lines: Array<Record<string, unknown>>) => {
        const dir = join(home, '.claude', 'projects', 'D--git-widgets');

        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 's1-native.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
      };
      const assistant = (model: string) => ({ type: 'assistant', message: { model, role: 'assistant', content: [] }, sessionId: 's1-native' });

      function capturing() {
        const calls: Array<{ withoutCodeMode: boolean | undefined; permissionMode: string; model: string | null; contract: string | undefined }> = [];
        const codeMode = resumer({
          resumeHeld: async (session, permissionMode, model, _label, launchId, _fresh, contract) => {
            calls.push({ withoutCodeMode: session.withoutCodeMode, permissionMode, model, contract });
            return { launchId: launchId ?? 'launch-x' };
          },
        });

        return { codeMode, calls };
      }

      /** s1 as a registered session that ended in the operator's window; `live` is what Claude's roster says of it. */
      async function registeredEnded(live: Awaited<ReturnType<NonNullable<SessionRunner['live']>>>) {
        const { codeMode, calls } = capturing();
        const context = await attaching(codeMode, config({ installHooks: true, permissionMode: 'auto', model: 'haiku' }), fakeRunner({ live: async () => live }));

        endIt(context);
        context.store.updateSession('s1', { codeMode: false, launchId: null, registered: true });

        return { ...context, calls };
      }

      it('resumes it in the holder without Code Mode, with its contract and the mode and model its transcript recorded, and holds it from then on', async () => {
        const context = await registeredEnded(null);
        transcript([{ type: 'user', message: { role: 'user', content: 'hi' }, permissionMode: 'bypassPermissions', sessionId: 's1-native' }, assistant('claude-sonnet-5')]);

        // Until then its row and its page offer it as an ended held session.
        expect(context.runtime.snapshot().workItems[0]!.sessions[0]).toMatchObject({ codeMode: true, registered: true });

        expect(await context.runtime.attach('s1')).toEqual(HOLDER);
        expect(context.calls).toEqual([{ withoutCodeMode: true, permissionMode: 'bypassPermissions', model: 'claude-sonnet-5', contract: expect.stringMatching(/^Report to Switchboard with these commands:\n/) }]);
        expect(context.store.session('s1')).toMatchObject({ state: 'idle', codeMode: true, withoutCodeMode: true, released: false });
        context.runtime.stop();
      });

      it('follows its conversation from the resume on, so the history before it is not read as new', async () => {
        const context = await registeredEnded(null);
        const path = join(home, '.claude', 'projects', 'D--git-widgets', 's1-native.jsonl');

        transcript([{ type: 'user', message: { role: 'user', content: 'days of history' }, sessionId: 's1-native' }, assistant('claude-sonnet-5')]);
        // The last line is complete; a line still being written would wait for its newline.
        appendFileSync(path, '\n');

        expect(await context.runtime.attach('s1')).toEqual(HOLDER);
        // The path as the conversation's transcript lookup names it, so its first read starts at the checkpoint.
        expect(context.store.checkpoint('s1')).toEqual({ sessionId: 's1', transcript: `${join(home, '.claude', 'projects')}/D--git-widgets/s1-native.jsonl`, offset: statSync(path).size, lastUuid: null, lastAt: expect.any(Number) });
        context.runtime.stop();
      });

      it('resumes one that ran in Code Mode with Code Mode, and falls back to the settings for what the transcript did not record', async () => {
        const context = await registeredEnded(null);
        transcript([{ type: 'repl-mode', replMode: true, sessionId: 's1-native' }]);

        expect(await context.runtime.attach('s1')).toEqual(HOLDER);
        expect(context.calls).toEqual([{ withoutCodeMode: false, permissionMode: 'auto', model: 'haiku', contract: expect.any(String) }]);
        expect(context.store.session('s1')).toMatchObject({ codeMode: true, withoutCodeMode: false });
        context.runtime.stop();
      });

      it('refuses while Claude lists it with a process, when the roster cannot be read, and without a transcript, and leaves it as it was', async () => {
        const running = await registeredEnded({ shortId: 's1-short', cwd: 'D:/git/widgets' });
        transcript([assistant('claude-sonnet-5')]);
        expect(await running.runtime.attach('s1')).toEqual({ refused: "Session s1-short still runs outside Switchboard's terminal holder, in a Claude window or the background service; end it there, then resume it here.", status: 409 });
        running.runtime.stop();

        const unread = await registeredEnded({ error: 'claude agents timed out' });
        expect(await unread.runtime.attach('s1')).toEqual({ refused: 'Switchboard could not check that session s1-short no longer runs elsewhere: claude agents timed out', status: 409 });
        unread.runtime.stop();

        rmSync(join(home, '.claude', 'projects'), { recursive: true, force: true });
        const missing = await registeredEnded(null);
        expect(await missing.runtime.attach('s1')).toEqual({ refused: 'Claude keeps no transcript of session s1-short, so it cannot be resumed.', status: 409 });
        expect(missing.calls).toEqual([]);
        expect(missing.store.session('s1')).toMatchObject({ state: 'ended', codeMode: false });
        missing.runtime.stop();
      });

      it('does not spawn when a roster read finds it running again while its checks run, nor for an older session of its work item', async () => {
        const { codeMode, calls } = capturing();
        let context: Awaited<ReturnType<typeof attaching>> | undefined;
        const claude = fakeRunner({
          live: async () => {
            context!.store.updateSession('s1', { state: 'running', endedAt: null });
            return null;
          },
        });

        context = await attaching(codeMode, config({ installHooks: true }), claude);
        endIt(context);
        context.store.updateSession('s1', { codeMode: false, launchId: null, registered: true });
        transcript([assistant('claude-sonnet-5')]);

        expect(await context.runtime.attach('s1')).toEqual({ refused: 'Session s1-short changed while it resumed; try again.', status: 409 });
        expect(calls).toEqual([]);
        expect(context.store.session('s1')).toMatchObject({ codeMode: false });
        context.runtime.stop();

        const { codeMode: second, calls: secondCalls } = capturing();
        let racing: Awaited<ReturnType<typeof attaching>> | undefined;
        racing = await attaching(second, config({ installHooks: true }), fakeRunner({
          live: async () => {
            racing!.store.insertSession({ ...racing!.store.session('s1')!, id: 's3', startedAt: T0 + 1, registered: false, nativeSessionId: 's3-native' });
            return null;
          },
        }));
        endIt(racing);
        racing.store.updateSession('s1', { codeMode: false, launchId: null, registered: true });
        expect(await racing.runtime.attach('s1')).toEqual({ refused: 'A newer session of this work item started; this one cannot resume.', status: 409 });
        expect(secondCalls).toEqual([]);
        expect(racing.store.session('s1')).toMatchObject({ codeMode: false });
        racing.runtime.stop();

        const older = await registeredEnded(null);
        older.store.insertSession({ ...older.store.session('s1')!, id: 's2', startedAt: T0 + 1, registered: false, nativeSessionId: 's2-native' });
        expect(await older.runtime.attach('s1')).toEqual({ refused: 'A newer session of this work item started; this one cannot resume.', status: 409 });
        older.runtime.stop();
      });

      it('refuses a registered session that still runs in the operator window, as any session that is not held', async () => {
        const context = await registeredEnded(null);

        context.store.updateSession('s1', { state: 'idle', endedAt: null, external: true });
        expect(await context.runtime.attach('s1')).toEqual({ refused: 'Session s1-short is not held in the terminal holder.', status: 409 });
        expect(context.runtime.snapshot().workItems[0]!.sessions[0]).toMatchObject({ codeMode: false });
        context.runtime.stop();
      });
    });

    it('refuses with the holder lookup failure', async () => {
      const { runtime, store } = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect: async () => Promise.reject(new Error('refused')), lockHeld: async () => true } });

      runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
      await runtime.settled();
      store.updateSession('s1', { codeMode: true, launchId: 'launch-1' });
      mkdirSync(join(home, '.switchboard'), { recursive: true });
      writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));

      expect(await runtime.attach('s1')).toEqual({ refused: 'The terminal holder holds its lock but does not answer.', status: 409 });
      runtime.stop();
    });

    it("resumes an ended session with its work item's mode and model and a label as its start had, then answers the holder", async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode, config({ installHooks: true, permissionMode: 'auto', model: 'haiku' }));

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toEqual([{ id: 's1', permissionMode: 'auto', model: 'haiku', label: 'switchboard · ad-hoc · adhoc 1 s1-native' }]);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-2' });
      expect(context.logs).toContain('session s1 resumed in the terminal holder');
      context.runtime.stop();
    });

    it('ends a session the holder no longer lists with a roster read before resuming it, and refuses one still listed by the roster', async () => {
      const codeMode = resumer({ observe: async () => ({ sessions: [] }) });
      const context = await attaching(codeMode);

      context.entries.splice(0, 1);
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);

      const still = resumer();
      const other = await attaching(still);

      other.entries.splice(0, 1);
      expect(await other.runtime.attach('s1')).toEqual({ refused: 'Session s1-short is still ending; try again.', status: 409 });
      expect(still.resumes).toEqual([]);
      context.runtime.stop();
      other.runtime.stop();
    });

    it("passes an ended session's last tree to the runner for Stop, and clears it once the processes have ended", async () => {
      const targets: unknown[] = [];
      const codeMode = resumer({
        stop: async (target) => {
          targets.push(target);
          return null;
        },
      });
      const context = await attaching(codeMode);
      const tree = [{ pid: 100, created: '1' }];

      endIt(context);
      context.store.updateSession('s1', { lastTree: tree });
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();

      expect(targets).toEqual([{ type: 'stop-session', sessionId: 's1', provider: 'claude', shortId: 's1-short', reason: 'operator', codeMode: true, lastTree: tree }]);
      expect(context.store.session('s1')!.lastTree).toBeNull();
      context.runtime.stop();
    });

    it('ends a resumed process and refuses the attach when Delete removed the session during the spawn', async () => {
      const spawning = deferred();
      const spawned = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.resumeHeld = async (...args) => {
        spawning.resolve();
        await spawned.promise;
        return resumeHeld(...args);
      };
      endIt(context);

      const attach = context.runtime.attach('s1');

      await spawning.promise;
      expect(context.runtime.send({ type: 'delete', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(codeMode.stops).toEqual([]);
      spawned.resolve();

      expect(await attach).toEqual({ refused: 'No session s1.', status: 404 });
      expect(codeMode.stops).toEqual(['s1']);
      expect(context.logs).toContain('session s1 changed while it resumed; ended the resumed process');
      context.runtime.stop();
    });

    it('does not end a session resumed while a roster read that left it out was running', async () => {
      const listed = deferred();
      const release = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);

      endIt(context);
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.push(held('s2'));
      codeMode.observe = async (sessions) => {
        const live = sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null));

        listed.resolve();
        await release.promise;
        return { sessions: live.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      };

      const read = context.runtime.readRoster();

      await listed.promise;
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      release.resolve();
      await read;

      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('waits for an operator Stop to reach the flow before resuming the stopped session', async () => {
      const killed = deferred();
      const reported = deferred();
      const codeMode = resumer({ observe: idleObservation });
      const context = await attaching(codeMode);
      let discoveries = 0;

      codeMode.stop = async () => {
        context.entries.splice(0, 1, held('s1', true));
        return null;
      };
      context.runtime['findSetupWorktrees'] = async () => {
        if (discoveries++ === 0) {
          killed.resolve();
          await reported.promise;
        }
      };
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await killed.promise;

      const attach = context.runtime.attach('s1');

      await new Promise((done) => setImmediate(done));
      expect(codeMode.resumes).toEqual([]);
      reported.resolve();

      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('waits for a Stop that starts while the attach looks up the holder, then resumes the stopped session', async () => {
      const looking = deferred();
      const found = deferred();
      const killed = deferred();
      const reported = deferred();
      const codeMode = resumer({ observe: idleObservation });
      const context = await attaching(codeMode);
      const holder = context.runtime['holder'];
      const find = holder.find.bind(holder);
      let discoveries = 0;

      holder.find = async (start) => {
        const result = await find(start);

        looking.resolve();
        await found.promise;
        return result;
      };
      codeMode.stop = async () => {
        context.entries.splice(0, 1, held('s1', true));
        return null;
      };
      context.runtime['findSetupWorktrees'] = async () => {
        if (discoveries++ === 0) {
          killed.resolve();
          await reported.promise;
        }
      };

      const attach = context.runtime.attach('s1');

      await looking.promise;
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await killed.promise;
      found.resolve();
      await new Promise((done) => setImmediate(done));
      expect(codeMode.resumes).toEqual([]);
      reported.resolve();

      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('leaves a session being resumed out of a roster read that lists its new process', async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      endIt(context);
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.push(held('s2'));
      codeMode.observe = async (sessions) => ({
        sessions: sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null)).map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })),
      });
      codeMode.resumeHeld = async (...args) => {
        context.entries.splice(0, 1, held('s1'));
        await context.runtime.readRoster();
        return resumeHeld(...args);
      };

      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.stops).toEqual([]);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('stores the launch before the spawn, so a hub restarted during it holds the live process under that launch', async () => {
      const spawned = deferred();
      const never = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const launches: Array<string | undefined> = [];

      codeMode.newLaunchId = () => 'launch-stored';
      codeMode.resumeHeld = async (session, _mode, _model, _label, launchId) => {
        launches.push(launchId);
        context.entries.splice(0, 1, held('s1'));
        spawned.resolve();
        await never.promise;
        return { launchId: launchId! };
      };
      endIt(context);
      void context.runtime.attach('s1');
      await spawned.promise;
      expect(context.store.session('s1')).toMatchObject({ state: 'ended', launchId: 'launch-stored' });
      context.runtime.stop();

      const restarted = new Runtime(context.runtime['deps'], context.runtime['config']);

      try {
        expect(await restarted.attach('s1')).toEqual(HOLDER);
        expect(launches).toEqual(['launch-stored']);
        expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-stored' });
        expect(context.logs).toContain('session s1 is live in the terminal holder under launch launch-stored; holding it again');
      } finally {
        restarted.stop();
      }
    });

    it('holds again an ended session that a roster read finds live under its stored launch', async () => {
      const codeMode = resumer({ observe: async (sessions) => ({ sessions: sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null)).map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) }) });
      const context = await attaching(codeMode);

      endIt(context);
      context.store.updateSession('s1', { launchId: 'launch-stored' });
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.splice(0, 1, held('s1'), held('s2'));
      await context.runtime.readRoster();

      expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-stored' });
      context.runtime.stop();
    });

    it('ignores a roster result for a session that Stop ended while the read ran', async () => {
      const listed = deferred();
      const release = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);

      codeMode.observe = async (sessions) => {
        listed.resolve();
        await release.promise;
        return { sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      };

      const read = context.runtime.readRoster();

      await listed.promise;
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
      release.resolve();
      await read;

      expect(context.store.session('s1')).toMatchObject({ state: 'ended', released: true });
      expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
      expect(context.logs.some((line) => line.includes('holding it again'))).toBe(false);
      context.runtime.stop();
    });

    it('refuses a resume with hooks off', async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode, config({ installHooks: false }));

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'Claude sessions need sessions.installHooks.', status: 409 });
      expect(codeMode.resumes).toEqual([]);
      context.runtime.stop();
    });

    it('refuses a resume while processes of the last run still run, or when they cannot be checked', async () => {
      let left: Awaited<ReturnType<NonNullable<SessionRunner['leftovers']>>> = [{ pid: 100, created: '1' }, { pid: 101, created: '2' }];
      const trees: unknown[] = [];
      const codeMode = resumer({
        leftovers: async (tree) => {
          trees.push(tree);
          return left;
        },
      });
      const context = await attaching(codeMode);

      endIt(context);
      context.store.updateSession('s1', { lastTree: [{ pid: 100, created: '1' }, { pid: 101, created: '2' }, { pid: 102, created: '3' }] });
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'Session s1-short still has 2 processes from its previous run (pids 100, 101). Stop them or wait for them to end.', status: 409 });
      expect(trees).toEqual([[{ pid: 100, created: '1' }, { pid: 101, created: '2' }, { pid: 102, created: '3' }]]);

      left = [{ pid: 100, created: '1' }];
      expect(await context.runtime.attach('s1')).toMatchObject({ refused: 'Session s1-short still has 1 process from its previous run (pid 100). Stop them or wait for them to end.' });

      left = { error: 'The process table could not be read: Access is denied.' };
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'The process table could not be read: Access is denied.', status: 409 });

      left = [];
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toHaveLength(1);
      context.runtime.stop();
    });

    it('offers Stop on the row while the guard refuses, until a leftover stop or a resume succeeds (PRD R95)', async () => {
      let left: Awaited<ReturnType<NonNullable<SessionRunner['leftovers']>>> = [{ pid: 100, created: '1' }];
      const codeMode = resumer({ leftovers: async () => left });
      const context = await attaching(codeMode);
      const shown = () => context.runtime.snapshot().workItems[0]!;
      const tree = [{ pid: 100, created: '1' }];

      endIt(context);
      context.store.updateSession('s1', { lastTree: tree });
      expect(shown().leftovers).toBeUndefined();
      expect(controlsOf(shown()).map((control) => control.label)).not.toContain('Stop session');

      await context.runtime.attach('s1');
      expect(shown().leftovers).toEqual([100]);
      expect(controlsOf(shown()).find((control) => control.label === 'Stop session')?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 1 } });

      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(context.store.session('s1')?.lastTree ?? null).toBeNull();
      expect(shown().leftovers).toBeUndefined();

      context.store.updateSession('s1', { lastTree: tree });
      await context.runtime.attach('s1');
      expect(shown().leftovers).toEqual([100]);
      left = [];
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(shown().leftovers).toBeUndefined();
      context.runtime.stop();
    });

    it('refuses with the reason a resume fails, and leaves the session ended', async () => {
      const codeMode = resumer({ resumeHeld: async () => ({ error: 'The terminal holder did not start.' }) });
      const context = await attaching(codeMode);

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'The terminal holder did not start.', status: 409 });
      expect(context.store.session('s1')).toMatchObject({ state: 'ended' });
      context.runtime.stop();
    });

    it('resumes once for attaches made together', async () => {
      const gate = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.resumeHeld = async (...args) => {
        await gate.promise;
        return resumeHeld(...args);
      };
      endIt(context);

      const attaches = [context.runtime.attach('s1'), context.runtime.attach('s1')];

      gate.resolve();

      expect(await Promise.all(attaches)).toEqual([HOLDER, HOLDER]);
      expect(codeMode.resumes).toHaveLength(1);
      context.runtime.stop();
    });

    it('defers an end that reads the terminals while an attach arrives, until the reservation expires', async () => {
      let answer = (): void => {};
      const codeMode = resumer({ heldActivity: () => new Promise((done) => (answer = () => done({ clients: 0, lastInputAt: null }))), observe: idleObservation });
      const context = await attaching(codeMode);

      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const attach = context.runtime.attach('s1');

      answer();
      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();

      expect(codeMode.stops).toEqual([]);
      expect(context.logs).toContain('end of held session s1 deferred: a terminal is attaching');

      context.clock.now = T0 + ATTACH_RESERVATION_MS;
      codeMode.heldActivity = async () => ({ clients: 0, lastInputAt: null });
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual(['s1']);
      context.runtime.stop();
    });

    it('waits for an end in progress, then resumes the ended session', async () => {
      let ended = (): void => {};
      const order: string[] = [];
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.stop = (target) =>
        new Promise((done) => {
          ended = () => {
            order.push(`stop ${target.sessionId}`);
            context.entries.splice(0, 1, held('s1', true));
            done(null);
          };
        });
      codeMode.resumeHeld = async (...args) => {
        order.push(`resume ${args[0].id}`);
        return resumeHeld(...args);
      };
      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const attach = context.runtime.attach('s1');

      await vi.waitFor(() => expect(order).toEqual([]));
      ended();

      expect(await attach).toEqual(HOLDER);
      expect(order).toEqual(['stop s1', 'resume s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2' });
      context.runtime.stop();
    });

    it('defers an end while a message is typed, and refuses a reservation for another launch or an ended session', async () => {
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);

      expect(await context.runtime.reserveInput('s1', 'launch-0')).toEqual({ refused: SESSION_RELAUNCHED });

      const reservation = await context.runtime.reserveInput('s1', 'launch-1');

      if (!('release' in reservation)) {
        throw new Error('expected a reservation');
      }

      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual([]);
      expect(context.logs).toContain('end of held session s1 deferred: a message is being typed');

      // A second release changes nothing.
      reservation.release();
      reservation.release();
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual(['s1']);
      endIt(context);
      expect(await context.runtime.reserveInput('s1', 'launch-1')).toEqual({ refused: SESSION_ENDED });
      context.runtime.stop();
    });

    it('waits for an end in progress before it reserves, and then refuses the ended session', async () => {
      let ended = (): void => {};
      const order: string[] = [];
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);

      codeMode.stop = (target) =>
        new Promise((done) => {
          ended = () => {
            order.push(`stop ${target.sessionId}`);
            context.entries.splice(0, 1, held('s1', true));
            done(null);
          };
        });
      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const reserving = context.runtime.reserveInput('s1', 'launch-1').then((result) => {
        order.push('reserved');
        return result;
      });

      await vi.waitFor(() => expect(order).toEqual([]));
      ended();

      expect(await reserving).toEqual({ refused: SESSION_ENDED });
      expect(order).toEqual(['stop s1', 'reserved']);
      context.runtime.stop();
    });

    it('types through the connected holder only when it serves write', async () => {
      const context = await attaching(resumer());

      expect(context.runtime.heldCannotType()).toBeNull();
      await context.runtime.readRoster();

      const cannotType = context.runtime.heldCannotType();

      expect(cannotType).toMatch(/^The terminal holder is from an older build and cannot accept messages from Switchboard\. Open the session in a terminal to type there\. To update it, run \S+ "[^"]+\/\.switchboard\/hub\.js" holder stop --all, review the sessions listed, then run it again with --yes; those sessions will stop\.$/);
      expect(context.runtime.heldHolder()).toMatchObject({ protocol: 1 });
      await expect(context.runtime.writeHeld('s1', 'x')).rejects.toThrow(new NotWritten(cannotType!));
      context.runtime.stop();
    });

    it("shows a held session in the page's console and resizes it only through a holder that serves view", async () => {
      const context = await attaching(resumer());

      await context.runtime.readRoster();

      const handlers = { onSize: () => undefined, onData: () => undefined, onReplayed: () => undefined, onExit: () => undefined, onClose: () => undefined };

      await expect(context.runtime.viewHeld('s1', handlers)).rejects.toThrow(/^The terminal holder is from an older build and cannot show the session's console here\. Open the session in a terminal\. To update it, run .* holder stop --all/);
      await expect(context.runtime.sizeHeld('s1', 100, 30)).rejects.toBeInstanceOf(NotWritten);
      context.runtime.stop();
    });

    it("streams a held session to the page's console over its own view connection, and resizes and types with a key through the holder", async () => {
      const context = await attaching(resumer());
      const calls: string[] = [];
      const fake = createNetServer((socket) => {
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');

          for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
            const message = JSON.parse(buffer.slice(0, index)) as { type: string; token?: string; session?: string };

            buffer = buffer.slice(index + 1);
            calls.push(message.type === 'hello' ? `hello ${message.token}` : `${message.type} ${message.session}`);

            if (message.type === 'hello') {
              socket.write(JSON.stringify({ type: 'welcome', protocol: 1, build: 'b', pid: 4243, features: ['snapshot', 'write', 'view'] }) + '\n');
            } else if (message.type === 'view') {
              for (const line of [{ type: 'resized', cols: 80, rows: 24 }, { type: 'replay', data: 'screen' }, { type: 'replayed' }, { type: 'output', data: 'more' }, { type: 'exited', exitCode: 0 }]) {
                socket.write(JSON.stringify(line) + '\n');
              }

              socket.end();
            }
          }
        });
      });

      await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
      writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: (fake.address() as { port: number }).port, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));
      context.runtime.stop();

      const connection: HolderConnection = {
        welcome: { protocol: 1, build: 'b', pid: 4243, features: ['snapshot', 'write', 'view'] },
        compatible: true,
        spawn: async () => ({ session: 's', pid: 1 }),
        list: async () => context.entries,
        kill: async () => 0,
        screen: async () => ({ head: '', text: '' }),
        write: async (session, data, key) => {
          calls.push(`write ${session} ${data} ${String(key)}`);
          return { rev: 1 };
        },
        size: async (session, cols, rows) => {
          calls.push(`size ${session} ${cols}x${rows}`);
          return { rev: 1 };
        },
        shutdown: async () => {},
        onClose: () => {},
        close: () => {},
      };
      const viewing = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });
      const seen: string[] = [];
      const closed = new Promise<string | null>((done) => {
        void viewing.runtime.viewHeld('s1', {
          onSize: (cols, rows) => seen.push(`size ${cols}x${rows}`),
          onData: (data) => seen.push(data),
          onReplayed: () => seen.push('replayed'),
          onExit: (exitCode) => seen.push(`exited ${String(exitCode)}`),
          onClose: done,
        });
      });

      expect(await closed).toBeNull();
      expect(seen).toEqual(['size 80x24', 'screen', 'replayed', 'more', 'exited 0']);
      await viewing.runtime.sizeHeld('s1', 100, 30);
      await viewing.runtime.writeHeld('s1', 'k', true);
      expect(calls).toEqual(['hello holder-token', 'view s1', 'size s1 100x30', 'write s1 k true']);
      viewing.runtime.stop();
      await new Promise((done) => fake.close(done));
    });
    describe('held sessions (PRD R94)', () => {
      const CLAUDE = '9273f594-1111-4222-8333-444455556666';
      const label = (key: string, native: string) => `switchboard · ad-hoc · ${key} ${native}`;

      it('lists the holder\'s sessions joined with the store, orphans first, and logs each orphan once', async () => {
        const context = await attaching(resumer());

        context.store.updateSession('s1', { nativeSessionId: CLAUDE });
        context.entries.splice(0, 1, { ...held('s1'), label: label('adhoc 1', 'old-native'), lastInputAt: T0 + 5, lastOutputAt: T0 + 9, clients: 2, memoryBytes: 300 * 1024 * 1024 }, { ...held('gone-1'), label: label('gh 7', 'aaaabbbb-0000') });
        await context.runtime.readRoster();
        await context.runtime.readRoster();

        expect(context.runtime.snapshot().held).toEqual([
          { session: 'gone-1', label: label('gh 7', 'aaaabbbb-0000'), workItemId: null, key: 'gh 7', nativeSessionId: 'aaaabbbb-0000', cwd: 'D:/git/widgets', state: 'live', idleSince: T0, memoryBytes: null, clients: 0, exitedAt: null, exitCode: null, orphan: true },
          { session: 's1', label: label('adhoc 1', 'old-native'), workItemId: 1, key: 'adhoc 1', nativeSessionId: CLAUDE, cwd: 'D:/git/widgets', state: 'running', idleSince: T0 + 9, memoryBytes: 300 * 1024 * 1024, clients: 2, exitedAt: null, exitCode: null, orphan: false },
        ]);
        expect(context.logs.filter((line) => line.startsWith('held session'))).toEqual([`held session gone-1 has no work item: ${label('gh 7', 'aaaabbbb-0000')}`]);
        context.runtime.stop();
      });

      it('counts an ended session still live as an orphan, but not an older session whose end waits, nor an exited one', async () => {
        const context = await attaching(resumer());

        context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
        await context.runtime.settled();
        context.store.updateSession('s2', { codeMode: true, state: 'ended', endedAt: T0, released: true });
        context.store.updateSession('s1', { state: 'idle', releasing: true });
        context.entries.splice(0, 1, held('s1'), held('s2'), held('s3', true));

        expect((await context.runtime.listHeld()).map((one) => [one.session, one.orphan, one.state])).toEqual([
          ['s2', true, 'live'],
          ['s1', false, 'idle'],
          ['s3', false, 'exited'],
        ]);
        context.runtime.stop();
      });

      it('reads the list with no active Code Mode session, keeps it when a read fails, and empties it once the holder is gone', async () => {
        const context = await attaching(resumer());
        const connection = await context.runtime['holder'].find(false);
        let closed = (): void => {};
        let fail: string | null = null;

        if (!('holder' in connection)) {
          throw new Error('no holder');
        }

        connection.holder.onClose = (listener) => (closed = listener);
        connection.holder.list = async () => (fail === null ? context.entries : Promise.reject(new Error(fail)));
        context.runtime.send({ type: 'delete', workItemId: 1 });
        await context.runtime.settled();
        context.runtime['holder'].close();
        context.entries.splice(0, 1, held('s9'));

        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held?.map((one) => one.session)).toEqual(['s9']);

        fail = 'The terminal holder did not answer.';
        await context.runtime.readRoster();
        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held?.map((one) => one.session)).toEqual(['s9']);
        expect(context.logs.filter((line) => line.startsWith('held session list failed'))).toEqual(['held session list failed: The terminal holder did not answer.']);

        context.runtime['holder']['deps'].connect = async () => Promise.reject(new Error('refused'));
        context.runtime['holder']['deps'].lockHeld = async () => false;
        closed();
        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held).toBeUndefined();
        context.runtime.stop();
      });

      it('never connects without a holder record', async () => {
        const connect = vi.fn(async () => Promise.reject(new Error('no holder')));
        const { runtime } = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect, lockHeld: async () => false } });

        expect(await runtime.listHeld()).toEqual([]);
        await runtime.readRoster();
        expect(connect).not.toHaveBeenCalled();
        expect(runtime.snapshot().held).toBeUndefined();
        runtime.stop();
      });

      describe('restart (architecture.md § Restarting the holder)', () => {
        const INSTALLED = 'cccccccccccccccc';

        /** Installs the build `INSTALLED` in the test home, so the connected holder, of build `b`, is from an older build. */
        function install(): void {
          mkdirSync(join(home, '.switchboard', 'holder', INSTALLED), { recursive: true });
          writeFileSync(join(home, '.switchboard', 'holder', INSTALLED, 'holder.js'), '');
          writeFileSync(join(home, '.switchboard', 'holder', 'current.json'), JSON.stringify({ build: INSTALLED }));
        }

        it('stops every live held session, restarts the holder, resumes the active ones and reports the one that did not resume', async () => {
          install();

          const codeMode = resumer({
            resumeHeld: async (session) => (session.id === 's2' ? { error: 'Claude Code did not start.' } : { launchId: `${session.id}-new` }),
          });
          const context = await attaching(codeMode);
          const order: string[] = [];

          context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
          await context.runtime.settled();
          context.store.updateSession('s2', { codeMode: true, launchId: 'launch-2' });
          context.entries.splice(0, 1, held('s1'), held('s2'), held('o1'));
          codeMode.stop = async (target) => {
            order.push(`stop ${target.sessionId}`);
            context.entries.splice(context.entries.findIndex((entry) => entry.session === target.sessionId), 1);
            return null;
          };
          await context.runtime.readRoster();

          const holder = context.runtime['holder'];
          const connection = await holder.find(false);

          if (!('holder' in connection)) {
            throw new Error('no holder');
          }

          holder.restart = async () => {
            order.push('restart');
            return connection;
          };

          expect(context.runtime.holderState()).toEqual({ build: 'b', installed: INSTALLED, older: true, restart: null });
          expect(context.runtime.restartHolder()).toBeNull();
          expect(context.runtime.restartHolder()).toBe('The terminal holder is already restarting.');
          expect(context.runtime.snapshot().holder?.restart).toEqual({ state: 'running', at: T0 });
          await context.runtime.settled();

          expect(order).toEqual(['stop o1', 'stop s1', 'stop s2', 'restart']);
          expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 's1-new' });
          // No terminal attaches, so nothing defers the resumed session's end.
          expect(context.runtime['reservations'].has('s1')).toBe(false);
          expect(context.store.session('s2')).toMatchObject({ state: 'ended', outcome: 'stopped' });
          expect(context.runtime.snapshot().holder?.restart).toEqual({ state: 'done', at: T0, resumed: 1, failed: [{ session: 's2', key: 'adhoc 2', error: 'Claude Code did not start.' }], error: null });
          expect(context.logs).toContain('holder restart: session s2 did not resume: Claude Code did not start.');
          context.runtime.stop();
        });

        it('resumes the stopped sessions in the old holder when it still holds a session after 3 rounds', async () => {
          install();

          const codeMode = resumer();
          const context = await attaching(codeMode);
          let restarts = 0;

          codeMode.stop = async () => {
            context.entries.splice(0, context.entries.length);
            return null;
          };
          await context.runtime.readRoster();

          const holder = context.runtime['holder'];

          holder.restart = async () => {
            restarts += 1;
            return { live: ['late-1'] };
          };

          expect(context.runtime.restartHolder()).toBeNull();
          await context.runtime.settled();

          expect(restarts).toBe(3);
          expect(context.store.session('s1')).toMatchObject({ state: 'idle' });
          expect(context.runtime.snapshot().holder?.restart).toMatchObject({ state: 'done', resumed: 1, failed: [], error: 'The terminal holder still holds 1 live session (late-1), so it was not ended.' });
          context.runtime.stop();
        });

        it('refuses with no holder connected, and for a holder of the installed build', async () => {
          const context = await attaching(resumer());

          expect(context.runtime.restartHolder()).toBe('No terminal holder is running.');
          expect(context.runtime.holderState()).toBeNull();

          install();
          await context.runtime.readRoster();

          const connection = await context.runtime['holder'].find(false);

          if (!('holder' in connection)) {
            throw new Error('no holder');
          }

          Object.assign(connection.holder.welcome, { build: INSTALLED, features: ['snapshot', 'write', 'view'] });
          expect(context.runtime.holderState()).toEqual({ build: INSTALLED, installed: INSTALLED, older: false, restart: null });
          expect(context.runtime.restartHolder()).toBe('The terminal holder already runs the installed build.');
          context.runtime.stop();
        });
      });

      it('stops an active held session through the flow by its Switchboard ID, Claude ID, a retired ID or 8 characters of one', async () => {
        for (const id of ['s1', CLAUDE, 'retired-claude-id', CLAUDE.slice(0, 8)]) {
          const codeMode = resumer();
          const context = await attaching(codeMode);

          context.store.updateSession('s1', { nativeSessionId: CLAUDE, retiredIds: ['retired-claude-id'] });

          expect(await context.runtime.stopHeld(id)).toEqual({ stopped: 's1' });
          expect(codeMode.stops).toEqual(['s1']);
          expect(context.store.session('s1')).toMatchObject({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' });
          expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
          context.runtime.stop();
        }
      });

      it('refuses an unknown ID, a prefix of several sessions, an exited session and a failed stop', async () => {
        const codeMode = resumer({ stop: async () => ({ error: 'The process did not exit.' }) });
        const context = await attaching(codeMode);

        context.store.updateSession('s1', { nativeSessionId: CLAUDE });
        context.entries.push({ ...held('o1'), label: label('gh 7', `${CLAUDE.slice(0, 8)}-other`) }, held('x1', true));

        expect(await context.runtime.stopHeld('nope')).toEqual({ refused: 'No held session nope.', status: 404 });
        expect(await context.runtime.stopHeld(CLAUDE.slice(0, 8))).toEqual({ refused: `${CLAUDE.slice(0, 8)} matches more than one held session: o1, s1.`, status: 409 });
        expect(await context.runtime.stopHeld('x1')).toEqual({ refused: 'Held session x1 has exited.', status: 409 });
        expect(await context.runtime.stopHeld('s1')).toEqual({ refused: 'Stop failed: The process did not exit.', status: 409 });
        expect(await context.runtime.stopHeld('o1')).toEqual({ refused: 'Stop failed: The process did not exit.', status: 409 });
        expect(context.store.session('s1')).toMatchObject({ state: 'running' });
        context.runtime.stop();
      });

      it('ends an orphan in the holder directly and logs it', async () => {
        const codeMode = resumer();
        const context = await attaching(codeMode);

        context.entries.push({ ...held('o1'), label: label('gh 7', 'n') });

        expect(await context.runtime.stopHeld('o1')).toEqual({ stopped: 'o1' });
        expect(codeMode.stops).toEqual(['o1']);
        expect(context.logs).toContain(`stopped orphaned held session o1: ${label('gh 7', 'n')}`);
        expect(context.store.session('s1')).toMatchObject({ state: 'running' });
        context.runtime.stop();
      });

      it('waits for a resume in progress, then stops the resumed session through the flow', async () => {
        let spawn = (): void => {};
        const codeMode = resumer();
        const context = await attaching(codeMode);
        const resumeHeld = codeMode.resumeHeld!;

        endIt(context);
        codeMode.resumeHeld = async (...args) => {
          context.entries.splice(0, 1, held('s1'));
          await new Promise<void>((done) => (spawn = done));
          return resumeHeld(...args);
        };
        codeMode.stop = async (target) => {
          codeMode.stops.push(target.sessionId);
          context.entries.splice(0, 1, held('s1', true));
          return null;
        };

        const attach = context.runtime.attach('s1');

        await vi.waitFor(() => expect(context.runtime['resuming'].has('s1')).toBe(true));

        const stop = context.runtime.stopHeld('s1');

        await new Promise((done) => setTimeout(done, 10));
        expect(codeMode.stops).toEqual([]);
        spawn();

        expect(await attach).toEqual(HOLDER);
        expect(await stop).toEqual({ stopped: 's1' });
        expect(codeMode.stops).toEqual(['s1']);
        expect(context.store.session('s1')).toMatchObject({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' });
        expect(context.logs.some((line) => line.startsWith('stopped orphaned held session'))).toBe(false);
        context.runtime.stop();
      });

      it('makes an attach wait for a held stop, which it then resumes', async () => {
        const order: string[] = [];
        let ended = (): void => {};
        const codeMode = resumer({ observe: idleObservation });
        const context = await attaching(codeMode);
        const resumeHeld = codeMode.resumeHeld!;

        codeMode.stop = (target) =>
          new Promise((done) => {
            ended = () => {
              order.push(`stop ${target.sessionId}`);
              context.entries.splice(0, 1, held('s1', true));
              done(null);
            };
          });
        codeMode.resumeHeld = async (...args) => {
          order.push(`resume ${args[0].id}`);
          return resumeHeld(...args);
        };

        const stop = context.runtime.stopHeld('s1');

        await vi.waitFor(() => expect(context.runtime['ending'].has('s1')).toBe(true));

        const attach = context.runtime.attach('s1');

        await Promise.resolve();
        expect(order).toEqual([]);
        ended();

        expect(await stop).toEqual({ stopped: 's1' });
        expect(await attach).toEqual(HOLDER);
        expect(order).toEqual(['stop s1', 'resume s1']);
        context.runtime.stop();
      });
    });
  });
});
