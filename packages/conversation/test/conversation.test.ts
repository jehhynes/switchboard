import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@switchboard/core';
import { COPIED_HEAD_BYTES, SessionConversation, TYPED_LATE_MS, UNCONFIRMED, typedTogether } from '../src/conversation.js';
import { transcriptEnd } from '../src/transcript.js';
import type { ConversationDeps } from '../src/conversation.js';
import type { ConversationChange } from '../src/conversation.js';
import type { ScreenRead } from '../src/screen.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 19, 12);
const iso = (ms: number): string => new Date(ms).toISOString();

const assistant = (uuid: string, at: number, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(at), message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text }] }, ...extra });
const user = (uuid: string, at: number, content: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: 'user', uuid, timestamp: iso(at), message: { role: 'user', content }, ...extra });
const chained = (line: string, parentUuid: string | null): string => JSON.stringify({ ...JSON.parse(line), parentUuid });

/** The lines Claude Code writes for a message sent while it is busy: the queue line when it is sent, and where Claude received it. */
const enqueue = (at: number, content: string): string => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), sessionId: 'native-1', content });
const absorbed = (at: number, content: string): string =>
  JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: iso(at), sessionId: 'native-1', content, reason: 'absorbed_mid_turn', commandUuid: 'c1', deliveryId: 'd1' });
const queued = (uuid: string, at: number, prompt: string, commandMode = 'prompt'): string =>
  JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'attachment',
    uuid,
    timestamp: iso(at),
    attachment: { type: 'queued_command', prompt, source_uuid: 'c1', delivery_id: 'd1', commandMode, origin: { kind: commandMode === 'prompt' ? 'human' : 'task-notification' }, timestamp: iso(at), humanTurn: true },
  });

/** A fake clock and timers for the screen hold. */
function setup() {
  const store = Store.open(':memory:');
  const clock = { t: T0 };
  const timers: Array<{ run: () => void; at: number; cleared: boolean }> = [];
  const changes: ConversationChange[] = [];
  const logs: string[] = [];
  let id = 0;
  const conversation = new SessionConversation('s1', 7, {
    store,
    now: () => clock.t,
    newId: () => String(++id),
    onChange: (change) => changes.push(change),
    log: (line) => logs.push(line),
    hold: {
      now: () => clock.t,
      setTimer: (run, ms) => {
        const timer = { run, at: clock.t + ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    },
  });
  const advance = (ms: number): void => {
    clock.t += ms;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= clock.t)) {
      timer.cleared = true;
      timer.run();
    }
  };
  const path = join(dir, 'native-1.jsonl');
  const append = (...lines: string[]): void => appendFileSync(path, lines.map((line) => `${line}\n`).join(''));
  const items = () => store.conversation('s1', null, 50).items;

  return { store, clock, conversation, changes, logs, advance, path, append, items };
}

const screen = (...lines: string[]): ScreenRead => ({ lines: [...lines, '', '> '], bullets: [...lines, '', ''].map((line) => line.startsWith('● ')), cols: 80, rows: 24 });

describe('SessionConversation', () => {
  it("confirms a message typed from the view by its transcript entry instead of adding it again, and answers it with the reply", () => {
    const { store, conversation, path, append, items, changes } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, pastedAt: T0 };

    store.addMessage({ ...typed, id: 'm-typed', at: T0, text: '/compact now', delivery: 'open', opId: 'op1' });
    store.addMessage({ ...typed, id: 'm-failed', at: T0, text: 'Same words', delivery: 'not-sent', opId: 'op2', provisional: false });
    // Pasted with a backslash, so it is a message and not a command; the same words typed in the terminal earlier are their own message.
    append(user('u0', T0 - 60_000, 'Same words'), user('u1', T0 + 500, '\\/compact now'), assistant('a1', T0 + 1000, 'Compacting is yours to run.'));
    conversation.readTranscript(path);

    // The typed message waited after the transcript's items until its line was read, and takes that line's place.
    expect(items()).toMatchObject([
      { type: 'message', id: 'm-failed', delivery: 'not-sent', transcriptUuid: null },
      { type: 'message', text: 'Same words', origin: 'terminal' },
      { type: 'message', id: 'm-typed', origin: 'typed', delivery: 'sent', transcriptUuid: 'u1', provisional: false },
      { type: 'reply', answers: 'm-typed', opening: 'Compacting is yours to run.' },
    ]);
    expect(items()).toHaveLength(4);
    expect(changes.map((change) => change.type)).toEqual(['message', 'message', 'reply']);
  });

  it('confirms a message typed with [spoken] by its tagged line, shows it without the tags, and keeps a reply\'s passage and tone line', () => {
    const { store, conversation, path, append, items } = setup();

    store.addMessage({ id: 'm-spoken', sessionId: 's1', workItemId: 7, at: T0, origin: 'typed', text: '/x? no, why', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'op1', pastedAt: T0, spokenRequested: true });
    append(user('u1', T0 + 500, '[spoken] [expressive] \\/x? no, why'), user('u2', T0 + 600, '[spoken] typed in the terminal'), assistant('a1', T0 + 1000, '[tone: calm]\n[speak]Because it failed.[/speak]\n\nThe log says so.'));
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-spoken', delivery: 'sent', transcriptUuid: 'u1', text: '/x? no, why', spokenRequested: true },
      { type: 'message', origin: 'terminal', text: 'typed in the terminal', spokenRequested: false },
      { type: 'reply', opening: 'Because it failed.\n\nThe log says so.', speak: 'Because it failed.', tone: 'calm', spokenState: 'none' },
    ]);
    expect(items()).toHaveLength(3);
  });

  it('confirms a dictated message and a [partial] part by their tagged lines, and passes on a reply\'s heard tags once, from its transcript copy only', () => {
    const { store, conversation, path, append, items, changes } = setup();
    const voice = { sessionId: 's1', workItemId: 7, origin: 'voice' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'open' as const };

    store.addMessage({ ...voice, id: 'm-part', at: T0, text: 'fix the', opId: 'op1', pastedAt: T0, partial: true });
    store.addMessage({ ...voice, id: 'm-rest', at: T0 + 100, text: 'login flow on a llama', opId: 'op2', pastedAt: T0 + 100 });
    append(user('u1', T0 + 500, '[voice] [partial] fix the'), user('u2', T0 + 600, '[voice] login flow on a llama'), assistant('a1', T0 + 1000, 'Fixed on Ollama.\n<!--heard:a llama=Ollama-->'));
    conversation.readTranscript(path);
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-part', delivery: 'sent', transcriptUuid: 'u1', text: 'fix the', partial: true },
      { type: 'message', id: 'm-rest', delivery: 'sent', transcriptUuid: 'u2', text: 'login flow on a llama' },
      { type: 'reply', opening: 'Fixed on Ollama.', answers: 'm-rest' },
    ]);
    expect(changes.filter((change) => change.type === 'heard')).toEqual([{ type: 'heard', replyId: items()[2]!.id, heard: [{ heard: 'a llama', meant: 'Ollama' }] }]);
  });

