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
    case 'blocked': {
      const reason = valueOf(argv, 'reason');

      return reason === null || reason === '' ? null : { sessionId, kind, reason };
    }
    case 'approval': {
      const prompt = valueOf(argv, 'prompt');

      return prompt === null || prompt === '' ? null : { sessionId, kind, prompt, summary: valueOf(argv, 'summary') };
    }
    case 'link': {
      const label = valueOf(argv, 'label');
      const target = valueOf(argv, 'target');

      // Any other URL scheme is refused rather than read as a relative path.
      if (label === null || label === '' || target === null || target === '' || (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^https?:\/\//i.test(target))) {
        return null;
      }

      return { sessionId, kind, label, target: /^https?:\/\//i.test(target) ? target : resolve(target) };
    }
    default:
      return null;
  }
}

