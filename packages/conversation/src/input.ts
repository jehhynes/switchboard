/**
 * Typing a message into a held session (architecture.md § Typing a message), from claude-collab's `session.js`: one input transaction per
 * message, serialized per session. It waits until no menu is open, the input box holds no draft and no key was typed in a terminal for
 * `TYPING_PAUSE_MS`; takes the hub's input reservation; pastes the text as a bracketed paste, waits `PASTE_SETTLE_MS`, and presses Enter as a
 * separate write, retrying Enter alone while the paste sits unsent; and counts the message sent only once the transcript has it. A message the
 * transcript does not confirm is uncertain and never typed again.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import headless from '@xterm/headless';
import type { Line } from './screenReader.js';
import { typedText, unwrapPasted } from './transcript.js';

/** Gap between a paste and its Enter; an Enter too soon after a paste can be dropped, and is retried. */
export const PASTE_SETTLE_MS = 60;
/** No message is typed while a key was typed in an attached terminal this recently. */
export const TYPING_PAUSE_MS = 1_500;
/** How often a waiting message checks the screen again. */
export const GUARD_POLL_MS = 200;
/** How long after its last Enter a message waits for the transcript before it is uncertain. */
export const CONFIRM_SENT_MS = 10_000;
/** The longest message the view may send. */
export const MAX_MESSAGE_CHARS = 10_000;
/** How much of the transcript's end the confirmation reads: the message was written moments ago. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * The text as it is pasted: line breaks kept as newlines, other control characters removed, and a backslash before a first character the input
 * box would take as a command (`/` slash command, `!` shell, `#` memory, `&` background), so a message is always a message. A first `@` is
 * a file mention, as anywhere else in the text, and is kept (mechanics M88). A slash command chosen from the composer's list (`command`) keeps
 * its `/`, so it runs.
 */
export function pasteText(text: string, command = false): string {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim();

  return (command ? /^[!#&]/ : /^[/!#&]/).test(clean) ? `\\${clean}` : clean;
}

/** What the visible screen says about typing, from Claude Code's classic renderer (claude-collab `session.js` `screenState`). */
export const screenState = {
  /** A numbered choice or confirmation is open; typed text would answer it. */
  menu: (text: string): boolean => /^\s*❯\s*\d+\.\s/m.test(text) || /Esc to (cancel|exit|go back)|Enter to (confirm|select)/i.test(text),
  /**
   * Text typed but not sent: every line of the input box, from the "❯" line right under a rule to the next rule, read with dim cells (the
   * placeholder, a suggested prompt) blanked, so a draft whose first line is empty still counts.
   */
  draft: (undimmed: string): string => {
    const lines = undimmed.split('\n');

    for (let index = lines.length - 1; index > 0; index--) {
      const match = /^❯ ?(.*)$/.exec(lines[index]!);

      if (match === null || !/^─{10,}/.test(lines[index - 1] ?? '')) {
        continue;
      }

      const text = [match[1]!];

      for (let next = index + 1; next < lines.length && !/^─{10,}/.test(lines[next]!); next++) {
        text.push(lines[next]!);
      }

      return text.map((line) => line.trim()).join('\n').trim();
    }

    return '';
  },
  /** The input box as drawn, rules included, or '' with none: what an Enter changes. */
  box: (undimmed: string): string => {
    const lines = undimmed.split('\n');

    for (let index = lines.length - 1; index > 0; index--) {
      if (!/^❯/.test(lines[index]!) || !/^─{10,}/.test(lines[index - 1] ?? '')) {
        continue;
      }

      let end = index + 1;

      while (end < lines.length && !/^─{10,}/.test(lines[end]!)) {
        end++;
      }

      return lines.slice(index - 1, end + 1).join('\n');
    }

    return '';
  },
};

/**
 * Whether the transcript's lines hold `text` as a message written at or after `since`: a user entry, or an `enqueue` queue operation, which
 * Claude Code writes for a message typed while it works, before it takes it. A paste of several lines is recorded inside `pasted_content` tags. Claude Code saves a message as it takes it, before it redraws, so
 * this confirms a message even while the screen lags.
 */
export function sentInTranscript(lines: string[], text: string, since: number): boolean {
  const want = text.trim();

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;

    if (!line.includes('"user"') && !line.includes('"queue-operation"')) {
      continue;
    }

    let entry: { type?: unknown; operation?: unknown; content?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } };

    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }

    let said: unknown;

    if (entry.type === 'queue-operation' && entry.operation === 'enqueue') {
      said = entry.content;
    } else if (entry.type === 'user' && entry.isSidechain !== true) {
      const content = entry.message?.content;

      said = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block: { type?: unknown }) => block?.type === 'text').map((block: { text?: unknown }) => String(block.text ?? '')).join('\n') : '';
    } else {
      continue;
    }

    // Older than the paste, or undated: nothing newer matched.
    if (!(typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) >= since)) {
      return false;
    }

    // A slash command is recorded in tags, which read back as `/name args`.
    if (typeof said === 'string' && (unwrapPasted(said).trim() === want || typedText(said) === want)) {
      return true;
    }
  }

  return false;
}

