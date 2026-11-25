import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@switchboard/core';
import { CONSOLE_INPUT_CHARS, PageConsole, noConsole } from '../src/console.js';
import type { HeldViewHandlers } from '../src/runtime.js';
import { SESSION_RELAUNCHED } from '../src/runtime.js';
import type { WindowScope } from '../src/windows.js';

const held = (patch: Partial<Session> = {}): Session => ({ id: 's1', codeMode: true, launchId: 'L1', execution: null, state: 'idle', ...patch }) as unknown as Session;

function setup() {
  const scopes = new Map<string, Partial<WindowScope>>([['page-1', { sessionId: 's1', scopeGen: 3 }]]);
  const sessions = new Map<string, Session>([['s1', held()]]);
  const calls: string[] = [];
  const views: Array<{ session: string; handlers: HeldViewHandlers; closed: boolean }> = [];
  let viewError: string | null = null;
  let reserveRefused: string | null = null;
  let reserveGate: Promise<void> = Promise.resolve();
  let writeError: string | null = null;
  const pageConsole = new PageConsole({
    isPage: (key) => key.startsWith('page-'),
    scope: (key) => (scopes.get(key) as WindowScope | undefined) ?? null,
    session: (id) => sessions.get(id) ?? null,
    view: async (session, handlers) => {
      if (viewError !== null) {
        throw new Error(viewError);
      }

      const view = { session, handlers, closed: false };

      views.push(view);
      return { close: () => (view.closed = true) };
    },
    reserve: async (sessionId, launch) => {
      await reserveGate;

      if (reserveRefused !== null) {
        return { refused: reserveRefused };
      }

      calls.push(`reserve ${sessionId} ${launch}`);
      return { release: () => calls.push(`release ${sessionId}`) };
    },
    write: async (session, data) => {
      if (writeError !== null) {
        throw new Error(writeError);
      }

      calls.push(`write ${session} ${JSON.stringify(data)}`);
    },
    size: async (session, cols, rows) => calls.push(`size ${session} ${cols}x${rows}`),
    log: () => undefined,
  });
  const stream = () => {
    const events: Array<[string, unknown]> = [];
    let ended = 0;
    let full = false;

    return {
      events,
      ended: () => ended,
      fill: () => (full = true),
      send: (event: string, data: unknown) => {
        events.push([event, data]);
        return !full;
      },
      end: () => ended++,
    };
  };

  return {
    pageConsole,
    scopes,
    sessions,
    calls,
    views,
    stream,
    failView: (why: string) => (viewError = why),
    refuseReserve: (why: string) => (reserveRefused = why),
    failWrite: (why: string) => (writeError = why),
    holdReserve: () => {
      let open = (): void => undefined;

      reserveGate = new Promise((done) => (open = done));
      return () => open();
    },
  };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
let current: PageConsole | null = null;

afterEach(() => {
  current?.close();
  current = null;
});

describe('the page console stream', () => {
  it("streams the shown session's size, screen and output, and ends when the page moves to another conversation", async () => {
    const t = setup();
    const s = t.stream();

    current = t.pageConsole;

    const opened = t.pageConsole.open('page-1', 's1', s.send, s.end);

    expect('close' in opened).toBe(true);
    await tick();
    expect(t.views.map((view) => view.session)).toEqual(['s1']);
    t.views[0]!.handlers.onSize(120, 40);
    t.views[0]!.handlers.onData('screen');
    t.views[0]!.handlers.onReplayed();
    t.views[0]!.handlers.onExit(0);
    expect(s.events).toEqual([
      ['size', { cols: 120, rows: 40 }],
      ['data', { data: 'screen' }],
      ['replayed', {}],
      ['exited', { exitCode: 0 }],
    ]);
    t.pageConsole.check();
    expect(t.pageConsole.size).toBe(1);
    t.scopes.set('page-1', { sessionId: 's2', scopeGen: 4 });
    t.pageConsole.check();
    expect(t.views[0]!.closed).toBe(true);
    expect(s.ended()).toBe(1);
    expect(t.pageConsole.size).toBe(0);
  });

  it('delivers nothing once the page shows another conversation or the session runs under another launch, and ends the stream', async () => {
    const t = setup();

    current = t.pageConsole;

    const moved = t.stream();

    t.pageConsole.open('page-1', 's1', moved.send, moved.end);
    await tick();
    t.scopes.set('page-1', { sessionId: 's2', scopeGen: 4 });
    t.views[0]!.handlers.onData('secret');
    expect(moved.events).toEqual([]);
    expect(moved.ended()).toBe(1);
    expect(t.views[0]!.closed).toBe(true);

    // Away and back again between two events: the old stream still ends, since the page opens a new one.
    t.scopes.set('page-1', { sessionId: 's1', scopeGen: 5 });

    const back = t.stream();

    t.pageConsole.open('page-1', 's1', back.send, back.end);
    await tick();
    t.scopes.set('page-1', { sessionId: 's1', scopeGen: 7 });
    t.views[1]!.handlers.onData('after a round trip');
    expect(back.events).toEqual([]);
    expect(back.ended()).toBe(1);

    const resumed = t.stream();

    t.pageConsole.open('page-1', 's1', resumed.send, resumed.end);
    await tick();
    t.sessions.set('s1', held({ launchId: 'L2' }));
    t.views[2]!.handlers.onData('new launch');
    expect(resumed.events).toEqual([]);
    expect(resumed.ended()).toBe(1);
  });

  it('refuses a key that is not a page, and a session the page does not show, without a viewer', () => {
    const t = setup();

    current = t.pageConsole;
    expect(t.pageConsole.open('window-1', 's1', () => true, () => undefined)).toEqual({ status: 403, error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." });
    expect(t.pageConsole.open('page-1', 's2', () => true, () => undefined)).toEqual({ status: 403, error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' });
    expect(t.pageConsole.open('page-9', 's1', () => true, () => undefined)).toEqual({ status: 403, error: 'This page has no work item open, so that was not done. Open one and try again.' });
    expect(t.views).toEqual([]);
  });

  it('says why a session has no console: not held, a Codex app-server session with no thread, or a holder that cannot show it', async () => {
    const t = setup();

    current = t.pageConsole;
    t.sessions.set('s1', held({ codeMode: false, execution: 'app-server', nativeSessionId: null } as Partial<Session>));

    const codex = t.stream();

    t.pageConsole.open('page-1', 's1', codex.send, codex.end);
    expect(codex.events).toEqual([['unavailable', { reason: 'This Codex session has no thread yet, so it has no console.' }]]);
    expect(codex.ended()).toBe(1);
    expect(t.views).toEqual([]);
    expect(noConsole(held({ codeMode: false } as Partial<Session>))).toContain("does not run in Switchboard's terminal holder");
    expect(noConsole(held())).toBeNull();
    // An ended registered session resumes in the holder (PRD R81).
    expect(noConsole(held({ codeMode: false, registered: true, state: 'ended', provider: 'claude', nativeSessionId: 'n1' } as Partial<Session>))).toBeNull();
    expect(noConsole(held({ codeMode: false, registered: true, state: 'idle', provider: 'claude', nativeSessionId: 'n1' } as Partial<Session>))).toBe('This session runs in your own Claude window, so it has a console here only once it ends there.');
    // So does one an earlier hub ran in Claude's background service (PRD R93).
    expect(noConsole(held({ codeMode: false, state: 'ended', provider: 'claude', nativeSessionId: 'n1' } as Partial<Session>))).toBeNull();

    // A Codex app-server session with a thread has its console: the view starts its Codex terminal.
    t.sessions.set('s1', held({ codeMode: false, execution: 'app-server', nativeSessionId: 'thread-1' } as Partial<Session>));

    const thread = t.stream();

    t.pageConsole.open('page-1', 's1', thread.send, thread.end);
    await tick();
    expect(t.views.map((view) => view.session)).toEqual(['s1']);
    t.views[0]!.handlers.onData('codex');
    expect(thread.events).toEqual([['data', { data: 'codex' }]]);
    t.scopes.set('page-1', { sessionId: 's2', scopeGen: 4 });
    t.pageConsole.check();
    t.scopes.set('page-1', { sessionId: 's1', scopeGen: 3 });

    t.sessions.set('s1', held());
    t.failView('The terminal holder is from an older build and cannot show its sessions here.');

    const older = t.stream();

    t.pageConsole.open('page-1', 's1', older.send, older.end);
    await tick();
    expect(older.events).toEqual([['unavailable', { reason: 'The terminal holder is from an older build and cannot show its sessions here.' }]]);
    expect(older.ended()).toBe(1);
    expect(t.pageConsole.size).toBe(0);
  });

  it('ends a stream that falls behind, and one the holder closed, with why', async () => {
    const t = setup();

    current = t.pageConsole;

    const slow = t.stream();

    t.pageConsole.open('page-1', 's1', slow.send, slow.end);
    await tick();
    slow.fill();
    t.views[0]!.handlers.onData('a lot');
    expect(t.views[0]!.closed).toBe(true);
    expect(slow.ended()).toBe(1);
    t.views[0]!.handlers.onData('more');
    expect(slow.events.filter(([event]) => event === 'data')).toHaveLength(1);

    const lost = t.stream();

    t.pageConsole.open('page-1', 's1', lost.send, lost.end);
    await tick();
    t.views[1]!.handlers.onClose('The terminal holder closed the connection.');
    expect(lost.events.at(-1)).toEqual(['closed', { error: 'The terminal holder closed the connection.' }]);
    expect(lost.ended()).toBe(1);
  });

  it('closes a viewer that opens after the stream ended', async () => {
    const t = setup();

    current = t.pageConsole;

    const s = t.stream();
    const opened = t.pageConsole.open('page-1', 's1', s.send, s.end) as { close(): void };

    opened.close();
    await tick();
    expect(t.views[0]!.closed).toBe(true);
  });
});

describe('the page console keys', () => {
  const keys = { window: 'page-1', scopeGen: 3, opId: 'o1', sessionId: 's1', launch: 'L1', data: '\u001b' };

  it('checks the page again once the reservation is held, typing nothing when it moved meanwhile', async () => {
    const t = setup();

    current = t.pageConsole;

    const release = t.holdReserve();
    const answer = t.pageConsole.input({ ...keys, cols: 100, rows: 30 });

    await tick();
    t.scopes.set('page-1', { sessionId: 's2', scopeGen: 4 });
    release();
    expect(await answer).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(t.calls).toEqual(['reserve s1 L1', 'release s1']);

    t.scopes.set('page-1', { sessionId: 's1', scopeGen: 4 });

    const relaunch = t.holdReserve();
    const relaunched = t.pageConsole.input({ ...keys, opId: 'o2', scopeGen: 4 });

    await tick();
    t.sessions.set('s1', held({ launchId: 'L2' }));
    relaunch();
    expect(await relaunched).toEqual({ status: 409, body: { error: SESSION_RELAUNCHED } });
    expect(t.calls.filter((call) => call.startsWith('write') || call.startsWith('size'))).toEqual([]);
  });

  it("types the keys as keys typed in a terminal, under the session's reservation, resizing first only when the console says its size", async () => {
    const t = setup();

    current = t.pageConsole;
    expect(await t.pageConsole.input(keys)).toEqual({ status: 200, body: { done: true } });
    expect(await t.pageConsole.input({ ...keys, opId: 'o2', data: 'ls\r', cols: 100, rows: 30 })).toEqual({ status: 200, body: { done: true } });
    expect(await t.pageConsole.input({ ...keys, opId: 'o3', data: '', cols: 90, rows: 30 })).toEqual({ status: 200, body: { done: true } });
    expect(t.calls).toEqual([
      'reserve s1 L1',
      'write s1 "\\u001b"',
      'release s1',
      'reserve s1 L1',
      'size s1 100x30',
      'write s1 "ls\\r"',
      'release s1',
      'reserve s1 L1',
      'size s1 90x30',
      'release s1',
    ]);
  });

  it('types a repeated opId once, and one page\'s keys in the order sent', async () => {
    const t = setup();

    current = t.pageConsole;

    const answers = await Promise.all([t.pageConsole.input({ ...keys, data: 'a' }), t.pageConsole.input({ ...keys, opId: 'o2', data: 'b' }), t.pageConsole.input({ ...keys, data: 'a' })]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(t.calls.filter((call) => call.startsWith('write'))).toEqual(['write s1 "a"', 'write s1 "b"']);
  });

  it('refuses malformed keys, another window, a stale scopeGen, another launch, a session not held and a refused reservation, typing nothing', async () => {
    const t = setup();

    current = t.pageConsole;
    expect((await t.pageConsole.input({ ...keys, data: '' })).status).toBe(400);
    expect((await t.pageConsole.input({ ...keys, data: 'x'.repeat(CONSOLE_INPUT_CHARS + 1) })).status).toBe(400);
    expect((await t.pageConsole.input({ ...keys, cols: 80 })).status).toBe(400);
    expect((await t.pageConsole.input({ ...keys, cols: 0, rows: 30 })).status).toBe(400);
    expect((await t.pageConsole.input({ ...keys, opId: '' })).status).toBe(400);
    expect(await t.pageConsole.input({ ...keys, opId: 'a', window: 'window-1' })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(await t.pageConsole.input({ ...keys, opId: 'b', sessionId: 's2' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect((await t.pageConsole.input({ ...keys, opId: 'c', scopeGen: 2 })).status).toBe(409);
    expect(await t.pageConsole.input({ ...keys, opId: 'd', launch: 'L0' })).toEqual({ status: 409, body: { error: SESSION_RELAUNCHED } });
    t.sessions.set('s1', held({ codeMode: false, execution: 'app-server', nativeSessionId: null } as Partial<Session>));
    expect((await t.pageConsole.input({ ...keys, opId: 'e' })).status).toBe(409);
    t.sessions.set('s1', held());
    t.refuseReserve('The session has ended.');
    expect(await t.pageConsole.input({ ...keys, opId: 'f' })).toEqual({ status: 409, body: { error: 'The session has ended.' } });
    expect(t.calls).toEqual([]);
  });

  it('answers a write the holder refused with why, and releases the reservation', async () => {
    const t = setup();

    current = t.pageConsole;
    t.failWrite('Session s1 has ended.');
    expect(await t.pageConsole.input(keys)).toEqual({ status: 409, body: { error: 'The keys were not typed: Session s1 has ended.' } });
    expect(t.calls).toEqual(['reserve s1 L1', 'release s1']);
  });
});
