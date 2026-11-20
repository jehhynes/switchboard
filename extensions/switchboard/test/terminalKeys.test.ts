import { describe, expect, it, vi } from 'vitest';
import type { KeyedTerminal, KeyState } from '../src/terminalKeys.js';
import { TERMINAL_PIDS, TerminalKeys } from '../src/terminalKeys.js';

interface Fake extends KeyedTerminal {
  label: string;
  exitStatus: { code: number } | undefined;
}

function fake(label: string, pid: number | undefined | 'never'): Fake {
  return { label, exitStatus: undefined, processId: pid === 'never' ? new Promise(() => {}) : Promise.resolve(pid) };
}

/** Workspace state that survives a "reload": each new TerminalKeys over it stands for a restarted extension host. */
function memento(initial: Record<string, unknown> = {}): KeyState & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = { ...initial };

  return {
    values,
    get: <T>(key: string) => values[key] as T | undefined,
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        delete values[key];
      } else {
        values[key] = value;
      }

      return Promise.resolve();
    },
  };
}

describe('TerminalKeys', () => {
  it('finds the terminal it kept while it runs, and none once it exits or VS Code no longer lists it', async () => {
    const listed: Fake[] = [];
    const keys = new TerminalKeys<Fake>(() => listed, memento());
    const terminal = fake('a', 100);

    listed.push(terminal);
    await keys.keep('attach:s1', terminal);
    expect(await keys.find('attach:s1')).toBe(terminal);

    terminal.exitStatus = { code: 0 };
    expect(await keys.find('attach:s1')).toBeUndefined();

    const other = fake('b', 101);

    listed.splice(0, listed.length, other);
    await keys.keep('attach:s1', other);
    listed.length = 0;
    expect(await keys.find('attach:s1')).toBeUndefined();
  });

  it('takes the terminal running the kept process after the extension host restarts, so the next click shows it instead of a duplicate', async () => {
    const state = memento();
    const before = fake('before reload', 4242);
    const unrelated = fake("the operator's shell", 77);

    await new TerminalKeys<Fake>(() => [before], state).keep('code:sb-1', before);
    expect(state.values[TERMINAL_PIDS]).toEqual({ 'code:sb-1': 4242 });

    // VS Code reconnects to the same process with a new Terminal object, whose creationOptions hold no shellPath, shellArgs or env.
    const reconnected = fake('reconnected', 4242);
    const listed = [unrelated, reconnected];
    const keys = new TerminalKeys<Fake>(() => listed, state);

    expect(await keys.find('code:sb-1')).toBe(reconnected);
    expect(state.values[TERMINAL_PIDS]).toEqual({ 'code:sb-1': 4242 });
    // Held again, so a stale entry for another key that names the same process cannot take it.
    expect(await keys.find('code:sb-1')).toBe(reconnected);
  });

  it('takes no terminal whose process differs, such as one VS Code revived after it quit, and drops the stale entry', async () => {
    const state = memento({ [TERMINAL_PIDS]: { 'attach:s2': 500, 'resume:s3': 600 } });
    const revived = fake('revived', 501);
    const keys = new TerminalKeys<Fake>(() => [revived, fake('resume', 600)], state);

    expect(await keys.find('attach:s2')).toBeUndefined();
    expect(state.values[TERMINAL_PIDS]).toEqual({ 'resume:s3': 600 });
  });

  it('takes no terminal that has exited, and none another key already holds', async () => {
    const state = memento({ [TERMINAL_PIDS]: { 'attach:s4': 700, 'resume:s4': 700 } });
    const exited = fake('exited', 700);

    exited.exitStatus = { code: 1 };
    expect(await new TerminalKeys<Fake>(() => [exited], state).find('attach:s4')).toBeUndefined();

    const shared = fake('one terminal', 700);
    const keys = new TerminalKeys<Fake>(() => [shared], memento({ [TERMINAL_PIDS]: { 'attach:s4': 700, 'resume:s4': 700 } }));

    expect(await keys.find('attach:s4')).toBe(shared);
    expect(await keys.find('resume:s4')).toBeUndefined();
  });

  it('finds nothing without workspace state, a kept entry, or a well-formed entry', async () => {
    const terminal = fake('t', 9);

    expect(await new TerminalKeys<Fake>(() => [terminal]).find('attach:s5')).toBeUndefined();
    expect(await new TerminalKeys<Fake>(() => [terminal], memento()).find('attach:s5')).toBeUndefined();
    expect(await new TerminalKeys<Fake>(() => [terminal], memento({ [TERMINAL_PIDS]: 'junk' })).find('attach:s5')).toBeUndefined();
    expect(await new TerminalKeys<Fake>(() => [terminal], memento({ [TERMINAL_PIDS]: { 'attach:s5': '9' } })).find('attach:s5')).toBeUndefined();
  });

  it('keeps no process ID for a terminal that reports none, and keeps one that comes after the lookup wait', async () => {
    vi.useFakeTimers();
    const state = memento();
    const keys = new TerminalKeys<Fake>(() => [], state);
    let report: (pid: number) => void = () => {};
    const late: Fake = { label: 'late', exitStatus: undefined, processId: new Promise((resolve) => (report = resolve)) };

    await keys.keep('attach:s7', fake('none', undefined));
    expect(state.values).toEqual({});

    const kept = keys.keep('attach:s6', late);

    try {
      await vi.advanceTimersByTimeAsync(5_000);
      report(66);
      await kept;
      expect(state.values[TERMINAL_PIDS]).toEqual({ 'attach:s6': 66 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting for a process ID after a second, and drops no entry while one has not come', async () => {
    vi.useFakeTimers();

    try {
      // A terminal whose process ID never comes does not block finding one that runs the kept process.
      const state = memento({ [TERMINAL_PIDS]: { 'attach:s8': 8, 'attach:s10': 10 } });
      const target = fake('target', 8);
      const found = new TerminalKeys<Fake>(() => [fake('stuck', 'never'), target], state).find('attach:s8');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await found).toBe(target);
      // The stuck terminal may run process 10.
      expect(state.values[TERMINAL_PIDS]).toEqual({ 'attach:s8': 8, 'attach:s10': 10 });

      const missed = new TerminalKeys<Fake>(() => [fake('stuck', 'never')], state).find('attach:s10');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await missed).toBeUndefined();
      expect(state.values[TERMINAL_PIDS]).toEqual({ 'attach:s8': 8, 'attach:s10': 10 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the process ID of a terminal it held once that ends, so a terminal given the same process ID later is not taken', async () => {
    const state = memento();
    const listed: Fake[] = [];
    const keys = new TerminalKeys<Fake>(() => listed, state);
    const first = fake('first', 300);

    listed.push(first);
    await keys.keep('attach:s11', first);
    first.exitStatus = { code: 0 };
    listed.push(fake("the operator's shell, given the same process ID", 300));

    expect(await keys.find('attach:s11')).toBeUndefined();
    expect(state.values).toEqual({});
    expect(await keys.find('attach:s11')).toBeUndefined();
  });

  it('takes no terminal that closed while the state was written', async () => {
    const target = fake('target', 14);
    const listed: Fake[] = [target];
    const state = memento({ [TERMINAL_PIDS]: { 'attach:s14': 14 } });
    const update = state.update;

    state.update = (key, value) => {
      listed.length = 0;
      return update(key, value);
    };

    expect(await new TerminalKeys<Fake>(() => listed, state).find('attach:s14')).toBeUndefined();
  });

  it('takes no terminal that closed while the process IDs were awaited', async () => {
    let report: (pid: number) => void = () => {};
    const slow: Fake = { label: 'slow', exitStatus: undefined, processId: new Promise((resolve) => (report = resolve)) };
    const target = fake('target', 12);
    const listed: Fake[] = [slow, target];
    const found = new TerminalKeys<Fake>(() => listed, memento({ [TERMINAL_PIDS]: { 'attach:s12': 12 } })).find('attach:s12');

    listed.splice(1, 1);
    report(13);
    expect(await found).toBeUndefined();
  });

  it('keeps an entry written while it read the listed process IDs', async () => {
    const state = memento({ [TERMINAL_PIDS]: { 'attach:old': 1 } });
    let report: (pid: number) => void = () => {};
    const slow: Fake = { label: 'slow', exitStatus: undefined, processId: new Promise((resolve) => (report = resolve)) };
    const keys = new TerminalKeys<Fake>(() => [slow], state);
    const found = keys.find('attach:old');

    await keys.keep('attach:new', fake('new', 2));
    report(3);
    expect(await found).toBeUndefined();
    expect(state.values[TERMINAL_PIDS]).toEqual({ 'attach:new': 2 });
  });

  it('keeps no process ID for a terminal replaced under its key before the ID came', async () => {
    const state = memento();
    const keys = new TerminalKeys<Fake>(() => [], state);
    let report: (pid: number) => void = () => {};
    const slow: Fake = { label: 'slow', exitStatus: undefined, processId: new Promise((resolve) => (report = resolve)) };
    const kept = keys.keep('attach:s9', slow);

    await keys.keep('attach:s9', fake('newer', 91));
    report(90);
    await kept;
    expect(state.values[TERMINAL_PIDS]).toEqual({ 'attach:s9': 91 });
  });

  it('runs the steps for one key in order, so a second click waits for the first to open its terminal, and a failed step does not stop the next', async () => {
    const keys = new TerminalKeys<Fake>(() => []);
    const order: string[] = [];
    let release: () => void = () => {};
    const first = keys.serial('k', () => new Promise<void>((resolve) => (release = resolve)).then(() => void order.push('first')));
    const failed = keys.serial('k', () => Promise.reject(new Error('refused')));
    const third = keys.serial('k', async () => void order.push('third'));
    const other = keys.serial('other', async () => void order.push('other key'));

    await other;
    expect(order).toEqual(['other key']);
    release();
    await first;
    await expect(failed).rejects.toThrow('refused');
    await third;
    expect(order).toEqual(['other key', 'first', 'third']);
  });
});
