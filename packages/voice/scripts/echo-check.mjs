// Acoustic echo check for dictation (voice-design § 11.6, decision 6). Plays a speech clip ALOUD through the default speakers while the
// default mic captures, four runs with one mic open at a time. The cancelled runs capture through commcapture.ps1, as the voice process does
// on Windows, in Windows' communications
// mode, where Windows cancels the echo of what its speakers play (--canceller=windows, the default), or through decibri with its tau
// canceller fed the clip (--canceller=tau):
//   1. raw, you silent          2. echo-cancelled, you silent
//   3. echo-cancelled, you talk 4. raw, you talk
// With tau, the clip goes to the canceller through the voice process's own PlayedReference, as it plays rather than as the speaker takes it
// (decibri's Speaker takes about 3.3 s ahead). Each run's capture is saved as a
// 16 kHz WAV in the output folder, with the canceller's metrics, so it can be listened to. The recogniser then reads each capture.
// PASS: run 1 hears most of the played words; run 2 keeps at most a tenth of them and is at least 6 dB quieter; run 3 keeps at least 3 of
// your 5 words. A short capture or a run 1 that heard too little gives no verdict.
//
// The verdict is the acceptance check for dictation's capture (mechanics.md M94). Build the voice package first, then run from the repository root with speakers (not headphones) at a normal volume:
//   npm run build --workspace @switchboard/voice
//   node packages/voice/scripts/echo-check.mjs [--canceller=windows|tau] [--clip=<24 kHz mono WAV>] [--model=<int8 Nemotron folder>] [--out=<folder>] [--rounds=3]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const voiceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(voiceRoot, 'package.json'));
const { PlayedReference } = await import(pathToFileURL(join(voiceRoot, 'dist', 'reference.js')).href);
const arg = (name, fallback) => process.argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const clipPath = arg('clip', 'D:/git/claude-collab/.wip/expr-plain.wav');
const modelDir = arg('model', 'D:/git/claude-collab/.wip/models/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25');
const outDir = arg('out', join(tmpdir(), `switchboard-echo-check-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const rounds = Number(arg('rounds', '3'));
// windows: the mic in communications mode through commcapture.ps1, so Windows cancels the echo itself; tau: decibri's canceller fed the clip.
const canceller = arg('canceller', 'windows');
const { Microphone, Speaker } = require('decibri');
const sherpa = require('sherpa-onnx-node');

const RATE = 16000;
const PLAY_RATE = 24000;
const SENTENCE = 'the quick brown fox jumps over the lazy dog';
const YOURS = ['quick', 'brown', 'fox', 'lazy', 'dog'];
const clip = sherpa.readWave(clipPath);

if (clip.sampleRate !== PLAY_RATE) {
  throw new Error(`The clip must be 24 kHz mono; it is ${clip.sampleRate} Hz.`);
}

const pcm24 = Buffer.alloc(clip.samples.length * 2);

clip.samples.forEach((sample, index) => pcm24.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), index * 2));
mkdirSync(outDir, { recursive: true });

const file = (name) => join(modelDir, name);
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: { transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') }, tokens: file('tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 },
  decodingMethod: 'modified_beam_search',
  maxActivePaths: 4,
});
const toFloat = (pcm) => {
  const samples = new Float32Array(pcm.length / 2);

  for (let index = 0; index < samples.length; index++) samples[index] = pcm.readInt16LE(index * 2) / 32768;
  return samples;
};
const recognise = (pcm, sampleRate) => {
  const stream = recognizer.createStream();

  stream.acceptWaveform({ sampleRate, samples: toFloat(pcm) });
  // Trailing silence lets the last words out of the streaming model.
  stream.acceptWaveform({ sampleRate, samples: new Float32Array(sampleRate) });
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
};
const rms = (pcm) => {
  let sum = 0;

  for (let index = 0; index < pcm.length; index += 2) sum += (pcm.readInt16LE(index) / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length / 2));
};
const wav = (pcm, sampleRate) => {
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
const words = (text) => text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The mic in communications mode through commcapture.ps1: resolves once it records, with the header Windows reported. `stop` closes its stdin
 * and resolves after its stdout has closed, with why the capture cannot be trusted (an error, an abnormal exit or lost audio), or null.
 */
function windowsMic(heard) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(voiceRoot, 'assets', 'commcapture.ps1')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let pending = '';
  let problem = null;
  let started = null;
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));

  child.stdout.on('data', (chunk) => heard.push(chunk));
  child.stdin.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    const fail = (why) => {
      problem ??= why;

      if (started === null) {
        reject(new Error(why));
      }
    };

    child.on('error', (error) => fail(`commcapture.ps1 did not run: ${error.message}`));
    child.stderr.on('data', (chunk) => {
      pending += chunk;

      const parts = pending.split(/\r?\n/);

      pending = parts.pop();

      for (const line of parts.filter((one) => one.trim() !== '')) {
        let message;

        try {
          message = JSON.parse(line);
        } catch {
          fail(`commcapture.ps1 wrote: ${line}`);
          continue;
        }

        lines.push(message);

        if (message.error !== undefined) {
          fail(message.error);
        } else if (message.discontinuities > 0) {
          fail(`the capture lost audio ${message.discontinuities} times`);
        } else if (started === null && message.device !== undefined) {
          started = message;
          resolve({
            header: message,
            stop: async () => {
              child.stdin.end();

              const code = await closed;

              if (code !== 0) {
                problem ??= `commcapture.ps1 exited ${code}`;
              }

              if (!lines.some((one) => one.discontinuities !== undefined)) {
                problem ??= 'commcapture.ps1 did not report its discontinuities';
              }

              return problem;
            },
          });
        }
      }
    });
    void closed.then((code) => {
      if (started === null) {
        fail(`commcapture.ps1 exited ${code} before recording`);
      }
    });
  });
}

async function run(name, title, cancel) {
  console.log(`\n== ${title}`);

  // One mic open at a time: two streams on one device, as over Remote Desktop's "Remote Audio", may not each get the whole signal.
  const heard = [];
  const windows = cancel && canceller === 'windows' ? await windowsMic(heard) : null;
  const tau = cancel && windows === null;
  const mic = windows !== null ? null : await Microphone.open({ sampleRate: RATE, channels: 1, dtype: 'int16', framesPerBuffer: RATE / 10, ...(tau ? { aec: { model: 'tau', referenceSampleRate: PLAY_RATE } } : {}) });
  let lead = 0;

  if (windows !== null) {
    console.log(`Windows capture: ${JSON.stringify(windows.header)}`);
  }

  mic?.on('data', (chunk) => heard.push(chunk));
  await sleep(500);

  const speaker = await Speaker.open({ sampleRate: PLAY_RATE, channels: 1, dtype: 'int16' });
  const startedAt = Date.now();
  let pushed = 0;
  const reference = new PlayedReference({
    push: (pcm) => {
      mic.pushAecReference(pcm);
      pushed += pcm.length;
      lead = Math.max(lead, pushed / (PLAY_RATE * 2 / 1000) - (Date.now() - startedAt));
    },
    now: () => Date.now(),
  });

  for (let round = 0; round < rounds; round++) {
    for (let at = 0; at < pcm24.length; at += 4800) {
      const chunk = pcm24.subarray(at, at + 4800);

      if (tau) {
        reference.written(chunk);
      }

      await speaker.writeAsync(chunk);
    }
  }

  await speaker.drainAsync();
  speaker.stop();
  reference.stop();
  await sleep(800);

  const metrics = tau ? mic.aecMetrics() : windows?.header ?? null;

  mic?.stop();

  const invalid = (await windows?.stop()) ?? null;

  if (invalid !== null) {
    console.log(`This capture cannot be trusted: ${invalid}`);
  }

  // A trailing odd byte from the pipe is half a sample.
  const all = Buffer.concat(heard);
  const pcm = all.subarray(0, all.length - (all.length % 2));
  const text = recognise(pcm, RATE);
  const path = join(outDir, `${name}.wav`);

  writeFileSync(path, wav(pcm, RATE));

  if (tau) {
    console.log(`canceller metrics: ${JSON.stringify(metrics)}`);
    console.log(`reference ran at most ${Math.round(lead)} ms ahead of the playback clock`);
  }

  const seconds = pcm.length / 2 / RATE;

  console.log(`${seconds.toFixed(1)} s captured, level ${rms(pcm).toFixed(4)}, saved ${path}`);
  console.log(`heard: "${text}"`);
  return { text, level: rms(pcm), seconds, metrics, invalid };
}

if (canceller !== 'windows' && canceller !== 'tau') {
  throw new Error(`--canceller must be windows or tau; it is ${canceller}.`);
}

console.log(`Captures go to ${outDir}; the cancelled runs use ${canceller === 'windows' ? "Windows' own echo cancellation (communications mode)" : "decibri's tau canceller"}.`);

const playedText = recognise(pcm24, PLAY_RATE);
const played = new Set(words(playedText));

console.log(`The clip says: "${playedText}"`);
console.log(`Playing ${clipPath} ${rounds} times per run through the default speakers. Stay silent for runs 1 and 2.`);

const rawSilent = await run('1-raw-silent', 'Run 1: raw, speech played aloud, you silent', false);
const cancelledSilent = await run('2-cancelled-silent', 'Run 2: echo-cancelled, speech played aloud, you silent', true);

console.log(`\nRuns 3 and 4 start in 3 seconds: while the speech plays, read this sentence aloud, twice if there is time: "${SENTENCE}".`);
await sleep(3000);

const cancelledTalk = await run('3-cancelled-talk', 'Run 3: echo-cancelled, speech played aloud while you talk', true);

console.log('\nRun 4 starts in 3 seconds: read the sentence aloud again while the speech plays.');
await sleep(3000);

const rawTalk = await run('4-raw-talk', 'Run 4: raw, speech played aloud while you talk', false);
const reduction = 20 * Math.log10(rawSilent.level / Math.max(1e-9, cancelledSilent.level));
const heardRaw = words(rawSilent.text).filter((word) => played.has(word));
const leaked = words(cancelledSilent.text).filter((word) => played.has(word));
// Only the sentence's words the clip does not say count as yours.
const yours = (run) => YOURS.filter((word) => !played.has(word) && words(run.text).includes(word));
const playedSeconds = (rounds * pcm24.length) / 2 / PLAY_RATE;
const short = [rawSilent, cancelledSilent, cancelledTalk, rawTalk].some((one) => one.seconds < playedSeconds * 0.9);
const invalid = [rawSilent, cancelledSilent, cancelledTalk, rawTalk].find((one) => one.invalid !== null)?.invalid ?? null;
// The raw run must hear most of what was played, so a quiet cancelled run means cancelling rather than a capture that heard nothing.
const control = new Set(heardRaw).size >= played.size / 2;
const passed = leaked.length <= Math.max(1, Math.floor(heardRaw.length / 10)) && reduction >= 6 && yours(cancelledTalk).length >= 3;
const summary = [
  `played words the raw capture heard (run 1): ${heardRaw.length}, ${new Set(heardRaw).size} of ${played.size} distinct`,
  `played words left after cancelling (run 2): ${leaked.length} of ${played.size} distinct (${leaked.join(' ') || 'none'})`,
  `level reduction, run 1 to run 2: ${reduction.toFixed(1)} dB`,
  `your words heard while speech played: cancelled ${yours(cancelledTalk).length} of 5 (${yours(cancelledTalk).join(' ') || 'none'}), raw ${yours(rawTalk).length} of 5 (${yours(rawTalk).join(' ') || 'none'})`,
  invalid !== null
    ? `NO VERDICT: a capture cannot be trusted: ${invalid}.`
    : short
    ? `NO VERDICT: a capture is shorter than the ${playedSeconds.toFixed(1)} s played; the mic dropped audio.`
    : !control
      ? 'NO VERDICT: the raw capture did not hear most of the played speech; turn the speakers up or check the default devices.'
      : passed
        ? 'PASS: the canceller takes the played speech out (at least 6 dB quieter) and keeps yours.'
        : 'FAIL: dictation should not ship on this capture path (voice-design § 11.6).',
];

writeFileSync(
  join(outDir, 'result.json'),
  JSON.stringify({ clip: clipPath, canceller, playedText, runs: { rawSilent, cancelledSilent, cancelledTalk, rawTalk }, reduction, summary }, null, 2),
);
console.log('\n== Verdict');
summary.forEach((line) => console.log(line));
console.log(`WAVs and result.json in ${outDir}`);
process.exit(0);
