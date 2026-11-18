import { describe, expect, it } from 'vitest';
import { LineReader, chunkData, parseClientMessage } from '../src/protocol.js';

describe('LineReader', () => {
  it('joins a line split across chunks and returns each complete line', () => {
    const reader = new LineReader(100);

    expect(reader.push(Buffer.from('{"a":'))).toEqual([]);
    expect(reader.push(Buffer.from('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
  });

  it('keeps a multibyte character split between chunks', () => {
    const reader = new LineReader(100);
    const bytes = Buffer.from('é\n');

    expect(reader.push(bytes.subarray(0, 1))).toEqual([]);
    expect(reader.push(bytes.subarray(1))).toEqual(['é']);
  });

  it('refuses a line over the limit, complete or not', () => {
    expect(new LineReader(4).push(Buffer.from('12345\n'))).toEqual({ error: 'The message is too long.' });
    expect(new LineReader(4).push(Buffer.from('12345'))).toEqual({ error: 'The message is too long.' });
    expect(new LineReader(4).push(Buffer.from('1234\n'))).toEqual(['1234']);
  });
});

describe('chunkData', () => {
  it('splits so that each JSON-encoded part fits the limit', () => {
    const data = '\u001b[0m'.repeat(10);
    const parts = chunkData(data, 20);

    expect(parts.join('')).toBe(data);
    expect(parts.length).toBe(5);

    for (const part of parts) {
      expect(JSON.stringify(part).length - 2).toBeLessThanOrEqual(20);
    }
  });

  it('keeps a surrogate pair in one part', () => {
    const parts = chunkData('a😀b', 4);

    expect(parts).toEqual(['a', '😀', 'b']);
  });

  it('returns no parts for empty data', () => {
    expect(chunkData('')).toEqual([]);
  });
});

describe('parseClientMessage', () => {
  it('reads a valid spawn', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'spawn', id: 1, session: 's', label: 'l', file: 'f', args: ['a'], cwd: 'c', env: { A: '1' }, cols: 80, rows: 24 }))).toEqual({
      type: 'spawn', id: 1, session: 's', label: 'l', file: 'f', args: ['a'], cwd: 'c', env: { A: '1' }, cols: 80, rows: 24,
    });
  });

  it.each([
    ['not JSON', '{', 'The message is not JSON.'],
    ['an array', '[]', 'The message is not an object.'],
    ['an unknown type', '{"type":"dance"}', 'Unknown message type "dance".'],
    ['a spawn with a number in env', JSON.stringify({ type: 'spawn', id: 1, session: 's', label: 'l', file: 'f', args: [], cwd: 'c', env: { A: 1 }, cols: 80, rows: 24 }), 'Invalid spawn message.'],
    ['a spawn with zero columns', JSON.stringify({ type: 'spawn', id: 1, session: 's', label: 'l', file: 'f', args: [], cwd: 'c', env: {}, cols: 0, rows: 24 }), 'Invalid spawn message.'],
    ['a kill without a session', '{"type":"kill","id":2}', 'Invalid kill message.'],
    ['a list without an id', '{"type":"list"}', 'Invalid list message.'],
    ['input that is not text', '{"type":"input","data":5}', 'Invalid input message.'],
    ['a resize of 3000 rows', '{"type":"resize","cols":80,"rows":3000}', 'Invalid resize message.'],
    ['a hello without a token', '{"type":"hello"}', 'Invalid hello message.'],
  ])('refuses %s', (_name, line, error) => {
    expect(parseClientMessage(line)).toEqual({ error });
  });
});
