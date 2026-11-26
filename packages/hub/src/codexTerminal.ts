import { join } from 'node:path';
import { claudeFile } from '@switchboard/claude';
import type { HolderLookup } from '@switchboard/claude';
import type { Session } from '@switchboard/core';
import { cliEnvironment, executableDirOnPath } from '@switchboard/core';

/** The size a Codex terminal starts at; the first console that types resizes it to its own. */
const COLS = 120;
const ROWS = 40;

export const NO_FIRST_TURN = "The console opens once the session has had its first message: Codex keeps no record of a thread before its first turn, so its terminal cannot join it yet.";

export interface CodexTerminalsDeps {
  /** The running holder; with `start`, one is started when none runs. */
  holder(start: boolean): Promise<HolderLookup>;
  session(id: string): Session | null;
  /** The label the holder lists the terminal under: the session's name and its thread, as a Code Mode session's name and Claude ID. */
  label(session: Session): string;
  /** Read at each start, so a change to `sessions.codexPath` applies to the next terminal. */
  codexPath(): string;
  codexHome: string;
  /** Variables for every Codex process besides `CODEX_HOME`. */
  env: Record<string, string>;
  /** Whether the thread has a turn, which a terminal needs to join it (mechanics M108). */
  hasTurns(session: Session): Promise<boolean>;
  /** Whether an end of the session is running now, which a start waits for. */
  ending(sessionId: string): Promise<void> | undefined;
  log(line: string): void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The control socket of the daemon in a Codex home, as `codex resume --remote` names it. */
export function controlSocket(codexHome: string): string {
  return `unix://${join(codexHome, 'app-server-control', 'app-server-control.sock').replaceAll('\\', '/')}`;
}

/** Why a session can have no Codex terminal, or null: only a live app-server session with a thread can. */
export function noCodexTerminal(session: Session): string | null {
  if (session.execution !== 'app-server' || session.nativeSessionId === null) {
    return 'This session has no Codex thread.';
  }

  return session.state === 'ended' || session.released || session.releasing ? 'The session has ended. Resume continues it.' : null;
}

/**
 * Codex's own terminal app held in the terminal holder for an app-server session (architecture.md § Codex runner), started the first time a
 * console asks for it and ended with the session: `codex resume --no-alt-screen --remote <control socket> <thread>`, a second client of the
 * thread the hub drives, under the Switchboard session ID. A start and an end of one session run one at a time, in the order asked.
 */
export class CodexTerminals {
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Sessions whose terminal an end could not end, so a later holder read ends it again even when the session's row is gone, as after Delete. */
  readonly #unended = new Set<string>();

  constructor(private readonly deps: CodexTerminalsDeps) {}

  /** Makes sure the holder holds a live terminal of the session, starting one when it holds none or only an exited one; rejects with why not. */
  async ensure(sessionId: string): Promise<void> {
    // A Stop, release or Delete still running ends the session, so no terminal starts for it. Waited for outside the queue, since the end itself
    // queues behind a start; an end asked for after this is queued after the start and ends what it started.
    for (let end = this.deps.ending(sessionId); end !== undefined; end = this.deps.ending(sessionId)) {
      await end.catch(() => undefined);
    }

    return this.#queued(sessionId, () => this.#ensure(sessionId));
  }

  /** Whether an end of the session's terminal failed and none has succeeded since. */
  unended(sessionId: string): boolean {
    return this.#unended.has(sessionId);
  }

  /** Ends the session's terminal, if the holder holds one; a holder that is gone or does not hold it has nothing to end. */
  end(sessionId: string): Promise<void> {
    return this.#queued(sessionId, () => this.#end(sessionId));
  }

  #queued<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(sessionId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(sessionId, settled);
    void settled.then(() => {
      if (this.#queues.get(sessionId) === settled) {
        this.#queues.delete(sessionId);
      }
    });

    return run;
  }

  async #ensure(sessionId: string): Promise<void> {
    const session = this.deps.session(sessionId);
    const why = session === null ? 'The session is gone.' : noCodexTerminal(session);

    if (why !== null) {
      throw new Error(why);
    }

    const found = await this.deps.holder(true);

    if (!('holder' in found)) {
      throw new Error('error' in found ? found.error : 'The terminal holder did not start.');
    }

    if ((await found.holder.list()).some((entry) => entry.session === sessionId && entry.exitedAt === null)) {
      return;
    }

    if (!(await this.deps.hasTurns(session!))) {
      throw new Error(NO_FIRST_TURN);
    }

    const codexPath = this.deps.codexPath();
    const env = cliEnvironment(this.deps.environment ?? process.env);

    await found.holder.spawn({
      session: sessionId,
      label: this.deps.label(session!),
      file: claudeFile(codexPath, this.deps.platform),
      args: ['resume', '--no-alt-screen', '--remote', controlSocket(this.deps.codexHome), session!.nativeSessionId!],
      cwd: session!.cwd,
      env: { ...(env as Record<string, string>), ...this.deps.env, ...executableDirOnPath(codexPath, env, this.deps.platform), CODEX_HOME: this.deps.codexHome, TERM: 'xterm-256color' },
      cols: COLS,
      rows: ROWS,
    });
    this.deps.log(`session ${sessionId}: started its Codex terminal in the terminal holder`);

    // An end that the session's state asked for while the spawn ran found no terminal, so this one is ended here.
    const after = this.deps.session(sessionId);

    if (after === null || noCodexTerminal(after) !== null || after.launchId !== session!.launchId) {
      await this.#end(sessionId);
      throw new Error(after === null ? 'The session is gone.' : (noCodexTerminal(after) ?? 'The session was resumed; open the console again.'));
    }
  }

  async #end(sessionId: string): Promise<void> {
    const found = await this.deps.holder(false);

    if (!('holder' in found)) {
      if ('error' in found) {
        this.#unended.add(sessionId);
        this.deps.log(`session ${sessionId}: its Codex terminal may still run: ${found.error}`);
      } else {
        this.#unended.delete(sessionId);
      }

      return;
    }

    try {
      const live = (await found.holder.list()).some((entry) => entry.session === sessionId && entry.exitedAt === null);

      if (live) {
        await found.holder.kill(sessionId);
        this.deps.log(`session ${sessionId}: ended its Codex terminal`);
      }

      this.#unended.delete(sessionId);
    } catch (error) {
      const message = (error as Error).message;

      if (message === `No session ${sessionId} is held.`) {
        this.#unended.delete(sessionId);
      } else {
        this.#unended.add(sessionId);
        this.deps.log(`session ${sessionId}: ending its Codex terminal failed, so it may still run: ${message}`);
      }
    }
  }
}
