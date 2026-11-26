import { describe, expect, it } from 'vitest';
import { AutoDuplex, CLEARS_NEEDED } from '../src/duplex.js';
import type { EchoMeasure } from '../src/echoCheck.js';

const NONE: EchoMeasure = { verdict: 'none', r: 0.1, lagMs: 300, levelDb: -70, rangeDb: 3, activeSeconds: 2 };
const ECHO: EchoMeasure = { verdict: 'echo', r: 0.66, lagMs: 130, levelDb: -31.7, rangeDb: 31, activeSeconds: 1.6 };
const UNCLEAR: EchoMeasure = { verdict: 'unclear', r: 0.3, lagMs: 200, levelDb: -25, rangeDb: 25, activeSeconds: 2 };
const SHORT: EchoMeasure = { ...UNCLEAR, activeSeconds: 0.2 };
const HEADPHONES = { headphones: true, why: 'form factor Headphones of "Headphones (WH-1000XM4)"' };

function setup() {
  const logs: string[] = [];

  return { logs, auto: new AutoDuplex((line) => logs.push(line)) };
}

describe('AutoDuplex', () => {
  it('needs two checks in a row that hear none, an unclear one between them changing nothing and an echo starting the count over', () => {
    const { logs, auto } = setup();

    expect([auto.full, auto.reason, auto.needed]).toEqual([false, 'echo check: not measured yet', CLEARS_NEEDED]);
    expect(auto.measured(NONE)).toBe(false);
    expect(auto.measured(UNCLEAR)).toBe(false);
    expect(auto.measured(ECHO)).toBe(true);
    expect(auto.reason).toBe('echo check: echo detected');
    expect(auto.measured(NONE)).toBe(false);
    expect(auto.measured(NONE)).toBe(true);
    expect([auto.full, auto.reason]).toEqual([true, 'echo check: no echo detected']);
    expect(logs).toEqual([
      'echo check: none (r 0.1 at 300 ms, level -70 dBFS, range 3 dB, 2 s played; hint: none; 1 of 2 in a row)',
      "echo check: unclear, sound that is not the reply's echo, such as talk (r 0.3 at 200 ms, level -25 dBFS, range 25 dB, 2 s played); nothing changes",
      'echo check: echo (r 0.66 at 130 ms, level -31.7 dBFS, range 31 dB, 1.6 s played; hint: none)',
      'echo check: none (r 0.1 at 300 ms, level -70 dBFS, range 3 dB, 2 s played; hint: none; 1 of 2 in a row)',
      'echo check: none (r 0.1 at 300 ms, level -70 dBFS, range 3 dB, 2 s played; hint: none; 2 of 2 in a row)',
    ]);

    // Full duplex: an echo heard makes it half-duplex again at once; too little played is not logged.
    expect(auto.measured(SHORT)).toBe(false);
    expect(auto.measured(ECHO)).toBe(true);
    expect(logs.at(-1)).toBe('echo check: echo (r 0.66 at 130 ms, level -31.7 dBFS, range 31 dB, 1.6 s played; hint: none): half-duplex again');
    expect(logs).toHaveLength(6);
  });

  it('needs one check with headphones on this computer, and ignores the hint over Remote Desktop', () => {
    const { logs, auto } = setup();

    auto.context(HEADPHONES, false);
    expect(auto.needed).toBe(1);
    expect(auto.measured(NONE)).toBe(true);
    expect(logs.at(-1)).toBe('echo check: none (r 0.1 at 300 ms, level -70 dBFS, range 3 dB, 2 s played; hint: headphones (form factor Headphones of "Headphones (WH-1000XM4)"); 1 of 1 in a row)');
    auto.reset('the playback device changed');
    auto.context(HEADPHONES, true);
    expect(auto.needed).toBe(2);
    expect(auto.measured(NONE)).toBe(false);
    expect(logs.at(-1)).toMatch(/hint: none over Remote Desktop, whose Remote Audio says nothing of headphones; 1 of 2 in a row\)$/);
    auto.context({ headphones: false, why: 'form factor Speakers of "Speakers"' }, false);
    expect(auto.hintText).toBe('hint: no headphones (form factor Speakers of "Speakers")');
  });

  it('starts over half-duplex, logging it only when something was measured', () => {
    const { logs, auto } = setup();

    auto.reset('the mic was turned on');
    expect(logs).toEqual([]);
    auto.measured(NONE);
    auto.measured(NONE);
    auto.reset('the playback device changed');
    expect([auto.full, auto.reason, logs.at(-1)]).toEqual([false, 'echo check: not measured yet', 'echo check starts over: the playback device changed']);
  });

  it('is half-duplex again when three or more of the words heard over a reply in full duplex are the reply\'s own', () => {
    const { logs, auto } = setup();
    const reply = 'The session token is refreshed in two places.';

    expect(auto.heardWhilePlaying('the session token is', reply)).toBe(false);
    auto.measured(NONE);
    auto.measured(NONE);
    expect(auto.heardWhilePlaying('the session', reply)).toBe(false);
    expect(auto.heardWhilePlaying('wait stop that', reply)).toBe(false);
    expect(auto.full).toBe(true);
    expect(auto.heardWhilePlaying('wait the session token', reply)).toBe(true);
    expect([auto.full, auto.reason]).toEqual([false, 'echo check: echo detected']);
    expect(logs.at(-1)).toBe('echo check: 3 of 4 words heard over the reply are its own: half-duplex again');
  });
});
