import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagePasted, parseLine, readHead, readLines, readLinesBefore, transcriptEnd } from '../src/transcript.js';

describe('parseLine', () => {
  it('reads nothing from what is not an entry object', () => {
    for (const line of ['[1]', '7', 'null', '{"type":"summary"}']) {
      expect(parseLine(line).entry).toBeNull();
    }
  });

  it("reads a message's text blocks beside an image, and a slash command with no arguments", () => {
    const at = '2026-11-19T12:00:00.000Z';

    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, message: { content: [{ type: 'image' }, { type: 'text', text: 'Look at this' }] } })).entry).toEqual({ kind: 'message', uuid: 'u', at: Date.parse(at), text: 'Look at this' });
    expect(parseLine(JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })).entry).toMatchObject({ text: '/clear', at: 0, uuid: null });
    expect(parseLine(JSON.stringify({ type: 'user', message: { content: '<command-name>compact</command-name><command-args> </command-args>' } })).entry).toMatchObject({ text: '/compact' });
  });

  it('times every assistant line the model wrote, not a subagent\'s or one Claude Code made up, and reads no reply from a made-up or empty one', () => {
    const at = '2026-11-19T12:00:00.000Z';

    expect(parseLine(JSON.stringify({ type: 'assistant', timestamp: at, message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } }))).toMatchObject({ entry: null, assistantAt: null });
    // An added Poll call or "No response requested.": no requestRef, madeBy other (claude-collab findings 2026-11-19).
    expect(parseLine(JSON.stringify({ type: 'assistant', timestamp: at, isVirtual: true, madeBy: 'other', message: { model: 'claude', content: [{ type: 'text', text: 'No response requested.' }] } }))).toMatchObject({ entry: null, assistantAt: null });
    expect(parseLine(JSON.stringify({ type: 'assistant', uuid: 'a', parentUuid: 'p', timestamp: at, madeBy: 'model', requestRef: 'r', message: { model: 'claude', content: [{ type: 'text', text: 'x' }] } }))).toMatchObject({ entry: { kind: 'reply' }, uuid: 'a', parent: 'p', assistantAt: Date.parse(at) });
    expect(parseLine(JSON.stringify({ type: 'assistant', timestamp: at, isSidechain: true, message: { content: [{ type: 'text', text: 'x' }] } }))).toMatchObject({ entry: null, assistantAt: null });
    expect(parseLine(JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use' }] } }))).toMatchObject({ entry: null, assistantAt: Date.parse(at) });
  });
});

describe('parseLine on messages', () => {
  const at = '2026-11-19T12:00:00.000Z';
  const queuedLine = (origin: unknown, commandMode = 'prompt') => JSON.stringify({ type: 'attachment', uuid: 'q', parentUuid: 'p', timestamp: at, attachment: { type: 'queued_command', prompt: 'Hi', commandMode, ...(origin === undefined ? {} : { origin }) } });

  it("reads a user line or queued command as the operator's only when its origin is human, and still names what was received", () => {
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, origin: { kind: 'human' }, message: { content: 'Hi' } }))).toMatchObject({ entry: { kind: 'message', text: 'Hi' }, received: 'Hi' });
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, origin: { kind: 'task-notification' }, message: { content: 'Done' } }))).toMatchObject({ entry: null, received: 'Done' });
    // Before Claude Code wrote origins, the text alone decides.
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, message: { content: 'Hi' } }))).toMatchObject({ entry: { kind: 'message' } });
    expect(parseLine(queuedLine({ kind: 'human' }))).toMatchObject({ entry: { kind: 'message', text: 'Hi', uuid: 'q' }, parent: 'p' });
    expect(parseLine(queuedLine({ kind: 'cross-session' }))).toMatchObject({ entry: null, received: 'Hi' });
    expect(parseLine(queuedLine(undefined))).toMatchObject({ entry: { kind: 'message' } });
    expect(parseLine(queuedLine(undefined, 'task-notification'))).toMatchObject({ entry: null, received: 'Hi' });
  });

  it('reads an enqueue as sent, and no other queue line', () => {
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: 'Hi' }))).toMatchObject({ entry: { kind: 'sent', text: 'Hi', at: Date.parse(at) } });
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at, content: 'Hi' }))).toMatchObject({ entry: null, received: null });
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: '<event nonce="x">' }))).toMatchObject({ entry: null });
  });

  it('reads the command and the continue text Claude Code queues at a usage limit as no message, but not the operator writing about them', () => {
    const enqueue = (content: string) => parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content }));
    const resumed = 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';

    expect(enqueue('/rate-limit-options')).toMatchObject({ entry: null, at: Date.parse(at) });
    expect(enqueue(resumed)).toMatchObject({ entry: null });
    // Its continue text when usage comes back before the reset, from the 2.1.330 binary.
    expect(enqueue('Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.')).toMatchObject({ entry: null });
    expect(enqueue('/rate-limit-options please')).toMatchObject({ entry: { kind: 'sent', text: '/rate-limit-options please' } });
    expect(enqueue(`${resumed} Then push.`)).toMatchObject({ entry: { kind: 'sent' } });
    // Switchboard's own continue text, which it types as a message of its own (architecture.md § Rate limits).
    expect(enqueue('Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.')).toMatchObject({ entry: { kind: 'sent' } });
    // Received as a slash command from the operator, it is theirs.
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, origin: { kind: 'human' }, message: { content: '<command-name>/rate-limit-options</command-name>\n<command-args></command-args>' } }))).toMatchObject({ entry: { kind: 'message', text: '/rate-limit-options' } });
  });

  it("reads Claude Code's notice of stopped background agents as no message, queued or in a line without an origin, but not the operator quoting it", () => {
    const enqueue = (content: string) => parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content }));
    const several = '2 background agents were stopped by the user: "One", "Two".';
    const one = 'Background agent "One" was stopped by the user.';

    expect(enqueue(several)).toMatchObject({ entry: null });
    expect(enqueue(one)).toMatchObject({ entry: null });
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, message: { content: one } }))).toMatchObject({ entry: null, received: one });
    expect(enqueue(`I got this: ${several}`)).toMatchObject({ entry: { kind: 'sent', text: `I got this: ${several}` } });
    // The operator sending the notice's words verbatim, from a line that names them as its origin.
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, origin: { kind: 'human' }, message: { content: several } }))).toMatchObject({ entry: { kind: 'message', text: several } });
    expect(parseLine(JSON.stringify({ type: 'attachment', uuid: 'q', timestamp: at, attachment: { type: 'queued_command', prompt: several, commandMode: 'prompt', origin: { kind: 'human' } } }))).toMatchObject({ entry: { kind: 'message', text: several, queued: true } });
    expect(parseLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: at, origin: { kind: 'human' }, message: { content: `[spoken] I got this: ${several}` } }))).toMatchObject({ entry: { kind: 'message', text: `I got this: ${several}` } });
  });
});