/** The end of a transcript as lines, or none when it cannot be read. */
export function transcriptTail(path: string): string[] {
  let fd: number;

  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }

  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);

    readSync(fd, buffer, 0, length, size - length);

    return buffer.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

/** The visible screen as typing sees it (claude-collab `session.js` `state`). */
export interface InputScreen {
  /** A numbered choice or confirmation is open. */
  menu: boolean;
  /** Text in the input box not yet sent, with dim placeholder text left out. */
  draft: string;
  /** The input box as drawn, rules included. */
  box: string;
}

/** Replays a snapshot and reads its visible rows: as drawn, and with dim cells blanked, which hides the input box's placeholder. */
export async function readInputScreen(snapshot: { data: string; cols: number; rows: number }): Promise<InputScreen> {
  const term = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: snapshot.rows, allowProposedApi: true });

  try {
    await new Promise<void>((resolve) => term.write(snapshot.data, resolve));

    const buffer = term.buffer.active;
    const plain: string[] = [];
    const undimmed: string[] = [];

    for (let row = buffer.baseY; row < buffer.baseY + snapshot.rows; row++) {
      const line = buffer.getLine(row) as unknown as (Line & { translateToString(trim: boolean): string }) | undefined;

      if (line === undefined) {
        plain.push('');
        undimmed.push('');
        continue;
      }

      plain.push(line.translateToString(true));

      let text = '';

      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);

        if (cell === undefined || cell.getWidth() === 0) {
          continue;
        }

        text += cell.isDim() ? ' ' : cell.getChars() || ' ';
      }

      undimmed.push(text.trimEnd());
    }

    const shown = undimmed.join('\n');

    return { menu: screenState.menu(plain.join('\n')), draft: screenState.draft(shown), box: screenState.box(shown) };
  } finally {
    term.dispose();
  }
}

/** The screen as a paste and its Enter see it. */
export interface SubmitScreen {
  /** Text is in the input box and no menu is open. */
  unsent: boolean;
  box: string;
  rev: number;
}

