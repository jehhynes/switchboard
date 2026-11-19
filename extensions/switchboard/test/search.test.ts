import { describe, expect, it } from 'vitest';
import { openUrlOf } from '../src/search.js';

describe('Open in Switchboard (PRD R69)', () => {
  it('reads the ticket URL from an open URI and refuses any other', () => {
    expect(openUrlOf('/open', 'url=https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1');
    expect(openUrlOf('/open', 'url=https://desk.example.test/t?a=1&b=2')).toBe('https://desk.example.test/t?a=1&b=2');
    expect(openUrlOf('/other', 'url=https://github.com/o/r/issues/1')).toBeNull();
    expect(openUrlOf('/open', 'link=https://github.com/o/r/issues/1')).toBeNull();
    expect(openUrlOf('/open', 'url=')).toBeNull();
  });
});
