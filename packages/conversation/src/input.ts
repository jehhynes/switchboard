/**
 * Typing a message into a held session (architecture.md § Typing a message), from claude-collab's `session.js`: one input transaction per
 * message, serialized per session. It waits until no menu is open, the input box holds no draft and no key was typed in a terminal for
 * `TYPING_PAUSE_MS`; takes the hub's input reservation; pastes the text as a bracketed paste, waits `PASTE_SETTLE_MS`, and presses Enter as a
 * separate write, retrying Enter alone while the paste sits unsent; and counts the message sent once the transcript has it. A message the transcript
 * does not confirm is settled from the screen: still in the input box, it is cleared from there and not sent; gone from it, it was sent.
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
/** How often the transcript is read for a typed message between screen checks: it is a local file, so a sent message shows as sent at once. */
export const SENT_POLL_MS = 50;
/** How often the screen is read while a paste has not shown in the input box yet (claude-collab `pasteAndSubmit`). */
export const ECHO_POLL_MS = 20;
/** How long after its last Enter a message waits for the transcript before the screen settles it. */
export const CONFIRM_SENT_MS = 10_000;
/**
 * The key that clears the input box: Ctrl+U deletes to the start of the line, and at the start of a line joins it to the line before, so a box of
 * n lines empties in at most 2n - 1 presses, deleting from the end; a long paste shown as "[Pasted text #1 +29 lines]" goes in one. It never
 * submits, interrupts a turn or opens a menu, also on an empty box (mechanics.md M90).
 */
export const CLEAR_LINE = '\u0015';
/** How long the screen gets to redraw after each clearing key. */
export const CLEAR_SETTLE_MS = 150;
/** A message not taken by Claude Code that Switchboard cleared from the input box. */
export const NOT_TAKEN = 'Claude Code did not take the message, so Switchboard cleared it from the input box. Send it again.';
/** A message not taken by Claude Code that is still in the input box. */
export const NOT_CLEARED = 'Claude Code did not take the message, and it is still in the input box: send or clear it in the terminal.';
/** How long a new hub waits for the holder to show a session's screen before it settles a message a stopped hub left being typed. */
export const RESOLVE_WAIT_MS = 30_000;
/** A typed message the transcript has not confirmed while the input box cannot be read. */
export const UNREADABLE = 'Claude Code has not shown taking the message, and Switchboard could not read its input box: check the terminal before sending it again.';
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
  /**
   * A numbered choice or confirmation is open; typed text would answer it. Claude Code's wait for a usage limit's reset says "Esc to cancel" but
   * takes a message, which re-arms it (mechanics M100), so its lines do not count.
   */
  menu: (text: string): boolean => {
    const shown = text.split('\n').filter((line) => !/continuing automatically/i.test(line)).join('\n');

    return /^\s*❯\s*\d+\.\s/m.test(shown) || /Esc to (cancel|exit|go back)|Enter to (confirm|select)/i.test(shown);
  },
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

/** Text with the input box's wrapping and spacing taken out. */
function flat(text: string): string {
  return text.replace(/\s+/g, '');
}

/** The placeholder Claude Code shows in the input box for a long paste: "[Pasted text #1]" or "[Pasted text #1 +29 lines]". */
const PASTED_PLACEHOLDER = /\[Pasted text #\d+(?: \+\d+ lines?)?\]/;

/** Whether the input box holds exactly the typed message: its text with the box's wrapping ignored, or only a long paste's placeholder. */
export function isMessage(draft: string, pasted: string): boolean {
  const shown = draft.trim();

  return shown !== '' && (flat(shown) === flat(pasted) || new RegExp(`^${PASTED_PLACEHOLDER.source}$`).test(shown));
}

/** Whether the input box holds the typed message, alone or with other text. */
export function boxHolds(draft: string, pasted: string): boolean {
  return isMessage(draft, pasted) || PASTED_PLACEHOLDER.test(draft) || (flat(pasted) !== '' && flat(draft).includes(flat(pasted)));
}

/** Whether what the input box holds is the start of the typed message, as Ctrl+U leaves it, deleting from the end. */
export function leftOfMessage(draft: string, pasted: string): boolean {
  return flat(draft) !== '' && flat(pasted).startsWith(flat(draft));
}

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
  /** How often the transcript is read between screen checks. */
  sentMs?: number;
}

