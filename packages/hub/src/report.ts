import { resolve } from 'node:path';

function valueOf(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);

  if (at !== -1) {
    return argv[at + 1] ?? null;
  }

  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));

  return inline === undefined ? null : inline.slice(name.length + 3);
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
      return { sessionId, kind, summary: valueOf(argv, 'summary') };
    case 'blocked': {
      const reason = valueOf(argv, 'reason');

      return reason === null || reason === '' ? null : { sessionId, kind, reason };
    }
    case 'approval': {
      const prompt = valueOf(argv, 'prompt');

      return prompt === null || prompt === '' ? null : { sessionId, kind, prompt, summary: valueOf(argv, 'summary') };
    }
    default:
      return null;
  }
}

