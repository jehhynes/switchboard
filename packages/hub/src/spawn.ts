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
