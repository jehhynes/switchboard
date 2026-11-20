import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASR_RATE, sherpaRecognizer } from './asr.js';
import { decibriCapture, decibriOutput } from './decibri.js';
import { windowsCapture, withFallback } from './windowsCapture.js';
import { Dictation } from './dictation.js';
import { writeHotwords } from './hotwords.js';
import { watchLock } from './lockWatch.js';
import { watchMicUse } from './micUse.js';
import { TURN_MODEL, turnModel } from './turn.js';
import { Vocabulary } from './vocabulary.js';
import { PROTOCOL } from './protocol.js';
import { parseVoiceRecord, voiceLockAddress, voiceRecordPath } from './record.js';
import { VoiceServer } from './server.js';
import { VoiceService } from './service.js';
import { readKey, SAMPLE_RATE, Tts } from './tts.js';
import { SPEAKER_MODEL, sherpaEmbedder, Voiceprint } from './voiceprint.js';
import { gpuCheck, SherpaRuntime } from './sherpa.js';

/** How long the voice process stays up with no hub connected; the hub stops it sooner when the demand ends. */
const IDLE_EXIT_MS = 10 * 60_000;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;

  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function listen(address: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());

    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen(address, () => resolve(server));
  });
}

function answers(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(address, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => resolve(false));
  });
}

/** Holds the single-instance lock, or null when another live voice process holds it. */
async function holdLock(home: string): Promise<Server | null> {
  const address = voiceLockAddress(home);
  const held = await listen(address);

  if (held !== null || process.platform === 'win32') {
    return held;
  }

  // A socket file outlives a crashed process; remove it only when nothing answers on it.
  if (await answers(address)) {
    return null;
  }

  rmSync(address, { force: true });

  return listen(address);
}

/** Removes the record only while it is this process's, so a successor's record stays. */
function removeRecord(home: string): void {
  try {
    if (parseVoiceRecord(readFileSync(voiceRecordPath(home), 'utf8'))?.pid === process.pid) {
      rmSync(voiceRecordPath(home), { force: true });
    }
  } catch {
    // No record to remove.
  }
}

async function main(): Promise<void> {
  const home = option('home');

  if (home === undefined || home === '') {
    console.error('Usage: voice.js --home=<Switchboard home> [--build=<build>]');
    process.exit(2);
  }

  mkdirSync(home, { recursive: true });

  const lock = await holdLock(home);

  if (lock === null) {
    log('Another voice process holds the lock of this home; exiting.');
    process.exit(0);
  }

  const build = option('build') ?? 'dev';
  const token = randomBytes(32).toString('hex');
  const tts = new Tts({ key: () => readKey() });
  // Models, terms, the glossary and hotword files live in <home>/voice (architecture.md § Dictation); the scripts beside this one.
  const voiceHome = join(home, 'voice');
  const scripts = dirname(process.argv[1]!);
  const vocabulary = new Vocabulary(voiceHome, Date.now, log);
  const decibri = await decibriCapture(ASR_RATE, SAMPLE_RATE);
  // On Windows, Windows' own echo cancellation in communications mode; decibri's canceller when its helper fails (mechanics.md M94).
  const capture =
    process.platform === 'win32' ? withFallback(windowsCapture({ script: join(scripts, 'commcapture.ps1'), speakers: () => service.settings.outputDevice, log }), decibri, log, "decibri with its tau echo canceller") : decibri;
  // sherpa-onnx's build, CUDA or CPU, is chosen when recognition or the voice check first loads, and both use it (architecture.md § Dictation).
  const sherpa = new SherpaRuntime({ models: join(voiceHome, 'models'), requireFrom: process.argv[1]!, check: gpuCheck(join(scripts, 'gpucheck.js')), log });
  // The speaker model loads at its first use, the first piece or enrolment.
  const voiceprint = new Voiceprint({ dir: voiceHome, embedder: () => sherpaEmbedder(join(voiceHome, 'models', SPEAKER_MODEL), sherpa), log });
  const service: VoiceService = new VoiceService({
    tts,
    output: await decibriOutput(SAMPLE_RATE),
    send: (message) => server.send(message),
    heard: (heard, meant) => void vocabulary.heard(heard, meant),
    watchLock: (changed) => watchLock({ script: join(scripts, 'lockwatch.ps1'), changed, log }),
    voiceprint,
    dictation: (hooks) =>
      new Dictation({
        capture,
        recognizer: (terms) => sherpaRecognizer(sherpa, (modelDir) => writeHotwords(voiceHome, modelDir, terms), log),
        vocabulary,
        turn: turnModel(join(voiceHome, 'models', TURN_MODEL), join(scripts, 'turn.js'), log),
        watchMicUse: (changed, failed) => watchMicUse({ script: join(scripts, 'micuse.ps1'), changed, failed, log }),
        settings: () => service.settings,
        voiceprint,
        send: hooks.send,
        playing: hooks.playing,
        playedUntil: hooks.playedUntil,
        interrupt: hooks.interrupt,
        changed: hooks.changed,
        spoke: hooks.spoke,
        newId: () => randomUUID(),
        now: Date.now,
        log,
      }),
    now: Date.now,
    log,
  });
  let idle: NodeJS.Timeout | null = null;
  let exiting = false;
  const exit = async (reason: string): Promise<void> => {
    if (exiting) {
      return;
    }

    exiting = true;
    log(`Exiting: ${reason}`);
    service.close();
    removeRecord(home);
    await server.close();
    lock.close();
    process.exit(0);
  };
  const server: VoiceServer = new VoiceServer({
    token,
    build,
    greeting: () => service.greeting(),
    receive: (message) => service.receive(message),
    shutdown: () => void exit('the hub asked it to stop'),
    connected: (connected) => {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }

      if (!connected) {
        idle = setTimeout(() => void exit('no hub connected for the idle time'), IDLE_EXIT_MS);
      }
    },
    log,
  });
  const port = await server.listen();
  const path = voiceRecordPath(home);

  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ protocol: PROTOCOL, build, port, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  renameSync(`${path}.${process.pid}.tmp`, path);
  idle = setTimeout(() => void exit('no hub connected for the idle time'), IDLE_EXIT_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void exit(`it received ${signal}`));
  }

  log(`Listening on 127.0.0.1:${port} for ${home} (protocol ${PROTOCOL}, Node.js ${process.version}).`);
}

process.on('uncaughtException', (error) => log(`Unexpected error: ${error.stack ?? error.message}`));
process.on('unhandledRejection', (error) => log(`Unexpected rejection: ${String(error)}`));

main().catch((error: unknown) => {
  log(`The voice process could not start: ${(error as Error).stack ?? String(error)}`);
  process.exit(1);
});
