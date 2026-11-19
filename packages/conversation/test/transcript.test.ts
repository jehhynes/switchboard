import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLine, readLines } from '../src/transcript.js';

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
