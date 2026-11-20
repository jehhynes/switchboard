import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubMessage, VoiceConnectOptions, VoiceMessage } from '@switchboard/voice';
import { VOICE_START_MS, VoiceLink } from '../src/voiceLink.js';
import type { VoiceConnection, VoiceLinkDeps } from '../src/voiceLink.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class Process implements VoiceConnection {
  readonly sent: HubMessage[] = [];
  closed = false;
  #close: (error: Error) => void = () => undefined;

  constructor(readonly welcome: { protocol: number; build: string; pid: number }) {}

  get compatible(): boolean {
    return this.welcome.protocol === 1;
  }

  onMessage(_listener: (message: VoiceMessage) => void): void {}

  onClose(listener: (error: Error) => void): void {
    this.#close = listener;
  }

  send(message: HubMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  drop(): void {
    this.#close(new Error('gone'));
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'voice-link-'));
  let t = 0;
  const launched: string[][] = [];
  const logs: string[] = [];
  const state = { lock: false, running: null as Process | null, build: 'b2' as string | null, reserved: true, onLaunch: (_args: string[]) => undefined as void };
  const record = (pid: number) => writeFileSync(join(home, 'voice.json'), JSON.stringify({ protocol: 1, build: 'x', port: 5000, token: 't', pid, startedAt: 'now' }));
  const deps: VoiceLinkDeps = {
    home,
    nodePath: () => 'node',
    log: (line) => logs.push(line),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    connect: async (_options: VoiceConnectOptions) => {
      if (state.running === null) {
        throw new Error('refused');
      }

      return state.running;
    },
    lockHeld: async () => state.lock,
    build: () => state.build,
    reserve: async () => state.reserved,
    launch: (nodePath, args, logPath) => {
      launched.push([nodePath, ...args, logPath]);
      state.onLaunch(args);
    },
  };

  dirs.push(home);

  return { home, deps, link: new VoiceLink(deps), launched, logs, state, record };
}

describe('VoiceLink', () => {
  it('starts the installed build when none runs and connects to it, sharing one lookup', async () => {
    const { home, link, launched, state, record } = setup();

    state.onLaunch = () => {
      record(42);
      state.running = new Process({ protocol: 1, build: 'b2', pid: 42 });
    };

    const [one, two] = await Promise.all([link.find(), link.find()]);

    expect(one).toBe(two);
    expect(launched).toEqual([['node', join(home, 'voice', 'b2', 'voice.js'), `--home=${home}`, '--build=b2', join(home, 'voice.log')]]);
    expect(link.connected()).toBe(one);
    expect(await link.find()).toBe(one);

    (one as Process).drop();
    expect(link.connected()).toBeNull();
  });

  it('keeps a running process of the same build, and replaces one of another build or protocol', async () => {
    const { link, launched, state, record } = setup();

    record(7);
    state.running = new Process({ protocol: 1, build: 'b2', pid: 7 });
    expect(await link.find()).toBe(state.running);
    expect(launched).toEqual([]);
    link.close();
    expect(link.connected()).toBeNull();

    const old = new Process({ protocol: 1, build: 'b1', pid: 7 });

    state.running = old;
    state.onLaunch = () => {
      record(8);
      state.running = new Process({ protocol: 1, build: 'b2', pid: 8 });
    };

    const found = await link.find();

    expect(old.sent).toEqual([{ type: 'shutdown' }]);
    expect(old.closed).toBe(true);
    expect((found as Process).welcome.pid).toBe(8);
    link.stop();
    expect((found as Process).sent).toEqual([{ type: 'shutdown' }]);
  });

  it('says why it cannot run: a process holding its lock without answering, no build installed, or one that never answers', async () => {
    const held = setup();

    held.state.lock = true;
    expect(await held.link.find()).toEqual({ error: 'The voice process holds its lock but does not answer.' });

    const missing = setup();

    missing.state.build = null;
    expect(await missing.link.find()).toEqual({ error: `The voice process is not installed in ${join(missing.home, 'voice')}; reload a VS Code window to install it.` });

    const silent = setup();

    expect(await silent.link.find()).toEqual({ error: `The voice process did not start within ${VOICE_START_MS / 1000} seconds. Log: ${join(silent.home, 'voice.log')}` });

    const broken = setup();

    broken.deps.launch = () => {
      throw new Error('spawn failed');
    };
    expect(await new VoiceLink(broken.deps).find()).toEqual({ error: `The voice process could not start: spawn failed Log: ${join(broken.home, 'voice.log')}` });

    // A record whose port another process answers is not the voice process.
    const reused = setup();

    reused.record(5);
    reused.state.running = new Process({ protocol: 1, build: 'b2', pid: 6 });
    reused.state.lock = true;
    expect(await reused.link.find()).toEqual({ error: 'The voice process holds its lock but does not answer.' });
    expect(reused.state.running.closed).toBe(true);

    const stuck = setup();

    stuck.record(7);
    stuck.state.running = new Process({ protocol: 1, build: 'b1', pid: 7 });
    stuck.state.lock = true;
    expect(await stuck.link.find()).toEqual({ error: `The voice process b1 did not exit within ${VOICE_START_MS / 1000} seconds.` });
  });
});
