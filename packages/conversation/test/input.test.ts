import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAR_LINE, NOT_CLEARED, NOT_TAKEN, NotWritten, SessionInput, UNREADABLE, blockedBy, stepsText, boxHolds, isMessage, leftOfMessage, pasteAndSubmit, pasteText, readInputScreen, sentInTranscript } from '../src/input.js';
import type { InputOutcome, InputSteps, SubmitScreen } from '../src/input.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversation-input-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RULE = '─'.repeat(30);
const T0 = Date.parse('2026-11-19T12:00:00Z');

/** A screen as Claude Code's classic renderer draws its input box: the dim placeholder while empty, and a menu above it when one is open. */
function drawn(box: string, menu = false): string {
  return [menu ? '❯ 1. Yes' : '● Done.', '', RULE, `❯ ${box === '' ? '\u001b[2mTry "fix the build"\u001b[22m' : box}`, RULE].join('\r\n');
}

const user = (text: string, at: number) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });

describe('pasteText', () => {
  it('keeps line breaks, drops other control characters, and escapes a first character the input box takes as a command', () => {
    expect(pasteText('  one\r\ntwo\rthree\tfour\u0007 ')).toBe('one\ntwo\nthree four');
    expect(pasteText('/compact now')).toBe('\\/compact now');
    expect(pasteText('!ls')).toBe('\\!ls');
    expect(pasteText('# note')).toBe('\\# note');
    // A first @ is a file mention, which the escape would lose (mechanics M88).
    expect(pasteText('@file.ts what is this?')).toBe('@file.ts what is this?');
    expect(pasteText('@"a b.ts" and @c.ts')).toBe('@"a b.ts" and @c.ts');
    expect(pasteText('& run')).toBe('\\& run');
    expect(pasteText('a/b')).toBe('a/b');
  });

  it('keeps the slash of a command chosen from the list, and still escapes the other command characters', () => {
    expect(pasteText(' /compact keep the plan ', true)).toBe('/compact keep the plan');
    expect(pasteText('/hello7', true)).toBe('/hello7');
    expect(pasteText('!ls', true)).toBe('\\!ls');
    expect(pasteText('# note', true)).toBe('\\# note');
    expect(pasteText('& run', true)).toBe('\\& run');
  });
});

