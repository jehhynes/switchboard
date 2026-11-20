import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ECHO_R, EchoCheck, judgeEcho } from '../src/echoCheck.js';

/** The PCM of a 16-bit mono WAV in `fixtures/echo` (README.md there says where each came from). */
function wav(name: string): Buffer {
  const file = readFileSync(new URL(`./fixtures/echo/${name}`, import.meta.url));

  return file.subarray(44);
}

const PLAYED = wav('played.wav');
const PLAY_START = 500;
const CLIP_MS = PLAYED.length / 48;

/**
 * Plays `played` from `PLAY_START` in 20 ms pieces as it plays, and delivers `captured` in 100 ms chunks that arrive 10 to 40 ms after their
 * audio, as the voice process sees them; then measures the playback.
 */
function run(captured: Buffer, played = PLAYED, options: { lateChunk?: number } = {}) {
  const check = new EchoCheck();
  let playedAt = 0;
  let capturedAt = 0;

  for (let ms = 0; capturedAt < captured.length; ms += 10) {
    while (playedAt < played.length && PLAY_START + playedAt / 48 <= ms) {
      check.played(played.subarray(playedAt, playedAt + 960), PLAY_START + playedAt / 48);
      playedAt += 960;
    }

    if (ms > 0 && ms % 100 === 0) {
      const late = ms / 100 === options.lateChunk ? 400 : 10 + ((ms / 10) % 4) * 10;

      check.captured(captured.subarray(capturedAt, capturedAt + 3200), ms + late);
      capturedAt += 3200;
    }
  }

  return { check, measure: check.measure(PLAY_START, PLAY_START + played.length / 48) };
}

function silence(ms: number): Buffer {
  return Buffer.alloc(ms * 32);
}

/** Steady white noise at about `db` dBFS. */
function noise(ms: number, db: number): Buffer {
  const pcm = Buffer.alloc(ms * 32);
  const amplitude = 10 ** (db / 20) * Math.sqrt(3) * 32_767;
  let seed = 7;

  for (let index = 0; index < pcm.length / 2; index++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    pcm.writeInt16LE(Math.round((seed / 2_147_483_648 - 0.5) * 2 * amplitude), index * 2);
  }

  return pcm;
}

describe('EchoCheck', () => {
  it('hears the speakers\' echo in real captures, on this computer and over Remote Desktop', () => {
    const local = run(wav('echo-local.wav')).measure!;
    const remote = run(wav('echo-remote.wav')).measure!;

    expect(local).toMatchObject({ verdict: 'echo' });
    expect(local.r).toBeGreaterThanOrEqual(ECHO_R + 0.1);
    expect(local.lagMs).toBeGreaterThanOrEqual(0);
    expect(local.lagMs).toBeLessThanOrEqual(400);
    expect(remote).toMatchObject({ verdict: 'echo' });
    expect(remote.r).toBeGreaterThanOrEqual(ECHO_R + 0.1);
    expect(remote.levelDb).toBeGreaterThan(-40);
  });

  it('hears none in a capture with the echo taken out, or with only steady room noise, as with headphones', () => {
    expect(run(wav('quiet.wav')).measure).toMatchObject({ verdict: 'none' });

    const steady = run(noise(4_000, -45)).measure!;

    expect(steady).toMatchObject({ verdict: 'none' });
    expect(steady.rangeDb).toBeLessThan(6);
    expect(steady.levelDb).toBeGreaterThan(-50);
  });

  it('finds the echo up to a second late and no later', () => {
    const echo = wav('echo-local.wav');
    const near = run(echo).measure!;
    const late = run(Buffer.concat([silence(700), echo])).measure!;

    expect(late).toMatchObject({ verdict: 'echo' });
    expect(late.lagMs - near.lagMs).toBeGreaterThanOrEqual(690);
    expect(late.lagMs - near.lagMs).toBeLessThanOrEqual(710);
    // 1.3 s late: past the delays searched, so it is sound that does not match, not echo.
    expect(run(Buffer.concat([silence(1_300), echo])).measure).toMatchObject({ verdict: 'unclear' });
  });

  it('calls speech that is not the playback\'s echo unclear, never none, as when the operator talks', () => {
    const echo = wav('echo-local.wav');
    const reversed = Buffer.alloc(echo.length);

    for (let index = 0; index < echo.length / 2; index++) {
      reversed.writeInt16LE(echo.readInt16LE(echo.length - 2 - index * 2), index * 2);
    }

    const measure = run(reversed).measure!;

    expect(measure.verdict).toBe('unclear');
    expect(measure.r).toBeLessThan(ECHO_R);
  });

  it('keeps the capture on the clock when a chunk arrives late', () => {
    expect(run(wav('echo-remote.wav'), PLAYED, { lateChunk: 12 }).measure).toMatchObject({ verdict: 'echo' });
  });

  it('measures nothing the capture did not cover with the echo after it, nor across a restart', () => {
    const { check } = run(wav('echo-local.wav').subarray(0, 3_200 * 30));

    // 3 s captured: the reply played from 0.5 s to 2.85 s, and its echo may come until 3.85 s.
    expect(check.measure(PLAY_START, PLAY_START + CLIP_MS)).toBeNull();
    expect(check.measure(PLAY_START, PLAY_START + 1_000)).not.toBeNull();
    check.restart();
    expect(check.measure(PLAY_START, PLAY_START + 1_000)).toBeNull();
    expect(check.readyAt(2_000)).toBe(3_200);
  });

  it('calls too little played audio unclear', () => {
    expect(run(wav('echo-local.wav'), PLAYED.subarray(0, 48 * 600)).measure).toMatchObject({ verdict: 'unclear' });
  });
});

describe('judgeEcho', () => {
  it('reports the delay of the best match from the first delay searched', () => {
    const played = new Float32Array(300).map((_, index) => (Math.floor(index / 20) % 2 === 0 ? 0.1 : 0.001));
    const capture = new Float32Array(400).fill(0.001);

    capture.set(played.map((value) => value * 0.3), 37);
    expect(judgeEcho(played, capture, -5)).toMatchObject({ verdict: 'echo', r: 1, lagMs: 320, activeSeconds: 1.6 });
  });
});
