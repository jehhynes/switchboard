/**
 * Removes `NO_COLOR` and `FORCE_COLOR` from the hub's own environment at startup, before it starts a holder, a voice process, a session or another
 * hub. A Claude session's Bash tool sets `NO_COLOR=1`, and a held Claude Code without colour draws its suggested prompt as typed text (mechanics M149).
 */
export function dropColourOverrides(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (/^(NO_COLOR|FORCE_COLOR)$/i.test(name)) {
      delete env[name];
    }
  }
}

/** Remove VS Code window and build variables so the hub and the CLIs it starts do not target the originating window (GC M26, M49). */
export function spawnEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_') && key !== 'NODE_OPTIONS') {
      result[key] = value;
    }
  }

  // Makes VS Code's executable run as Node; plain Node ignores it.
  result['ELECTRON_RUN_AS_NODE'] = '1';

  return result;
}