describe('readInputScreen', () => {
  it('reads a dim placeholder as an empty box, typed text as a draft, and a numbered choice as a menu', async () => {
    const empty = await readInputScreen({ data: drawn(''), cols: 40, rows: 6 });

    expect(empty).toMatchObject({ menu: false, draft: '' });
    expect(empty.box).toBe(`${RULE}\n❯\n${RULE}`);
    expect(await readInputScreen({ data: drawn('half a thought'), cols: 40, rows: 6 })).toMatchObject({ menu: false, draft: 'half a thought' });
    expect(await readInputScreen({ data: drawn('', true), cols: 40, rows: 6 })).toMatchObject({ menu: true, draft: '' });
    expect((await readInputScreen({ data: 'Do you trust this folder?\r\nEnter to confirm · Esc to cancel', cols: 40, rows: 6 })).menu).toBe(true);
    // The box as Claude Code 2.1.328 drew it in the live run of mechanics M86: a rule carrying the session's name, and the mode line below.
    const label = '─'.repeat(20) + ' switchboard · ad-hoc · adhoc 1 ─';
    const live = (box: string) => ['● ready', '', '✻ Baked for 1s · done 3:32 PM', '', label, `❯ ${box}`, RULE, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'].join('\r\n');

    expect(await readInputScreen({ data: live(''), cols: 60, rows: 8 })).toMatchObject({ menu: false, draft: '' });
    expect(await readInputScreen({ data: live('half typed'), cols: 60, rows: 8 })).toMatchObject({ menu: false, draft: 'half typed' });
    // A draft whose first line is empty still holds text on the lines below it.
    expect(await readInputScreen({ data: [RULE, '❯ ', '  second line', RULE].join('\r\n'), cols: 40, rows: 6 })).toMatchObject({ draft: 'second line' });
    expect(await readInputScreen({ data: [RULE, '❯ one', '  two', RULE, '  ⏵⏵ auto mode on'].join('\r\n'), cols: 40, rows: 6 })).toMatchObject({ draft: 'one\ntwo' });
  });

  it('blocks on a menu, a draft and a key typed in a terminal within 1.5 seconds', () => {
    const clear = { menu: false, draft: '', box: '' };

    expect(blockedBy(clear, null, T0)).toBeNull();
    expect(blockedBy(clear, T0 - 1_499, T0)).toBe('a key was typed in a terminal');
    expect(blockedBy(clear, T0 - 1_500, T0)).toBeNull();
    expect(blockedBy({ ...clear, menu: true }, null, T0)).toBe('a menu is open');
    expect(blockedBy({ ...clear, draft: 'x' }, null, T0)).toBe('the input box holds a draft');
  });
});

describe('sentInTranscript', () => {
  it('finds the message as a user entry or an enqueue written at or after the paste, and nothing older', () => {
    const lines = [user('hello', T0 - 10), user('other', T0), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(T0 + 5).toISOString(), content: 'queued one' })];

    expect(sentInTranscript(lines, 'other', T0)).toBe(true);
    expect(sentInTranscript(lines, 'queued one', T0)).toBe(true);
    // The same text sent before the paste does not confirm this one.
    expect(sentInTranscript(lines, 'hello', T0)).toBe(false);
    expect(sentInTranscript(lines, 'missing', T0)).toBe(false);
    expect(sentInTranscript([JSON.stringify({ type: 'user', isSidechain: true, timestamp: new Date(T0).toISOString(), message: { content: 'nested' } })], 'nested', T0)).toBe(false);
    expect(sentInTranscript([JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { content: [{ type: 'text', text: 'blocks' }] } })], 'blocks', T0)).toBe(true);
    // A paste of several lines, as Claude Code 2.1.328 records it (mechanics M86).
    expect(sentInTranscript([user('<pasted_content id="914d">\nLine one\nLine two\n\nHow many?\n</pasted_content id="914d">', T0)], 'Line one\nLine two\n\nHow many?', T0)).toBe(true);
  });

  it('finds a slash command by the tags Claude Code records it in, with and without arguments (mechanics M88)', () => {
    expect(sentInTranscript([user('<command-message>hello7</command-message>\n<command-name>/hello7</command-name>', T0)], '/hello7', T0)).toBe(true);
    expect(sentInTranscript([user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>', T0)], '/compact keep the plan', T0)).toBe(true);
    expect(sentInTranscript([user('<command-name>/compact</command-name>\n<command-args>other</command-args>', T0)], '/compact keep the plan', T0)).toBe(false);
    expect(sentInTranscript([user('<command-name>/hello7</command-name>', T0 - 1)], '/hello7', T0)).toBe(false);
  });
});

/** A held Claude Code session as the holder serves it: its input box, a menu, Enters it drops, and its transcript. */
class FakeSession {
  box = '';
  menu = false;
  rev = 0;
  keyAt: number | null = null;
  /** Enters that land too soon after a paste and are lost. */
  dropEnters = 0;
  /** Whether an Enter writes the message to the transcript. */
  saves = true;
  /** Whether Claude takes a box that starts with a slash as a command, recorded in its tags, as for a command sent unescaped. */
  runsCommands = false;
  /** Whether Ctrl+U deletes from the input box. */
  clears = true;
  readonly writes: string[] = [];
  clock = T0;
  readonly transcript: string;

  constructor() {
    this.transcript = join(dir, 'session.jsonl');
    writeFileSync(this.transcript, `${user('earlier', T0 - 60_000)}\n`);
  }

  write(data: string): { rev: number } {
    this.writes.push(data);
    this.rev++;

    const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/.exec(data);

    if (paste !== null) {
      this.box += paste[1]!;
    } else if (data === CLEAR_LINE) {
      // As Claude Code's: the text before the cursor on its line, or at a line's start the line break before it.
      if (this.clears) {
        this.box = this.box.endsWith('\n') ? this.box.slice(0, -1) : this.box.slice(0, this.box.lastIndexOf('\n') + 1);
        this.rev++;
      }
    } else if (data === '\r') {
      if (this.dropEnters > 0) {
        this.dropEnters--;
      } else if (this.box !== '') {
        const command = this.runsCommands ? /^\/(\S+)(?: (.*))?$/.exec(this.box) : null;

        if (this.saves) {
          appendFileSync(this.transcript, `${user(command === null ? this.box : `<command-message>${command[1]}</command-message>\n<command-name>/${command[1]}</command-name>${command[2] === undefined ? '' : `\n<command-args>${command[2]}</command-args>`}`, this.clock)}\n`);
        }

        this.box = '';
        // Claude redraws.
        this.rev++;
      }
    }

    return { rev: this.rev };
  }

  deps(overrides: Partial<ConstructorParameters<typeof SessionInput>[1]> = {}) {
    const logs: string[] = [];
    const reservations = { taken: 0, released: 0 };

    return {
      logs,
      reservations,
      deps: {
        snapshot: async () => ({ data: drawn(this.box.split('\n').join('\r\n  '), this.menu), cols: 40, rows: 8, rev: this.rev, keyAt: this.keyAt }),
        write: async (data: string) => this.write(data),
        transcriptPath: () => this.transcript,
        check: () => null,
        reserve: async () => {
          reservations.taken++;
          return { release: () => void reservations.released++ };
        },
        now: () => this.clock,
        sleep: async (ms: number) => {
          this.clock += ms;
          // A macrotask, as a real sleep is, so a loop that polls an unchanged screen lets the test's own timers run.
          await new Promise((resolve) => setImmediate(resolve));
        },
        log: (line: string) => logs.push(line),
        ...overrides,
      },
    };
  }
}

describe('SessionInput', () => {
  it('types a slash command chosen from the list as it is, and a message that starts with one escaped, each confirmed by the transcript', async () => {
    const session = new FakeSession();
    const { deps } = session.deps();
    const input = new SessionInput('s1', deps);
    const outcomes: InputOutcome[] = [];

    session.runsCommands = true;
    await input.send('/compact keep the plan', (outcome) => outcomes.push(outcome), { command: true });
    await input.send('/compact is what I meant', (outcome) => outcomes.push(outcome));

    expect(session.writes).toEqual(['\u001b[200~/compact keep the plan\u001b[201~', '\r', '\u001b[200~\\/compact is what I meant\u001b[201~', '\r']);
    expect(outcomes).toEqual([{ delivery: 'sent' }, { delivery: 'sent' }]);
  });

  it('reports when each step happened, and counts the message sent as soon as the transcript has it, without waiting for the screen check', async () => {
    const session = new FakeSession();
    const { deps } = session.deps();
    const outcomes: InputOutcome[] = [];
    let steps: InputSteps | null = null;

    await new SessionInput('s1', deps).send('Fix the build', (outcome) => outcomes.push(outcome), { steps: (reported) => void (steps = reported) });

    expect(outcomes).toEqual([{ delivery: 'sent' }]);
    // Two guard reads and one after the settle, which shows the paste; the transcript has the message at its Enter, so no 400 ms screen check.
    expect(steps).toEqual({ queuedAt: T0, startedAt: T0, readyAt: T0, waited: null, reads: 3, readMs: 0, pastedAt: T0, echoAt: T0 + 60, missed: null, enterAt: T0 + 60, enters: 1, confirmedAt: T0 + 60 });
    expect(session.clock).toBe(T0 + 60);
    expect(stepsText(steps!, session.clock)).toBe('queue 0 ms, guards 0 ms, paste→echo 60 ms, paste→Enter 60 ms, Enter→transcript 0 ms, 3 screen reads in 0 ms, 60 ms in all');
  });

  it('reports a paste never seen in the input box with what the screen showed, and the guard that held the message back', async () => {
    const session = new FakeSession();
    // The holder's screen lags: the box never shows the paste, though Claude Code has it.
    const { deps } = session.deps({ snapshot: async () => ({ data: drawn(''), cols: 40, rows: 8, rev: session.rev, keyAt: session.keyAt }) });
    let steps: InputSteps | null = null;

    session.keyAt = T0 - 1_000;
    await new SessionInput('s1', deps).send('Fix the build', () => undefined, { steps: (reported) => void (steps = reported) });

    expect(steps!.waited).toBe('a key was typed in a terminal');
    expect(steps!.echoAt).toBeNull();
    expect(steps!.missed).toBe('the input box is empty');
    expect(steps!.enterAt! - steps!.pastedAt!).toBeGreaterThanOrEqual(1_000);
    expect(stepsText(steps!, session.clock)).toMatch(/^queue 0 ms, guards [5-9]\d{2} ms \(waited: a key was typed in a terminal\), paste→echo not seen \(the input box is empty\), paste→Enter 1\d{3} ms, Enter→transcript \d+ ms, \d+ screen reads in 0 ms, \d+ ms in all$/);

    const menu = new FakeSession();
    const shown = menu.deps({ snapshot: async () => ({ data: drawn('', menu.writes.length > 0), cols: 40, rows: 8, rev: menu.rev, keyAt: null }) });

    await new SessionInput('s1', shown.deps).send('Fix the build', () => undefined, { steps: (reported) => void (steps = reported) });
    expect(steps!.missed).toBe('a menu is open');
  });

  it('counts the screen reads and the transcript of a message settled from the input box, and a guard met under the reservation', async () => {
    const late = new FakeSession();
    let snapshots = 0;
    const counted = late.deps();
    const deps = { ...counted.deps, snapshot: () => (snapshots++, counted.deps.snapshot()) };
    let steps: InputSteps | null = null;

    // Claude takes the message and never saves it, so the box settles it.
    late.saves = false;
    await new SessionInput('s1', deps).send('Fix the build', () => undefined, { steps: (reported) => void (steps = reported) });
    // The settlement's read of the box counts with the others.
    expect(steps!.reads).toBe(snapshots);
    expect(steps!.confirmedAt).toBeNull();

    const menu = new FakeSession();
    let first = true;
    const guarded = menu.deps({
      reserve: async () => {
        if (first) {
          first = false;
          menu.menu = true;
        }

        return { release: () => undefined };
      },
      sleep: async (ms: number) => {
        menu.clock += ms;
        menu.menu = false;
        await Promise.resolve();
      },
    });

    await new SessionInput('s1', guarded.deps).send('Fix the build', () => undefined, { steps: (reported) => void (steps = reported) });
    expect(steps!.waited).toBe('a menu is open');
  });

  it('waits for the pause after a key typed in a terminal, pastes, presses Enter separately, and counts the message sent from the transcript', async () => {
    const session = new FakeSession();
    const { deps, reservations, logs } = session.deps();
    const input = new SessionInput('s1', deps);
    const outcomes: InputOutcome[] = [];

    session.keyAt = T0 - 500;
    await input.send('Fix the build', (outcome) => outcomes.push(outcome));

    expect(outcomes).toEqual([{ delivery: 'sent' }]);
    expect(session.writes).toEqual(['\u001b[200~Fix the build\u001b[201~', '\r']);
    expect(session.clock).toBeGreaterThanOrEqual(T0 + 1_000);
    expect(logs).toEqual(['session s1: a message waits, a key was typed in a terminal']);
    expect(reservations).toEqual({ taken: 1, released: 1 });
  });

  it('retries Enter alone when the first is dropped, never pasting again', async () => {
    const session = new FakeSession();
    const { deps } = session.deps();
    const outcomes: InputOutcome[] = [];

    session.dropEnters = 1;
    await new SessionInput('s1', deps).send('/compact please', (outcome) => outcomes.push(outcome));

    expect(outcomes).toEqual([{ delivery: 'sent' }]);
    expect(session.writes).toEqual(['\u001b[200~\\/compact please\u001b[201~', '\r', '\r']);
  });

  it('settles a message the transcript never shows from the input box: sent once the box no longer holds it, cleared and not sent while it does', async () => {
    const session = new FakeSession();
    const { deps, reservations, logs } = session.deps();
    const outcomes: InputOutcome[] = [];

    // Claude took the Enter, so the box emptied, but the transcript never showed it: sent, and its line places it if it lands.
    session.saves = false;
    await new SessionInput('s1', deps).send('Hello', (outcome) => outcomes.push(outcome));
    expect(outcomes).toEqual([{ delivery: 'sent' }]);
    expect(session.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r']);
    expect(reservations).toEqual({ taken: 1, released: 1 });
    expect(logs.at(-1)).toBe('session s1: a typed message is not in the transcript yet and not in the input box; counted as sent');

    // Enters that never take leave the text in the box, which is cleared one Ctrl+U at a time, three for two lines, under the reservation.
    const stuck = new FakeSession();
    const stuckDeps = stuck.deps();
    const stuckOutcomes: InputOutcome[] = [];

    stuck.dropEnters = 99;
    await new SessionInput('s1', stuckDeps.deps).send('Hello\nthere', (outcome) => stuckOutcomes.push(outcome));
    expect(stuckOutcomes).toEqual([{ delivery: 'not-sent', error: NOT_TAKEN }]);
    expect(stuck.writes).toEqual(['\u001b[200~Hello\nthere\u001b[201~', '\r', '\r', '\r', '\r', CLEAR_LINE, CLEAR_LINE, CLEAR_LINE]);
    expect(stuck.box).toBe('');
    expect(stuckDeps.reservations).toEqual({ taken: 1, released: 1 });

    // A box that does not clear is left as it is after a bounded number of keys, and the message is not sent.
    const fixed = new FakeSession();
    const fixedOutcomes: InputOutcome[] = [];

    fixed.dropEnters = 99;
    fixed.clears = false;
    await new SessionInput('s1', fixed.deps().deps).send('Hello', (outcome) => fixedOutcomes.push(outcome));
    expect(fixedOutcomes).toEqual([{ delivery: 'not-sent', error: NOT_CLEARED }]);
    expect(fixed.writes.filter((data) => data === CLEAR_LINE)).toHaveLength(4);

    // Never a paste again, and nothing cleared that is not the message, such as text typed in the terminal after it went.
    const other = new FakeSession();
    const otherOutcomes: InputOutcome[] = [];
    const otherDeps = other.deps({
      write: async (data: string) => {
        const answer = other.write(data);

        if (data === '\r') {
          other.box = 'typed by hand';
        }

        return answer;
      },
    });

    other.saves = false;
    await new SessionInput('s1', otherDeps.deps).send('Hello', (outcome) => otherOutcomes.push(outcome));
    expect(otherOutcomes).toEqual([{ delivery: 'sent' }]);
    expect(other.writes.filter((data) => data.startsWith('\u001b[200~') || data === CLEAR_LINE)).toEqual(['\u001b[200~Hello\u001b[201~']);
  });

  it("never clears the operator's own text: a box with more than the message, one a terminal typed into, or text that changed under a key", async () => {
    const outcomes: InputOutcome[] = [];

    // The operator added to the stuck message in the terminal.
    const more = new FakeSession();

    more.dropEnters = 99;
    await new SessionInput('s1', more.deps({ write: async (data: string) => { const answer = more.write(data); if (data === '\r') more.box = 'Hello and mine'; return answer; } }).deps).send('Hello', (outcome) => outcomes.push(outcome));

    // A key typed in a terminal since the paste.
    const typed = new FakeSession();

    typed.dropEnters = 99;
    await new SessionInput('s1', typed.deps({ write: async (data: string) => { const answer = typed.write(data); if (data === '\r') typed.keyAt = typed.clock; return answer; } }).deps).send('Hello', (outcome) => outcomes.push(outcome));

    // The box changed to other text after the first Ctrl+U.
    const changed = new FakeSession();

    changed.dropEnters = 99;
    await new SessionInput('s1', changed.deps({ write: async (data: string) => { const answer = changed.write(data); if (data === CLEAR_LINE) changed.box = 'one\nmine'; return answer; } }).deps).send('one\ntwo', (outcome) => outcomes.push(outcome));

    expect(outcomes).toEqual([
      { delivery: 'not-sent', error: NOT_CLEARED },
      { delivery: 'not-sent', error: NOT_CLEARED },
      { delivery: 'not-sent', error: NOT_CLEARED },
    ]);
    expect([more.box, typed.box, changed.box]).toEqual(['Hello and mine', 'Hello', 'one\nmine']);
    expect([more.writes, typed.writes].map((writes) => writes.filter((data) => data === CLEAR_LINE))).toEqual([[], []]);
    expect(changed.writes.filter((data) => data === CLEAR_LINE)).toHaveLength(1);
  });

  it('counts a message sent when the transcript shows it as a clearing write fails or the screen cannot be read after it', async () => {
    const outcomes: InputOutcome[] = [];

    for (const fails of ['write', 'read'] as const) {
      const session = new FakeSession();
      let cleared = false;
      const base = session.deps().deps;

      session.dropEnters = 99;
      await new SessionInput('s1', {
        ...base,
        write: async (data: string) => {
          if (data !== CLEAR_LINE) {
            return session.write(data);
          }

          // Claude takes the message late, as the clearing key fails or its screen read does.
          appendFileSync(session.transcript, `${user('Hello', session.clock)}\n`);
          cleared = true;

          if (fails === 'write') {
            throw new Error('The terminal holder closed the connection.');
          }

          return session.write(data);
        },
        snapshot: async () => (cleared && fails === 'read' ? Promise.reject(new Error('The terminal holder did not answer.')) : base.snapshot()),
      }).send('Hello', (outcome) => outcomes.push(outcome));
    }

    expect(outcomes).toEqual([{ delivery: 'sent' }, { delivery: 'sent' }]);
  });

  it('counts a message sent when the transcript shows it while the box is being cleared', async () => {
    const session = new FakeSession();
    const outcomes: InputOutcome[] = [];
    const { deps } = session.deps({
      write: async (data: string) => {
        // Claude takes the message late, as the first Ctrl+U arrives.
        if (data === CLEAR_LINE) {
          appendFileSync(session.transcript, `${user('one\ntwo', session.clock)}\n`);
        }

        return session.write(data);
      },
    });

    session.dropEnters = 99;
    await new SessionInput('s1', deps).send('one\ntwo', (outcome) => outcomes.push(outcome));
    expect(outcomes).toEqual([{ delivery: 'sent' }]);
    expect(session.writes.filter((data) => data === CLEAR_LINE)).toHaveLength(1);
  });

  it('waits while a menu is open or a draft is in the box, and types nothing once the session can no longer take it', async () => {
    const session = new FakeSession();
    let why: string | null = null;
    const { deps, reservations, logs } = session.deps({ check: () => why });
    const outcomes: InputOutcome[] = [];

    session.menu = true;

    const sending = new SessionInput('s1', deps).send('Hello', (outcome) => outcomes.push(outcome));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.writes).toEqual([]);
    why = 'The session has ended. Open it in the terminal to resume it.';
    await sending;
    expect(outcomes).toEqual([{ delivery: 'not-sent', error: 'The session has ended. Open it in the terminal to resume it.' }]);
    expect(session.writes).toEqual([]);
    expect(reservations.taken).toBe(0);
    expect(logs).toEqual(['session s1: a message waits, a menu is open']);

    const drafted = new FakeSession();
    const draftOutcomes: InputOutcome[] = [];
    const draftDeps = drafted.deps();

    drafted.box = 'typed by hand';

    const waiting = new SessionInput('s1', draftDeps.deps).send('Hello', (outcome) => draftOutcomes.push(outcome));

    // The log comes after the first screen read, which replays the screen on a real timer.
    await vi.waitFor(() => expect(draftDeps.logs).toEqual(['session s1: a message waits, the input box holds a draft']), { timeout: 4_000 });
    expect(drafted.writes).toEqual([]);
    drafted.box = '';
    await waiting;
    expect(draftOutcomes).toEqual([{ delivery: 'sent' }]);
  });

  it('types nothing when the reservation is refused, and releases a reservation whose screen changed meanwhile', async () => {
    const session = new FakeSession();
    const refused = session.deps({ reserve: async () => ({ refused: 'The session has ended. Open it in the terminal to resume it.' }) });
    const outcomes: InputOutcome[] = [];

    await new SessionInput('s1', refused.deps).send('Hello', (outcome) => outcomes.push(outcome));
    expect(outcomes).toEqual([{ delivery: 'not-sent', error: 'The session has ended. Open it in the terminal to resume it.' }]);
    expect(session.writes).toEqual([]);

    // A key typed while the reservation waited sends the message back to waiting, with the reservation released.
    const typed = new FakeSession();
    let first = true;
    const released: number[] = [];
    const deps = typed.deps({
      reserve: async () => {
        if (first) {
          first = false;
          typed.keyAt = typed.clock;
        }

        return { release: () => void released.push(typed.clock) };
      },
    });

    await new SessionInput('s1', deps.deps).send('Hello', (outcome) => outcomes.push(outcome));
    expect(outcomes.at(-1)).toEqual({ delivery: 'sent' });
    expect(released).toHaveLength(2);
    expect(typed.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r']);
  });

  it('types one message at a time, in order, and settles one whose write failed from the screen', async () => {
    const session = new FakeSession();
    const { deps } = session.deps();
    const input = new SessionInput('s1', deps);
    const outcomes: string[] = [];

    await Promise.all([input.send('one', (outcome) => outcomes.push(`one ${outcome.delivery}`)), input.send('two', (outcome) => outcomes.push(`two ${outcome.delivery}`))]);
    expect(outcomes).toEqual(['one sent', 'two sent']);
    expect(session.writes).toEqual(['\u001b[200~one\u001b[201~', '\r', '\u001b[200~two\u001b[201~', '\r']);

    const failing = new FakeSession();
    let writes = 0;
    const failed: InputOutcome[] = [];
    const broken = failing.deps({
      write: async (data: string) => {
        if (++writes > 1) {
          throw new Error('Session s1 has ended.');
        }

        return failing.write(data);
      },
    });
    const gone = new FakeSession().deps({ write: async () => Promise.reject(new NotWritten('No session s1 is held.')) });
    // A write whose answer was lost may have reached the session.
    const lost = new FakeSession().deps({ write: async () => Promise.reject(new Error('The terminal holder closed the connection.')) });

    await new SessionInput('s1', broken.deps).send('Hello', (outcome) => failed.push(outcome));
    await new SessionInput('s1', gone.deps).send('Hello', (outcome) => failed.push(outcome));
    await new SessionInput('s1', lost.deps).send('Hello', (outcome) => failed.push(outcome));
    // The pasted text still in the box could not be cleared, as the session ended; a lost write left the box empty, so it counts as sent.
    expect(failed).toEqual([
      { delivery: 'not-sent', error: 'Session s1 has ended.' },
      { delivery: 'not-sent', error: 'No session s1 is held.' },
      { delivery: 'sent' },
    ]);
    expect(failing.box).toBe('Hello');
    expect([gone.reservations, lost.reservations]).toEqual([{ taken: 1, released: 1 }, { taken: 1, released: 1 }]);
    expect(broken.reservations).toEqual({ taken: 1, released: 1 });
  });
});

describe('the input box and the typed message', () => {
  it("tells the message alone, however it wraps or as Claude Code's placeholder for a long paste, from the message with other text, and what Ctrl+U leaves of it", () => {
    expect(isMessage('Fix the build in\nthe inbox', 'Fix the build in the inbox')).toBe(true);
    expect(isMessage('[Pasted text #1]', 'x'.repeat(2_000))).toBe(true);
    expect(isMessage('[Pasted text #2 +29 lines]', 'a\nb')).toBe(true);
    expect(isMessage('', 'Hello')).toBe(false);
    expect(isMessage('Hello and more', 'Hello')).toBe(false);
    expect(isMessage('[Pasted text #2 +29 lines] mine', 'a\nb')).toBe(false);
    expect(boxHolds('Hello and more', 'Hello')).toBe(true);
    expect(boxHolds('mine [Pasted text #3]', 'a\nb')).toBe(true);
    expect(boxHolds('typed by hand', 'Hello')).toBe(false);
    expect(leftOfMessage('one\ntwo', 'one\ntwo\nthree')).toBe(true);
    expect(leftOfMessage('one\nother', 'one\ntwo\nthree')).toBe(false);
    expect(leftOfMessage('', 'one')).toBe(false);
  });
});

describe('SessionInput.resolve', () => {
  const ANY_LAUNCH = { check: () => null, reserve: async () => ({ release: () => undefined }) };

  it('clears nothing from a session resumed under another launch, and holds the launch it was typed into', async () => {
    const outcomes: InputOutcome[] = [];
    const held = new FakeSession();
    const reserved: string[] = [];

    held.box = 'Hello';
    await new SessionInput('s1', held.deps().deps).resolve('Hello', T0, (outcome) => outcomes.push(outcome), UNREADABLE, {
      check: () => 'The session was resumed since the view showed it; send the message again.',
      reserve: async () => (reserved.push('launch-1'), { release: () => undefined }),
    });
    expect(outcomes).toEqual([{ delivery: 'not-sent', error: 'The session was resumed since the view showed it; send the message again.' }]);
    expect(held.writes).toEqual([]);
    expect(held.box).toBe('Hello');
    expect(reserved).toEqual(['launch-1']);
  });

  it('settles a message a stopped hub left being typed: sent from the transcript or an empty box, cleared and not sent from a box holding it', async () => {
    const outcomes: InputOutcome[] = [];

    const confirmed = new FakeSession();

    appendFileSync(confirmed.transcript, `${user('Hello', T0 + 10)}\n`);
    await new SessionInput('s1', confirmed.deps().deps).resolve('Hello', T0, (outcome) => outcomes.push(outcome), UNREADABLE, ANY_LAUNCH);

    const empty = new FakeSession();

    await new SessionInput('s1', empty.deps().deps).resolve('Hello', T0, (outcome) => outcomes.push(outcome), UNREADABLE, ANY_LAUNCH);

    const held = new FakeSession();
    const heldDeps = held.deps();

    held.box = 'Hello';
    await new SessionInput('s1', heldDeps.deps).resolve('Hello', T0, (outcome) => outcomes.push(outcome), UNREADABLE, { check: heldDeps.deps.check, reserve: heldDeps.deps.reserve });

    expect(outcomes).toEqual([{ delivery: 'sent' }, { delivery: 'sent' }, { delivery: 'not-sent', error: NOT_TAKEN }]);
    expect([confirmed.writes, empty.writes, held.writes]).toEqual([[], [], [CLEAR_LINE]]);
    expect(heldDeps.reservations).toEqual({ taken: 1, released: 1 });
  });

  it('waits for the holder to show the screen, and leaves a message whose screen it never reads not sent', async () => {
    const outcomes: InputOutcome[] = [];
    const late = new FakeSession();
    let reads = 0;
    const lateDeps = late.deps();

    late.box = 'Hello';
    await new SessionInput('s1', { ...lateDeps.deps, snapshot: async () => (++reads < 3 ? Promise.reject(new Error('The terminal holder is not connected.')) : lateDeps.deps.snapshot()) }).resolve('Hello', T0, (outcome) => outcomes.push(outcome), UNREADABLE, ANY_LAUNCH);

    const never = new FakeSession();

    await new SessionInput('s1', { ...never.deps().deps, snapshot: async () => Promise.reject(new Error('The terminal holder is not connected.')) }).resolve('Hello', T0, (outcome) => outcomes.push(outcome), 'Restarted.', ANY_LAUNCH, 1_000);

    expect(outcomes).toEqual([{ delivery: 'not-sent', error: NOT_TAKEN }, { delivery: 'not-sent', error: 'Restarted.' }]);
    expect(never.writes).toEqual([]);
  });
});

describe('SessionInput against a session that changes', () => {
  it('presses no further Enter once the session was resumed under another launch, and says when it pastes', async () => {
    const session = new FakeSession();
    let launch = 'launch-1';
    // The session is resumed under another launch just after the first Enter.
    const { deps } = session.deps({
      write: async (data: string) => {
        const answer = session.write(data);

        if (data === '\r') {
          launch = 'launch-2';
        }

        return answer;
      },
    });
    const outcomes: InputOutcome[] = [];
    const pastes: number[] = [];

    session.dropEnters = 99;

    const sending = new SessionInput('s1', deps).send('Hello', (outcome) => outcomes.push(outcome), {
      check: () => (launch === 'launch-1' ? null : 'The session was resumed since the view showed it; send the message again.'),
      pasting: (at) => pastes.push(at),
    });

    await sending;
    expect(session.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r']);
    // The text it left in the box is not cleared from a session resumed under another launch.
    expect(outcomes).toEqual([{ delivery: 'not-sent', error: 'The session was resumed since the view showed it; send the message again.' }]);
    expect(session.writes).not.toContain(CLEAR_LINE);
    expect(pastes).toHaveLength(1);
  });

  it('releases the reservation when the screen cannot be read under it, and counts pending messages', async () => {
    const session = new FakeSession();
    let reads = 0;
    const { deps, reservations } = session.deps();
    const failing = { ...deps, snapshot: async () => (++reads > 1 ? Promise.reject(new Error('The terminal holder did not answer.')) : deps.snapshot()) };
    const input = new SessionInput('s1', failing);
    const outcomes: InputOutcome[] = [];
    const sending = input.send('Hello', (outcome) => outcomes.push(outcome));

    expect(input.pending).toBe(1);
    await sending;
    expect(input.pending).toBe(0);
    expect(outcomes).toEqual([{ delivery: 'not-sent', error: 'The terminal holder did not answer.' }]);
    expect(reservations).toEqual({ taken: 1, released: 1 });
    expect(session.writes).toEqual([]);
  });
});

describe('pasteAndSubmit', () => {
  it('stops pressing Enter once the transcript has the message, whatever the screen shows', async () => {
    let clock = T0;
    let sent = false;
    const writes: string[] = [];
    // The screen copy lags: the text stays in the box after the Enter.
    const screen: SubmitScreen = { unsent: true, box: 'box with text', rev: 1 };
    const result = await pasteAndSubmit('hi', {
      write: async (data) => {
        writes.push(data);
        sent = data === '\r';
        return 1;
      },
      read: async () => screen,
      sent: () => sent,
      now: () => clock,
      wait: async (ms) => void (clock += ms),
    });

    expect(writes).toEqual(['\u001b[200~hi\u001b[201~', '\r']);
    expect(result).toEqual({ enterAt: T0 + 60, enterAttempts: 1, submitted: true });
  });

  it('reads the transcript every 50 ms after an Enter and stops when it has the message, before the 400 ms screen check', async () => {
    let clock = T0;
    let enterAt = Infinity;
    let reads = 0;
    const result = await pasteAndSubmit('hi', {
      write: async (data) => {
        enterAt = data === '\r' ? clock : enterAt;
        return 1;
      },
      read: async () => (reads++, { unsent: true, box: 'box with text', rev: 1 }),
      // Claude saves the message 130 ms after the Enter.
      sent: () => clock >= enterAt + 130,
      now: () => clock,
      wait: async (ms) => void (clock += ms),
    });

    expect(result).toEqual({ enterAt: T0 + 60, enterAttempts: 1, submitted: true });
    expect(clock).toBe(T0 + 60 + 150);
    // The read after the settle only: none after the Enter.
    expect(reads).toBe(1);
  });
});
