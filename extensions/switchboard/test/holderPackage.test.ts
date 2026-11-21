import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Attachment, HolderClient, parseHolderRecord, recordPath } from '@switchboard/holder';
import type { HolderRecord } from '@switchboard/holder';
import { parseVoiceRecord, VoiceClient, voiceRecordPath } from '@switchboard/voice';
import type { VoiceMessage } from '@switchboard/voice';

// The packaged extension, extracted outside the checkout so no node_modules of the repository can be reached; npm run build writes dist.
const EXTENSION = join(import.meta.dirname, '..');
let root: string;
let extracted: string;
const children: Array<{ pid: number; exited: Promise<unknown> }> = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'holder-package-'));

  const vsix = join(root, 'switchboard.vsix');

  execFileSync(process.execPath, [join(EXTENSION, '..', '..', 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', vsix], { cwd: EXTENSION, stdio: 'ignore' });
  extracted = join(root, 'vsix');
  mkdirSync(extracted);

  if (process.platform === 'win32') {
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', vsix, '-C', extracted]);
  } else {
    execFileSync('unzip', ['-q', vsix, '-d', extracted]);
  }
}, 120_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(child.pid);
    } catch {
      // Gone.
    }

    await child.exited;
  }
});

afterAll(() => {
  // Windows releases a loaded native module's file a moment after its process exits.
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const holderDir = (): string => join(extracted, 'extension', 'dist', 'holder');

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(process.execPath, [file, ...args], { stdio: 'ignore', windowsHide: true, env });

  children.push({ pid: child.pid!, exited: new Promise((resolve) => child.once('exit', resolve)) });
}

async function until<T>(read: () => T | null, what: string): Promise<T> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const found = read();

    if (found !== null) {
      return found;
    }
  }

  throw new Error(`No ${what}.`);
}

function holderRecord(home: string): HolderRecord | null {
  return existsSync(recordPath(home)) ? parseHolderRecord(readFileSync(recordPath(home), 'utf8')) : null;
}

const program = {
  label: 'item',
  file: process.execPath,
  args: ['-e', "let last = ''; setInterval(() => { process.stdout._refreshSize?.(); const size = process.stdout.columns + 'x' + process.stdout.rows; if (size !== last) { last = size; process.stdout.write('pty ok ' + size + '\\n'); } }, 100)"],
  cwd: tmpdir(),
  env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
  cols: 90,
  rows: 20,
};