describe('readLines', () => {
  it('reads a file that was replaced by a shorter one again from its start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
    const path = join(dir, 't.jsonl');

    try {
      writeFileSync(path, 'a\nb\n');
      expect(readLines(path, 0)).toEqual({ lines: ['a', 'b'], offset: 4 });
      writeFileSync(path, 'c\n');
      expect(readLines(path, 4)).toEqual({ lines: ['c'], offset: 2 });
      expect(readLines(path, 2)).toEqual({ lines: [], offset: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading part of a transcript', () => {
  it('reads the lines before an offset within a window, leaving out a line the window cuts, and the lines of its start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
    const path = join(dir, 't.jsonl');

    try {
      writeFileSync(path, 'first\nsecond\nthird\nhalf');
      // Lines end at 6, 13 and 19; 'half' is still being written.
      expect(readLinesBefore(path, 23, 1_000)).toEqual(['first', 'second', 'third']);
      expect(readLinesBefore(path, 19, 16)).toEqual(['second', 'third']);
      expect(readLinesBefore(path, 19, 13)).toEqual(['second', 'third']);
      expect(readLinesBefore(path, 15, 9)).toEqual(['second']);
      expect(readLinesBefore(join(dir, 'missing.jsonl'), 20, 100)).toEqual([]);
      expect(readHead(path, 9)).toEqual(['first']);
      expect(readHead(path, 1_000)).toEqual(['first', 'second', 'third']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the end of a transcript's last complete line, past a line longer than one read", () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
    const path = join(dir, 't.jsonl');

    try {
      writeFileSync(path, `a\n${'x'.repeat(200_000)}`);
      expect(transcriptEnd(path)).toBe(2);
      writeFileSync(path, `a\n${'x'.repeat(200_000)}\n`);
      expect(transcriptEnd(path)).toBe(200_003);
      writeFileSync(path, 'no line end');
      expect(transcriptEnd(path)).toBe(0);
      expect(transcriptEnd(join(dir, 'missing.jsonl'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('imagePasted', () => {
  const shot = (n: number): string => `"C:\\Users\\Operator\\Pictures\\shot-${n}.png"`;

  it('matches a paste whose image path lines became placeholders, ignoring spacing and typed tags (mechanics M159)', () => {
    expect(imagePasted(`[Image #4] [Image #5]Look at these. ${shot(1)}`, `Look at these. ${shot(1)}\n${shot(2)}\n${shot(3)}`)).toBe(true);
    expect(imagePasted('[Image #1] [spoken] Look', `[spoken] Look\n${shot(2)}`)).toBe(true);
    expect(imagePasted('[Image #1]Look', '/home/operator/shot.JPG\nLook')).toBe(true);
  });

  it('refuses another count of images, other words, no placeholder, and a paste of images alone', () => {
    expect(imagePasted('[Image #1]Look', `Look\n${shot(2)}\n${shot(3)}`)).toBe(false);
    expect(imagePasted('[Image #1]Look here', `Look\n${shot(2)}`)).toBe(false);
    expect(imagePasted('Look', `Look\n${shot(2)}`)).toBe(false);
    expect(imagePasted('Look [Image #1]', 'Look [Image #1]')).toBe(false);
    expect(imagePasted('[Image #1] [Image #2]', `${shot(1)}\n${shot(2)}`)).toBe(false);
    // A line with more than a path is text.
    expect(imagePasted('[Image #1]Look', `Look\nsee ${shot(2)}`)).toBe(false);
  });
});
