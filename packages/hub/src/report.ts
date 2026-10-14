import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';

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

/** Undoes Git Bash's rewrite of a slash command such as `/sb-ship 16416`. */
function unconverted(value: string, root: string | null): string {
  return root !== null && value.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? value.slice(root.length) : value;
}

/**
 * A paste's file: a path that names one file wherever it is read (PRD R60). On Windows that is a drive or UNC path, because
 * `\x` and `C:x` depend on the reader's current drive or directory; elsewhere it is a POSIX absolute path.
 */
export function isPastePath(path: unknown, platform: NodeJS.Platform = process.platform): path is string {
  if (typeof path !== 'string') {
    return false;
  }

  return platform === 'win32' ? /^([a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(path) : posix.isAbsolute(path);
}

/** Turns a Git Bash drive path such as `/d/case/reply.md`, which Git Bash leaves unconverted under `MSYS_NO_PATHCONV`, into `D:/case/reply.md`. */
function windowsDrivePath(value: string, root: string | null): string {
  const drive = /^\/([a-z])(\/|$)/i.exec(value);

  return root === null || drive === null ? value : `${drive[1]!.toUpperCase()}:/${value.slice(3)}`;
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

/** The title from `register --title <text>`, or null for bad usage (PRD R81). */
export function registerTitle(argv: readonly string[]): string | null {
  const title = valueOf(argv, 'title');

  return title === null || title.trim() === '' ? null : title;
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
    case 'task': {
      const given = valueOf(argv, 'prompt');
      const repo = valueOf(argv, 'repo');
      const title = valueOf(argv, 'title');

      // A --repo or --title flag without a value is bad usage, not a request for the default.
      if (given === null || given.trim() === '' || ((repo === null || repo === '') && hasFlag(argv, 'repo')) || (title === null && hasFlag(argv, 'title'))) {
        return null;
      }

      return { sessionId, kind, prompt: unconverted(given, root), repo: repo === null ? null : resolve(repo), title };
    }
    case 'link': {
      const label = valueOf(argv, 'label');
      const target = valueOf(argv, 'target');

      return label === null || label === '' || target === null || !/^https?:\/\//i.test(target) ? null : { sessionId, kind, label, target };
    }
    case 'question': {
      const question = valueOf(argv, 'text');

      return question === null || question.trim() === '' ? null : { sessionId, kind, text: question };
    }
    case 'paste': {
      const label = valueOf(argv, 'label');
      const given = valueOf(argv, 'file');
      const file = given === null ? null : windowsDrivePath(given, root);

      // The extension reads the file later from another directory, so a relative path is refused rather than resolved.
      return label === null || label.trim() === '' || file === null || !isPastePath(file) ? null : { sessionId, kind, label, file };
    }
    default:
      return null;
  }
}

