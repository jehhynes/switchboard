import { describe, expect, it } from 'vitest';
import { PlayedReference, REFERENCE_TICK_MS } from '../src/reference.js';
import { BYTES_PER_MS } from '../src/tts.js';
import { Clock } from './fakes.js';

function setup() {
  const clock = new Clock();
  const pushed: Buffer[] = [];
  const reference = new PlayedReference({ push: (pcm) => pushed.push(pcm), now: clock.now, every: clock.every });
  const total = () => pushed.reduce((sum, pcm) => sum + pcm.length, 0);

  return { clock, pushed, reference, total };
}

/** `ms` of audio whose samples count up, so the order pushed can be checked. */
function audio(ms: number, from = 0): Buffer {
  const pcm = Buffer.alloc(ms * BYTES_PER_MS);

  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE((from + index) % 32768, index * 2);
  return pcm;
}

describe('PlayedReference', () => {
  it('pushes audio as it plays, one tick ahead, however far ahead it was written', () => {
    const { clock, pushed, reference, total } = setup();
    const first = audio(3000);
    const second = audio(1000, 3000 * 24);

    // A speaker takes seconds of audio at once; the canceller must get it only as it plays.
    reference.written(first);
    reference.written(second);
    expect(total()).toBe(REFERENCE_TICK_MS * BYTES_PER_MS);
    clock.advance(1000);
    expect(total()).toBe((1000 + REFERENCE_TICK_MS) * BYTES_PER_MS);
    clock.advance(2500);
    expect(total()).toBe((3500 + REFERENCE_TICK_MS) * BYTES_PER_MS);
    clock.advance(1000);
    expect(Buffer.concat(pushed).equals(Buffer.concat([first, second]))).toBe(true);
    // Nothing left: the ticker stops.
    expect(clock.timers.filter((timer) => !timer.cleared)).toEqual([]);
  });

  it('starts audio written after the playback ran dry when it is written', () => {
    const { clock, reference, total } = setup();

    reference.written(audio(100));
    clock.advance(500);
    expect(total()).toBe(100 * BYTES_PER_MS);
    reference.written(audio(100));
    expect(total()).toBe((100 + REFERENCE_TICK_MS) * BYTES_PER_MS);
    clock.advance(40);
    expect(total()).toBe((100 + 40 + REFERENCE_TICK_MS) * BYTES_PER_MS);
  });

  it('skips audio that played more than a tick ago when a tick comes late, rather than pushing it in a burst', () => {
    const { clock, pushed, reference, total } = setup();
    const pcm = audio(4000);

    reference.written(pcm);
    expect(total()).toBe(REFERENCE_TICK_MS * BYTES_PER_MS);
    // The event loop stalls: the ticks are cleared and the clock jumps 2.5 s without them.
    for (const timer of clock.timers) timer.cleared = true;
    clock.t = 2500;
    clock.timers.length = 0;
    // The next write resumes one tick behind the playback position.
    reference.written(audio(10));
    expect(pushed.at(-1)!.length).toBe(2 * REFERENCE_TICK_MS * BYTES_PER_MS);
    expect(pushed.at(-1)!.equals(pcm.subarray((2500 - REFERENCE_TICK_MS) * BYTES_PER_MS, (2500 + REFERENCE_TICK_MS) * BYTES_PER_MS))).toBe(true);
    expect(total()).toBeLessThan(4000 * BYTES_PER_MS);
  });

  it('drops the audio not played yet when the playback stops, and pushes whole samples only', () => {
    const { clock, pushed, reference, total } = setup();

    reference.written(Buffer.alloc(961));
    expect(pushed.map((pcm) => pcm.length)).toEqual([960]);
    clock.advance(40);
    expect(pushed.map((pcm) => pcm.length)).toEqual([960]);
    reference.written(audio(1000));
    reference.stop();
    const stopped = total();

    clock.advance(2000);
    expect(total()).toBe(stopped);
    expect(clock.timers.filter((timer) => !timer.cleared)).toEqual([]);

    // Nothing written: nothing pushed, no ticker.
    const idle = setup();

    idle.reference.written(Buffer.alloc(0));
    expect(idle.pushed).toEqual([]);
    expect(idle.clock.timers).toEqual([]);
  });

  it('pushes a phone\'s audio as the phone reports it heard, whatever the clock says, and never skips what a report passed over', () => {
    const clock = new Clock();
    const pushed: Buffer[] = [];
    let heard = 0;
    const reference = new PlayedReference({ push: (pcm) => pushed.push(pcm), now: clock.now, played: () => heard, every: clock.every });
    const total = () => pushed.reduce((sum, pcm) => sum + pcm.length, 0);
    const pcm = audio(1000);

    reference.written(pcm.subarray(0, 600 * BYTES_PER_MS));
    reference.written(pcm.subarray(600 * BYTES_PER_MS));
    expect(total()).toBe(REFERENCE_TICK_MS * BYTES_PER_MS);
    // Two seconds pass and the phone has played nothing: nothing more goes.
    clock.advance(2000);
    expect(total()).toBe(REFERENCE_TICK_MS * BYTES_PER_MS);
    // A report jumps 300 ms: all of it goes, in order.
    heard = 300;
    clock.advance(REFERENCE_TICK_MS);
    expect(total()).toBe((300 + REFERENCE_TICK_MS) * BYTES_PER_MS);
    heard = 1000;
    clock.advance(REFERENCE_TICK_MS);
    expect(Buffer.concat(pushed).equals(pcm)).toBe(true);
    expect(clock.timers.filter((timer) => !timer.cleared)).toEqual([]);
  });
});
