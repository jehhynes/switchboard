import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShortcut, shortcutIcon } from '../src/appShortcut.js';

describe('app shortcut download sheet', () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement('div'); document.body.append(root); });
  afterEach(() => { render(null, root); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('gets the real client icon path before downloading with an explicit profile and this browser', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows Chrome/158 Edg/158');
    const prepare = vi.fn(async () => ({ icon: 'D:\\Downloads\\Switchboard\\switchboard.ico' }));
    const save = vi.fn();
    render(h(AppShortcut, { prepare, save }), root);
    await act(async () => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    expect(prepare).toHaveBeenCalledWith('ico');
    const url = new URL(save.mock.calls[0]![0], location.origin);
    expect(url.pathname).toBe('/page/switchboard-shortcut.zip');
    expect(Object.fromEntries(url.searchParams)).toEqual({ browser: 'edge', profile: 'Default', installation: 'standard', icon: 'D:\\Downloads\\Switchboard\\switchboard.ico' });
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Keep the icon');
  });
  it('on Linux asks for the PNG icon and downloads a Chrome launcher without Windows options', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) Chrome/158');
    const prepare = vi.fn(async () => ({ icon: '/home/alex/Downloads/Switchboard/switchboard.png' }));
    const save = vi.fn();
    render(h(AppShortcut, { prepare, save }), root);
    expect(root.querySelector('select')!.value).toBe('linux');
    expect(root.querySelectorAll('select')).toHaveLength(1); expect(root.querySelector('.more-options-toggle')).toBeNull();
    expect(root.textContent).toContain('~/.local/share/applications');
    await act(async () => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    expect(prepare).toHaveBeenCalledWith('png');
    const url = new URL(save.mock.calls[0]![0], location.origin);
    expect(Object.fromEntries(url.searchParams)).toEqual({ system: 'linux', browser: 'chrome', profile: 'Default', icon: '/home/alex/Downloads/Switchboard/switchboard.png' });
  });
  it('on Linux refuses the ICO an older extension saves, asking for its reload', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) Chrome/158');
    const save = vi.fn();
    render(h(AppShortcut, { prepare: async () => ({ icon: '/home/alex/Downloads/Switchboard/switchboard.ico' }), save }), root);
    await act(async () => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Reload the Switchboard browser extension');
    expect(save).not.toHaveBeenCalled();
  });
  it('on Linux accepts a profile directory with dots but not . or ..', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) Chrome/158');
    render(h(AppShortcut, { prepare: vi.fn(), save: vi.fn() }), root);
    const profile = root.querySelector('input')!;
    for (const [value, disabled] of [['my-prof.x', false], ['..', true], ['.', true], ['a/b', true]] as const) {
      await act(() => { profile.value = value; profile.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(root.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(disabled);
    }
  });
  it('switches from Windows to Linux in the dialog', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows Chrome/158');
    const prepare = vi.fn(async () => ({ icon: '/home/alex/Downloads/Switchboard/switchboard.png' }));
    const save = vi.fn();
    render(h(AppShortcut, { prepare, save }), root);
    const system = root.querySelector('select')!;
    await act(() => { system.value = 'linux'; system.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    expect(prepare).toHaveBeenCalledWith('png');
    expect(new URL(save.mock.calls[0]![0], location.origin).searchParams.get('system')).toBe('linux');
  });
  it('uses the shared disclosure controls and refuses an unsafe profile without downloading', async () => {
    const prepare = vi.fn(); const save = vi.fn();
    render(h(AppShortcut, { prepare, save }), root);
    const profile = root.querySelector('input')!;
    await act(() => root.querySelector<HTMLButtonElement>('.more-options-toggle')!.click());
    expect(root.querySelector('.more-options-toggle')?.getAttribute('aria-expanded')).toBe('true');
    const installation = root.querySelectorAll('select')[2]!;
    await act(() => { profile.value = '../Default'; profile.dispatchEvent(new Event('input', { bubbles: true })); installation.value = 'user'; installation.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(root.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('without a path');
    expect(prepare).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('keeps download failures in the dialog and lets the user retry', async () => {
    const save = vi.fn();
    render(h(AppShortcut, { prepare: async () => null, save }), root);
    await act(async () => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Reload the Switchboard browser extension');
    expect(root.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('does not download after the dialog is dismissed during icon preparation', async () => {
    let finish!: (value: { icon: string }) => void;
    const pending = new Promise<{ icon: string }>((resolve) => { finish = resolve; });
    const save = vi.fn();
    render(h(AppShortcut, { prepare: () => pending, save }), root);
    await act(() => root.querySelector<HTMLButtonElement>('button.primary')!.click());
    await act(() => render(null, root));
    await act(async () => { finish({ icon: 'C:\\Downloads\\Switchboard\\switchboard.ico' }); await pending; });
    expect(save).not.toHaveBeenCalled();
  });
  it('asks the extension for the requested icon format', async () => {
    const sendMessage = vi.fn((_id: string, _message: unknown, callback: (answer: unknown) => void) => callback({ icon: '/home/alex/Downloads/Switchboard/switchboard.png' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    expect(await shortcutIcon('png')).toEqual({ icon: '/home/alex/Downloads/Switchboard/switchboard.png' });
    expect(sendMessage).toHaveBeenLastCalledWith('hlbibnhgkgnjkbfledhgjblacloneije', { type: 'iframe-shortcut', format: 'png' }, expect.any(Function));
    await shortcutIcon();
    expect(sendMessage).toHaveBeenLastCalledWith('hlbibnhgkgnjkbfledhgjblacloneije', { type: 'iframe-shortcut', format: 'ico' }, expect.any(Function));
  });
  it('handles an absent extension and Chrome runtime errors without trusting their answers', async () => {
    expect(await shortcutIcon()).toBeNull();
    vi.stubGlobal('chrome', { runtime: { lastError: { message: 'disconnected' }, sendMessage: (_id: string, _message: unknown, callback: (answer: unknown) => void) => callback({ icon: 'untrusted' }) } });
    expect(await shortcutIcon()).toBeNull();
  });
});
