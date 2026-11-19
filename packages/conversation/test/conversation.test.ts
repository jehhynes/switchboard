import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@switchboard/core';
import { SessionConversation } from '../src/conversation.js';
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
function setup(rules = true) {
  const store = Store.open(':memory:');
  const clock = { t: T0 };
  const timers: Array<{ run: () => void; at: number; cleared: boolean }> = [];
  const changes: ConversationChange[] = [];
  const logs: string[] = [];
  let id = 0;
  const conversation = new SessionConversation('s1', 7, () => rules, {
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

  it('confirms a typed message only by an entry near its paste: never one still waiting to paste, nor an uncertain one long after', () => {
    const { store, conversation, path, append, items } = setup();
    const typed = { sessionId: 's1', workItemId: 7, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, error: null };

    store.addMessage({ ...typed, id: 'm-waiting', at: T0, text: 'Yes', delivery: 'open', opId: 'op1', pastedAt: null });
    store.addMessage({ ...typed, id: 'm-old', at: T0, text: 'Yes', delivery: 'uncertain', opId: 'op2', pastedAt: T0, provisional: false });
    store.addMessage({ ...typed, id: 'm-queued', at: T0, text: 'Later', delivery: 'sent', opId: 'op3', pastedAt: T0 });
    // An hour later: a "Yes" typed in the terminal, and the queued message Claude took only now.
    append(user('u1', T0 + 3_600_000, 'Yes'), user('u2', T0 + 3_600_001, 'Later'));
    conversation.readTranscript(path);

    expect(items().map((item) => [item.id, item.type === 'message' ? item.delivery : null])).toEqual([
      ['m-old', 'uncertain'],
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

    store.addMessage({ ...typed, id: 'm-first', at: T0, text: 'Yes', delivery: 'uncertain', opId: 'op1', pastedAt: T0 });
    store.addMessage({ ...typed, id: 'm-second', at: T0 + 30_000, text: 'Yes', delivery: 'sent', opId: 'op2', pastedAt: T0 + 30_000 });
    append(user('u1', T0 + 30_100, 'Yes'));
    conversation.readTranscript(path);
    expect(store.message('m-second')?.transcriptUuid).toBe('u1');
    expect(store.message('m-first')).toMatchObject({ delivery: 'uncertain', transcriptUuid: null });

    // After /clear the session writes a new transcript; the uncertain "Yes" of the earlier one is never confirmed by it.
    const cleared = join(dir, 'native-2.jsonl');

    writeFileSync(cleared, `${user('u2', T0 + 40_000, 'Yes')}\n`);
    conversation.readTranscript(cleared);
    expect(store.message('m-first')).toMatchObject({ delivery: 'uncertain', transcriptUuid: null });
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

    store.addMessage({ id: 'm-typed', sessionId: 's1', workItemId: 7, at: T0, origin: 'typed', text: 'One\nTwo', transcriptUuid: null, provisional: false, withdrawn: false, delivery: 'uncertain', error: 'x', opId: 'op1', pastedAt: T0 });
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

    const restarted = new SessionConversation('s1', 7, () => true, { store, now: () => T0, newId: (() => { let n = 0; return () => `x${++n}`; })(), onChange: () => {}, log: () => {} });

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
    const again = new SessionConversation('s1', 7, () => true, {
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
    const other = new SessionConversation('s2', 8, () => true, deps('o'));
    const otherPath = join(dir, 'native-2.jsonl');

    writeFileSync(otherPath, `${enqueue(T0 + 1, 'Second?')}\n`);
    other.readTranscript(otherPath);
    expect(store.provisionalMessages('s2')).toHaveLength(1);

    // A new reader after a restart: m1 was read before it, and its reply's chain reaches it.
    const restarted = new SessionConversation('s1', 7, () => true, deps('x'));

    append(chained(queued('m2', T0 + 2, 'Second?'), 'm1'), chained(assistant('t1', T0 + 3, 'Tool step.'), 'm2'), chained(assistant('r1', T0 + 4, 'About both.'), 't1'));
    restarted.readTranscript(path);

    const [, m2, , r1] = items();

    expect(m2).toMatchObject({ text: 'Second?', provisional: false });
    expect(r1).toMatchObject({ opening: 'About both.', answers: m2!.id });

    // A reply whose chain reaches only a message read before the restart answers that message, not the latest.
    const again = new SessionConversation('s1', 7, () => true, deps('y'));

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

  it("shows a reply whole for a session whose prompt lacks the current rules", () => {
    const { conversation, path, append, items } = setup(false);

    append(assistant('a1', T0, '[aside] Done.'));
    conversation.readTranscript(path);
    expect(items()).toMatchObject([{ kind: 'reply', opening: '[aside] Done.' }]);
  });

  it('resumes at its checkpoint after a hub restart and imports nothing twice', () => {
    const first = setup();

    first.append(assistant('a1', T0, 'One.'));
    first.conversation.readTranscript(first.path);

    let id = 100;
    const again = new SessionConversation('s1', 7, () => true, { store: first.store, now: () => T0, newId: () => String(++id), onChange: () => undefined, log: () => undefined });

    first.append(assistant('a2', T0 + 1, 'Two.'));
    again.readTranscript(first.path);
    // A redraw of the reply read before the restart is not new.
    again.readScreen(screen('● One.'));
    expect(first.items().map((item) => (item.type === 'reply' ? item.opening : ''))).toEqual(['One.', 'Two.']);
  });

  it('answers the stored message after a restart, and imports no entry twice when the transcript is replaced by a shorter copy', () => {
    const first = setup();

    first.append(user('u1', T0, `Question? ${'x'.repeat(600)}`), assistant('a1', T0 + 1, 'One.'));
    first.conversation.readTranscript(first.path);

    let id = 100;
    const again = new SessionConversation('s1', 7, () => true, { store: first.store, now: () => T0, newId: () => String(++id), onChange: () => undefined, log: () => undefined });

    writeFileSync(first.path, `${assistant('a1', T0 + 1, 'One.')}\n${assistant('a2', T0 + 2, 'Two.')}\n`);
    again.readTranscript(first.path);
    expect(first.items().map((item) => (item.type === 'reply' ? `${item.opening}<${item.answers}` : item.text.slice(0, 9)))).toEqual(['Question?', 'One.<m-1', 'Two.<m-1']);
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
