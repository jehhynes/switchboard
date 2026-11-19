/**
 * Closes a node-pty pseudo-terminal without killing its program, so the program sees its terminal go and runs its own cleanup: Claude Code
 * ends its shell commands and logs `SessionEnd` (mechanics M78). node-pty's `kill()` does not do this on Windows: it kills the program first.
 * The Windows close uses node-pty's private agent, checked here because a node-pty upgrade can change it (package.json pins the version).
 * Returns false when this pseudo-terminal offers no close, so the caller ends the process tree instead.
 */
export function closePseudoTerminal(pty: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const agent = (pty as { _agent?: { _useConpty?: unknown; _useConptyDll?: unknown; _pty?: unknown; _ptyNative?: { kill?: unknown } } } | null)?._agent;

    // winpty's kill takes other arguments and kills the program, so only ConPTY qualifies. With conpty.dll the native kill also terminates it.
    if (agent?._useConpty !== true || agent._useConptyDll !== false || typeof agent._pty !== 'number' || typeof agent._ptyNative?.kill !== 'function') {
      return false;
    }

    // ClosePseudoConsole; the output pipe stays read, so the program's last output reaches the screen.
    (agent._ptyNative.kill as (id: number, useConptyDll: boolean) => void)(agent._pty, false);

    return true;
  }

  const unix = pty as { destroy?: unknown } | null;

  if (typeof unix?.destroy !== 'function') {
    return false;
  }

  // Closes the master side, which hangs up the terminal, and sends the program SIGHUP.
  (unix.destroy as () => void).call(unix);

  return true;
}