/**
 * Pastes the text and presses Enter, retrying Enter while the text still waits in the box (claude-collab `pasteAndSubmit`). The transcript
 * (`sent`) settles it first. The screen answers for an Enter only once Claude has visibly reacted to it: a revision after the Enter and a changed
 * input box, because Claude can stall for seconds between taking a message and drawing it, and a retry on a stale screen would send a blind
 * Enter that a menu opened meanwhile would take. A paste that shows only after the Enter is its echo, not a reaction.
 */
export async function pasteAndSubmit(text: string, io: SubmitIo, options: SubmitOptions = {}): Promise<{ enterAt: number; enterAttempts: number; submitted: boolean }> {
  const { settleMs = PASTE_SETTLE_MS, echoMs = 1_000, checkMs = 400, quietMs = 10_000, attempts: max = 4, sentMs = SENT_POLL_MS } = options;

  await io.write(`\u001b[200~${text}\u001b[201~`);
  await io.wait(settleMs);

  let screen = await io.read();

  for (const end = io.now() + echoMs; !screen.unsent && !io.sent() && io.now() < end; ) {
    await io.wait(ECHO_POLL_MS);
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

    // Until the first screen check after an Enter the transcript is read every `sentMs`, so a message Claude took ends the wait as soon as it is
    // saved; after it, as before, every `checkMs` with the screen.
    for (let first = true; ; first = false) {
      if (first) {
        for (const until = io.now() + checkMs; !io.sent() && io.now() < until; ) {
          await io.wait(Math.min(sentMs, until - io.now()));
        }
      } else {
        await io.wait(checkMs);
      }

      if (io.sent()) {
        break;
      }

      screen = await io.read();

      if (reacted() || io.now() >= quietUntil) {
        break;
      }
    }

    if (attempts >= max || !pending()) {
      break;
    }
  }

  return { enterAt, enterAttempts: attempts, submitted: !pending() };
}

/** Thrown by `SessionInputDeps.write` when the holder refused the write, so nothing of it reached the session. */
export class NotWritten extends Error {}

/**
 * What became of a typed message: `sent` once the transcript has it, or when the input box no longer holds it; `not-sent` when nothing was typed,
 * or when Claude Code did not take it, with why.
 */
export type InputOutcome = { delivery: 'sent' } | { delivery: 'not-sent'; error: string };

/** When each step of one input transaction happened, in epoch milliseconds, for its timing line (architecture.md § Typing a message). */
export interface InputSteps {
  /** The message was queued. */
  queuedAt: number;
  /** Its turn in the session's queue came. */
  startedAt: number;
  /** The guards passed and the input reservation was held; null when it never was. */
  readyAt: number | null;
  /** The first guard that held it back, such as "a menu is open"; null when none did. */
  waited: string | null;
  /** Screen reads (holder snapshots), and the time spent in them. */
  reads: number;
  readMs: number;
  /** The paste was written. */
  pastedAt: number | null;
  /** The paste first showed in the input box; null when the first Enter went without seeing it. */
  echoAt: number | null;
  /** Why the paste was not seen before the first Enter, from the last screen read: a menu, no input box, or an empty box; null when it was. */
  missed: string | null;
  /** The first Enter was written, and how many were. */
  enterAt: number | null;
  enters: number;
  /** The transcript had the message; null when it never did. */
  confirmedAt: number | null;
}

