// Window choice for extension.js, free of GNOME Shell imports so Vitest can load it.

/** VS Code's window class: `com.microsoft.VSCode` as a Wayland client, `Code` under XWayland (mechanics M39). @param {string | null} wmClass */
export function isVsCode(wmClass) {
  const name = wmClass?.toLowerCase();

  return name === 'com.microsoft.vscode' || name === 'code';
}

/**
 * Whether the dock may find and bring forward a window: a normal VS Code window with a size. The window VS Code never shows is 0 × 0 wherever it
 * is, while a minimized window or one on another workspace keeps its size, though Mutter hides those too (mechanics M39).
 * @param {{ normal: boolean, wmClass: string | null, width: number, height: number }} window
 */
export function isListed(window) {
  return window.normal && isVsCode(window.wmClass) && window.width > 0 && window.height > 0;
}