describe('the packaged terminal holder', () => {
  it('carries every file its manifest lists, with the build hash of their contents', () => {
    const manifest = JSON.parse(readFileSync(join(holderDir(), 'manifest.json'), 'utf8')) as { build: string; files: string[] };
    const hash = createHash('sha256');

    for (const file of manifest.files) {
      hash.update(file).update('\0').update(readFileSync(join(holderDir(), file))).update('\0');
    }

    expect(hash.digest('hex').slice(0, 16)).toBe(manifest.build);
    expect(manifest.files).toContain('holder.js');
    expect(manifest.files).toContain('node_modules/node-pty/package.json');
    expect(manifest.files).toContain('node_modules/node-pty/lib/index.js');
    expect(manifest.files.some((file) => file.endsWith('.node'))).toBe(true);
    expect(manifest.files.some((file) => file.endsWith('.test.js') || file.endsWith('.pdb'))).toBe(false);

    if (process.platform === 'win32') {
      expect(manifest.files).toContain('node_modules/node-pty/lib/worker/conoutSocketWorker.js');
      expect(manifest.files).toContain('node_modules/node-pty/lib/conpty_console_list_agent.js');
    }
  });

  it('spawns, resizes and kills a pseudo-terminal', async () => {
    const home = join(root, 'home-spawn');

    run(join(holderDir(), 'holder.js'), [`--home=${home}`, '--build=package-test']);

    const record = await until(() => holderRecord(home), 'holder record');
    const client = await HolderClient.connect({ port: record.port, token: record.token });
    const shows = async (text: string): Promise<void> => {
      for (const deadline = Date.now() + 10_000; !(await client.screen('s1')).head.includes(text); await new Promise((resolve) => setTimeout(resolve, 100))) {
        expect(Date.now()).toBeLessThan(deadline);
      }
    };

    await client.spawn({ session: 's1', ...program });
    await shows('pty ok 90x20');

    // Attaching at another size resizes the pseudo-terminal.
    const attachment = await Attachment.open({ port: record.port, token: record.token, session: 's1', cols: 132, rows: 40, onData: () => undefined });

    await shows('pty ok 132x40');
    attachment.close();
    expect(await client.kill('s1')).not.toBeUndefined();
    await client.shutdown();
    client.close();
  }, 30_000);

  it.runIf(process.platform === 'win32')('starts the hub and the holder without the native binary, and fails only a spawn, with the reason', async () => {
    for (const folder of ['prebuilds/win32-x64', 'build/Release']) {
      rmSync(join(holderDir(), 'node_modules', 'node-pty', folder, 'conpty.node'), { force: true });
    }

    const home = join(root, 'home-hub');

    mkdirSync(home);
    // As the hub spawn tests do: its own Claude and Codex homes, and a PATH with no real Claude or Codex.
    run(join(extracted, 'extension', 'dist', 'hub.js'), [`--home=${home}`, '--browser-port=0', '--page-port=0'], {
      ...process.env,
      PATH: [dirname(process.execPath), join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')].join(delimiter),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    });
    await until(() => (existsSync(join(home, '.switchboard', 'hub.json')) ? true : null), 'hub record');

    const holderHome = join(root, 'home-native');

    run(join(holderDir(), 'holder.js'), [`--home=${holderHome}`, '--build=package-test']);

    const record = await until(() => holderRecord(holderHome), 'holder record');
    const client = await HolderClient.connect({ port: record.port, token: record.token });

    await expect(client.spawn({ session: 's1', ...program })).rejects.toThrow(/could not be started: .*conpty\.node/);
    expect(await client.list()).toEqual([]);
    await client.shutdown();
    client.close();
  }, 30_000);
});

describe('the packaged voice process (architecture.md § Voice)', () => {
  const voiceDir = (): string => join(extracted, 'extension', 'dist', 'voice');

  it('carries every file its manifest lists, decibri and its binary included, with the build hash of their contents', () => {
    const manifest = JSON.parse(readFileSync(join(voiceDir(), 'manifest.json'), 'utf8')) as { build: string; files: string[] };
    const hash = createHash('sha256');

    for (const file of manifest.files) {
      hash.update(file).update('\0').update(readFileSync(join(voiceDir(), file))).update('\0');
    }

    expect(hash.digest('hex').slice(0, 16)).toBe(manifest.build);
    expect(manifest.files).toContain('voice.js');
    expect(manifest.files).toContain('node_modules/decibri/package.json');
    expect(manifest.files).toContain('node_modules/decibri/src/decibri-output.js');
    expect(manifest.files.some((file) => file.startsWith('node_modules/@decibri/') && file.endsWith('.node'))).toBe(true);
    expect(manifest.files.some((file) => file.includes('/browser/'))).toBe(false);
    // Dictation (architecture.md § Dictation): the turn model's process, the other-app watcher, recognition and onnxruntime for this platform only.
    expect(manifest.files).toContain('turn.js');
    // The GPU check sherpa-onnx's CUDA build runs before it loads; the CUDA build itself is machine data in <home>/voice/models.
    expect(manifest.files).toContain('gpucheck.js');
    expect(manifest.files.some((file) => file.includes('onnxruntime_providers_cuda'))).toBe(false);
    expect(manifest.files).toContain('micuse.ps1');
    expect(manifest.files).toContain('commcapture.ps1');
    expect(manifest.files).toContain('lockwatch.ps1');
    expect(manifest.files).toContain('node_modules/sherpa-onnx-node/package.json');
    expect(manifest.files.some((file) => /^node_modules\/sherpa-onnx-[a-z]+-[a-z0-9]+\/sherpa-onnx\.node$/.test(file))).toBe(true);
    expect(manifest.files.some((file) => file.startsWith(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/`) && file.endsWith('.node'))).toBe(true);
    expect(manifest.files.some((file) => file.startsWith('node_modules/onnxruntime-node/bin/') && !file.includes(`/${process.platform}/${process.arch}/`))).toBe(false);
    expect(manifest.files).toContain('node_modules/onnxruntime-common/package.json');
    // The turn process loads the model's tokenizer by name from beside it.
    expect(manifest.files).toContain('node_modules/@huggingface/tokenizers/package.json');
  });

  it('starts in a home, loads its playback, greets the hub that knows its token, and exits when asked', async () => {
    const home = join(root, 'home-voice');

    run(join(voiceDir(), 'voice.js'), [`--home=${home}`, '--build=package-test']);

    const record = await until(() => (existsSync(voiceRecordPath(home)) ? parseVoiceRecord(readFileSync(voiceRecordPath(home), 'utf8')) : null), 'voice record');

    await expect(VoiceClient.connect({ port: record.port, token: 'wrong' })).rejects.toThrow('The token is wrong.');

    const client = await VoiceClient.connect({ port: record.port, token: record.token });
    const messages: VoiceMessage[] = [];

    expect(client.welcome).toMatchObject({ protocol: 1, build: 'package-test', pid: record.pid });
    client.onMessage((message) => messages.push(message));
    await until(() => (messages.length >= 2 ? true : null), 'greeting');
    expect(messages).toEqual([
      { type: 'active', gen: 0, sessionId: null, reason: 'gone' },
      { type: 'audio', mic: 'off', engine: 'decibri', device: null, recognizer: null, error: null },
    ]);

    const closed = new Promise((resolve) => client.onClose(resolve));

    client.send({ type: 'shutdown' });
    await closed;
    await until(() => (existsSync(voiceRecordPath(home)) ? null : true), 'record removed');
  }, 30_000);
});
