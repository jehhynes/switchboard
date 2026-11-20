import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Capture } from '../src/output.js';
import { NoEchoCancellation, noEchoReason, WINDOWS_CAPTURE_START_MS, windowsCapture, withFallback } from '../src/windowsCapture.js';
import { Clock } from './fakes.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = 0;

  kill(): void {
    this.killed++;
  }
}

const HEADER = '{"device":"Microphone (BRIO)","speakers":"LG","mode":"communications","effects":[{"effect":"acoustic echo cancellation","on":true}],"reference":"speakers"}';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(speakers: string | null = null) {
  const clock = new Clock();
  const runs: Array<{ command: string; args: string[]; child: FakeChild }> = [];
  const logs: string[] = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeChild();

    runs.push({ command, args, child });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const capture = windowsCapture({ script: 'C:/v/commcapture.ps1', speakers: () => speakers, log: (line) => logs.push(line), spawn, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  return { clock, runs, logs, capture };
}

describe('windowsCapture', () => {
  it('runs commcapture.ps1 on the chosen devices, logs what Windows applies, and passes whole samples on once it records', async () => {
    const { clock, runs, logs, capture } = setup('LG');
    const pcm: Buffer[] = [];
    const errors: Error[] = [];
    const opening = capture.open('BRIO', (chunk) => pcm.push(chunk), (error) => errors.push(error));
    const child = runs[0]!.child;

    expect(runs[0]!.command).toBe('powershell.exe');
    expect(runs[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/v/commcapture.ps1', '-Device', 'BRIO', '-Speakers', 'LG']);
    child.stdout.write(Buffer.from([9, 9]));
    await tick();
    child.stderr.write(`${HEADER}\n`);

    const stream = await opening;

    expect(logs).toEqual([`windows capture: ${HEADER}`]);
    expect([stream.halfDuplex, stream.remote]).toEqual([null, false]);
    // A sample split across two reads is joined; nothing from before the header is passed on.
    child.stdout.write(Buffer.from([1, 2, 3]));
    await tick();
    child.stdout.write(Buffer.from([4, 5, 6, 7]));
    await tick();
    expect(Buffer.concat(pcm)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(pcm.every((chunk) => chunk.length % 2 === 0)).toBe(true);
    // Windows takes the echo reference from the speakers: nothing is fed.
    stream.reference(Buffer.alloc(4));

    // The helper exiting on its own is a device failure.
    child.stderr.write('{"discontinuities":2}\n');
    await tick();
    expect(logs.at(-1)).toBe('windows capture: 2 packets followed lost audio');
    child.emit('exit', 1);
    expect(errors.map((error) => error.message)).toEqual(['the Windows capture helper exited with code 1']);
    expect(clock.timers.filter((timer) => !timer.cleared)).toEqual([]);
  });

  it('ends the helper by closing its input, kills it if it lingers, and reports nothing once stopped', async () => {
    const { clock, runs, capture } = setup();
    const errors: Error[] = [];
    const opening = capture.open(null, () => undefined, (error) => errors.push(error));
    const child = runs[0]!.child;

    expect(runs[0]!.args).not.toContain('-Device');
    expect(runs[0]!.args).not.toContain('-Speakers');
    child.stderr.write(`${HEADER}\n`);

    const stream = await opening;
    let ended = false;

    child.stdin.on('finish', () => (ended = true));
    stream.stop();
    stream.stop();
    await tick();
    expect(ended).toBe(true);
    clock.advance(3000);
    expect(child.killed).toBe(1);
    child.emit('exit', null);
    expect(errors).toEqual([]);
  });

  it('fails to open, killing the helper, on an error line, an early exit, a spawn error, no answer in time or no echo cancellation', async () => {
    const { clock, runs, capture } = setup();
    const pcm: Buffer[] = [];
    const opens = [0, 1, 2, 3, 4].map(() => capture.open(null, (chunk) => pcm.push(chunk), () => undefined).then(() => 'opened', (error: Error) => error.message));

    runs[0]!.child.stderr.write('{"error":"Start failed: 0x88890008"}\n');
    runs[1]!.child.emit('exit', 1);
    runs[2]!.child.emit('error', new Error('spawn powershell.exe ENOENT'));
    runs[4]!.child.stderr.write('{"device":"Headset","effects":[{"effect":"acoustic echo cancellation","on":false}]}\n');
    await tick();
    clock.advance(WINDOWS_CAPTURE_START_MS);
    expect(await Promise.all(opens)).toEqual([
      'Start failed: 0x88890008',
      'the Windows capture helper exited with code 1',
      'the Windows capture helper did not run: spawn powershell.exe ENOENT',
      'the Windows capture helper did not start within 20 s',
      'Windows applies no echo cancellation to Headset',
    ]);
    expect(runs.map((run) => run.child.killed)).toEqual([1, 1, 1, 1, 1]);

    // No echo cancellation says why for half-duplex listening, naming Remote Desktop when the helper reports a remote session.
    const remote = capture.open(null, () => undefined, () => undefined).catch((error: unknown) => error);

    runs[5]!.child.stderr.write('{"device":"Microphone (Remote Audio)","effects":[],"remote":true}\n');
    await tick();
    expect(await remote).toBeInstanceOf(NoEchoCancellation);
    expect(((await remote) as NoEchoCancellation).halfDuplex).toBe('no echo cancellation on Remote Audio');
    expect(((await remote) as NoEchoCancellation).remote).toBe(true);
    expect(runs[5]!.child.killed).toBe(1);

    // A helper that failed to open stays silent, even if it answers late.
    runs[3]!.child.stderr.write(`${HEADER}\n`);
    runs[3]!.child.stdout.write(Buffer.from([1, 2, 3, 4]));
    await tick();
    expect(pcm).toEqual([]);
  });
});

describe('noEchoReason', () => {
  it('names Remote Audio, another device over Remote Desktop, or the device', () => {
    expect(noEchoReason('Microphone (Remote Audio)', false)).toBe('no echo cancellation on Remote Audio');
    expect(noEchoReason('Microphone (Remote Audio)', true)).toBe('no echo cancellation on Remote Audio');
    expect(noEchoReason('Headset', true)).toBe('no echo cancellation on Headset over Remote Desktop');
    expect(noEchoReason('Headset', false)).toBe('no echo cancellation on Headset');
  });
});

describe('withFallback', () => {
  it('gives a half-duplex fallback the reason of a device with no echo cancellation, and its own reason after another failure', async () => {
    let failure: Error = new NoEchoCancellation('Windows applies no echo cancellation to Microphone (Remote Audio)', 'no echo cancellation on Remote Audio', true);
    const references: number[] = [];
    let stopped = 0;
    const primary: Capture = {
      open: async () => {
        throw failure;
      },
    };
    const fallback: Capture = {
      open: async () => ({ stop: () => void stopped++, reference: (pcm) => void references.push(pcm.length), halfDuplex: "decibri's echo canceller removes too little echo", remote: null }),
    };
    const capture = withFallback(primary, fallback, () => undefined, 'decibri');
    const stream = await capture.open(null, () => undefined, () => undefined);

    expect([stream.halfDuplex, stream.remote]).toEqual(['no echo cancellation on Remote Audio', true]);
    stream.reference(Buffer.alloc(6));
    stream.stop();
    expect([references, stopped]).toEqual([[6], 1]);
    failure = new Error('the Windows capture helper exited with code 1');
    expect((await capture.open(null, () => undefined, () => undefined)).halfDuplex).toBe("decibri's echo canceller removes too little echo");
  });

  it('opens through the fallback, logging why, only when the first capture fails', async () => {
    const logs: string[] = [];
    const opened: string[] = [];
    let failing = true;
    const stream = { stop: () => undefined, reference: () => undefined, halfDuplex: null, remote: false };
    const primary: Capture = {
      open: async (device) => {
        if (failing) {
          throw new Error('the Windows capture helper exited with code 1');
        }

        opened.push(`primary ${device}`);
        return stream;
      },
    };
    const fallback: Capture = {
      open: async (device) => {
        opened.push(`fallback ${device}`);
        return stream;
      },
    };
    const capture = withFallback(primary, fallback, (line) => logs.push(line), 'decibri');

    expect(await capture.open('USB', () => undefined, () => undefined)).toBe(stream);
    expect(logs).toEqual(['the Windows capture helper exited with code 1; capturing through decibri']);
    failing = false;
    await capture.open(null, () => undefined, () => undefined);
    expect(opened).toEqual(['fallback USB', 'primary null']);
    expect(logs).toHaveLength(1);
  });
});
