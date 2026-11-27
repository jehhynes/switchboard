import { BROWSER_EXTENSION_ID } from '@switchboard/core/hubRecord';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SheetFrame } from './sheetFrame.js';

export const APP_SHORTCUT_DOWNLOAD = '/page/switchboard-shortcut.zip';

/** Asks the extension to save Switchboard's icon in Downloads: the ICO a Windows shortcut takes, or the PNG a Linux launcher takes. */
export async function shortcutIcon(format: 'ico' | 'png' = 'ico'): Promise<{ icon?: string; error?: string } | null> {
  const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?(id: string, message: unknown, callback: (answer: { icon?: string; error?: string } | null) => void): void; lastError?: unknown } } }).chrome?.runtime;
  if (runtime?.sendMessage === undefined) return null;
  return new Promise((resolve) => runtime.sendMessage!(BROWSER_EXTENSION_ID, { type: 'iframe-shortcut', format }, (answer) => resolve(runtime.lastError === undefined ? answer : null)));
}

export function AppShortcut({ prepare = shortcutIcon, save = (url: string) => {
  const link = document.createElement('a'); link.href = url; link.download = 'switchboard-shortcut.zip'; document.body.append(link); link.click(); link.remove();
} }: { prepare?: typeof shortcutIcon; save?: (url: string) => void; children?: ComponentChildren }) {
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const [system, setSystem] = useState(/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent) ? 'linux' : 'windows');
  const linux = system === 'linux';
  const [browser, setBrowser] = useState(/Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome');
  const [profile, setProfile] = useState('Default');
  const [installation, setInstallation] = useState('standard');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Chrome keeps a Linux profile directory's dots in its app ID (mechanics M160).
  const valid = linux ? /^(?!\.\.?$)[A-Za-z0-9_ .-]{1,80}$/.test(profile) : /^[A-Za-z0-9_ -]{1,80}$/.test(profile);
  const download = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const answer = await prepare(linux ? 'png' : 'ico');
      if (!active.current) return;
      if (!answer?.icon) throw new Error(answer?.error ?? 'Reload the Switchboard browser extension, then try again.');
      // An extension older than the Linux launcher saves the ICO whatever the page asks.
      if (linux && !answer.icon.endsWith('.png')) throw new Error('Reload the Switchboard browser extension, then try again.');
      save(`${APP_SHORTCUT_DOWNLOAD}?${new URLSearchParams(linux ? { system, browser: 'chrome', profile, icon: answer.icon } : { browser, profile, installation, icon: answer.icon })}`);
      setSaved(true);
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : 'Could not download the shortcut. Try again.'); }
    finally { if (active.current) setBusy(false); }
  };
  return <SheetFrame title="Download app shortcut" close buttons={<button type="button" class="sheet-button primary" disabled={!valid || busy} onClick={() => void download()}>{busy ? 'Preparing…' : 'Download shortcut'}</button>}>
    <p class="sheet-detail">Open Switchboard in its own app window. No installer is needed.</p>
    <label class="sheet-field"><span class="sheet-label">System</span><select class="sheet-select" value={system} disabled={busy} onChange={(event) => setSystem(event.currentTarget.value)}><option value="windows">Windows</option><option value="linux">Linux</option></select></label>
    {linux ? null : <label class="sheet-field"><span class="sheet-label">Browser</span><select class="sheet-select" value={browser} disabled={busy} onChange={(event) => setBrowser(event.currentTarget.value)}><option value="chrome">Chrome</option><option value="edge">Edge</option></select></label>}
    <label class="sheet-field"><span class="sheet-label">Profile directory</span><input class="sheet-select" value={profile} disabled={busy} maxLength={80} placeholder="Default or Profile 1" onInput={(event) => setProfile(event.currentTarget.value)} />
      <span class="sheet-note">{linux ? 'Use the last folder in Profile Path on chrome://version.' : 'Use the last folder in Profile Path on chrome://version or edge://version.'} The profile must have the Switchboard extension and be signed in.</span>
    </label>
    {linux ? <p class="sheet-detail">Linux launchers open Google Chrome on GNOME on Wayland.</p> : <div class="sheet-field more-options">
      <button type="button" class="more-options-toggle" aria-expanded={more} onClick={() => setMore(!more)}><span class={`codicon codicon-chevron-${more ? 'down' : 'right'}`} aria-hidden="true"></span><span>Browser installation</span></button>
      {more ? <label class="sheet-field"><span class="sheet-label">Location</span><select class="sheet-select" value={installation} disabled={busy} onChange={(event) => setInstallation(event.currentTarget.value)}><option value="standard">Standard installation</option><option value="user">Per-user installation</option><option value="program-files">Program Files</option><option value="program-files-x86">Program Files (x86)</option></select></label> : null}
    </div>}
    {!valid ? <p class="sheet-error" role="alert">Enter a profile directory such as Default or Profile 1, without a path.</p> : null}
    {error ? <p class="sheet-error" role="alert">{error}</p> : null}
    {linux
      ? <ol class="sheet-detail extension-steps"><li>Extract the zip and move switchboard.desktop to ~/.local/share/applications.</li><li>Keep the Switchboard icon folder in Downloads.</li><li>Open Switchboard from your apps and pin it to the dock.</li></ol>
      : <ol class="sheet-detail extension-steps"><li>Extract the zip and move Switchboard.lnk to your desktop.</li><li>Keep the Switchboard icon folder in Downloads.</li><li>Pin the Switchboard shortcut to your taskbar.</li></ol>}
    {saved ? <p class="sheet-detail" role="status">Shortcut download started. Keep the icon in Downloads when moving or pinning the shortcut.</p> : null}
  </SheetFrame>;
}
