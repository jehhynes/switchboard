import type { Session } from '@switchboard/core';
import { resumesHeld } from '@switchboard/core';
import { refusal } from './conversation.js';
import { SESSION_RELAUNCHED } from './runtime.js';
import type { HeldViewHandlers } from './runtime.js';
import { outOfScope } from './windows.js';
import type { WindowScope } from './windows.js';

/** The most text one `console-input` types: a pasted block, not a message, which the composer sends. */
export const CONSOLE_INPUT_CHARS = 64 * 1024;
/** How often open consoles are checked against their page's scope, so one whose page moved on, or whose session was replaced, ends. */
export const CONSOLE_CHECK_MS = 1_000;
/** How many `console-input` answers are kept by page key and `opId`, so a repeated one is never typed twice. */
const ANSWERS_KEPT = 200;

export interface PageConsoleDeps {
  isPage(key: string): boolean;
  scope(key: string): WindowScope | null;
  session(id: string): Session | null;
  view(session: string, handlers: HeldViewHandlers): Promise<{ close(): void }>;
  reserve(sessionId: string, launch: string | null): Promise<{ release(): void } | { refused: string }>;
  /** Types the operator's keys into the held session as keys typed in a terminal. */
  write(session: string, data: string): Promise<unknown>;
  size(session: string, cols: number, rows: number): Promise<unknown>;
  log(line: string): void;
}

/** Writes one SSE event to a console stream; false once the stream has more queued than `CONSOLE_QUEUE_BYTES` (`page.ts`). */
export type ConsoleSend = (event: string, data: unknown) => boolean;

/**
 * Why a session has no console on the page, or null when the terminal holder holds it: a held session, an ended one that was never held, which
 * resumes there (PRD R81, R93), or Codex's terminal app on a Codex app-server session's thread, which the hub starts in the holder when a console opens.
 */
