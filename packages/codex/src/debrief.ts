import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '@switchboard/core';
import { executableDirOnPath } from '@switchboard/core';
import { forkArgs } from './args.js';
import { lastErrorLine } from './log.js';
import { codexNotFound } from './processes.js';

/** The rollout file of a thread and when it was last written. */
export interface Rollout {
  path: string;
  writtenAt: number;
}

/** The thread's rollout under `<codex home>/sessions/YYYY/MM/DD/`, newest day first, or null. */
export function findRollout(codexHome: string, threadId: string): Rollout | null {
  const suffix = `-${threadId}.jsonl`;
  const names = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };

  for (const year of names(join(codexHome, 'sessions'))) {
    for (const month of names(join(codexHome, 'sessions', year))) {
      for (const day of names(join(codexHome, 'sessions', year, month))) {
        const dir = join(codexHome, 'sessions', year, month, day);
        const file = names(dir).find((name) => name.startsWith('rollout-') && name.endsWith(suffix));

        if (file !== undefined) {
          const path = join(dir, file);

          try {
            return { path, writtenAt: statSync(path).mtimeMs };
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

/** The work a Codex debrief covers: the turns after the last debriefed one (PRD R55). */
export interface CodexDebriefRange {
  /** The last completed turn; the next debrief starts after it. */
  throughTurnId: string;
  /** Tool calls in the range's turns. */
  toolCalls: number;
  /** The opening of the first user message after the start; null for a first debrief or when none is found. */
  fromPrompt: string | null;
}

const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
/**
 * Messages Codex adds as the user's, which are not the operator's prompt: AGENTS.md, and context in one of Codex's own tags, such as
 * `<environment_context>` or the panel's `<external_codex_apps_open_page>` (mechanics M31). An operator's prompt in another tag is kept.
 */
const INJECTED = /^\s*(# AGENTS\.md instructions|<(environment_context|user_instructions|external_codex_[a-z_]+)>[\s\S]*<\/\2>\s*$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The range of a rollout after `afterTurnId`, or the whole thread when that turn is not in it, counting tool calls per turn and ending at the last
 * completed turn. Null when no completed turn follows.
 */
export function codexDebriefRange(text: string, afterTurnId: string | null): CodexDebriefRange | null {
  const turns: { id: string; toolCalls: number; prompt: string | null; completed: boolean }[] = [];

  for (const line of text.split('\n')) {
    let record: unknown;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = isRecord(record) && isRecord(record['payload']) ? record['payload'] : null;

    if (payload === null) {
      continue;
    }

    const current = turns.at(-1);

    if (record !== null && (record as Record<string, unknown>)['type'] === 'event_msg' && typeof payload['turn_id'] === 'string') {
      if (payload['type'] === 'task_started') {
        turns.push({ id: payload['turn_id'], toolCalls: 0, prompt: null, completed: false });
      } else if (payload['type'] === 'task_complete' && current?.id === payload['turn_id']) {
        current.completed = true;
      }

      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (TOOL_CALLS.has(String(payload['type']))) {
      current.toolCalls += 1;
    } else if (payload['type'] === 'message' && payload['role'] === 'user' && current.prompt === null && Array.isArray(payload['content'])) {
      const text = payload['content'].map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join('');

      if (!INJECTED.test(text)) {
        current.prompt = text;
      }
    }
  }

  const after = afterTurnId === null ? -1 : turns.findIndex((turn) => turn.id === afterTurnId);
  const range = turns.slice(after + 1);
  const last = range.map((turn) => turn.completed).lastIndexOf(true);

  if (last === -1) {
    return null;
  }

  const covered = range.slice(0, last + 1);
  const opening = after === -1 ? null : covered[0]!.prompt;

  return {
    throughTurnId: covered[last]!.id,
    toolCalls: covered.reduce((sum, turn) => sum + turn.toolCalls, 0),
    fromPrompt: opening === null ? null : opening.replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

export function codexScopeOf(range: CodexDebriefRange): string {
  return range.fromPrompt === null ? 'the whole conversation' : `the work after the user message that begins "${range.fromPrompt}"`;
}

/**
 * Asks the thread in an ephemeral, read-only fork, which leaves the thread unchanged (mechanics M31); the prompt goes on stdin. Returns the fork's
 * last message, or why it failed.
 */
export async function runCodexDebrief(
  input: { codexPath: string; threadId: string; cwd: string; prompt: string; env: Record<string, string>; timeoutMs: number },
  exec: Exec,
): Promise<{ text: string } | { error: string }> {
  const env = { ...executableDirOnPath(input.codexPath), ...input.env };
  const result = await exec(input.codexPath, forkArgs(input.threadId), { cwd: input.cwd, stdin: input.prompt, env, timeoutMs: input.timeoutMs });

  // A missing working directory also fails with ENOENT.
  if (result.missing) {
    return { error: existsSync(input.cwd) ? codexNotFound(input.codexPath) : `The session's directory ${input.cwd} was not found.` };
  }

  if (result.timedOut) {
    return { error: `The Codex debrief did not finish within ${input.timeoutMs / 1000} seconds.` };
  }

  let last: string | null = null;
  let failure: string | null = null;

  for (const line of result.stdout.split('\n')) {
    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(event)) {
      continue;
    }

    const item = event['item'];

    if (event['type'] === 'item.completed' && isRecord(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      last = item['text'];
    } else if (event['type'] === 'turn.failed' && isRecord(event['error']) && typeof event['error']['message'] === 'string') {
      failure = event['error']['message'];
    }
  }

  if (failure !== null || result.code !== 0 || last === null) {
    return { error: failure ?? lastErrorLine(result.stderr) ?? `codex exec fork exited with code ${String(result.code)} and no answer.` };
  }

  return { text: last };
}
