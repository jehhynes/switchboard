import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';

/** One part of an `AskUserQuestion` call, as Claude's job state records it (mechanics M24). */
export interface JobQuestion {
  question: string;
  options: { label: string; description: string }[];
}

/** The job state file of a background session, which the background service writes (mechanics M24). */
export function jobStatePath(configDir: string, shortId: string): string {
  return join(configDir, 'jobs', shortId, 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function questionOf(value: unknown): JobQuestion | null {
  if (!isRecord(value) || typeof value['question'] !== 'string' || value['question'].trim() === '' || !Array.isArray(value['options'])) {
    return null;
  }

  const options: JobQuestion['options'] = [];

  for (const option of value['options']) {
    if (!isRecord(option) || typeof option['label'] !== 'string' || option['label'].trim() === '') {
      return null;
    }

    options.push({ label: option['label'], description: typeof option['description'] === 'string' ? option['description'] : '' });
  }

  return { question: value['question'], options };
}

/**
 * The questions a background session waits on, from its job state: present while `tempo` is `blocked` and `block.questions` holds
 * well-formed questions. Null for a missing or unreadable file or any other shape, because the format is undocumented (mechanics M24).
 */
export function readJobQuestion(configDir: string, shortId: string): { questions: JobQuestion[] } | null {
  let state: unknown;

  try {
    state = JSON.parse(readFileSync(jobStatePath(configDir, shortId), 'utf8'));
  } catch {
    return null;
  }

  if (!isRecord(state) || state['tempo'] !== 'blocked' || !isRecord(state['block']) || !Array.isArray(state['block']['questions'])) {
    return null;
  }

  const questions = state['block']['questions'].map(questionOf);

  return questions.length === 0 || questions.includes(null) ? null : { questions: questions as JobQuestion[] };
}

/** How the reply request reaches Claude's background service; tests inject a test-owned pipe. */
export interface ServiceDeps {
  /** The names in `\\.\pipe\`. */
  listPipes(): string[];
  connect(path: string): Socket;
}

export const claudeService: ServiceDeps = {
  listPipes: () => readdirSync('\\\\.\\pipe\\'),
  connect: (path) => connect(path),
};

export const REPLY_TIMEOUT_MS = 5_000;

const CONTROL_PIPE = /^cc-daemon-[0-9a-f]+-control$/;

/** The background service's control pipe, or why there is not exactly one. */
function controlPipe(deps: ServiceDeps): { path: string } | { error: string } {
  let names: string[];

  try {
    names = deps.listPipes().filter((name) => CONTROL_PIPE.test(name));
  } catch (error) {
    return { error: `Switchboard could not list the named pipes: ${(error as Error).message}` };
  }

  if (names.length === 0) {
    return { error: "Claude's background service is not running." };
  }

  if (names.length > 1) {
    return { error: `Several Claude background services are running (${names.join(', ')}), so Switchboard cannot tell which one holds the session.` };
  }

  return { path: `\\\\.\\pipe\\${names[0]}` };
}

/**
 * Answers a background session's question through the background service's `reply` request on its control pipe, authenticated by
 * `<config dir>/daemon/control.key` (mechanics M24). Returns null when the service accepted it, else its message or why it was not sent.
 */
export async function replyToSession(configDir: string, shortId: string, text: string, deps: ServiceDeps, timeoutMs = REPLY_TIMEOUT_MS): Promise<{ error: string } | null> {
  const pipe = controlPipe(deps);

  if ('error' in pipe) {
    return pipe;
  }

  const keyPath = join(configDir, 'daemon', 'control.key');
  let key: string;

  try {
    key = readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    return { error: `Switchboard could not read ${keyPath}: ${(error as Error).message}` };
  }

  const line = await new Promise<{ line: string } | { error: string }>((resolve) => {
    const socket = deps.connect(pipe.path);
    let buffer = '';
    const finish = (result: { line: string } | { error: string }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `Claude's background service did not answer within ${timeoutMs / 1000} seconds.` }), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ proto: 1, op: 'reply', short: shortId, text, auth: key })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      const end = buffer.indexOf('\n');

      if (end !== -1) {
        finish({ line: buffer.slice(0, end) });
      }
    });
    socket.on('error', (error) => finish({ error: `Claude's background service did not take the answer: ${error.message}` }));
    socket.on('close', () => finish({ error: "Claude's background service closed the connection without answering." }));
  });

  if ('error' in line) {
    return line;
  }

  let reply: unknown;

  try {
    reply = JSON.parse(line.line);
  } catch {
    return { error: `Claude's background service answered with text that is not JSON: ${line.line.slice(0, 200)}` };
  }

  if (isRecord(reply) && reply['ok'] === true) {
    return null;
  }

  return { error: isRecord(reply) && typeof reply['error'] === 'string' ? reply['error'] : `Claude's background service refused the answer: ${line.line.slice(0, 200)}` };
}