/** One line of an input transaction's step durations, ending at `endAt`, such as "queue 0 ms, guards 48 ms, paste→echo 92 ms, …". */
export function stepsText(steps: InputSteps, endAt: number): string {
  const span = (from: number | null, to: number | null): string => (from === null || to === null ? '-' : `${Math.max(0, to - from)} ms`);
  const parts = [
    `queue ${span(steps.queuedAt, steps.startedAt)}`,
    `guards ${span(steps.startedAt, steps.readyAt)}${steps.waited === null ? '' : ` (waited: ${steps.waited})`}`,
    `paste→echo ${steps.echoAt === null ? `not seen${steps.missed === null ? '' : ` (${steps.missed})`}` : span(steps.pastedAt, steps.echoAt)}`,
    `paste→Enter ${span(steps.pastedAt, steps.enterAt)}${steps.enters > 1 ? ` (${steps.enters} Enters)` : ''}`,
    `Enter→transcript ${steps.confirmedAt === null ? 'not seen' : span(steps.enterAt, steps.confirmedAt)}`,
    `${steps.reads} screen reads in ${steps.readMs} ms`,
    `${span(steps.queuedAt, endAt)} in all`,
  ];

  return parts.join(', ');
}

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
  /** The last screen read and what it showed, since polling while a message waits mostly reads an unchanged screen, and each replay waits on a timer. */
  #lastScreen: { data: string; cols: number; rows: number; screen: InputScreen } | null = null;

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
   * `pasting` is told when the paste is about to be written, `command` types a slash command chosen from the composer's list as it is, and
   * `steps` gets when each step happened, just before `done`.
   */
  send(
    text: string,
    done: (outcome: InputOutcome) => void,
    guard: Partial<Pick<SessionInputDeps, 'check' | 'reserve'>> & { pasting?(at: number): void; command?: boolean; steps?(steps: InputSteps): void } = {},
  ): Promise<void> {
    const check = guard.check ?? this.deps.check;
    const reserve = guard.reserve ?? this.deps.reserve;
    const steps: InputSteps = { queuedAt: this.deps.now(), startedAt: 0, readyAt: null, waited: null, reads: 0, readMs: 0, pastedAt: null, echoAt: null, missed: null, enterAt: null, enters: 0, confirmedAt: null };
    const report = (outcome: InputOutcome): void => {
      guard.steps?.(steps);
      done(outcome);
    };

    this.#pending++;

    const run = this.#tail
      .then(() => this.#type(text, check, reserve, guard.pasting ?? (() => undefined), guard.command === true, steps))
      .then(report, (error: unknown) => report({ delivery: 'not-sent', error: String(error) }))
      .finally(() => void this.#pending--);

    this.#tail = run;

    return run;
  }

  /**
   * Settles a message a stopped hub left being typed after its paste at `pastedAt`, queued behind the session's other messages: sent when the
   * transcript has it or the input box no longer holds it; not sent when the box still holds it, which is cleared. `guard` names the session
   * and launch the message was typed into, so nothing is cleared from a session resumed since. It waits up to `waitMs` for the holder to show
   * the screen, since a new hub connects to it on first use; a screen it never reads leaves the message not sent, with `unreadable`.
   */
  resolve(
    text: string,
    pastedAt: number,
    done: (outcome: InputOutcome) => void,
    unreadable: string,
    guard: Pick<SessionInputDeps, 'check' | 'reserve'>,
    waitMs = RESOLVE_WAIT_MS,
  ): Promise<void> {
    this.#pending++;

    const run = this.#tail
      .then(async (): Promise<InputOutcome> => {
        // A slash command chosen from the composer's list was typed as it is, a message escaped; the box tells which this one was.
        let pasted = pasteText(text);

        for (const until = this.deps.now() + waitMs; guard.check() === null && this.deps.now() < until; ) {
          try {
            const { screen } = await this.#screen();

            pasted = isMessage(screen.draft, pasteText(text, true)) ? pasteText(text, true) : pasted;
            break;
          } catch {
            await this.deps.sleep(GUARD_POLL_MS);
          }
        }

        const reservation = await guard.reserve();

        if ('refused' in reservation) {
          return this.#sent(pasted, pastedAt) ? { delivery: 'sent' } : { delivery: 'not-sent', error: reservation.refused };
        }

        try {
          return await this.#settle(pasted, pastedAt, guard.check, unreadable);
        } finally {
          reservation.release();
        }
      })
      .then(done, (error: unknown) => done({ delivery: 'not-sent', error: String(error) }))
      .finally(() => void this.#pending--);

    this.#tail = run;

    return run;
  }

  #sent(pasted: string, since: number): boolean {
    const path = this.deps.transcriptPath();

    return path !== null && sentInTranscript(transcriptTail(path), pasted, since);
  }

  /**
   * Settles a typed message the transcript has not confirmed, from the input box, pasted no earlier than `since`. An empty box, or one holding
   * other text, means the message went: it is sent, and its transcript line places it when it lands. A box holding exactly the message, with
   * no key typed in a terminal since `since`, is cleared with `CLEAR_LINE` one key at a time, each only while the box still holds what is
   * left of the message, no key was typed in a terminal and the session can take it, and the message is not sent. A box holding the message
   * with more, or one a terminal typed into, is left as it is, and the message is not sent. The transcript is read again before and after each
   * key and after any failure, so a message Claude takes late is sent. A screen that cannot be read leaves it not sent, with `unreadable`.
   */
  async #settle(pasted: string, since: number, check: () => string | null, unreadable: string, steps?: InputSteps): Promise<InputOutcome> {
    const sent = (): boolean => {
      const found = this.#sent(pasted, since);

      if (found && steps !== undefined) {
        steps.confirmedAt ??= this.deps.now();
      }

      return found;
    };
    const outcome = (error: string): InputOutcome => (sent() ? { delivery: 'sent' } : { delivery: 'not-sent', error });

    if (sent()) {
      return { delivery: 'sent' };
    }

    let shown: { screen: InputScreen; keyAt: number | null };

    try {
      shown = await this.#screen(steps);
    } catch {
      return outcome(unreadable);
    }

    const draft = shown.screen.draft;
    const typedSince = (keyAt: number | null): boolean => keyAt !== null && keyAt >= since;

    if (draft === '' || !boxHolds(draft, pasted)) {
      this.deps.log(`session ${this.sessionId}: a typed message is not in the transcript yet and not in the input box; counted as sent`);
      return { delivery: 'sent' };
    }

    if (!isMessage(draft, pasted) || typedSince(shown.keyAt)) {
      this.deps.log(`session ${this.sessionId}: a typed message Claude Code did not take shares the input box with other text; left as it is`);
      return outcome(NOT_CLEARED);
    }

    let left = draft;
    const most = 2 * draft.split('\n').length + 2;

    for (let presses = 0; left !== '' && presses < most; presses++) {
      const why = check();

      if (why !== null) {
        return outcome(why);
      }

      if (sent()) {
        return { delivery: 'sent' };
      }

      try {
        await this.deps.write(CLEAR_LINE);
        await this.deps.sleep(CLEAR_SETTLE_MS);
        shown = await this.#screen(steps);
      } catch (error) {
        return outcome((error as Error).message);
      }

      // Taken while it was being cleared, so the transcript has it.
      if (sent()) {
        return { delivery: 'sent' };
      }

      left = shown.screen.draft;

      // Only what is left of the message, from its start, may be cleared further.
      if (typedSince(shown.keyAt) || (left !== '' && !leftOfMessage(left, pasted))) {
        break;
      }
    }

    this.deps.log(`session ${this.sessionId}: a typed message Claude Code did not take was ${left === '' ? 'cleared from' : 'left in'} the input box`);

    return outcome(left === '' ? NOT_TAKEN : NOT_CLEARED);
  }

  async #screen(steps?: InputSteps): Promise<{ screen: InputScreen; rev: number; keyAt: number | null }> {
    const from = this.deps.now();
    const snapshot = await this.deps.snapshot();
    const last = this.#lastScreen;

    if (last === null || last.data !== snapshot.data || last.cols !== snapshot.cols || last.rows !== snapshot.rows) {
      this.#lastScreen = { data: snapshot.data, cols: snapshot.cols, rows: snapshot.rows, screen: await readInputScreen(snapshot) };
    }

    if (steps !== undefined) {
      steps.reads++;
      steps.readMs += this.deps.now() - from;
    }

    return { screen: this.#lastScreen!.screen, rev: snapshot.rev, keyAt: snapshot.keyAt };
  }

  /** Waits until typing would disturb nothing, then holds the reservation; a refusal or an ended session means nothing was typed. */
  async #ready(check: () => string | null, reserve: SessionInputDeps['reserve'], steps: InputSteps): Promise<{ release(): void } | { refused: string }> {
    let logged: string | null = null;

    for (;;) {
      const why = check();

      if (why !== null) {
        return { refused: why };
      }

      const { screen, keyAt } = await this.#screen(steps);
      const blocked = blockedBy(screen, keyAt, this.deps.now());

      if (blocked === null) {
        const reservation = await reserve();

        if ('refused' in reservation) {
          return reservation;
        }

        // The reservation may have waited for an end or a resume, so the screen is read again under it.
        let still: string | null;

        try {
          const again = await this.#screen(steps);

          still = check() ?? blockedBy(again.screen, again.keyAt, this.deps.now());
        } catch (error) {
          reservation.release();
          throw error;
        }

        if (still === null) {
          return reservation;
        }

        steps.waited ??= still;
        reservation.release();
      } else if (blocked !== logged) {
        logged = blocked;
        steps.waited ??= blocked;
        this.deps.log(`session ${this.sessionId}: a message waits, ${blocked}`);
      }

      await this.deps.sleep(GUARD_POLL_MS);
    }
  }

  async #type(text: string, check: () => string | null, reserve: SessionInputDeps['reserve'], pasting: (at: number) => void, command: boolean, steps: InputSteps): Promise<InputOutcome> {
    let ready: { release(): void } | { refused: string };

    steps.startedAt = this.deps.now();

    try {
      ready = await this.#ready(check, reserve, steps);
    } catch (error) {
      return { delivery: 'not-sent', error: (error as Error).message };
    }

    if ('refused' in ready) {
      return { delivery: 'not-sent', error: ready.refused };
    }

    steps.readyAt = this.deps.now();

    const pasted = pasteText(text, command);
    const since = this.deps.now();
    const sent = (): boolean => {
      const found = this.#sent(pasted, since);

      if (found) {
        steps.confirmedAt ??= this.deps.now();
      }

      return found;
    };
    // Once a write is sent, the session may have it, unless the holder refused it.
    let attempted = false;
    // What the last screen read showed, for why a paste was not seen before the first Enter.
    let shown = '';

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

            if (data === '\r' && steps.enters === 0 && steps.echoAt === null) {
              steps.missed = shown;
            }

            try {
              const { rev } = await this.deps.write(data);
              const at = this.deps.now();

              if (data === '\r') {
                steps.enterAt ??= at;
                steps.enters++;
              } else {
                steps.pastedAt ??= at;
              }

              attempted = true;
              return rev;
            } catch (error) {
              attempted ||= !(error instanceof NotWritten);
              throw error;
            }
          },
          read: async () => {
            const { screen, rev } = await this.#screen(steps);
            const unsent = !screen.menu && screen.draft !== '';

            shown = screen.menu ? 'a menu is open' : screen.box === '' ? 'no input box on the screen' : 'the input box is empty';

            if (unsent && steps.enterAt === null) {
              steps.echoAt ??= this.deps.now();
            }

            return { unsent, box: screen.box, rev };
          },
          sent,
          now: this.deps.now,
          wait: this.deps.sleep,
        },
        this.deps.submit,
      );

      // The transcript usually saves the message within a second of its Enter, so it is read often for that second and then less often.
      for (const start = this.deps.now(), until = start + CONFIRM_SENT_MS; !sent() && this.deps.now() < until; ) {
        await this.deps.sleep(this.deps.now() - start < 1_000 ? SENT_POLL_MS : GUARD_POLL_MS);
      }

      if (sent()) {
        return { delivery: 'sent' };
      }

      this.deps.log(`session ${this.sessionId}: a typed message is not in the transcript after ${result.enterAttempts} Enter${result.enterAttempts === 1 ? '' : 's'}${result.submitted ? '' : '; it is still in the input box'}`);

      return await this.#settle(pasted, since, check, UNREADABLE, steps);
    } catch (error) {
      // Something was written, so the screen says whether the message went.
      return attempted ? await this.#settle(pasted, since, check, (error as Error).message, steps) : { delivery: 'not-sent', error: (error as Error).message };
    } finally {
      ready.release();
    }
  }
}
