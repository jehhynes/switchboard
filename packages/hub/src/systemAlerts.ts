import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { browserCommand, launchEnvironment } from './launch.js';

/** A needs-you alert shown as a system notification (PRD R65): the ticket's title, why it needs the operator, and the page URL a click opens. */
export interface SystemAlert {
  workItemId: number;
  title: string;
  reason: string;
  url: string;
}

/** Shows needs-you alerts as system notifications, one per work item; `sound` lets the system play its notification sound. */
export interface SystemNotifier {
  notify(alerts: readonly SystemAlert[], sound: boolean): void;
}

/** How the notifier runs a helper program, writing `input` to its standard input: its exit code and output; rejects when it cannot start. */
export type RunHelper = (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runHelper: RunHelper = (file, args, env, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

/** The app ID the Windows toasts show as, registered under HKCU so Windows shows them as Switchboard's without a Start menu shortcut. */
export const TOAST_APP_ID = 'Switchboard';

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A Windows toast: the title, then the reason; a click opens the URL with its protocol's handler, the default browser, with no process to answer it. */
export function toastXml(alert: SystemAlert, sound: boolean): string {
  return (
    `<toast activationType="protocol" launch="${xml(alert.url)}"><visual><binding template="ToastGeneric"><text>${xml(alert.title)}</text><text>${xml(alert.reason)}</text></binding></visual>` +
    `${sound ? '' : '<audio silent="true"/>'}</toast>`
  );
}

/**
 * The Windows PowerShell script that shows toasts through WinRT's ToastNotificationManager, which PowerShell 7 cannot load. It holds no alert
 * text: it reads the toasts from standard input as base64 UTF-8 JSON (`toastInput`), so no title is ever parsed as PowerShell, and no number of
 * alerts reaches the command line's length limit. Each toast is tagged by its work item, so a later alert for it replaces the one still shown.
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${TOAST_APP_ID}'`,
  `if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null; Set-ItemProperty -Path $key -Name DisplayName -Value '${TOAST_APP_ID}' }`,
  '$toasts = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]',
  `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}')`,
  'foreach ($one in @($toasts)) {',
  '  $document = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '  $document.LoadXml([string]$one.xml)',
  '  $toast = New-Object Windows.UI.Notifications.ToastNotification $document',
  '  $toast.Tag = [string]$one.tag',
  "  $toast.Group = 'needs'",
  '  $notifier.Show($toast)',
  '}',
].join('\n');

/** The toasts `TOAST_SCRIPT` reads: each one's XML and tag, as base64 UTF-8 JSON, which survives any console code page. */
export function toastInput(alerts: readonly SystemAlert[], sound: boolean): string {
  return Buffer.from(JSON.stringify(alerts.map((alert) => ({ xml: toastXml(alert, sound), tag: `w${alert.workItemId}` }))), 'utf8').toString('base64');
}

/**
 * The notifier that runs this computer's notification helper (architecture.md § Dock, Needs you): Windows PowerShell's WinRT toast on Windows,
 * `notify-send` on Linux, whose Open action opens the URL, and `osascript` on macOS, whose notification opens nothing. A helper that fails is
 * logged; the alert is not retried.
 */
export function systemNotifier(log: (line: string) => void, run: RunHelper = runHelper, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SystemNotifier {
  const clean = launchEnvironment(env);
  /** Logs a helper's failing exit, or why it could not start. */
  const failed = (what: string) => (result: unknown) => {
    const exit = result as { code?: unknown; stderr?: unknown } | null;
    const detail = typeof exit === 'object' && exit !== null && 'code' in exit ? `exit ${String(exit.code)}: ${String(exit.stderr).trim().slice(0, 300)}` : String(result);

    log(`system notification not shown (${what}): ${detail}`);
  };

  return {
    notify(alerts, sound) {
      if (alerts.length === 0) {
        return;
      }

      if (platform === 'win32') {
        const powershell = win32.join(env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');

        void run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], clean, toastInput(alerts, sound)).then((result) => result.code === 0 || failed('toast')(result), failed('toast'));
        return;
      }

      if (platform === 'linux') {
        for (const alert of alerts) {
          const base = ['--app-name=Switchboard', ...(sound ? [] : ['--hint=boolean:suppress-sound:true'])];
          const text = ['--', alert.title, alert.reason];
          const plain = (): void => void run('notify-send', [...base, ...text], clean).then((result) => result.code === 0 || failed('notify-send')(result), failed('notify-send'));

          // --wait holds notify-send until the notification closes and prints the action chosen; a notify-send older than libnotify 0.7.9 has no
          // --action and fails, so the notification is shown again without one.
          void run('notify-send', [...base, '--action=default=Open', '--wait', ...text], clean).then((result) => {
            if (result.code !== 0) {
              plain();
            } else if (result.stdout.trim() === 'default') {
              const { file, args } = browserCommand(alert.url, platform);

              void run(file, args, clean).then((opened) => opened.code === 0 || failed('xdg-open')(opened), failed('xdg-open'));
            }
          }, failed('notify-send'));
        }

        return;
      }

      if (platform === 'darwin') {
        for (const alert of alerts) {
          // The title and reason arrive as arguments, so no AppleScript string is built from them.
          const script = `on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)${sound ? ' sound name "default"' : ''}\nend run`;

          void run('osascript', ['-e', script, alert.title, alert.reason], clean).then((result) => result.code === 0 || failed('osascript')(result), failed('osascript'));
        }

        return;
      }

      log(`system notification not shown: none on ${platform}`);
    },
  };
}
