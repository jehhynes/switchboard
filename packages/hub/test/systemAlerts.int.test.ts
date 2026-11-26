import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detachHelper, NOTIFY_SCRIPT } from '../src/systemAlerts.js';

/** This test process's process group. */
const getpgid = (): number => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());

describe.runIf(process.platform !== 'win32')('the Linux notification script', () => {
  const TITLE = '-x "it\'s" * $(touch pwned) `id` $HOME';
  const URL = 'http://127.0.0.1:47616/page/?a=1&b=$(id)#w=7';

  /** Runs NOTIFY_SCRIPT with a fake notify-send that answers `answer` to --wait; returns each program's arguments, one bracketed per argument. */
  function runScript(answer: { code: number; stdout: string }): { calls: string[]; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hub-notify-'));
    const record = join(dir, 'calls');
    const each = `for a in "$@"; do printf '[%s]' "$a" >> '${record}'; done; echo >> '${record}'`;
    writeFileSync(join(dir, 'notify-send'), `#!/bin/sh\nprintf 'notify-send ' >> '${record}'\n${each}\ncase " $* " in *" --wait "*) printf '%s' '${answer.stdout}'; exit ${answer.code};; esac\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'opener'), `#!/bin/sh\nprintf 'opener ' >> '${record}'\n${each}\n`, { mode: 0o755 });
    try {
      execFileSync('sh', ['-c', NOTIFY_SCRIPT, 'switchboard-notify', join(dir, 'opener'), URL, '--app-name=Switchboard', '--', TITLE, 'Why  two spaces'], { env: { PATH: `${dir}:/usr/bin:/bin` }, cwd: dir });
      return { calls: readFileSync(record, 'utf8').trim().split('\n'), files: readdirSync(dir).sort() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const shown = `[--app-name=Switchboard][--][${TITLE}][Why  two spaces]`;

  it('opens the URL when the operator chose Open, passing each argument whole and running none of its text', () => {
    expect(runScript({ code: 0, stdout: 'default\n' })).toEqual({
      calls: [`notify-send [--action=default=Open][--wait]${shown}`, `opener [${URL}]`],
      files: ['calls', 'notify-send', 'opener'],
    });
  });

  it('opens nothing when the notification was dismissed', () => {
    expect(runScript({ code: 0, stdout: '' }).calls).toEqual([`notify-send [--action=default=Open][--wait]${shown}`]);
  });

  it('shows the notification again without an action where notify-send has none', () => {
    expect(runScript({ code: 1, stdout: '' }).calls).toEqual([`notify-send [--action=default=Open][--wait]${shown}`, `notify-send ${shown}`]);
  });

  it('starts the helper in its own process group, apart from the hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-detach-'));
    const out = join(dir, 'out');
    try {
      const errors: Error[] = [];
      detachHelper('sh', ['-c', `echo "$$ $(ps -o pgid= -p $$)" > '${out}.tmp' && mv '${out}.tmp' '${out}'`], { PATH: '/usr/bin:/bin' }, (error) => errors.push(error));
      await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
      const [pid, group] = readFileSync(out, 'utf8').trim().split(/\s+/);
      expect(group).toBe(pid);
      expect(Number(group)).not.toBe(getpgid());
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
