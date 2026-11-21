import { describe, expect, it } from 'vitest';
import { parseHubIdentity, parseHubRecord } from '../src/hubRecord.js';

const record = { protocol: 1, version: '0.1.0', build: 'abc123', configDir: 'C:/Users/me/.switchboard', execPath: '/usr/share/code/code', port: 51234, token: 'abc', pid: 4321, startedAt: '2026-10-02T12:00:00.000Z' };

describe('parseHubRecord', () => {
  it('reads a complete record', () => {
    expect(parseHubRecord(JSON.stringify(record))).toEqual(record);
  });

  it('drops unknown fields', () => {
    expect(parseHubRecord(JSON.stringify({ ...record, extra: true }))).toEqual(record);
  });

  it.each([
    ['empty text', ''],
    ['truncated JSON', '{"protocol":1,'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing token', JSON.stringify({ ...record, token: undefined })],
    ['an empty token', JSON.stringify({ ...record, token: '' })],
    ['port 0', JSON.stringify({ ...record, port: 0 })],
    ['port 65536', JSON.stringify({ ...record, port: 65536 })],
    ['a fractional pid', JSON.stringify({ ...record, pid: 1.5 })],
    ['a string port', JSON.stringify({ ...record, port: '51234' })],
    ['protocol 0', JSON.stringify({ ...record, protocol: 0 })],
    ['a missing build', JSON.stringify({ ...record, build: undefined })],
    ['a numeric version', JSON.stringify({ ...record, version: 1 })],
    ['a missing startedAt', JSON.stringify({ ...record, startedAt: undefined })],
    ['a missing configDir', JSON.stringify({ ...record, configDir: undefined })],
    ['a missing execPath', JSON.stringify({ ...record, execPath: undefined })],
    ['a numeric execPath', JSON.stringify({ ...record, execPath: 7 })],
  ])('rejects %s', (_, text) => {
    expect(parseHubRecord(text)).toBeNull();
  });
});

describe('parseHubIdentity', () => {
  it('reads an identity', () => {
    expect(parseHubIdentity('{"hub":"switchboard","protocol":1,"version":"0.1.0","pid":7}')).toEqual({
      hub: 'switchboard',
      protocol: 1,
      version: '0.1.0',
      pid: 7,
    });
  });

  it.each([
    ['text', 'not json'],
    ['a missing hub', '{"protocol":1,"version":"0.1.0","pid":7}'],
    ['a zero pid', '{"hub":"switchboard","protocol":1,"version":"0.1.0","pid":0}'],
    ['a missing version', '{"hub":"switchboard","protocol":1,"pid":7}'],
  ])('rejects %s', (_, text) => {
    expect(parseHubIdentity(text)).toBeNull();
  });
});
