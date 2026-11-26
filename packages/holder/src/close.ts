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

/**
 * Frees what node-pty keeps after a Windows program exits: node-pty 1.1.0 ends its output-pipe Worker thread only in `kill()`, which the holder
 * never calls, and never closes the input pipe, so without this each ended session keeps a thread, a pipe handle and, through the Worker's
 * listeners, its pseudo-terminal and screen (mechanics M168). Uses node-pty's private agent, checked as `closePseudoTerminal` checks it.
 * Returns what it freed; nothing on other platforms, where node-pty frees its pseudo-terminal itself.
 */
export function releasePseudoTerminal(pty: unknown, platform: NodeJS.Platform = process.platform): Array<'worker' | 'input'> {
  if (platform !== 'win32') {
    return [];
  }

  type Agent = { _conoutSocketWorker?: { dispose?: unknown; _worker?: { on?: unknown } }; _inSocket?: { destroy?: unknown } };
  const agent = (pty as { _agent?: Agent } | null)?._agent;
  const released: Array<'worker' | 'input'> = [];
  const worker = agent?._conoutSocketWorker;
  const input = agent?._inSocket;

  if (typeof worker?.dispose === 'function') {
    // The Worker fails when output reaches it after node-pty closed its end, and node-pty does not listen for that; it is ending anyway.
    if (typeof worker._worker?.on === 'function') {
      (worker._worker.on as (event: string, listener: () => void) => void).call(worker._worker, 'error', () => undefined);
    }

    // Terminates the Worker once node-pty's one-second drain timer passes.
    (worker.dispose as () => void).call(worker);
    released.push('worker');
  }

  if (typeof input?.destroy === 'function') {
    (input.destroy as () => void).call(input);
    released.push('input');
  }

  return released;
}
