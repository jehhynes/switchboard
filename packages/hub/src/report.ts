import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** The Windows root that Git Bash puts in front of an argument starting with `/` (mechanics M20), or null outside Git Bash. */
export function gitBashRoot(env: NodeJS.ProcessEnv, run: (file: string, args: string[]) => string = runSync): string | null {
  if (env['MSYSTEM'] === undefined) {
    return null;
  }

  try {
    const root = run('cygpath', ['-m', '/']).trim().replace(/\/+$/, '');

    return root === '' ? null : root;
  } catch {
    return null;
  }
}

function runSync(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true });
}

/** Undoes Git Bash's rewrite of a slash command such as `/legacy-ship 16416`. */
function unconverted(value: string, root: string | null): string {
  return root !== null && value.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? value.slice(root.length) : value;
}

function valueOf(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);

  if (at !== -1) {
    const value = argv[at + 1];

    return value === undefined || value.startsWith('--') ? null : value;
  }

  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));

  return inline === undefined ? null : inline.slice(name.length + 3);
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));
}

/** A report body from `report <kind> <sessionId> …`, or null for bad usage. `root` is the Git Bash root the CLI ran under. */
export function reportBody(argv: readonly string[], root: string | null = null): Record<string, unknown> | null {
  const [kind, sessionId, text] = argv;

  if (sessionId === undefined || sessionId.startsWith('--')) {
    return null;
  }

  switch (kind) {
    case 'stage':
      return text === undefined ? null : { sessionId, kind, stage: argv.slice(2).join(' ') };
    case 'worktree':
      return text === undefined ? null : { sessionId, kind, path: resolve(text) };
    case 'done':
      return { sessionId, kind };
    case 'approval': {
      const given = valueOf(argv, 'prompt');
      const prompt = given === null ? null : unconverted(given, root);

      const report = valueOf(argv, 'report');

      // A --report flag without a value is bad usage, not an approval without a draft.
      return prompt === null || prompt === '' || ((report === null || report === '') && hasFlag(argv, 'report')) ? null : { sessionId, kind, prompt, summary: valueOf(argv, 'summary'), report: report === null ? null : resolve(report) };
    }
    case 'playbook':
      return text === undefined ? null : { sessionId, kind, playbook: text };
    case 'link': {
      const label = valueOf(argv, 'label');
      const target = valueOf(argv, 'target');

      return label === null || label === '' || target === null || !/^https?:\/\//i.test(target) ? null : { sessionId, kind, label, target };
    }
    default:
      return null;
  }
}

