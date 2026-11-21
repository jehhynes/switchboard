import { execPath } from 'node:process';
import { describe, expect, it } from 'vitest';
import { PANE_HELPER_MAX_CRASHES, PANE_HELPER_STOP_MS, PaneHelper, paneHelperReport, spawnPaneHelper } from '../src/paneHelper.js';
import type { PaneHelperProcess, PaneHelperReport } from '../src/paneHelper.js';

describe('paneHelperReport', () => {
  it('reads the helper’s reports and refuses anything else', () => {
    expect(paneHelperReport('{"state":"ready"}')).toEqual({ state: 'ready', marker: null });
    expect(paneHelperReport('{"state":"shown","marker":"0123456789ab","focused":true}')).toEqual({ state: 'shown', marker: '0123456789ab', focused: true });
    expect(paneHelperReport('{"state":"failed","marker":"0123456789ab","reason":"why"}')).toEqual({ state: 'failed', marker: '0123456789ab', reason: 'why' });
    expect(paneHelperReport('{"state":"moved","marker":null}')).toBeNull();
    expect(paneHelperReport('{"state":"shown","marker":1}')).toBeNull();
    expect(paneHelperReport('{"state":"shown","marker":null,"focused":"yes"}')).toBeNull();
    expect(paneHelperReport(JSON.stringify({ state: 'failed', marker: null, reason: 'x'.repeat(501) }))).toBeNull();
    expect(paneHelperReport('[]')).toBeNull();
    expect(paneHelperReport('not json')).toBeNull();
  });
});

class FakeProcess implements PaneHelperProcess {
  readonly pid = 77;
  readonly written: string[] = [];
  ended = false;
  killed = false;
  #line: (line: string) => void = () => {};
  #exit: (code: number | null, error: string | null) => void = () => {};
  #error: (line: string) => void = () => {};

  write(line: string): boolean {
    this.written.push(line);
    return !this.ended;
  }

  end(): void {
    this.ended = true;
  }

  kill(): void {
    this.killed = true;
  }

  onLine(listener: (line: string) => void): void {
    this.#line = listener;
  }

  onError(listener: (line: string) => void): void {
    this.#error = listener;
  }

  onExit(listener: (code: number | null, error: string | null) => void): void {
    this.#exit = listener;
  }

  line(text: string): void {
    this.#line(text);
  }

  stderr(text: string): void {
    this.#error(text);
  }

  exit(code: number | null): void {
    this.#exit(code, null);
  }
}

