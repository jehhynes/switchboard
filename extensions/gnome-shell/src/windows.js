// Window choice for extension.js, free of GNOME Shell imports so Vitest can load it.

/** VS Code's window class: `com.microsoft.VSCode` as a Wayland client, `Code` under XWayland (mechanics M39). @param {string | null} wmClass */
export function isVsCode(wmClass) {
  const name = wmClass?.toLowerCase();

  return name === 'com.microsoft.vscode' || name === 'code';
}

/** Ptyxis's window class, the terminal the dock opens sessions in (mechanics M47). @param {string | null} wmClass */
export function isTerminal(wmClass) {
  return wmClass?.toLowerCase() === 'org.gnome.ptyxis';
}

/**
 * Whether the dock may find and bring forward a window as a terminal: a normal Ptyxis window with a size.
 * @param {{ normal: boolean, wmClass: string | null, width: number, height: number }} window
 */
export function isListedTerminal(window) {
  return window.normal && isTerminal(window.wmClass) && window.width > 0 && window.height > 0;
}

/**
 * Whether the dock may find and bring forward a window: a normal VS Code window with a size. The window VS Code never shows is 0 × 0 wherever it
 * is, while a minimized window or one on another workspace keeps its size, though Mutter hides those too (mechanics M39).
 * @param {{ normal: boolean, wmClass: string | null, width: number, height: number }} window
 */
export function isListed(window) {
  return window.normal && isVsCode(window.wmClass) && window.width > 0 && window.height > 0;
}
