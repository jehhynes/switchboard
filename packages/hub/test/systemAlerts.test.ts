import { describe, expect, it } from 'vitest';
import { systemNotifier, TOAST_SCRIPT, toastInput, toastXml } from '../src/systemAlerts.js';
import type { RunHelper, SystemAlert } from '../src/systemAlerts.js';

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

  it('shows each alert with notify-send on Linux and opens its URL when the operator chose Open, and nothing when it was dismissed', async () => {
    const logs: string[] = [];
    const { calls, run } = fakeRun((file, args) => (file === 'notify-send' ? { code: 0, stdout: args.includes('Second') ? '\n' : 'default\n' } : { code: 0 }));

    systemNotifier((line) => logs.push(line), run, 'linux', {}).notify([ALERT, { ...ALERT, workItemId: 8, title: 'Second', url: 'http://x/page/#w=8' }], false);
    await settle();
    await settle();
    expect(calls).toEqual([
      { file: 'notify-send', args: ['--app-name=Switchboard', '--hint=boolean:suppress-sound:true', '--action=default=Open', '--wait', '--', ALERT.title, 'Review, then approve'] },
      { file: 'notify-send', args: ['--app-name=Switchboard', '--hint=boolean:suppress-sound:true', '--action=default=Open', '--wait', '--', 'Second', 'Review, then approve'] },
      { file: 'xdg-open', args: [ALERT.url] },
    ]);
    expect(logs).toEqual([]);
  });

  it('shows the notification again without an action where notify-send has none, logging when that fails too', async () => {
    const logs: string[] = [];
    const { calls, run } = fakeRun((_file, args) => (args.includes('--wait') ? { code: 1, stderr: 'Unknown option --action' } : { code: 2, stderr: 'no bus' }));

    systemNotifier((line) => logs.push(line), run, 'linux', {}).notify([ALERT], true);
    await settle();
    await settle();
    expect(calls.map((call) => call.args)).toEqual([
      ['--app-name=Switchboard', '--action=default=Open', '--wait', '--', ALERT.title, 'Review, then approve'],
      ['--app-name=Switchboard', '--', ALERT.title, 'Review, then approve'],
    ]);
    expect(logs).toEqual(['system notification not shown (notify-send): exit 2: no bus']);
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
