import { appendFileSync, closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundDetail, CONVERSATION_RETENTION, PERMISSION_PROMPT, Store, toneSection, toneVersion } from '@switchboard/core';
import type { ConversationMessage, Interruption, Session as StoredSession } from '@switchboard/core';
import { BACKGROUND_DETAIL, projectSlug } from '@switchboard/claude';
import { ConversationService, MIC_TIMING_MAX_MS, MIC_TIMING_STEPS, refusal, sessionView, typedText } from '../src/conversation.js';
import type { ConversationServiceDeps, ConversationVoice } from '../src/conversation.js';
import type { ConversationAdapter, ConversationChanged } from '../src/conversationAdapter.js';
import type { InputOutcome } from '@switchboard/conversation';
import { dockView, windowOf } from '../src/dock.js';
import { canonicalFolder } from '../src/folders.js';
import { WindowScopes } from '../src/windows.js';
import type { WindowScope } from '../src/windows.js';
import type { Snapshot, WorkItemView } from '../src/snapshot.js';
import { pageList } from '../src/page.js';
import { questionIndex } from '../src/questions.js';
import { questionCardOpen } from '../src/runtime.js';
import type { PageHeader } from '../src/page.js';
import { NOW, item, session, snapshot } from './views.js';
import { openPageFile } from '../src/localFiles.js';

export let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-conversation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

export const WINDOWS = 'C:/sb/windows';
export const worktree = (path: string) => ({ id: 1, ticketId: 1, path, branch: null, linkedBy: 'report' as const });

/** Work items 1 (done) and 2 share a worktree, so one item window; 3 has its own. */
export function world() {
  const done = item(1, { status: 'done', worktree: worktree('D:/w12'), sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w12', state: 'ended' })] });
  const current = item(2, { ticketId: 1, ticket: { ...done.ticket }, worktree: worktree('D:/w12'), status: 'blocked', sessions: [session({ id: 's2', workItemId: 2, cwd: 'D:/w12', codeMode: true, nativeSessionId: 'n2' })] });
  const other = item(3, { worktree: worktree('D:/w3'), sessions: [session({ id: 's3', workItemId: 3, cwd: 'D:/w3', codeMode: true, nativeSessionId: 'n3' })] });
  const file = windowOf(current, WINDOWS)!.file!;
  const otherFile = windowOf(other, WINDOWS)!.file!;

  return { done, current, other, file, otherFile, view: snapshot([done, current, other]) };
}

export function stored(store: Store, view: ReturnType<typeof world>): void {
  for (const one of [view.done, view.current, view.other]) {
    const ticket = store.ticket(one.ticketId) ?? store.insertTicket({ ...one.ticket, adhocKey: null } as never);

    store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: one.status, createdAt: NOW } as never);

    for (const held of one.sessions) {
      store.insertSession(held as StoredSession);
    }
  }
}


/** A page key showing the work item, as a page has once it selected it (architecture.md § Web page). */
export function pageOn(scopes: WindowScopes, view: Snapshot, workItemId: number): string {
  scopes.update(view);

  const key = scopes.openPage();

  scopes.select(key, workItemId);
  return key;
}


export const RULE = '─'.repeat(30);

/** The holder and runtime as typing sees them: a held session's input box, its writes, the transcript an Enter writes to, and reservations. */
export class FakeHeld {
  clock = NOW;
  box = '';
  menu = false;
  rev = 0;
  cannotType_: string | null = null;
  readonly writes: string[] = [];
  readonly reservations: Array<{ sessionId: string; launch: string | null }> = [];
  released = 0;
  refuse: string | null = null;
  transcript: (session: string) => string | null = () => null;
  /** A whole screen to show instead of the input box, and when a terminal last typed. */
  shown: string[] | null = null;
  keyAt: number | null = null;