it('confirms messages typed as one by their shared line, each in order with its own tags, without adding a terminal message, and answers the last', () => {
    const { store, conversation, path, append, items, changes } = setup();
    const open = { sessionId: 's1', workItemId: 7, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'open' as const, pastedAt: T0 };

    store.addMessage({ ...open, id: 'm-first', at: T0 - 300, origin: 'typed', text: '/x first', opId: 'op1', spokenRequested: true });
    store.addMessage({ ...open, id: 'm-said', at: T0 - 200, origin: 'voice', text: 'then this', opId: 'op2' });
    store.addMessage({ ...open, id: 'm-answers', at: T0 - 100, origin: 'typed', text: '[answers]\n- keep-route: Keep it? → A) Yes', opId: 'op3' });
    // Pasted at another time, so not one of them.
    store.addMessage({ ...open, id: 'm-alone', at: T0, origin: 'typed', text: 'then this', opId: 'op4', pastedAt: T0 + 5_000 });
    append(enqueue(T0 + 400, '[spoken] \\/x first\n\n[voice] then this\n\n[answers]\n- keep-route: Keep it? → A) Yes'));
    conversation.readTranscript(path);
    expect(['m-first', 'm-said', 'm-answers', 'm-alone'].map((id) => store.message(id)?.delivery)).toEqual(['sent', 'sent', 'sent', 'open']);

    append(
      user('u1', T0 + 500, '<pasted_content id="1">\n[spoken] \\/x first\n\n[voice] then this\n\n[answers]\n- keep-route: Keep it? → A) Yes\n</pasted_content id="1">'),
      chained(assistant('a1', T0 + 1000, 'Done all three.'), 'u1'),
    );
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-first', delivery: 'sent', transcriptUuid: 'u1', provisional: false, text: '/x first' },
      { type: 'message', id: 'm-said', delivery: 'sent', transcriptUuid: 'u1', provisional: false, text: 'then this' },
      { type: 'message', id: 'm-answers', delivery: 'sent', transcriptUuid: 'u1', provisional: false },
      { type: 'reply', answers: 'm-answers', opening: 'Done all three.' },
      { type: 'message', id: 'm-alone', delivery: 'open', provisional: true },
    ]);
    expect(items()).toHaveLength(5);
    expect(changes.filter((change) => change.type === 'message').map((change) => (change as { message: { id: string } }).message.id)).toEqual(['m-first', 'm-said', 'm-answers', 'm-first', 'm-said', 'm-answers']);
    expect(store.messageByTranscriptUuid('s1', 'u1')?.id).toBe('m-answers');
  });

  it('gives a line to the latest paste it matches, whether a message alone or messages typed as one', () => {
    const { store, conversation, path, append } = setup();
    const open = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'open' as const };

    store.addMessage({ ...open, id: 'm-alone', at: T0, text: 'one\n\ntwo', opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...open, id: 'm-one', at: T0 + 10, text: 'one', opId: 'op2', pastedAt: T0 + 1000 });
    store.addMessage({ ...open, id: 'm-two', at: T0 + 20, text: 'two', opId: 'op3', pastedAt: T0 + 1000 });
    append(user('u1', T0 + 1500, 'one\n\ntwo'));
    conversation.readTranscript(path);
    expect(['m-alone', 'm-one', 'm-two'].map((id) => store.message(id)?.transcriptUuid)).toEqual([null, 'u1', 'u1']);

    // A message alone pasted after the group takes the next such line.
    store.addMessage({ ...open, id: 'm-later', at: T0 + 30, text: 'one\n\ntwo', opId: 'op4', pastedAt: T0 + 2000 });
    store.addMessage({ ...open, id: 'm-three', at: T0 + 40, text: 'one', opId: 'op5', pastedAt: T0 + 1900 });
    store.addMessage({ ...open, id: 'm-four', at: T0 + 50, text: 'two', opId: 'op6', pastedAt: T0 + 1900 });
    append(user('u2', T0 + 2500, 'one\n\ntwo'));
    conversation.readTranscript(path);
    expect(['m-later', 'm-three', 'm-four'].map((id) => store.message(id)?.transcriptUuid)).toEqual(['u2', null, null]);
  });

  it('reads a line as messages typed as one only when it holds each of them, in order, with nothing else', () => {
    const message = (text: string) => ({ text }) as Parameters<typeof typedTogether>[1][number];
    const both = [message('/one'), message('two')];

    expect(typedTogether('\\/one\n\n[spoken] [voice] two', both)).toBe(true);
    expect(typedTogether('two\n\n\\/one', both)).toBe(false);
    expect(typedTogether('\\/one\n\ntwo and more', both)).toBe(false);
    expect(typedTogether('\\/one\ntwo', both)).toBe(false);
    expect(typedTogether('\\/one', both)).toBe(false);
  });

  it('confirms a slash command chosen from the composer by its command line, and keeps it apart from the same words sent as a message', () => {
    const { store, conversation, path, append, items } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'open' as const };

    store.addMessage({ ...typed, id: 'm-command', at: T0, text: '/hello7', opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...typed, id: 'm-message', at: T0 + 3000, text: '/hello7', opId: 'op2', pastedAt: T0 + 3000 });
    append(
      user('u1', T0 + 500, '<command-message>hello7</command-message>\n<command-name>/hello7</command-name>'),
      user('u2', T0 + 600, 'Base directory for this skill: D:/x', { isMeta: true }),
      assistant('a1', T0 + 1000, 'HELLO-SEVEN-OK'),
      user('u3', T0 + 3500, '\\/hello7'),
    );
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-command', text: '/hello7', delivery: 'sent', transcriptUuid: 'u1', provisional: false },
      { type: 'reply', answers: 'm-command', opening: 'HELLO-SEVEN-OK' },
      { type: 'message', id: 'm-message', text: '/hello7', delivery: 'sent', transcriptUuid: 'u3', provisional: false },
    ]);
    expect(items()).toHaveLength(3);
  });

  it('confirms a typed message only by an entry near its paste: never one still waiting to paste, and a sent one by its line however late', () => {
    const { store, conversation, path, append, items } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null };

    store.addMessage({ ...typed, id: 'm-waiting', at: T0, text: 'Yes', delivery: 'open', opId: 'op1', pastedAt: null });
    store.addMessage({ ...typed, id: 'm-queued', at: T0, text: 'Later', delivery: 'sent', opId: 'op3', pastedAt: T0 });
    // An hour later: a "Yes" typed in the terminal, and the queued message Claude took only now.
    append(user('u1', T0 + 3_600_000, 'Yes'), user('u2', T0 + 3_600_001, 'Later'));
    conversation.readTranscript(path);

    expect(items().map((item) => [item.id, item.type === 'message' ? item.delivery : null])).toEqual([
      ['m-1', null],
      ['m-queued', 'sent'],
      // Still waiting to be pasted, so after everything in the transcript.
      ['m-waiting', 'open'],
    ]);
    expect(store.message('m-queued')?.transcriptUuid).toBe('u2');
  });

  it('gives an entry to the latest attempt pasted before it, and none to a message typed into an earlier transcript', () => {
    const { store, conversation, path, append, items } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null };

    store.addMessage({ ...typed, id: 'm-first', at: T0, text: 'Yes', delivery: 'sent', opId: 'op1', pastedAt: T0, provisional: false });
    store.addMessage({ ...typed, id: 'm-second', at: T0 + 30_000, text: 'Yes', delivery: 'sent', opId: 'op2', pastedAt: T0 + 30_000 });
    append(user('u1', T0 + 30_100, 'Yes'));
    conversation.readTranscript(path);
    expect(store.message('m-second')?.transcriptUuid).toBe('u1');
    // Claude Code takes messages in order, so the earlier attempt no line showed is unconfirmed.
    expect(store.message('m-first')).toMatchObject({ delivery: 'unconfirmed', transcriptUuid: null });

    // After /clear the session writes a new transcript; the earlier "Yes" it never placed is never confirmed by it.
    const cleared = join(dir, 'native-2.jsonl');

    writeFileSync(cleared, `${user('u2', T0 + 40_000, 'Yes')}\n`);
    conversation.readTranscript(cleared);
    expect(store.message('m-first')).toMatchObject({ delivery: 'unconfirmed', transcriptUuid: null });
    expect(items().filter((item) => item.type === 'message')).toHaveLength(3);
  });

  it("follows a typed message sent while Claude works as the transcript's queue model does: sent by its queue line, placed where Claude received it, and never withdrawn", () => {
    const { store, conversation, path, append, items, changes } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null };

    append(user('u0', T0 - 1000, 'Start the build'));
    conversation.readTranscript(path);
    store.addMessage({ ...typed, id: 'm-typed', at: T0, text: 'Line one\nLine two', delivery: 'open', opId: 'op1', pastedAt: T0 });
    // A paste of several lines is queued inside its tags; Claude Code's own queue lines also start with "<", and this is not one.
    append(enqueue(T0 + 100, '<pasted_content id="a1">\nLine one\nLine two\n</pasted_content id="a1">'));
    conversation.readTranscript(path);
    expect(store.message('m-typed')).toMatchObject({ delivery: 'sent', provisional: true, transcriptUuid: null });
    expect(items()).toHaveLength(2);

    append(assistant('a1', T0 + 500, 'Building.'), queued('q1', T0 + 600, '<pasted_content id="a1">\nLine one\nLine two\n</pasted_content id="a1">'), assistant('a2', T0 + 700, 'Two lines read.'));
    conversation.readTranscript(path);
    expect(items().map((item) => item.id)).toEqual(['m-1', items()[1]!.id, 'm-typed', items()[3]!.id]);
    expect(items()[3]).toMatchObject({ type: 'reply', opening: 'Two lines read.' });
    expect(store.message('m-typed')).toMatchObject({ delivery: 'sent', provisional: false, transcriptUuid: 'q1' });

    // The session's end withdraws terminal messages Claude never received, never a typed one.
    store.addMessage({ ...typed, id: 'm-late', at: T0 + 800, text: 'Never read', delivery: 'sent', opId: 'op2', pastedAt: T0 + 800 });
    conversation.end();
    expect(store.message('m-late')).toMatchObject({ withdrawn: false });
    expect(changes.filter((change) => change.type === 'message' && change.message.id === 'm-typed')).toHaveLength(2);
  });

  it('shows a pasted block of several lines without the tags Claude Code records it in, and confirms a typed one by it', () => {
    const { store, conversation, path, append, items } = setup();

    store.addMessage({ id: 'm-typed', sessionId: 's1', workItemId: 7, at: T0, origin: 'typed', text: 'One\nTwo', transcriptUuid: null, provisional: false, withdrawn: false, delivery: 'sent', error: null, opId: 'op1', pastedAt: T0 });
    append(user('u1', T0 + 100, '<pasted_content id="914d">\nOne\nTwo\n</pasted_content id="914d">'), user('u2', T0 + 200, 'See <pasted_content id="a1">\nx\ny\n</pasted_content id="a1"> please'));
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { id: 'm-typed', delivery: 'sent', error: null, transcriptUuid: 'u1' },
      { origin: 'terminal', text: 'See x\ny please' },
    ]);
  });

  it('shows a message and the reply that answers it, and reads each transcript line once', () => {
    const { conversation, path, append, items, changes } = setup();

    append(user('u1', T0, 'Why does it fail?'), assistant('a1', T0 + 1000, 'A stale cache.\n\nClear `.cache` and rerun.'));
    conversation.readTranscript(path);
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-1', text: 'Why does it fail?', origin: 'terminal', at: T0, workItemId: 7 },
      { type: 'reply', kind: 'reply', answers: 'm-1', opening: 'A stale cache.\n\nClear `.cache` and rerun.', source: 'transcript', withdrawn: false, transcriptUuid: 'a1' },
    ]);
    expect(changes.map((change) => change.type)).toEqual(['message', 'reply']);
  });

  it('leaves out tool results, meta entries, subagents and reminders, shows a slash command as typed, and a reply saved as thinking', () => {
    const { conversation, path, append, items } = setup();

    append(
      user('u1', T0, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      user('u2', T0, 'hidden', { isMeta: true }),
      assistant('a1', T0, 'subagent', { isSidechain: true }),
      user('u3', T0, '<system-reminder>x</system-reminder>'),
      user('u4', T0, '<command-message>sb-plan</command-message>\n<command-name>/sb-plan</command-name>\n<command-args>15619</command-args>'),
      JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: iso(T0), thinkingDisplay: 'updates', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'The answer is 4.' }] } }),
      'not json',
    );
    conversation.readTranscript(path);

    expect(items().map((item) => (item.type === 'message' ? item.text : item.opening))).toEqual(['/sb-plan 15619', 'The answer is 4.']);
  });

  it('holds a screen copy for its transcript copy and publishes only that when it comes in time', () => {
    const { conversation, path, append, items, advance, changes } = setup();

    conversation.readScreen(screen('● The fix is in.'));
    advance(100);
    append(assistant('a1', T0 + 100, 'The fix is **in**.'));
    conversation.readTranscript(path);
    advance(1000);

    expect(items()).toMatchObject([{ type: 'reply', opening: 'The fix is **in**.', source: 'transcript' }]);
    expect(changes).toHaveLength(1);
    // A redraw of it later publishes nothing.
    conversation.readScreen(screen('● The fix is in.'));
    advance(1000);
    expect(items()).toHaveLength(1);
  });

  it('publishes a screen copy whose transcript copy is late, then replaces it in place', () => {
    const { conversation, path, append, items, advance, changes } = setup();

    conversation.readScreen(screen('● Done, list below.'));
    advance(300);
    expect(items()).toMatchObject([{ type: 'reply', source: 'screen', opening: 'Done, list below.' }]);

    const id = (items()[0] as { id: string }).id;

    advance(2000);
    append(assistant('a1', T0 + 2000, 'Done, list below.\n\n- `x.ts`'));
    conversation.readTranscript(path);

    expect(items()).toMatchObject([{ id, source: 'transcript', opening: 'Done, list below.\n\n- `x.ts`', at: T0 + 2000 }]);
    expect(changes.map((change) => (change.type === 'reply' ? change.reply.id : null))).toEqual([id, id]);
  });

  describe('a reply with a link the screen draws with its target', () => {
    // Session 311b1ad4's reply of 2026-11-22T21:12:38Z, which showed twice until its screen copy was withdrawn.
    const raw =
      "The Changes list compares the worktree with the remote's main branch. It finds where the worktree's HEAD branched off `origin/HEAD`, which is normally `origin/main`, and falls back to `origin/main` or `origin/master`. From that commit (the merge base) to what's on disk now, it lists every committed, staged, unstaged and untracked change. If none of those remote branches exist, it shows only uncommitted changes.\n\nOne catch: the remote is the reference, not your local `main`. If local `main` has commits that aren't pushed yet, a worktree branched from it also shows those commits as changes. That's why everything looks like a big diff until you push. The code is at [changes.ts:280](file:///D:/git/switchboard/packages/hub/src/changes.ts#L280).\n\nShould the base be the local `main` instead, or whichever comes later of local `main` and `origin/main`?";
    const drawn = [
      "● The Changes list compares the worktree with the remote's main branch. It finds",
      "  where the worktree's HEAD branched off `origin/HEAD`, which is normally",
      "  `origin/main`, and falls back to `origin/main` or `origin/master`. From that",
      "  commit (the merge base) to what's on disk now, it lists every committed,",
      "  staged, unstaged and untracked change. If none of those remote branches exist,",
      "  it shows only uncommitted changes.",
      "",
      "  One catch: the remote is the reference, not your local `main`. If local `main`",
      "  has commits that aren't pushed yet, a worktree branched from it also shows",
      "  those commits as changes. That's why everything looks like a big diff until",
      "  you push. The code is at changes.ts:280",
      "  (file:///D:/git/switchboard/packages/hub/src/changes.ts#L280).",
      "",
      "  Should the base be the local `main` instead, or whichever comes later of local",
      "  `main` and `origin/main`?",
    ];

    it('publishes no screen copy read after its transcript copy', () => {
      // The short one has its link within the letters that tell a redraw of a sent reply.
      const short = 'See [changes.ts:280](file:///D:/git/switchboard/packages/hub/src/changes.ts#L280) for the base.';

      for (const [text, lines] of [
        [raw, drawn],
        [short, ['● See changes.ts:280 (file:///D:/git/switchboard/packages/hub/src/changes.ts#L280) for the', '  base.']],
      ] as const) {
        const { conversation, path, append, items, advance, logs } = setup();

        rmSync(path, { force: true });

        append(assistant('a1', T0, text));
        conversation.readTranscript(path);
        advance(300);
        conversation.readScreen(screen(...lines));
        advance(25_000);
        conversation.tick(false);

        expect(items()).toMatchObject([{ type: 'reply', source: 'transcript', opening: text, withdrawn: false }]);
        expect(items()).toHaveLength(1);
        expect(logs.filter((line) => line.includes('withdrawn'))).toEqual([]);
      }
    });

    it('publishes a later reply that opens with the same long link as one read before', () => {
      const { conversation, path, append, items, advance } = setup();
      const target = 'file:///D:/git/switchboard.worktrees/reply-dup/packages/conversation/src/conversation.ts#L479';
      const link = `[conversation.ts:479](${target})`;
      const drawnB = `See conversation.ts:479 (${target}), then do B.`;

      append(assistant('a1', T0, `See ${link}, then do A.`));
      conversation.readTranscript(path);
      advance(300);
      conversation.readScreen(screen(`● ${drawnB}`));
      advance(300);

      expect(items()).toMatchObject([
        { type: 'reply', source: 'transcript', opening: `See ${link}, then do A.` },
        { type: 'reply', source: 'screen', opening: drawnB },
      ]);
    });

    it('replaces the screen copy its drawn key matches, whole or cut off, rather than a shorter one its own key starts with', () => {
      for (const drawnLong of ['See docs (https://example.com/long/path) done.', 'See docs (https://example.com/long/path)']) {
        const { conversation, path, append, items, advance } = setup();

        rmSync(path, { force: true });
        conversation.readScreen(screen('● See docs.', '', '● Other.', '', `● ${drawnLong}`));
        advance(300);

        const [short, , long] = items() as Array<{ id: string }>;

        append(assistant('a1', T0 + 300, 'See [docs](https://example.com/long/path) done.'));
        conversation.readTranscript(path);

        // The replaced copy takes its transcript line's place, before the copies still waiting.
        expect(items()).toMatchObject([
          { id: long!.id, source: 'transcript', opening: 'See [docs](https://example.com/long/path) done.' },
          { id: short!.id, source: 'screen', opening: 'See docs.' },
          { source: 'screen', opening: 'Other.' },
        ]);
      }
    });

    it('publishes only its transcript copy when that comes while the screen copy is held', () => {
      const { conversation, path, append, items, advance, changes, logs } = setup();

      conversation.readScreen(screen(...drawn));
      advance(100);
      append(assistant('a1', T0 + 100, raw));
      conversation.readTranscript(path);
      advance(25_000);
      conversation.tick(false);

      expect(items()).toMatchObject([{ type: 'reply', source: 'transcript', opening: raw, withdrawn: false }]);
      expect(items()).toHaveLength(1);
      expect(changes).toHaveLength(1);
      expect(logs.filter((line) => line.includes('withdrawn'))).toEqual([]);
    });

    it('replaces its screen copy, whole or cut off before the target, in place with its transcript copy', () => {
      for (const shown of [drawn, drawn.slice(0, 11)]) {
        const { conversation, path, append, items, advance, changes, logs } = setup();

        rmSync(path, { force: true });

        conversation.readScreen(screen(...shown));
        advance(300);
        expect(items()).toMatchObject([{ type: 'reply', source: 'screen' }]);

        const id = (items()[0] as { id: string }).id;

        advance(500);
        append(assistant('a1', T0 + 800, raw));
        conversation.readTranscript(path);
        advance(25_000);
        conversation.tick(false);

        expect(items()).toMatchObject([{ id, source: 'transcript', opening: raw, withdrawn: false }]);
        expect(items()).toHaveLength(1);
        expect(changes.map((change) => (change.type === 'reply' ? change.reply.id : null))).toEqual([id, id]);
        expect(logs.filter((line) => line.includes('withdrawn'))).toEqual([]);
      }
    });
  });

  it('orders by transcript line, not timestamp, and moves a message sent mid-turn from the bottom to where Claude received it', () => {
    const { conversation, path, append, items, changes } = setup();
    const shown = () => items().map((item) => `${item.type === 'message' ? `${item.text}${item.provisional ? ' (sent)' : ''}` : item.opening}`);

    // The second message is sent while Claude works on the first; Claude's reply to the first is stamped before the queue line but written after it.
    append(user('u1', T0, 'First?'), enqueue(T0 + 5000, 'Second?'), assistant('a1', T0 + 3000, 'About the first.'));
    conversation.readTranscript(path);
    expect(shown()).toEqual(['First?', 'About the first.', 'Second? (sent)']);

    const sent = items()[2]!;

    // Claude receives it mid-turn; the reply to it is again stamped before the line that delivered it.
    append(absorbed(T0 + 6000, 'Second?'), queued('q1', T0 + 7000, 'Second?'), assistant('a2', T0 + 6500, 'About the second.'));
    conversation.readTranscript(path);
    expect(shown()).toEqual(['First?', 'About the first.', 'Second?', 'About the second.']);
    expect(items()[2]).toMatchObject({ id: sent.id, provisional: false, transcriptUuid: 'q1', at: T0 + 7000 });
    expect(items()[3]).toMatchObject({ answers: sent.id });
    expect(changes.filter((change) => change.type === 'message').map((change) => (change.type === 'message' ? [change.message.id, change.message.provisional] : null))).toEqual([
      ['m-1', false],
      [sent.id, true],
      [sent.id, false],
    ]);
  });

  it('places a message sent at idle where its prompt line is, and a reply\'s screen copy where its transcript copy is once that is read', () => {
    const { conversation, path, append, items, advance } = setup();
    const ids = () => items().filter((item) => !(item.type === 'reply' && item.withdrawn)).map((item) => (item.type === 'message' ? item.text : item.opening));

    append(user('u1', T0, 'First?'), enqueue(T0 + 100, 'Second?'));
    conversation.readTranscript(path);
    // The reply's screen copy, first seen after the message was sent, shows below it until the transcript is read.
    conversation.readScreen(screen('● About the first.'));
    advance(300);
    expect(ids()).toEqual(['First?', 'Second?', 'About the first.']);

    append(assistant('a1', T0 + 200, 'About the first.'), JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(T0 + 300), sessionId: 'native-1' }), user('u2', T0 + 300, 'Second?'));
    conversation.readTranscript(path);
    expect(ids()).toEqual(['First?', 'About the first.', 'Second?']);
    expect(items().filter((item) => item.type === 'message')).toHaveLength(2);
  });

  it('withdraws a sent message Claude received as something else or never received, and never shows a queued notification', () => {
    const { conversation, path, append, items } = setup();

    append(
      enqueue(T0, '<task-notification>\n<task-id>x</task-id>\n</task-notification>'),
      enqueue(T0, '[Cross-session delivery notice] Your message was held.'),
      queued('q0', T0, '<task-notification>done</task-notification>', 'task-notification'),
      enqueue(T0, 'Relayed'),
      user('u1', T0, 'Relayed', { isMeta: true }),
      enqueue(T0, 'Never read'),
    );
    conversation.readTranscript(path);
    expect(items()).toMatchObject([
      { type: 'message', text: 'Relayed', provisional: true, withdrawn: true },
      { type: 'message', text: 'Never read', provisional: true, withdrawn: false },
    ]);

    conversation.end();
    expect(items()[1]).toMatchObject({ text: 'Never read', withdrawn: true });
  });

  it('never shows the stopped-agents notice an earlier run queued and exited with, and answers the next run\'s message with its reply', () => {
    const { conversation, path, items, changes } = setup();

    // Scrubbed lines of a real transcript: the notice is the earlier run's last queue line, dated three days before the resumed run's message.
    copyFileSync(join(import.meta.dirname, 'fixtures', 'transcripts', 'agents-stopped.jsonl'), path);
    conversation.readTranscript(path);

    const shown = items();

    expect(shown.map((item) => [item.type, item.type === 'message' ? item.text : item.opening, item.type === 'message' && item.provisional, item.withdrawn])).toEqual([
      ['message', 'Start the two background agents.', false, false],
      ['reply', 'Both agents are running.', false, false],
      ['message', 'Hello again', false, false],
      ['reply', 'Hello.', false, false],
    ]);
    expect(shown[3]).toMatchObject({ answers: shown[2]!.id });
    expect(changes.filter((change) => change.type === 'message')).toHaveLength(2);
  });

  it('leaves out the command and the continue text Claude Code queues itself at a usage limit', () => {
    const { conversation, path, items, changes } = setup();

    // Scrubbed lines of a real transcript (mechanics M140): at the limit Claude Code queues `/rate-limit-options` and receives it as no user
    // line; at the reset it queues its continue text and receives it as a meta line. The two limits were days apart and are retimed here.
    copyFileSync(join(import.meta.dirname, 'fixtures', 'transcripts', 'usage-limit.jsonl'), path);
    conversation.readTranscript(path);

    expect(items().map((item) => [item.type, item.type === 'message' ? item.text : item.opening, item.type === 'message' && item.provisional, item.withdrawn])).toEqual([
      ['message', 'Run the checks.', false, false],
      ['reply', "You've hit your usage limit, which resets at 11:20 am Eastern.", false, false],
      ['reply', 'The checks pass.', false, false],
    ]);
    expect(changes.filter((change) => change.type === 'message')).toHaveLength(1);
  });

  it('withdraws a message queued before one Claude received and never received itself, and keeps one queued after it', () => {
    const { store, conversation, path, append, items } = setup();
    const shown = () => items().map((item) => `${item.type === 'message' ? `${item.text}${item.provisional ? ' (sent)' : ''}` : item.opening}${item.withdrawn ? ' (withdrawn)' : ''}`);

    // An earlier run exits with "Lost" queued; the next run's first message is typed at idle.
    append(user('u1', T0, 'First?'), enqueue(T0 + 1000, 'Lost'));
    conversation.readTranscript(path);
    expect(shown()).toEqual(['First?', 'Lost (sent)']);

    append(user('u2', T0 + 86_400_000, 'Next day?'));
    conversation.readTranscript(path);
    expect(shown()).toEqual(['First?', 'Lost (sent) (withdrawn)', 'Next day?']);

    // "Before" and "After" are queued mid-turn and only "After" is received: "Before" was passed over; a later one still waits.
    append(enqueue(T0 + 86_401_000, 'Before'), enqueue(T0 + 86_402_000, 'After'), enqueue(T0 + 86_403_000, 'Later'), queued('q1', T0 + 86_404_000, 'After'));
    conversation.readTranscript(path);
    expect(shown()).toEqual(['First?', 'Lost (sent) (withdrawn)', 'Next day?', 'Before (sent) (withdrawn)', 'After', 'Later (sent)']);

    // A message typed from the view passes over a terminal message queued before its paste, not one queued after it.
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'open' as const, opId: 'op1' };

    store.addMessage({ ...typed, id: 'm-typed', at: T0 + 86_410_000, text: 'From the view', pastedAt: T0 + 86_410_000 });
    append(enqueue(T0 + 86_411_000, 'Typed after'), user('u3', T0 + 86_412_000, 'From the view'));
    conversation.readTranscript(path);
    expect(store.message('m-typed')).toMatchObject({ provisional: false, withdrawn: false });
    expect(shown().filter((line) => line.startsWith('Later') || line.startsWith('Typed after'))).toEqual(['Later (sent) (withdrawn)', 'Typed after (sent)']);
  });

  it('passes over queued messages by the order of their queue lines, not their times, and not for a queued command no queue line matches', () => {
    const { conversation, path, append, items } = setup();
    const waiting = () => items().filter((item) => item.type === 'message' && item.provisional && !item.withdrawn).map((item) => (item.type === 'message' ? item.text : ''));

    append(user('u1', T0, 'First?'));
    // "Second" is queued after "First queued" although its line carries an earlier time; receiving "First queued" leaves it waiting.
    append(enqueue(T0 + 5000, 'First queued'), enqueue(T0 + 1000, 'Second'), queued('q1', T0 + 6000, 'First queued'));
    conversation.readTranscript(path);
    expect(waiting()).toEqual(['Second']);

    // A queued command that matches no queue line, such as one Claude Code reworded, cannot say where it was queued.
    append(queued('q2', T0 + 7000, 'Reworded'));
    conversation.readTranscript(path);
    expect(waiting()).toEqual(['Second']);
  });

  it("links each reply to the operator's message on its parentUuid chain, past tool calls, other lines and made-up assistant lines", () => {
    const { conversation, path, append, items } = setup();
    const human = { origin: { kind: 'human' } };

    // M1 starts a turn; M2 is sent mid-turn and delivered beside a tool result, after a made-up Poll call; R1 is on the chain past M2, so it
    // answers M2; R0 is on a branch from M1 that M2's delivery is not on.
    append(
      chained(user('m1', T0, 'First?', human), null),
      chained(assistant('r0', T0 + 1, 'Looking at the first.', { madeBy: 'model', requestRef: 'q1' }), 'm1'),
      chained(JSON.stringify({ type: 'assistant', uuid: 't1', timestamp: iso(T0 + 2), madeBy: 'model', requestRef: 'q1', message: { role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'x' }] } }), 'r0'),
      chained(user('tr', T0 + 3, [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), 't1'),
      enqueue(T0 + 4, 'Second?'),
      chained(queued('m2', T0 + 4, 'Second?'), 'tr'),
      chained(JSON.stringify({ type: 'assistant', uuid: 'v1', timestamp: iso(T0 + 5), isVirtual: true, madeBy: 'other', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }), 'm2'),
      chained(JSON.stringify({ type: 'attachment', uuid: 'pe', timestamp: iso(T0 + 5), attachment: { type: 'poll_events' } }), 'm2'),
      chained(assistant('r1', T0 + 3, 'About the second.', { madeBy: 'model', requestRef: 'q2' }), 'pe'),
    );
    conversation.readTranscript(path);

    const [m1, r0, m2, r1] = items();

    expect(items().map((item) => (item.type === 'message' ? item.text : item.opening))).toEqual(['First?', 'Looking at the first.', 'Second?', 'About the second.']);
    expect(r0).toMatchObject({ answers: m1!.id });
    expect(r1).toMatchObject({ answers: m2!.id });
  });

  it("corrects a screen copy's answer once its transcript line names the message it answers", () => {
    const { conversation, path, append, items, advance } = setup();

    append(chained(user('m1', T0, 'First?'), null));
    conversation.readTranscript(path);
    conversation.readScreen(screen('● About the first.'));
    advance(300);
    append(enqueue(T0 + 1, 'Second?'), chained(queued('m2', T0 + 2, 'Second?'), 'm1'), chained(assistant('r1', T0 + 3, 'About the first.'), 'm2'));
    conversation.readTranscript(path);

    const [, m2, r1] = items();

    expect(r1).toMatchObject({ opening: 'About the first.', source: 'transcript', answers: m2!.id });
  });

  it('adds a sent message once when its transcript is read again from the start', () => {
    const { conversation, path, append, items } = setup();

    append(user('u1', T0, 'First?'), enqueue(T0 + 1, 'Second?'));
    conversation.readTranscript(path);
    writeFileSync(path, `${user('u1', T0, 'First?')}\n${enqueue(T0 + 1, 'Second?')}\n`.slice(0, 10));
    conversation.readTranscript(path);
    writeFileSync(path, `${user('u1', T0, 'First?')}\n${enqueue(T0 + 1, 'Second?')}\n`);
    conversation.readTranscript(path);

    expect(items().filter((item) => item.type === 'message').map((item) => item.type === 'message' && item.text)).toEqual(['First?', 'Second?']);
  });

  it('joins the text lines of one API message into one reply', () => {
    const { conversation, path, append, items } = setup();
    const block = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: iso(T0), madeBy: 'model', requestRef: 'q', message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] } });

    append(user('u1', T0, 'Both?'), block('a1', 'First part.'), block('a2', 'Second part.'), assistant('a3', T0 + 1, 'Another message.'));
    conversation.readTranscript(path);

    const replies = items().filter((item) => item.type === 'reply');

    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ transcriptUuid: 'a1' });
    expect(`${replies[0]!.type === 'reply' && replies[0]!.opening}`).toContain('First part.');
    expect(`${replies[0]!.type === 'reply' && replies[0]!.opening}`).toContain('Second part.');
  });

  it('joins the lines of one API message across a hub restart, and adds none twice when the transcript is read again', () => {
    const { store, conversation, path, append, items } = setup();
    const block = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: iso(T0), madeBy: 'model', requestRef: 'q', message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] } });
    const lines = [user('u1', T0, 'Both?'), block('a1', 'First part.'), block('a2', 'Second part.')];
    const replies = () => items().filter((item) => item.type === 'reply').map((item) => (item.type === 'reply' ? item.opening : ''));

    append(lines[0]!, lines[1]!);
    conversation.readTranscript(path);

    const restarted = new SessionConversation('s1', 7, { store, now: () => T0, newId: (() => { let n = 0; return () => `x${++n}`; })(), onChange: () => {}, log: () => {} });

    append(lines[2]!);
    restarted.readTranscript(path);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain('Second part.');

    // A shorter copy, then the whole file again.
    writeFileSync(path, 'x');
    restarted.readTranscript(path);
    writeFileSync(path, `${lines.join('\n')}\n`);
    restarted.readTranscript(path);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]!.match(/Second part\./g)).toHaveLength(1);

    // A reader after another restart does not take the screen's drawing of either line for a new reply.
    let clock = T0;
    const timers: Array<() => void> = [];
    const again = new SessionConversation('s1', 7, {
      store,
      now: () => clock,
      newId: (() => { let n = 0; return () => `y${++n}`; })(),
      onChange: () => {},
      log: () => {},
      hold: { now: () => clock, setTimer: (run) => timers.push(run), clearTimer: () => {} },
    });

    again.readScreen(screen('● First part.', '', '● Second part.'));
    clock += 5000;
    again.readScreen(screen('● First part.', '', '● Second part.'));
    timers.splice(0).forEach((run) => run());
    expect(replies()).toHaveLength(1);

    // A line recorded as joined whose text was not written, as after a crash between the two writes, is written when it is read again.
    const id = items().find((item) => item.type === 'reply')!.id;

    store.updateReply(id, { opening: 'First part.' });
    writeFileSync(path, 'x');
    again.readTranscript(path);
    writeFileSync(path, `${lines.join('\n')}\n`);
    again.readTranscript(path);
    expect(replies()[0]).toContain('Second part.');
  });

  it("rewrites the reply before a rewrite's transcript place, not the one its screen copy rewrote", () => {
    const { conversation, path, append, items, advance } = setup();

    append(user('u1', T0, 'Which port?'), assistant('a1', T0 + 1, 'Port 8765.'));
    conversation.readTranscript(path);
    conversation.readScreen(screen('● [rewrite] Port 8799.'));
    advance(300);
    append(assistant('a2', T0 + 2, 'Port 8770.'), assistant('a3', T0 + 3, '[rewrite] Port 8799.'));
    conversation.readTranscript(path);

    const [, first, second, rewrite] = items() as Array<{ id: string; replaces: string | null; rewrittenBy: string | null; opening: string }>;

    expect([first!.opening, second!.opening, rewrite!.opening]).toEqual(['Port 8765.', 'Port 8770.', 'Port 8799.']);
    expect(first!.rewrittenBy).toBeNull();
    expect(second!.rewrittenBy).toBe(rewrite!.id);
    expect(rewrite!.replaces).toBe(second!.id);
  });

  it('names a sent message by its session as well, and links replies past lines read before a hub restart', () => {
    const { store, conversation, path, append, items } = setup();

    append(chained(user('m1', T0, 'First?'), null), enqueue(T0 + 1, 'Second?'));
    conversation.readTranscript(path);

    const deps = (prefix: string): ConversationDeps => ({ store, now: () => T0, newId: (() => { let n = 0; return () => `${prefix}${++n}`; })(), onChange: () => {}, log: () => {} });
    const other = new SessionConversation('s2', 8, deps('o'));
    const otherPath = join(dir, 'native-2.jsonl');

    writeFileSync(otherPath, `${enqueue(T0 + 1, 'Second?')}\n`);
    other.readTranscript(otherPath);
    expect(store.provisionalMessages('s2')).toHaveLength(1);

    // A new reader after a restart: m1 was read before it, and its reply's chain reaches it.
    const restarted = new SessionConversation('s1', 7, deps('x'));

    append(chained(queued('m2', T0 + 2, 'Second?'), 'm1'), chained(assistant('t1', T0 + 3, 'Tool step.'), 'm2'), chained(assistant('r1', T0 + 4, 'About both.'), 't1'));
    restarted.readTranscript(path);

    const [, m2, , r1] = items();

    expect(m2).toMatchObject({ text: 'Second?', provisional: false });
    expect(r1).toMatchObject({ opening: 'About both.', answers: m2!.id });

    // A reply whose chain reaches only a message read before the restart answers that message, not the latest.
    const again = new SessionConversation('s1', 7, deps('y'));

    append(chained(assistant('r2', T0 + 5, 'Back to the first.'), 'm1'));
    again.readTranscript(path);
    expect(items().at(-1)).toMatchObject({ opening: 'Back to the first.', answers: items()[0]!.id });
  });

  it('withdraws a screen copy no transcript copy confirms', () => {
    const { conversation, items, advance, logs } = setup();

    conversation.readScreen(screen('● Not really a reply'));
    advance(300);
    conversation.tick(false);
    advance(6000);
    conversation.tick(false);

    expect(items()).toMatchObject([{ type: 'reply', withdrawn: true }]);
    expect(logs).toEqual([expect.stringMatching(/^session s1 reply r-1 withdrawn/)]);
  });

  it('shows an aside as an aside, and a rewrite in place of the reply before it', () => {
    const { conversation, path, append, items } = setup();

    append(
      user('u1', T0, 'Which port?'),
      assistant('a1', T0 + 1, 'Port 8765.'),
      assistant('a2', T0 + 2, '[aside] Checking.'),
      user('u2', T0 + 3, 'the other one'),
      assistant('a3', T0 + 4, '[rewrite] Port 8799, the other one.'),
    );
    conversation.readTranscript(path);

    const [, first, aside, , rewrite] = items() as Array<{ id: string; kind: string; replaces: string | null; rewrittenBy: string | null; opening: string }>;

    expect(aside).toMatchObject({ kind: 'aside', opening: 'Checking.' });
    expect(first!.rewrittenBy).toBe(rewrite!.id);
    expect(rewrite).toMatchObject({ replaces: first!.id, opening: 'Port 8799, the other one.' });
  });

  it("frees the reply a withdrawn rewrite replaced", () => {
    const { conversation, path, append, items, advance } = setup();

    append(assistant('a1', T0, 'Port 8765.'));
    conversation.readTranscript(path);
    conversation.readScreen(screen('● [rewrite] Port 8799.'));
    advance(300);
    expect(items()[0]).toMatchObject({ rewrittenBy: 'r-2' });
    advance(6000);
    conversation.tick(false);
    expect(items()).toMatchObject([{ id: 'r-1', rewrittenBy: null }, { id: 'r-2', withdrawn: true, replaces: null }]);
  });

  it("takes a status from a reply's transcript copy, never its screen copy, and keeps one per reply, the reply's text before the tag", () => {
    const { store, conversation, path, append, items, advance, changes } = setup();

    conversation.readScreen(screen('● Fixed.', '', '[state]', '', 'All green.'));
    advance(300);
    // The screen copy shows the reply's text alone.
    expect(items()).toMatchObject([{ opening: 'Fixed.', source: 'screen' }]);
    expect(store.latestState('s1')).toBeNull();

    append(user('u1', T0, 'Status?'), assistant('a1', T0 + 100, 'Fixed.\n\n[state]\n## Where it stands\n- All green.'));
    conversation.readTranscript(path);

    const [, reply] = items() as Array<{ id: string; opening: string }>;

    expect(reply).toMatchObject({ opening: 'Fixed.', source: 'transcript' });
    expect(store.latestState('s1')).toMatchObject({ id: `st-${reply!.id}`, sessionId: 's1', workItemId: 7, replyId: reply!.id, at: T0 + 100, headline: 'Where it stands', body: '- All green.', seenAt: null });
    expect(changes.filter((change) => change.type === 'state')).toHaveLength(1);

    // A reply that is only a state has no text, and as a rewrite replaces nothing.
    append(assistant('a2', T0 + 200, '[rewrite]\n[state]\nNext: ship it.'));
    conversation.readTranscript(path);
    expect(items().at(-1)).toMatchObject({ opening: '', replaces: null });
    expect(items()[1]).toMatchObject({ rewrittenBy: null });
    expect(store.latestState('s1')?.headline).toBe('Next: ship it.');
  });

  it('updates a status in place when a later line of its reply adds to it', () => {
    const { store, conversation, path, append, changes } = setup();
    const block = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: iso(T0), madeBy: 'model', requestRef: 'q', message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] } });

    append(block('a1', 'Done.\n[state]\nFirst part.'));
    conversation.readTranscript(path);
    append(block('a2', 'Second part.'));
    conversation.readTranscript(path);

    const states = changes.filter((change) => change.type === 'state').map((change) => (change.type === 'state' ? change.state : null));

    expect(states.map((state) => [state!.headline, state!.body])).toEqual([['First part.', null], ['First part.', 'Second part.']]);
    expect(new Set(states.map((state) => state!.id)).size).toBe(1);
    expect(store.states('s1', null, 10).states).toHaveLength(1);
  });

  it('resumes at its checkpoint after a hub restart and imports nothing twice', () => {
    const first = setup();

    first.append(assistant('a1', T0, 'One.'));
    first.conversation.readTranscript(first.path);

    let id = 100;
    const again = new SessionConversation('s1', 7, { store: first.store, now: () => T0, newId: () => String(++id), onChange: () => undefined, log: () => undefined });

    first.append(assistant('a2', T0 + 1, 'Two.'));
    again.readTranscript(first.path);
    // A redraw of the reply read before the restart is not new.
    again.readScreen(screen('● One.'));
    expect(first.items().map((item) => (item.type === 'reply' ? item.opening : ''))).toEqual(['One.', 'Two.']);
  });

  it('reads only what follows a checkpoint set at the end of a transcript with history, and answers a message typed after it', () => {
    const { store, conversation, path, append, items, changes } = setup();

    append(user('u0', T0 - 60_000, 'Old question'), assistant('a0', T0 - 59_000, 'Old answer.'));
    store.setCheckpoint({ sessionId: 's1', transcript: path, offset: transcriptEnd(path), lastUuid: null, lastAt: T0 });
    append(chained(user('u1', T0 + 1000, 'New question'), 'a0'), chained(assistant('a1', T0 + 2000, 'New answer.'), 'u1'));
    conversation.readTranscript(path);

    expect(items().map((item) => (item.type === 'reply' ? `${item.opening}<${item.answers}` : item.text))).toEqual(['New question', `New answer.<${items()[0]!.id}`]);
    expect(changes).toHaveLength(2);
  });

  // Only Windows takes either separator, so only there can the two spellings name one file.
  it.runIf(process.platform === 'win32')('takes a checkpoint whose path names the transcript with other separators as its own', () => {
    const { store, conversation, path, append, items } = setup();

    append(user('u0', T0 - 60_000, 'Old question'));
    store.setCheckpoint({ sessionId: 's1', transcript: path.replaceAll('\\', '/'), offset: transcriptEnd(path), lastUuid: null, lastAt: T0 });
    append(user('u1', T0 + 1000, 'New question'));
    conversation.readTranscript(path.replaceAll('/', '\\'));

    expect(items().map((item) => (item.type === 'message' ? item.text : ''))).toEqual(['New question']);
  });

  it('answers the stored message after a restart, and imports no entry twice when the transcript is replaced by a shorter copy', () => {
    const first = setup();

    first.append(user('u1', T0, `Question? ${'x'.repeat(600)}`), assistant('a1', T0 + 1, 'One.'));
    first.conversation.readTranscript(first.path);

    let id = 100;
    const again = new SessionConversation('s1', 7, { store: first.store, now: () => T0, newId: () => String(++id), onChange: () => undefined, log: () => undefined });

    writeFileSync(first.path, `${assistant('a1', T0 + 1, 'One.')}\n${assistant('a2', T0 + 2, 'Two.')}\n`);
    again.readTranscript(first.path);
    expect(first.items().map((item) => (item.type === 'reply' ? `${item.opening}<${item.answers}` : item.text.slice(0, 9)))).toEqual(['Question?', 'One.<m-1', 'Two.<m-1']);
  });

  it('withdraws a screen copy a stopped hub left waiting when no transcript copy comes, and replaces one whose transcript copy comes', () => {
    const { store, conversation, clock, path, append, items, advance, logs } = setup();

    conversation.readScreen(screen('● Never confirmed'));
    conversation.readScreen(screen('● Never confirmed', '', '● Confirmed later'));
    advance(300);
    expect(items()).toMatchObject([{ source: 'screen', withdrawn: false }, { source: 'screen', withdrawn: false }]);

    const [never, later] = items().map((item) => (item as { id: string }).id);
    // The hub restarts: a new process reads the same store.
    const restarted = new SessionConversation('s1', 7, { store, now: () => clock.t, newId: () => 'n', onChange: () => {}, log: (line) => logs.push(line) });

    append(assistant('a1', clock.t + 100, 'Confirmed later, in full.'));
    restarted.readTranscript(path);
    // The transcript copy takes its line's place, before the copy still waiting.
    expect(items()).toMatchObject([{ id: later, source: 'transcript', opening: 'Confirmed later, in full.' }, { id: never, source: 'screen', withdrawn: false }]);

    clock.t += 5_001;
    restarted.tick(false);
    expect(items().find((item) => (item as { id: string }).id === never)).toMatchObject({ withdrawn: true });
    expect(items().find((item) => (item as { id: string }).id === later)).toMatchObject({ withdrawn: false });
    expect(logs).toContain(`session s1 reply ${never} withdrawn: no transcript copy came`);
  });

  it('grows the newest screen copy a stopped hub left in place, and lets a tagged transcript copy replace one by its opening', () => {
    const { store, conversation, clock, path, append, items, advance } = setup();

    conversation.readScreen(screen('● Done.', '  [status]', '  All good'));
    conversation.readScreen(screen('● Done.', '  [status]', '  All good', '', '● Still drawing'));
    advance(300);

    const [done, drawing] = items().map((item) => (item as { id: string }).id);
    const restarted = new SessionConversation('s1', 7, { store, now: () => clock.t, newId: () => 'n', onChange: () => {}, log: () => {} });

    restarted.readScreen(screen('● Done.', '  [status]', '  All good', '', '● Still drawing, and done'));
    expect(items()).toMatchObject([{ id: done }, { id: drawing, source: 'screen', opening: 'Still drawing, and done' }]);

    append(assistant('a1', clock.t, 'Done.\n[status]\nAll good'));
    restarted.readTranscript(path);
    expect(items()).toHaveLength(2);
    expect(items().find((item) => (item as { id: string }).id === done)).toMatchObject({ source: 'transcript', withdrawn: false });
  });

  it('withdraws a screen copy still waiting when the session ends', () => {
    const { conversation, items, advance } = setup();

    conversation.readScreen(screen('● Never confirmed'));
    advance(300);
    conversation.end();
    expect(items()).toMatchObject([{ withdrawn: true }]);
  });

  it('reads a cleared session\'s new transcript from its start, and one with copied history from its end with a note', () => {
    const { conversation, path, append, items, clock } = setup();

    append(assistant('a1', T0 + 10_000, 'Before.'));
    conversation.readTranscript(path);

    const cleared = join(dir, 'native-2.jsonl');

    writeFileSync(cleared, `${assistant('b1', T0 + 20_000, 'After clear.')}\n`);
    conversation.readTranscript(cleared);

    const branched = join(dir, 'native-3.jsonl');

    clock.t = T0 + 25_000;
    writeFileSync(branched, `${assistant('c1', T0, 'Copied old.')}\n`);
    conversation.readTranscript(branched);
    appendFileSync(branched, `${assistant('c2', T0 + 30_000, 'New in branch.')}\n`);
    conversation.readTranscript(branched);

    expect(items().map((item) => (item.type === 'reply' ? `${item.kind}:${item.opening}` : ''))).toEqual(['reply:Before.', 'reply:After clear.', 'note:Conversation continued from another session.', 'reply:New in branch.']);
  });

  it('reads a new transcript whose first line is longer than the part checked for copied history from its end', () => {
    const { conversation, path, append, items } = setup();

    append(assistant('a1', T0 + 10_000, 'Before.'));
    conversation.readTranscript(path);

    const resumed = join(dir, 'native-2.jsonl');

    writeFileSync(resumed, `${assistant('c0', T0, `Copied ${'x'.repeat(COPIED_HEAD_BYTES)}`)}\n${assistant('c1', T0 + 1, 'Copied too.')}\n`);
    conversation.readTranscript(resumed);

    expect(items().map((item) => (item.type === 'reply' ? `${item.kind}:${item.opening}` : ''))).toEqual(['reply:Before.', 'note:Conversation continued from another session.']);
  });

  it('confirms a typed /clear by its line in the new transcript it starts, and still lets go of other messages typed into the earlier one', () => {
    const { store, conversation, path, append, items } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'sent' as const };

    append(assistant('a1', T0, 'Before.'));
    conversation.readTranscript(path);
    store.addMessage({ ...typed, id: 'm-clear', at: T0 + 1000, text: '/clear', opId: 'op1', pastedAt: T0 + 1000 });
    store.addMessage({ ...typed, id: 'm-other', at: T0 + 900, text: 'Lost words', opId: 'op2', pastedAt: T0 + 900 });

    const cleared = join(dir, 'native-2.jsonl');

    writeFileSync(
      cleared,
      [user('c0', T0 + 1200, '<local-command-caveat>Caveat: run directly.</local-command-caveat>'), user('c1', T0 + 1200, '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')].map((line) => `${line}\n`).join(''),
    );
    conversation.readTranscript(cleared);

    expect(items()).toMatchObject([
      { type: 'reply', opening: 'Before.' },
      { type: 'message', id: 'm-other', provisional: false, transcriptUuid: null },
      { type: 'message', id: 'm-clear', text: '/clear', transcriptUuid: 'c1', provisional: false },
    ]);
    expect(items()).toHaveLength(3);
  });

  it('waits for a line still being written, and reads nothing from a missing transcript', () => {
    const { conversation, path, items } = setup();

    conversation.readTranscript(join(dir, 'missing.jsonl'));
    appendFileSync(path, assistant('a1', T0, 'Half'));
    conversation.readTranscript(path);
    expect(items()).toEqual([]);
    appendFileSync(path, '\n');
    conversation.readTranscript(path);
    expect(items()).toHaveLength(1);
  });
});

