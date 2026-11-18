import { describe, expect, it } from 'vitest';
import { holderLockAddress, parseHolderRecord } from '../src/record.js';

describe('parseHolderRecord', () => {
  const record = { protocol: 1, build: 'b', port: 5000, token: 'ab', pid: 7, startedAt: '2026-11-18T00:00:00.000Z' };

  it('reads a complete record', () => {
    expect(parseHolderRecord(JSON.stringify(record))).toEqual(record);
  });

  it.each([['{'], ['[]'], [JSON.stringify({ ...record, port: 70000 })], [JSON.stringify({ ...record, token: '' })], [JSON.stringify({ ...record, pid: undefined })]])('refuses %s', (text) => {
    expect(parseHolderRecord(text)).toBeNull();
  });
});

describe('holderLockAddress', () => {
  it('names a pipe per home on Windows, ignoring case, and a socket in the home elsewhere', () => {
    expect(holderLockAddress('C:\\Users\\a\\.switchboard', 'win32')).toMatch(/^\\\\\.\\pipe\\switchboard-holder-[0-9a-f]{16}$/);
    expect(holderLockAddress('C:\\Users\\a\\.switchboard', 'win32')).toBe(holderLockAddress('c:\\users\\A\\.switchboard', 'win32'));
    expect(holderLockAddress('C:\\Users\\a\\.switchboard', 'win32')).not.toBe(holderLockAddress('C:\\Users\\b\\.switchboard', 'win32'));
  });
});