  async screen(_session: string): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt: number | null }> {
    if (this.shown !== null) {
      return { data: this.shown.join('\r\n'), cols: 110, rows: this.shown.length, rev: this.rev, keyAt: this.keyAt };
    }

    return { data: [this.menu ? '❯ 1. Yes' : '', RULE, `❯ ${this.box === '' ? '\u001b[2mTry "fix it"\u001b[22m' : this.box}`, RULE].join('\r\n'), cols: 40, rows: 5, rev: this.rev, keyAt: null };
  }

  async reserve(sessionId: string, launch: string | null): Promise<{ release(): void } | { refused: string }> {
    this.reservations.push({ sessionId, launch });

    return this.refuse !== null ? { refused: this.refuse } : { release: () => void this.released++ };
  }

  async write(session: string, data: string): Promise<{ rev: number }> {
    this.writes.push(data);
    this.rev++;

    const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/.exec(data);

    if (paste !== null) {
      this.box += paste[1]!;
    } else if (data === '\u0015') {
      this.box = this.box.endsWith('\n') ? this.box.slice(0, -1) : this.box.slice(0, this.box.lastIndexOf('\n') + 1);
    } else if (data === '\r' && this.box !== '') {
      const path = this.transcript(session);

      if (path !== null) {
        appendFileSync(path, `${JSON.stringify({ type: 'user', uuid: `typed-${this.rev}`, timestamp: new Date(this.clock).toISOString(), message: { role: 'user', content: this.box } })}\n`);
      }

      this.box = '';
      this.rev++;
    }

    return { rev: this.rev };
  }

  cannotType(): string | null {
    return this.cannotType_;
  }
}


/** Waits for typing to settle: each screen read replays it in xterm, which waits on a real timer, so the wait has no budget of its own below the test's. */
export const settled = (check: () => void) => vi.waitFor(check, { timeout: 15_000 });

export function setupSend(held = new FakeHeld(), holderAnswerMs?: number, voice?: ConversationVoice, extra: Partial<ConversationServiceDeps> = {}) {
  const store = Store.open(':memory:');
  const view = world();
  let keys = 0;
  const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
  const projects = join(dir, 'projects');
  const logs: string[] = [];
  let id = 0;
  let hooks = true;
  const make = () =>
    new ConversationService({
      store,
      windows: scopes,
      projectsDir: projects,
      claudeConfig: join(dir, '.claude.json'),
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => hooks,
      ...(holderAnswerMs === undefined ? {} : { holderAnswerMs }),
      now: () => held.clock,
      sleep: async (ms) => {
        held.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      newId: () => String(++id),
      ...(voice === undefined ? {} : { voice }),
      log: (line) => logs.push(line),
      ...extra,
    });
  const service = make();

  stored(store, view);
  store.updateSession('s2', { launchId: 'launch-1' });
  store.updateSession('s3', { launchId: 'launch-3' });
  mkdirSync(join(projects, projectSlug('D:/w12')), { recursive: true });
  writeFileSync(join(projects, projectSlug('D:/w12'), 'n2.jsonl'), '');
  held.transcript = (session) => (session === 's2' ? join(projects, projectSlug('D:/w12'), 'n2.jsonl') : null);

  const open = (workItemId: number) => {
    const key = pageOn(scopes, view.view, workItemId);
    const frames: Array<{ type: string; [field: string]: unknown }> = [];

    service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

    return { key, frames };
  };
  const body = (key: string, patch: Record<string, unknown> = {}) => ({ window: key, scopeGen: 1, opId: 'op-1', sessionId: 's2', launch: 'launch-1', text: 'Fix the build', ...patch });

  return { store, view, service, held, logs, open, body, make, scopes, setHooks: (on: boolean) => (hooks = on) };
}


/** A voice that records what the conversation layer asks of it. */
export function fakeVoice(spoken = { spoken: true, expressive: false }) {
  const calls: string[] = [];
  const voice: ConversationVoice = {
    shown: (key) => ({ enabled: true, here: key === 'k1', mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null }),
    settings: () => ({ briefReplies: true, expandReplies: false, diffLayout: 'auto', diffWrap: 'auto', messageTimes: false }),
    spokenFor: (sessionId, command, key) => {
      calls.push(`spokenFor ${sessionId} ${command} ${key ?? 'none'}`);
      return command ? { spoken: false, expressive: false } : spoken;
    },
    replyChanged: (reply) => void calls.push(`reply ${reply.opening}`),
    talkHere: (key) => (key === 'k1' ? null : 'Voice is off (voice.enabled).'),
    stopSpeaking: () => "Voice is not on this page's session. Select Talk here to use it.",
    setSpeakReplies: (on) => void calls.push(`speak-replies ${on}`),
    replay: (_key, replyId) => (replyId === 'r-x' ? 'That reply is not in the session this page shows, so it was not read again.' : null),
    update: () => void calls.push('update'),
    selected: (key) => void calls.push(`selected ${key}`),
    expressive: () => true,
  };

  return { voice, calls };
}