export function noConsole(session: Session): string | null {
  if (session.codeMode === true || resumesHeld(session) || (session.execution === 'app-server' && session.nativeSessionId !== null)) {
    return null;
  }

  return session.execution === 'app-server'
    ? 'This Codex session has no thread yet, so it has no console.'
    : session.provider === 'claude'
      ? 'This session runs in your own Claude window, so it has a console here only once it ends there.'
      : "This session does not run in Switchboard's terminal holder, so it has no console here.";
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;

/**
 * The web page's console (architecture.md § Web page): a page's view of its selected conversation's held session, streamed from the terminal
 * holder without attaching, so it never changes the session's size, and the keys the operator types in it, written through the holder's `write`
 * with the checks of the page's prompt keys. Only a console that types resizes the session, to its own size.
 */
export class PageConsole {
  readonly #open = new Set<{ key: string; sessionId: string; scopeGen: number; launch: string | null; close(): void }>();
  readonly #answers = new Map<string, Promise<{ status: number; body: unknown }>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #timer: NodeJS.Timeout;

  constructor(private readonly deps: PageConsoleDeps) {
    this.#timer = setInterval(() => this.check(), CONSOLE_CHECK_MS);
    this.#timer.unref();
  }

  /**
   * Opens a page's console on its selected conversation's current session: `size`, `data`, `replayed`, `exited` and `closed` events, or one
   * `unavailable` event with why and the end; a refusal, with no stream, for a key that is not a page's or a session it does not show.
   */
  open(key: string, sessionId: string, send: ConsoleSend, end: () => void): { close(): void } | { status: number; error: string } {
    const known = this.deps.isPage(key);
    const scope = known ? this.deps.scope(key) : null;

    if (scope === null || scope.sessionId !== sessionId) {
      return { status: 403, error: outOfScope(known, scope).body.error };
    }

    const session = this.deps.session(sessionId);
    const why = session === null ? 'The session is gone.' : noConsole(session);
    let viewer: { close(): void } | null = null;
    let closed = false;
    const entry = {
      key,
      sessionId,
      scopeGen: scope.scopeGen,
      launch: session?.launchId ?? null,
      close: (): void => {
        if (closed) {
          return;
        }

        closed = true;
        this.#open.delete(entry);
        viewer?.close();
        end();
      },
    };
    const deliver = (event: string, data: unknown): void => {
      // Nothing more reaches a page that moved to another conversation, or once its session was resumed under another launch.
      if (!closed && !this.#current(entry)) {
        entry.close();
        return;
      }

      if (!closed && !send(event, data)) {
        this.deps.log(`session ${sessionId}: the page's console fell behind its output and was closed`);
        entry.close();
      }
    };

    if (why !== null) {
      send('unavailable', { reason: why });
      end();
      return { close: () => undefined };
    }

    this.#open.add(entry);
    this.deps
      .view(sessionId, {
        onSize: (cols, rows) => deliver('size', { cols, rows }),
        onData: (data) => deliver('data', { data }),
        onReplayed: () => deliver('replayed', {}),
        onExit: (exitCode) => deliver('exited', { exitCode }),
        onClose: (error) => {
          deliver('closed', { error });
          entry.close();
        },
      })
      .then(
        (opened) => {
          if (closed) {
            opened.close();
          } else {
            viewer = opened;
          }
        },
        (error: Error) => {
          deliver('unavailable', { reason: error.message });
          entry.close();
        },
      );

    return entry;
  }

  /** Ends each console whose page closed, moved to another conversation, or whose session is another or runs under another launch now. */
  check(): void {
    for (const entry of [...this.#open]) {
      if (!this.#current(entry)) {
        entry.close();
      }
    }
  }

  /** Whether a console's page still shows its session under the scope generation and launch it opened on, so a page that moved away and back gets a new one. */
  #current(entry: { key: string; sessionId: string; scopeGen: number; launch: string | null }): boolean {
    const scope = this.deps.isPage(entry.key) ? this.deps.scope(entry.key) : null;

    return scope?.sessionId === entry.sessionId && scope.scopeGen === entry.scopeGen && (this.deps.session(entry.sessionId)?.launchId ?? null) === entry.launch;
  }

  /** The number of open consoles, for tests. */
  get size(): number {
    return this.#open.size;
  }

  close(): void {
    clearInterval(this.#timer);

    for (const entry of [...this.#open]) {
      entry.close();
    }
  }

  /**
   * `console-input {window, scopeGen, opId, sessionId, launch, data, cols?, rows?}` types the keys of the page's console into its selected
   * conversation's current Code Mode session, under the launch the page showed and the session's input reservation, as `prompt-key` does, and
   * with `cols` and `rows` first resizes the session to the console that types; `data` may be empty to resize alone. Refused as `history` is,
   * and with 409 for another launch or an ended session. A repeated `opId` answers the first result; one page's keys are typed in order.
   */
  input(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, opId, sessionId, launch, data, cols, rows } = body;
    const sized = cols !== undefined || rows !== undefined;

    if (
      typeof window !== 'string' ||
      typeof scopeGen !== 'number' ||
      typeof opId !== 'string' ||
      opId === '' ||
      typeof sessionId !== 'string' ||
      !(launch === null || typeof launch === 'string') ||
      typeof data !== 'string' ||
      data.length > CONSOLE_INPUT_CHARS ||
      (data === '' && !sized) ||
      (sized && !(isSize(cols) && isSize(rows)))
    ) {
      return Promise.resolve({ status: 400, body: { error: `Expected {window, scopeGen, opId, sessionId, launch, data, cols?, rows?} with data at most ${CONSOLE_INPUT_CHARS} characters, and cols and rows together.` } });
    }

    const done = this.#answers.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const queued = this.#queues.get(window) ?? Promise.resolve();
    const answer = queued.then(() => this.#type(window, scopeGen, sessionId, launch, data, sized ? { cols: cols as number, rows: rows as number } : null));
    const settled = answer.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(window, settled);
    void settled.then(() => {
      if (this.#queues.get(window) === settled) {
        this.#queues.delete(window);
      }
    });
    this.#answers.set(`${window} ${opId}`, answer);

    for (const old of [...this.#answers.keys()].slice(0, -ANSWERS_KEPT)) {
      this.#answers.delete(old);
    }

    return answer;
  }

  /** Why the keys cannot go to the session now: the page's scope, the session and the launch the page showed; null when they can. */
  #refused(window: string, scopeGen: number, sessionId: string, launch: string | null): { status: number; body: unknown } | null {
    const refused = refusal({ known: this.deps.isPage(window), scope: this.deps.isPage(window) ? this.deps.scope(window) : null }, scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const session = this.deps.session(sessionId);
    const why = session === null ? 'The session is gone.' : noConsole(session);

    if (why !== null) {
      return { status: 409, body: { error: why } };
    }

    return (session!.launchId ?? null) !== launch ? { status: 409, body: { error: SESSION_RELAUNCHED } } : null;
  }

  async #type(window: string, scopeGen: number, sessionId: string, launch: string | null, data: string, size: { cols: number; rows: number } | null): Promise<{ status: number; body: unknown }> {
    const before = this.#refused(window, scopeGen, sessionId, launch);

    if (before !== null) {
      return before;
    }

    const reservation = await this.deps.reserve(sessionId, launch);

    if ('refused' in reservation) {
      return { status: 409, body: { error: reservation.refused } };
    }

    try {
      // The page may have moved to another conversation while the reservation waited, or while the session was resized.
      const reserved = this.#refused(window, scopeGen, sessionId, launch);

      if (reserved !== null) {
        return reserved;
      }

      if (size !== null) {
        await this.deps.size(sessionId, size.cols, size.rows);
      }

      const sized = size === null || data === '' ? null : this.#refused(window, scopeGen, sessionId, launch);

      if (sized !== null) {
        return sized;
      }

      if (data !== '') {
        await this.deps.write(sessionId, data);
      }

      return { status: 200, body: { done: true } };
    } catch (error) {
      return { status: 409, body: { error: `The keys were not typed: ${(error as Error).message}` } };
    } finally {
      reservation.release();
    }
  }
}
