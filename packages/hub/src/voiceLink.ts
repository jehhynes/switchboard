import type { LogLevel } from '@switchboard/core';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answers } from '@switchboard/core';
import { LOG_FILE, VoiceClient, parseVoiceRecord, voiceLockAddress, voiceRecordPath } from '@switchboard/voice';
import type { HubMessage, VoiceConnectOptions, VoiceMessage } from '@switchboard/voice';
import { currentHolderBuild, reserveHolderBuild, VOICE_INSTALL } from './holderInstall.js';

/** How long a started voice process may take to answer. */
export const VOICE_START_MS = 10_000;
const POLL_MS = 100;

/** The voice process calls the hub makes; `VoiceClient` provides them. */
export interface VoiceConnection {
  readonly welcome: { protocol: number; build: string; pid: number };
  readonly compatible: boolean;
  onMessage(listener: (message: VoiceMessage) => void): void;
  onClose(listener: (error: Error) => void): void;
  send(message: HubMessage): void;
  close(): void;
}

export interface VoiceLinkDeps {
  /** The Switchboard home, which holds `voice.json` and the installed builds. */
  home: string;
  /** Read at each start, so a change to `sessions.nodePath` applies to the next one. */
  nodePath(): string;
  log(line: string, level?: LogLevel): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  connect?(options: VoiceConnectOptions): Promise<VoiceConnection>;
  lockHeld?(): Promise<boolean>;
  /** The build installed in the home; `currentHolderBuild` of the voice by default. */
  build?(): string | null;
  reserve?(build: string): Promise<boolean>;
  /** Starts `<nodePath> <script> <args>` detached, with its output appended to the log file. */
  launch?(nodePath: string, args: string[], logPath: string): void;
}

/** The voice process's environment: the hub's without VS Code's runtime and window variables. */
function voiceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ELECTRON_|VSCODE_)/i.test(name) && name.toUpperCase() !== 'NODE_OPTIONS'));
}

function launchDetached(nodePath: string, args: string[], logPath: string): void {
  const log = openSync(logPath, 'a');

  try {
    const child = spawn(nodePath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: voiceEnvironment(process.env) });

    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * The hub's link to the voice process of its home (architecture.md § Voice), modelled on the terminal holder's: one connection, kept while it
 * lasts. `find` connects to the process `voice.json` names, starts one when none runs, and replaces one of another build, since the voice process
 * holds no state worth keeping.
 */
export class VoiceLink {
  #client: VoiceConnection | null = null;
  #finding: Promise<VoiceConnection | { error: string }> | null = null;

  constructor(private readonly deps: VoiceLinkDeps) {}

  get logPath(): string {
    return join(this.deps.home, LOG_FILE);
  }

  /** The process this link is connected to, without a lookup; null while none answered. */
  connected(): VoiceConnection | null {
    return this.#client;
  }

  /** Connects to the running voice process, starting or replacing it as needed. Concurrent calls share one lookup. */
  find(): Promise<VoiceConnection | { error: string }> {
    if (this.#client !== null) {
      return Promise.resolve(this.#client);
    }

    this.#finding ??= this.#find().finally(() => {
      this.#finding = null;
    });

    return this.#finding;
  }

  /** Asks the process to exit and closes the connection. */
  stop(): void {
    const client = this.#client;

    this.#client = null;
    client?.send({ type: 'shutdown' });
    client?.close();
  }

  /** Closes the connection; the process keeps running until it is idle. */
  close(): void {
    this.#client?.close();
    this.#client = null;
  }

  async #find(): Promise<VoiceConnection | { error: string }> {
    const build = (this.deps.build ?? (() => currentHolderBuild(this.deps.home, VOICE_INSTALL)))();
    const found = await this.#connect();

    if (found !== null && found.welcome.build === build && found.compatible) {
      return this.#keep(found);
    }

    if (found !== null) {
      this.deps.log(`voice process ${found.welcome.build} replaced by ${build ?? 'none'}`);
      found.send({ type: 'shutdown' });
      found.close();

      for (const until = this.deps.now() + VOICE_START_MS; await this.#lockHeld(); ) {
        if (this.deps.now() >= until) {
          return { error: `The voice process ${found.welcome.build} did not exit within ${VOICE_START_MS / 1000} seconds.` };
        }

        await this.deps.sleep(POLL_MS);
      }
    } else if (await this.#lockHeld()) {
      return { error: 'The voice process holds its lock but does not answer.' };
    }

    if (build === null || !(await (this.deps.reserve ?? ((one) => reserveHolderBuild(this.deps.home, one, VOICE_INSTALL)))(build))) {
      return { error: `The voice process is not installed in ${join(this.deps.home, 'voice')}; run hub.js install (npm run install-local) to install it.` };
    }

    try {
      (this.deps.launch ?? launchDetached)(this.deps.nodePath(), [join(this.deps.home, 'voice', build, 'voice.js'), `--home=${this.deps.home}`, `--build=${build}`], this.logPath);
    } catch (error) {
      return { error: `The voice process could not start: ${(error as Error).message} Log: ${this.logPath}` };
    }

    this.deps.log(`started the voice process ${build}`);

    for (const until = this.deps.now() + VOICE_START_MS; this.deps.now() < until; ) {
      await this.deps.sleep(POLL_MS);

      const started = await this.#connect();

      if (started !== null) {
        return this.#keep(started);
      }
    }

    return { error: `The voice process did not start within ${VOICE_START_MS / 1000} seconds. Log: ${this.logPath}` };
  }

  #keep(client: VoiceConnection): VoiceConnection {
    this.#client = client;
    client.onClose(() => {
      if (this.#client === client) {
        this.#client = null;
      }
    });

    return client;
  }

  /** A connection to the process the record names, or null when none answers as that process. */
  async #connect(): Promise<VoiceConnection | null> {
    let record;

    try {
      record = parseVoiceRecord(readFileSync(voiceRecordPath(this.deps.home), 'utf8'));
    } catch {
      return null;
    }

    if (record === null) {
      return null;
    }

    try {
      const client = await (this.deps.connect ?? VoiceClient.connect)({ port: record.port, token: record.token });

      // A record left by a process that exited by force can name a port another process now uses.
      if (client.welcome.pid === record.pid) {
        return client;
      }

      client.close();
    } catch {
      // Not answering; the lock decides whether it is gone.
    }

    return null;
  }

  #lockHeld(): Promise<boolean> {
    return this.deps.lockHeld?.() ?? answers(voiceLockAddress(this.deps.home));
  }
}