export interface SubmitIo {
  /** Writes to the session; resolves the holder's revision after the write. */
  write(data: string): Promise<number>;
  read(): Promise<SubmitScreen>;
  /** Whether the transcript has the message, which settles it whatever the screen shows. */
  sent(): boolean;
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface SubmitOptions {
  settleMs?: number;
  /** How long the first Enter waits for the paste to show in the box. */
  echoMs?: number;
  checkMs?: number;
  /** After this long since the first Enter, an Enter that drew no reaction is retried anyway. */
  quietMs?: number;
  attempts?: number;
}

/**
 * Pastes the text and presses Enter, retrying Enter while the text still waits in the box (claude-collab `pasteAndSubmit`). The transcript
 * (`sent`) settles it first. The screen answers for an Enter only once Claude has visibly reacted to it: a revision after the Enter and a changed
 * input box, because Claude can stall for seconds between taking a message and drawing it, and a retry on a stale screen would send a blind
 * Enter that a menu opened meanwhile would take. A paste that shows only after the Enter is its echo, not a reaction.
 */
export async function pasteAndSubmit(text: string, io: SubmitIo, options: SubmitOptions = {}): Promise<{ enterAt: number; enterAttempts: number; submitted: boolean }> {
  const { settleMs = PASTE_SETTLE_MS, echoMs = 1_000, checkMs = 400, quietMs = 10_000, attempts: max = 4 } = options;

  await io.write(`\u001b[200~${text}\u001b[201~`);
  await io.wait(settleMs);

  let screen = await io.read();

  for (const end = io.now() + echoMs; !screen.unsent && !io.sent() && io.now() < end; ) {
    await io.wait(50);
    screen = await io.read();
  }

  let attempts = 0;
  let enterAt = 0;
  let quietUntil = 0;
  const pending = (): boolean => !io.sent() && screen.unsent;

  for (;;) {
    let before = screen.box;
    let shown = screen.unsent;
    const rev = await io.write('\r');
    const at = io.now();

    if (attempts === 0) {
      enterAt = at;
      quietUntil = at + quietMs;
    }

    attempts++;

    const reacted = (): boolean => {
      if (!(screen.rev > rev)) {
        return false;
      }

      if (!shown && screen.unsent) {
        shown = true;
        before = screen.box;
        return false;
      }

      return screen.box !== before;
    };

    do {
      await io.wait(checkMs);
      screen = await io.read();
    } while (!io.sent() && !reacted() && io.now() < quietUntil);

    if (attempts >= max || !pending()) {
      break;
    }
  }

  return { enterAt, enterAttempts: attempts, submitted: !pending() };
}

/** Thrown by `SessionInputDeps.write` when the holder refused the write, so nothing of it reached the session. */
export class NotWritten extends Error {}

/** What became of a typed message: `sent` once the transcript has it; `uncertain` when it was typed but not confirmed; `not-sent` when nothing was typed. */
export type InputOutcome = { delivery: 'sent' } | { delivery: 'uncertain' | 'not-sent'; error: string };

export interface SessionInputDeps {
  /** The session's visible screen from the holder, with its revision and when a terminal last typed. */
  snapshot(): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt: number | null }>;
  /** Types into the session through the holder; resolves the revision after the write. Rejects with `NotWritten` when nothing was written. */
  write(data: string): Promise<{ rev: number }>;
  /** The session's transcript file now, or null while it has none. */
  transcriptPath(): string | null;
  /** Why the message can no longer go to the session, such as that it ended; null while it can. A message can give its own. */
  check(): string | null;
  /** The hub's input reservation, which waits for an end, stop or resume in progress and defers a release while it is held. A message can give its own. */
  reserve(): Promise<{ release(): void } | { refused: string }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  submit?: SubmitOptions;
}

/** Why typing waits now, or null when nothing on the screen or in the terminal stops it. */
export function blockedBy(screen: InputScreen, keyAt: number | null, now: number): string | null {
  if (screen.menu) {
    return 'a menu is open';
  }

  if (screen.draft !== '') {
    return 'the input box holds a draft';
  }

  return keyAt !== null && now - keyAt < TYPING_PAUSE_MS ? 'a key was typed in a terminal' : null;
}

