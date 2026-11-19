import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotWritten, SessionInput, blockedBy, pasteAndSubmit, pasteText, readInputScreen, sentInTranscript } from '../src/input.js';
import type { InputOutcome, SubmitScreen } from '../src/input.js';

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
    expect(pasteText('@file.ts')).toBe('\\@file.ts');
    expect(pasteText('& run')).toBe('\\& run');
    expect(pasteText('a/b')).toBe('a/b');
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
    } else if (data === '\r') {
      if (this.dropEnters > 0) {
        this.dropEnters--;
      } else if (this.box !== '') {
        if (this.saves) {
          appendFileSync(this.transcript, `${user(this.box, this.clock)}\n`);
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
        snapshot: async () => ({ data: drawn(this.box.split('\n')[0]!, this.menu), cols: 40, rows: 6, rev: this.rev, keyAt: this.keyAt }),
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
          await Promise.resolve();
        },
        log: (line: string) => logs.push(line),
        ...overrides,
      },
    };
  }
}

describe('SessionInput', () => {
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

  it('marks a message uncertain when the transcript never shows it, after its Enter attempts, and never types it again', async () => {
    const session = new FakeSession();
    const { deps, reservations } = session.deps();
    const outcomes: InputOutcome[] = [];

    session.saves = false;
    await new SessionInput('s1', deps).send('Hello', (outcome) => outcomes.push(outcome));
    expect(outcomes).toEqual([{ delivery: 'uncertain', error: 'The transcript does not show the message.' }]);
    expect(session.writes.filter((data) => data.startsWith('\u001b[200~'))).toHaveLength(1);
    expect(reservations.released).toBe(1);

    // Enters that never take leave the text in the box, which the operator is told to check.
    const stuck = new FakeSession();
    const stuckOutcomes: InputOutcome[] = [];

    stuck.dropEnters = 99;
    await new SessionInput('s1', stuck.deps().deps).send('Hello', (outcome) => stuckOutcomes.push(outcome));
    expect(stuckOutcomes).toEqual([{ delivery: 'uncertain', error: 'The message is still in the input box; check the terminal.' }]);
    expect(stuck.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r', '\r', '\r', '\r']);
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drafted.writes).toEqual([]);
    expect(draftDeps.logs).toEqual(['session s1: a message waits, the input box holds a draft']);
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

  it('types one message at a time, in order, and says what failed: not sent before the paste, uncertain after it', async () => {
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
    expect(failed).toEqual([
      { delivery: 'uncertain', error: 'Session s1 has ended.' },
      { delivery: 'not-sent', error: 'No session s1 is held.' },
      { delivery: 'uncertain', error: 'The terminal holder closed the connection.' },
    ]);
    expect([gone.reservations, lost.reservations]).toEqual([{ taken: 1, released: 1 }, { taken: 1, released: 1 }]);
    expect(broken.reservations).toEqual({ taken: 1, released: 1 });
  });
});

describe('SessionInput against a session that changes', () => {
  it('presses no further Enter once the session was resumed under another launch, and says when it pastes', async () => {
    const session = new FakeSession();
    let launch = 'launch-1';
    const { deps } = session.deps();
    const outcomes: InputOutcome[] = [];
    const pastes: number[] = [];

    session.dropEnters = 99;

    const sending = new SessionInput('s1', deps).send('Hello', (outcome) => outcomes.push(outcome), {
      check: () => (launch === 'launch-1' ? null : 'The session was resumed since the view showed it; send the message again.'),
      pasting: (at) => pastes.push(at),
    });

    await vi.waitFor(() => expect(session.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r']));
    launch = 'launch-2';
    await sending;
    expect(session.writes).toEqual(['\u001b[200~Hello\u001b[201~', '\r']);
    expect(outcomes).toEqual([{ delivery: 'uncertain', error: 'The session was resumed since the view showed it; send the message again.' }]);
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
});
