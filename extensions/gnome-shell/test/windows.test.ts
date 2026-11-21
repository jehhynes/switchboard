import { describe, expect, it } from 'vitest';
import { isListed, isListedTerminal, isTerminal, isVsCode, isWebUrl, terminalFocusSignal } from '../src/windows.js';

describe('isVsCode', () => {
  it('takes VS Code as a Wayland client and under XWayland, in any case', () => {
    expect(isVsCode('com.microsoft.VSCode')).toBe(true);
    expect(isVsCode('Code')).toBe(true);
    expect(isVsCode('code')).toBe(true);
  });

  it('refuses other windows, other builds of VS Code and a window with no class', () => {
    expect(isVsCode('Switchboard.Dock')).toBe(false);
    expect(isVsCode('code-oss')).toBe(false);
    expect(isVsCode('com.microsoft.VSCodeInsiders')).toBe(false);
    expect(isVsCode(null)).toBe(false);
  });
});

describe('isListed', () => {
  // A VS Code window as Mutter 50.1 reported it, its size kept while minimized or on another workspace (mechanics M39).
  const shown = { normal: true, wmClass: 'com.microsoft.VSCode', width: 1440, height: 900 };

  it('lists a VS Code window with a size', () => {
    expect(isListed(shown)).toBe(true);
  });

  it('leaves out the 0 × 0 window VS Code never shows, its dialogs and other apps’ windows', () => {
    expect(isListed({ ...shown, width: 0, height: 0 })).toBe(false);
    expect(isListed({ ...shown, height: 0 })).toBe(false);
    expect(isListed({ ...shown, normal: false })).toBe(false);
    expect(isListed({ ...shown, wmClass: 'Switchboard.Dock' })).toBe(false);
  });
});

describe('isTerminal', () => {
  it('takes Ptyxis, as Mutter 50.1 reported it, in any case', () => {
    expect(isTerminal('org.gnome.Ptyxis')).toBe(true);
    expect(isTerminal('org.gnome.ptyxis')).toBe(true);
  });

  it('refuses VS Code, other terminals and a window with no class', () => {
    expect(isTerminal('com.microsoft.VSCode')).toBe(false);
    expect(isTerminal('org.gnome.Terminal')).toBe(false);
    expect(isTerminal(null)).toBe(false);
  });
});

describe('isListedTerminal', () => {
  const shown = { normal: true, wmClass: 'org.gnome.Ptyxis', width: 1410, height: 920 };

  it('lists a Ptyxis window with a size, and keeps it out of the VS Code list', () => {
    expect(isListedTerminal(shown)).toBe(true);
    expect(isListed(shown)).toBe(false);
  });

  it('leaves out a Ptyxis dialog, a window with no size and VS Code', () => {
    expect(isListedTerminal({ ...shown, normal: false })).toBe(false);
    expect(isListedTerminal({ ...shown, width: 0 })).toBe(false);
    expect(isListedTerminal({ ...shown, wmClass: 'com.microsoft.VSCode' })).toBe(false);
  });
});

describe('isWebUrl', () => {
  it('takes http and https links, with a query and a bookmark', () => {
    expect(isWebUrl('https://github.com/o/r/issues/1?a=1#issuecomment-2')).toBe(true);
    expect(isWebUrl('HTTP://localhost:8080/')).toBe(true);
  });

  it('refuses other schemes, an empty host part and text with spaces', () => {
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('vscode://file/x')).toBe(false);
    expect(isWebUrl('https://')).toBe(false);
    expect(isWebUrl('https://a b')).toBe(false);
    expect(isWebUrl(' https://a')).toBe(false);
  });
});

describe('terminalFocusSignal', () => {
  it('reports each terminal that gains the focus, and the focus leaving a terminal once', () => {
    expect(terminalFocusSignal(false, true)).toBe('TerminalFocused');
    expect(terminalFocusSignal(true, true)).toBe('TerminalFocused');
    expect(terminalFocusSignal(true, false)).toBe('TerminalUnfocused');
    expect(terminalFocusSignal(false, false)).toBeNull();
  });
});