/** One session's typed messages, typed one at a time in the order they came. */
export class SessionInput {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly sessionId: string,
    private readonly deps: SessionInputDeps,
  ) {}

  #pending = 0;

  /** Messages queued or being typed. */
  get pending(): number {
    return this.#pending;
  }

  /**
   * Queues a message; `done` gets what became of it. `guard` replaces the check and reservation for this message, such as for the launch it names,
   * `pasting` is told when the paste is about to be written, and `command` types a slash command chosen from the composer's list as it is.
   */
  send(text: string, done: (outcome: InputOutcome) => void, guard: Partial<Pick<SessionInputDeps, 'check' | 'reserve'>> & { pasting?(at: number): void; command?: boolean } = {}): Promise<void> {
    const check = guard.check ?? this.deps.check;
    const reserve = guard.reserve ?? this.deps.reserve;

    this.#pending++;

    const run = this.#tail
      .then(() => this.#type(text, check, reserve, guard.pasting ?? (() => undefined), guard.command === true))
      .then(done, (error: unknown) => done({ delivery: 'uncertain', error: String(error) }))
      .finally(() => void this.#pending--);

    this.#tail = run;

    return run;
  }

  async #screen(): Promise<{ screen: InputScreen; rev: number; keyAt: number | null }> {
    const snapshot = await this.deps.snapshot();

    return { screen: await readInputScreen(snapshot), rev: snapshot.rev, keyAt: snapshot.keyAt };
  }

  /** Waits until typing would disturb nothing, then holds the reservation; a refusal or an ended session means nothing was typed. */
  async #ready(check: () => string | null, reserve: SessionInputDeps['reserve']): Promise<{ release(): void } | { refused: string }> {
    let logged: string | null = null;

    for (;;) {
      const why = check();

      if (why !== null) {
        return { refused: why };
      }

      const { screen, keyAt } = await this.#screen();
      const blocked = blockedBy(screen, keyAt, this.deps.now());

      if (blocked === null) {
        const reservation = await reserve();

        if ('refused' in reservation) {
          return reservation;
        }

        // The reservation may have waited for an end or a resume, so the screen is read again under it.
        let still: string | null;

        try {
          const again = await this.#screen();

          still = check() ?? blockedBy(again.screen, again.keyAt, this.deps.now());
        } catch (error) {
          reservation.release();
          throw error;
        }

        if (still === null) {
          return reservation;
        }

        reservation.release();
      } else if (blocked !== logged) {
        logged = blocked;
        this.deps.log(`session ${this.sessionId}: a message waits, ${blocked}`);
      }

      await this.deps.sleep(GUARD_POLL_MS);
    }
  }

  async #type(text: string, check: () => string | null, reserve: SessionInputDeps['reserve'], pasting: (at: number) => void, command: boolean): Promise<InputOutcome> {
    let ready: { release(): void } | { refused: string };

    try {
      ready = await this.#ready(check, reserve);
    } catch (error) {
      return { delivery: 'not-sent', error: (error as Error).message };
    }

    if ('refused' in ready) {
      return { delivery: 'not-sent', error: ready.refused };
    }

    const pasted = pasteText(text, command);
    const since = this.deps.now();
    const sent = (): boolean => {
      const path = this.deps.transcriptPath();

      return path !== null && sentInTranscript(transcriptTail(path), pasted, since);
    };
    // Once a write is sent, the session may have it, unless the holder refused it.
    let attempted = false;

    try {
      const result = await pasteAndSubmit(
        pasted,
        {
          write: async (data) => {
            // Every write, an Enter retry too, goes only to the session and launch the message was for.
            const why = check();

            if (why !== null) {
              throw new NotWritten(why);
            }

            if (!attempted) {
              pasting(this.deps.now());
            }

            try {
              const { rev } = await this.deps.write(data);

              attempted = true;
              return rev;
            } catch (error) {
              attempted ||= !(error instanceof NotWritten);
              throw error;
            }
          },
          read: async () => {
            const { screen, rev } = await this.#screen();

            return { unsent: !screen.menu && screen.draft !== '', box: screen.box, rev };
          },
          sent,
          now: this.deps.now,
          wait: this.deps.sleep,
        },
        this.deps.submit,
      );

      for (const until = this.deps.now() + CONFIRM_SENT_MS; !sent() && this.deps.now() < until; ) {
        await this.deps.sleep(GUARD_POLL_MS);
      }

      if (sent()) {
        return { delivery: 'sent' };
      }

      this.deps.log(`session ${this.sessionId}: a typed message is not in the transcript after ${result.enterAttempts} Enter${result.enterAttempts === 1 ? '' : 's'}${result.submitted ? '' : '; it is still in the input box'}`);

      return { delivery: 'uncertain', error: result.submitted ? 'The transcript does not show the message.' : 'The message is still in the input box; check the terminal.' };
    } catch (error) {
      return attempted ? { delivery: 'uncertain', error: (error as Error).message } : { delivery: 'not-sent', error: (error as Error).message };
    } finally {
      ready.release();
    }
  }
}