function setup(start?: () => Promise<{ process: PaneHelperProcess } | { error: string }>) {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; cleared: boolean }> = [];
  const processes: FakeProcess[] = [];
  const reports: PaneHelperReport[] = [];
  const stops: Array<string | null> = [];
  const log: string[] = [];
  const helper = new PaneHelper({
    start:
      start ??
      (async () => {
        const process = new FakeProcess();

        processes.push(process);
        return { process };
      }),
    report: (report) => reports.push(report),
    stopped: (error) => stops.push(error),
    log: (line) => log.push(line),
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run, cleared: false };

      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => void ((timer as { cleared: boolean }).cleared = true),
  });
  const advance = async (ms: number) => {
    now += ms;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= now)) {
      timer.cleared = true;
      timer.run();
    }

    await Promise.resolve();
    await Promise.resolve();
  };

  return { helper, processes, reports, stops, log, advance, timers };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('PaneHelper', () => {
  it('starts when wanted, passes on its reports once ready, and sends orders only to a ready helper', async () => {
    const { helper, processes, reports, log } = setup();

    expect(helper.send({ marker: null, rect: null })).toBe(false);
    helper.want(true);
    helper.want(true);
    await settle();
    expect(processes).toHaveLength(1);
    expect(helper.send({ marker: null, rect: null })).toBe(false);

    processes[0]!.line('{"state":"ready"}');
    processes[0]!.line('garbage');
    processes[0]!.stderr('Unhandled exception.');
    expect(helper.ready).toBe(true);
    expect(reports).toEqual([{ state: 'ready', marker: null }]);
    expect(log).toContain('pane helper: ignored a line: garbage');
    expect(log).toContain('pane helper: Unhandled exception.');

    expect(helper.send({ marker: '0123456789ab', rect: null })).toBe(true);
    expect(processes[0]!.written).toEqual(['{"type":"pane","marker":"0123456789ab","rect":null}']);
  });

  it('closes its input when no longer wanted, kills it if it has not exited, and counts that exit as no crash', async () => {
    const { helper, processes, stops, advance } = setup();

    helper.want(true);
    await settle();
    processes[0]!.line('{"state":"ready"}');
    helper.want(false);
    expect(processes[0]!.ended).toBe(true);
    expect(helper.send({ marker: null, rect: null })).toBe(false);
    await advance(PANE_HELPER_STOP_MS);
    expect(processes[0]!.killed).toBe(true);
    processes[0]!.exit(1);
    expect(stops).toEqual([null]);
    await advance(60_000);
    expect(processes).toHaveLength(1);
  });

  it('starts again at once when wanted again while it stopped', async () => {
    const { helper, processes } = setup();

    helper.want(true);
    await settle();
    helper.want(false);
    helper.want(true);
    expect(processes).toHaveLength(1);
    processes[0]!.exit(0);
    await settle();
    expect(processes).toHaveLength(2);
  });

  it('restarts a crashed helper after a growing wait, and gives up after crashes in a row until it is no longer wanted', async () => {
    const { helper, processes, stops, advance } = setup();

    helper.want(true);
    await settle();
    processes[0]!.exit(3);
    expect(stops).toEqual([null]);
    await advance(999);
    expect(processes).toHaveLength(1);
    await advance(1);
    expect(processes).toHaveLength(2);
    processes[1]!.exit(3);
    await advance(1_999);
    expect(processes).toHaveLength(2);
    await advance(1);
    expect(processes).toHaveLength(3);

    for (let crash = 3; crash < PANE_HELPER_MAX_CRASHES; crash++) {
      processes.at(-1)!.exit(3);
      await advance(60_000);
    }

    processes.at(-1)!.exit(3);
    expect(stops.at(-1)).toContain('keeps stopping');
    await advance(600_000);
    expect(processes).toHaveLength(PANE_HELPER_MAX_CRASHES);

    helper.want(false);
    helper.want(true);
    await settle();
    expect(processes).toHaveLength(PANE_HELPER_MAX_CRASHES + 1);
  });

  it('counts a crash after a long run as the first in a row', async () => {
    const { helper, processes, advance } = setup();

    helper.want(true);
    await settle();
    processes[0]!.exit(3);
    await advance(1_000);
    await advance(120_000);
    processes[1]!.exit(3);
    // A first crash waits one second again, not two.
    await advance(1_000);
    expect(processes).toHaveLength(3);
  });

  it('says why when it cannot start, and tries again only once it was not wanted', async () => {
    let starts = 0;
    const { helper, stops, advance } = setup(async () => (starts++, { error: 'The Chrome pane helper is not installed.' }));

    helper.want(true);
    await settle();
    expect(stops).toEqual(['The Chrome pane helper is not installed.']);
    await advance(600_000);
    expect(starts).toBe(1);
    helper.want(false);
    helper.want(true);
    await settle();
    expect(starts).toBe(2);
  });

  it('starts nothing after it was closed, even when a page still wants it as its last helper exits', async () => {
    const { helper, processes, stops } = setup();

    helper.want(true);
    await settle();
    processes[0]!.line('{"state":"ready"}');
    helper.close();
    expect(processes[0]!.ended).toBe(true);
    helper.want(true);
    processes[0]!.exit(0);
    await settle();
    expect(stops).toEqual([null]);
    helper.want(true);
    await settle();
    expect(processes).toHaveLength(1);
  });

  it('stops a helper that started after it was no longer wanted', async () => {
    let release: (value: { process: PaneHelperProcess }) => void = () => {};
    const process = new FakeProcess();
    const { helper } = setup(() => new Promise((done) => (release = done)));

    helper.want(true);
    helper.want(false);
    release({ process });
    await settle();
    expect(process.ended).toBe(true);
  });
});

describe('spawnPaneHelper', () => {
  it('runs a program over stdin and stdout lines and reports its exit, and a missing program as an exit with the error', async () => {
    const script = "process.stdout.write('{\"state\":\"ready\"}\\n'); process.stdin.on('data', (data) => process.stdout.write(data)); process.stdin.on('end', () => { console.error('bye'); process.exit(5); });";
    const helper = spawnPaneHelper(execPath, ['-e', script], process.env);
    const lines: string[] = [];
    const errors: string[] = [];
    const exited = new Promise<[number | null, string | null]>((done) => helper.onExit((code, error) => done([code, error])));

    helper.onLine((line) => {
      lines.push(line);

      if (lines.length === 1) {
        expect(helper.write('{"type":"pane","marker":null,"rect":null}')).toBe(true);
        helper.end();
      }
    });
    helper.onError((line) => errors.push(line));
    expect(await exited).toEqual([5, null]);
    expect(lines).toEqual(['{"state":"ready"}', '{"type":"pane","marker":null,"rect":null}']);
    expect(errors).toEqual(['bye']);
    expect(helper.write('late')).toBe(false);

    const missing = spawnPaneHelper('C:/no/such/helper.exe', [], process.env);
    const [code, error] = await new Promise<[number | null, string | null]>((done) => missing.onExit((one, two) => done([one, two])));

    expect(code).toBeNull();
    expect(error).toMatch(/ENOENT/);
  });
});
