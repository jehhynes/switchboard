import type { Pty, PtyFactory } from './host.js';

interface NodePtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty;
}

/**
 * Pseudo-terminals from node-pty, a native module, which only the holder's entry point loads. node-pty is optional: on a platform where npm
 * could not build it, the holder still starts and each spawn fails with the load error (mechanics M76).
 */
export async function loadNodePty(): Promise<PtyFactory> {
  let loaded: NodePtyModule | Error;

  try {
    // A variable specifier keeps TypeScript from needing node-pty's types where it is not installed.
    const name = 'node-pty';
    const module = (await import(name)) as { default?: NodePtyModule } & NodePtyModule;

    loaded = module.default ?? module;
  } catch (error) {
    loaded = error as Error;
  }

  return (file, args, options) => {
    if (loaded instanceof Error) {
      throw loaded;
    }

    return loaded.spawn(file, args, { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });
  };
}
