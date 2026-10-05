import { resolve } from 'node:path';

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

/** A report body from `report <kind> <sessionId> …`, or null for bad usage. */
export function reportBody(argv: readonly string[]): Record<string, unknown> | null {
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
      const prompt = valueOf(argv, 'prompt');

      const report = valueOf(argv, 'report');

      // A --report flag without a value is bad usage, not an approval without a draft.
      return prompt === null || prompt === '' || ((report === null || report === '') && hasFlag(argv, 'report')) ? null : { sessionId, kind, prompt, summary: valueOf(argv, 'summary'), report: report === null ? null : resolve(report) };
    }
    case 'link': {
      const label = valueOf(argv, 'label');
      const target = valueOf(argv, 'target');

      return label === null || label === '' || target === null || !/^https?:\/\//i.test(target) ? null : { sessionId, kind, label, target };
    }
    default:
      return null;
  }
}

