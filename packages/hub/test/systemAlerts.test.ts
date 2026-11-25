import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detachHelper, NOTIFY_SCRIPT, systemNotifier, TOAST_SCRIPT, toastInput, toastXml } from '../src/systemAlerts.js';
import type { DetachHelper, RunHelper, SystemAlert } from '../src/systemAlerts.js';

const ALERT: SystemAlert = { workItemId: 7, title: 'Fix <b> & "quote" it\'s', reason: 'Review, then approve', url: 'http://127.0.0.1:47616/page/#w=7' };

/** A helper runner that records each call and answers from `answer`. */
function fakeRun(answer: (file: string, args: string[]) => { code: number | null; stdout?: string; stderr?: string } | Error = () => ({ code: 0 })) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const run: RunHelper = async (file, args, _env, input) => {
    calls.push({ file, args, ...(input === undefined || input === '' ? {} : { input }) });
    const result = answer(file, args);

    if (result instanceof Error) {
      throw result;
    }

    return { stdout: '', stderr: '', ...result };
  };

  return { calls, run };
}

/** This test process's process group. */
const getpgid = (): number => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('toastXml', () => {
  it('escapes the title, reason and URL, opens the URL by protocol, and is silent unless it may sound', () => {
    const silent = toastXml(ALERT, false);

    expect(silent).toBe(
      '<toast activationType="protocol" launch="http://127.0.0.1:47616/page/#w=7"><visual><binding template="ToastGeneric"><text>Fix &lt;b&gt; &amp; &quot;quote&quot; it&apos;s</text><text>Review, then approve</text></binding></visual><audio silent="true"/></toast>',
    );
    expect(toastXml(ALERT, true)).not.toContain('<audio');
    expect(toastXml({ ...ALERT, url: 'http://h/page/?a=1&b=2#w=7' }, true)).toContain('launch="http://h/page/?a=1&amp;b=2#w=7"');
  });
});

describe('toastInput', () => {
  const decode = (input: string) => JSON.parse(Buffer.from(input, 'base64').toString('utf8')) as Array<{ xml: string; tag: string }>;

  it('carries each toast as XML and a tag by work item, keeping any title out of the script', () => {
    // A typographic apostrophe ends a PowerShell single-quoted string, so a title must never be parsed as PowerShell.
    const smart = { ...ALERT, workItemId: 8, title: 'Fix’ + $(Write-Output INJECTED) + ’ and John’s badge — ok' };

    expect(decode(toastInput([ALERT, smart], false))).toEqual([
      { xml: toastXml(ALERT, false), tag: 'w7' },
      { xml: toastXml(smart, false), tag: 'w8' },
    ]);
    expect(TOAST_SCRIPT).not.toContain('INJECTED');
    expect(TOAST_SCRIPT).toContain('if (-not (Test-Path $key))');
    expect(TOAST_SCRIPT).toContain("$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\Switchboard'");
    expect(TOAST_SCRIPT).toContain("CreateToastNotifier('Switchboard')");
    expect(TOAST_SCRIPT).toContain('[Console]::In.ReadToEnd()');
  });
});

describe('systemNotifier', () => {
  it('runs Windows PowerShell with the encoded toast script, and logs a failing exit or a helper that cannot start', async () => {
    const logs: string[] = [];
    const { calls, run } = fakeRun(() => ({ code: 1, stderr: 'Element not found.\r\n' }));

    systemNotifier((line) => logs.push(line), run, 'win32', { SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' }).notify([ALERT], true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(calls[0]!.args[3]!, 'base64').toString('utf16le')).toBe(TOAST_SCRIPT);
    expect(calls[0]!.input).toBe(toastInput([ALERT], true));
    expect(logs).toEqual(['system notification not shown (toast): exit 1: Element not found.']);

    const missing = fakeRun(() => new Error('spawn ENOENT'));

    systemNotifier((line) => logs.push(line), missing.run, 'win32', {}).notify([ALERT], false);
    await settle();
    expect(missing.calls[0]!.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(logs.at(-1)).toBe('system notification not shown (toast): Error: spawn ENOENT');
  });

  it('keeps the command line the same however many alerts there are, so a large batch never reaches its length limit', async () => {
    const { calls, run } = fakeRun();
    const many = Array.from({ length: 200 }, (_, index) => ({ ...ALERT, workItemId: index, title: `A long ticket title for work item number ${index} that fills the line` }));

    systemNotifier(() => {}, run, 'win32', {}).notify(many, false);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(' ').length).toBeLessThan(8_000);
    expect(JSON.parse(Buffer.from(calls[0]!.input!, 'base64').toString('utf8'))).toHaveLength(200);
  });

  it('runs nothing for no alerts, and logs a platform with no helper', async () => {
    const logs: string[] = [];
    const { calls, run } = fakeRun();

    systemNotifier((line) => logs.push(line), run, 'win32', {}).notify([], true);
    systemNotifier((line) => logs.push(line), run, 'freebsd', {}).notify([ALERT], true);
    await settle();
    expect(calls).toEqual([]);
    expect(logs).toEqual(['system notification not shown: none on freebsd']);
  });

  it('shows each alert on Linux through a detached shell that outlives the hub, with the URL and notify-send arguments as its own arguments', () => {
    const logs: string[] = [];
    const { calls, run } = fakeRun();
    const detached: Array<{ file: string; args: string[] }> = [];
    const detach: DetachHelper = (file, args, _env, failed) => { detached.push({ file, args }); if (args.includes('Broken')) failed(new Error('spawn sh ENOENT')); };

    systemNotifier((line) => logs.push(line), run, 'linux', {}, detach).notify([ALERT, { ...ALERT, workItemId: 8, title: 'Broken', url: 'http://x/page/#w=8' }], false);
    expect(calls).toEqual([]);
    expect(detached).toEqual([
      { file: 'sh', args: ['-c', NOTIFY_SCRIPT, 'switchboard-notify', 'xdg-open', ALERT.url, '--app-name=Switchboard', '--hint=boolean:suppress-sound:true', '--', ALERT.title, 'Review, then approve'] },
      { file: 'sh', args: ['-c', NOTIFY_SCRIPT, 'switchboard-notify', 'xdg-open', 'http://x/page/#w=8', '--app-name=Switchboard', '--hint=boolean:suppress-sound:true', '--', 'Broken', 'Review, then approve'] },
    ]);
    expect(logs).toEqual(['system notification not shown (notify-send): Error: spawn sh ENOENT']);
    systemNotifier(() => {}, run, 'linux', {}, (file, args) => detached.push({ file, args })).notify([ALERT], true);
    expect(detached[2]!.args.slice(5)).toEqual(['--app-name=Switchboard', '--', ALERT.title, 'Review, then approve']);
  });

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

  it('passes the title and reason to osascript as arguments on macOS, with the sound only when it may', async () => {
    const { calls, run } = fakeRun();

    systemNotifier(() => {}, run, 'darwin', {}).notify([ALERT], true);
    systemNotifier(() => {}, run, 'darwin', {}).notify([ALERT], false);
    await settle();
    expect(calls[0]).toEqual({ file: 'osascript', args: ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "default"\nend run', ALERT.title, 'Review, then approve'] });
    expect(calls[1]!.args[1]).not.toContain('sound');
  });
});