describe('a typed message no transcript line confirms', () => {
  const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null, delivery: 'sent' as const };
  const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', 'transcripts', name);
  const pasted = (at: number): number => Date.parse('2026-11-25T14:18:35.742Z') + at;
  const shots = ['"C:\\Users\\Operator\\Pictures\\shot-1.png"', '"C:\\Users\\Operator\\Pictures\\shot-2.png"', '"C:\\Users\\Operator\\Pictures\\shot-3.png"'];

  it('is confirmed by the line Claude Code wrote after taking its image path lines as images (M159), with no terminal copy', () => {
    const { store, conversation, path, items } = setup();

    store.addMessage({ ...typed, id: 'm-shots', at: pasted(0), text: `make the notices bigger. ${shots[0]}\n${shots[1]}\n${shots[2]}`, opId: 'op1', pastedAt: pasted(0) });
    copyFileSync(fixture('image-paste.jsonl'), path);
    conversation.readTranscript(path);

    expect(items()).toMatchObject([
      { type: 'message', id: 'm-shots', delivery: 'sent', provisional: false, transcriptUuid: 'u0000000-0000-4000-8000-000000000002' },
      { type: 'reply', answers: 'm-shots', opening: 'A subagent is now working on the notices.' },
    ]);
    expect(items()).toHaveLength(2);
  });

  it('takes no message for a line of images when messages with its words name other images, and the latest of the same paste', () => {
    const { store, conversation, path, append, items } = setup();

    store.addMessage({ ...typed, id: 'm-one', at: T0, text: `Look\n${shots[0]}`, opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...typed, id: 'm-two', at: T0 + 1000, text: `Look\n${shots[1]}`, opId: 'op2', pastedAt: T0 + 1000 });
    append(user('u1', T0 + 1200, '[Image #1]Look', { origin: { kind: 'human' } }));
    conversation.readTranscript(path);
    expect(store.message('m-one')?.transcriptUuid).toBeNull();
    expect(store.message('m-two')?.transcriptUuid).toBeNull();
    expect(items().filter((item) => item.type === 'message' && item.origin === 'terminal')).toHaveLength(1);

    // Sent again with the same image, the latest attempt takes the line.
    store.addMessage({ ...typed, id: 'm-again', at: T0 + 2000, text: `Again\n${shots[2]}`, opId: 'op3', pastedAt: T0 + 2000 });
    store.addMessage({ ...typed, id: 'm-again-2', at: T0 + 3000, text: `Again\n${shots[2]}`, opId: 'op4', pastedAt: T0 + 3000 });
    append(user('u2', T0 + 3200, '[Image #2]Again', { origin: { kind: 'human' } }));
    conversation.readTranscript(path);
    expect(store.message('m-again-2')).toMatchObject({ delivery: 'sent', transcriptUuid: 'u2' });
    expect(store.message('m-again')).toMatchObject({ delivery: 'unconfirmed', transcriptUuid: null });
  });

  it('is unconfirmed, not sent and not last, once TYPED_LATE_MS pass with no line, and a line in another form never confirms it', () => {
    const { store, clock, conversation, path, append, items, changes, logs } = setup();

    // The same words with one of its two image lines: Claude Code left a path it could not read as text, so this is not the paste.
    store.addMessage({ ...typed, id: 'm-shots', at: T0, text: `look ${shots[0]}\n${shots[1]}\n${shots[2]}`, opId: 'op1', pastedAt: T0 });
    append(user('u1', T0 + 200, `[Image #1]look ${shots[0]}\n${shots[2]}`, { origin: { kind: 'human' } }), assistant('a1', T0 + 900, 'One image.'));
    conversation.readTranscript(path);
    clock.t = T0 + TYPED_LATE_MS - 1;
    conversation.tick(false);
    expect(store.message('m-shots')).toMatchObject({ delivery: 'sent', provisional: true });
    expect(items().map((item) => item.id).at(-1)).toBe('m-shots');

    clock.t = T0 + TYPED_LATE_MS + 1;
    conversation.tick(false);
    expect(store.message('m-shots')).toMatchObject({ delivery: 'unconfirmed', error: UNCONFIRMED, provisional: false, transcriptUuid: null });
    // It keeps the place where it was sent, before the terminal message and the reply that came after it.
    expect(items().map((item) => [item.type, item.type === 'message' ? item.origin : null])).toEqual([['message', 'typed'], ['message', 'terminal'], ['reply', null]]);
    expect(changes.filter((change) => change.type === 'message' && change.message.id === 'm-shots').at(-1)).toMatchObject({ message: { delivery: 'unconfirmed' } });
    expect(logs.some((line) => line.includes('m-shots is unconfirmed'))).toBe(true);
  });

  it('waits however long once its queue line is read, also after a hub restart, and is unconfirmed when the session ends without it', () => {
    const { store, clock, conversation, path, append, changes } = setup();

    store.addMessage({ ...typed, id: 'm-queued', at: T0, text: 'After the agents', opId: 'op1', pastedAt: T0 });
    append(user('u0', T0 - 1000, 'Start the agents'), enqueue(T0 + 100, 'After the agents'));
    conversation.readTranscript(path);
    clock.t = T0 + 3_600_000;
    conversation.tick(true);
    expect(store.message('m-queued')).toMatchObject({ delivery: 'sent', provisional: true });

    // A new hub indexes the lines read before it and finds the queue line.
    const again = new SessionConversation('s1', 7, { store, now: () => clock.t, newId: () => 'x', onChange: (change) => changes.push(change), log: () => {} });

    again.readTranscript(path);
    again.tick(true);
    expect(store.message('m-queued')).toMatchObject({ delivery: 'sent', provisional: true });

    again.end();
    expect(store.message('m-queued')).toMatchObject({ delivery: 'unconfirmed', provisional: false });
  });

  it('is unconfirmed at once when a message typed after it reaches the transcript, and still confirmed by its own line if that comes later', () => {
    const { store, conversation, path, append, items } = setup();

    store.addMessage({ ...typed, id: 'm-lost', at: T0, text: 'First words', opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...typed, id: 'm-next', at: T0 + 5_000, text: 'Second words', opId: 'op2', pastedAt: T0 + 5_000 });
    append(user('u2', T0 + 5_200, 'Second words'));
    conversation.readTranscript(path);

    expect(store.message('m-next')).toMatchObject({ delivery: 'sent', provisional: false, transcriptUuid: 'u2' });
    expect(store.message('m-lost')).toMatchObject({ delivery: 'unconfirmed', provisional: false, transcriptUuid: null });

    // Its line after all, however late: it is sent and takes that line's place.
    append(user('u3', T0 + 600_000, 'First words'));
    conversation.readTranscript(path);
    expect(store.message('m-lost')).toMatchObject({ delivery: 'sent', error: null, transcriptUuid: 'u3' });
    expect(items().map((item) => item.id)).toEqual(['m-next', 'm-lost']);
  });

  it('waits last again when its queue line comes after it was unconfirmed, until Claude receives it', () => {
    const { store, clock, conversation, path, append, items } = setup();

    append(user('u0', T0 - 1000, 'Start'));
    conversation.readTranscript(path);
    store.addMessage({ ...typed, id: 'm-late', at: T0, text: 'Slow one', opId: 'op1', pastedAt: T0 });
    clock.t = T0 + TYPED_LATE_MS + 1;
    conversation.tick(true);
    expect(store.message('m-late')).toMatchObject({ delivery: 'unconfirmed', provisional: false });

    append(enqueue(T0 + 200_000, 'Slow one'), assistant('a1', T0 + 200_100, 'Still busy.'));
    conversation.readTranscript(path);
    expect(store.message('m-late')).toMatchObject({ delivery: 'sent', error: null, provisional: true });
    expect(items().map((item) => item.id).at(-1)).toBe('m-late');

    append(queued('q1', T0 + 300_000, 'Slow one'));
    conversation.readTranscript(path);
    expect(store.message('m-late')).toMatchObject({ delivery: 'sent', provisional: false, transcriptUuid: 'q1' });
  });

  it("is never confirmed by Claude Code's meta line or a line from another origin with its words", () => {
    const { store, clock, conversation, path, append } = setup();

    store.addMessage({ ...typed, id: 'm-words', at: T0, text: 'Same words', opId: 'op1', pastedAt: T0 });
    append(user('u1', T0 + 100, 'Same words', { isMeta: true }), user('u2', T0 + 200, 'Same words', { origin: { kind: 'task-notification' } }));
    conversation.readTranscript(path);
    expect(store.message('m-words')).toMatchObject({ delivery: 'sent', transcriptUuid: null });
    clock.t = T0 + TYPED_LATE_MS + 1;
    conversation.tick(false);
    expect(store.message('m-words')).toMatchObject({ delivery: 'unconfirmed', transcriptUuid: null });
  });

  it('is unconfirmed when the session moves to another transcript before a line shows it', () => {
    const { store, clock, conversation, path, append, changes } = setup();

    append(user('u0', T0 - 1000, 'Hello'));
    conversation.readTranscript(path);
    store.addMessage({ ...typed, id: 'm-gone', at: T0, text: 'Never shown', opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...typed, id: 'm-open', at: T0, text: 'Still typing', delivery: 'open', opId: 'op2', pastedAt: T0 });

    const next = join(dir, 'native-2.jsonl');

    writeFileSync(next, `${user('u1', T0 + 1000, 'Something else')}\n`);
    conversation.readTranscript(next);
    expect(store.message('m-gone')).toMatchObject({ delivery: 'unconfirmed', error: UNCONFIRMED, pastedAt: null });
    expect(changes.some((change) => change.type === 'message' && change.message.id === 'm-gone' && change.message.delivery === 'unconfirmed')).toBe(true);
    // One still being typed keeps its paste time: its typing counts it sent, and with no line it is unconfirmed in time.
    expect(store.message('m-open')).toMatchObject({ delivery: 'open', pastedAt: T0 });
    store.updateMessage('m-open', { delivery: 'sent' });
    clock.t = T0 + TYPED_LATE_MS + 1;
    conversation.tick(false);
    expect(store.message('m-open')).toMatchObject({ delivery: 'unconfirmed', error: UNCONFIRMED });
  });
});
