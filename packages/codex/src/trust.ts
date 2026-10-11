import { spawn } from 'node:child_process';
import { cliEnvironment } from '@switchboard/core';

/** One step of the trust exchange: send the next request, finish with an error or null, or ignore the message. */
export type TrustStep = { send: unknown } | { done: string | null } | null;

const INITIALIZE = 1;
const LIST = 2;
const WRITE = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `hooks.state` edit that trusts Switchboard's untrusted or modified hooks, and how many of Switchboard's hooks Codex listed. */
export function trustEdit(listResult: unknown, commands: ReadonlySet<string>): { value: Record<string, { trusted_hash: string }>; ours: number } {
  const value: Record<string, { trusted_hash: string }> = {};
  let ours = 0;
  const scopes = isRecord(listResult) && Array.isArray(listResult['data']) ? listResult['data'] : [];

  for (const scope of scopes) {
    const hooks = isRecord(scope) && Array.isArray(scope['hooks']) ? scope['hooks'] : [];

    for (const hook of hooks) {
      if (!isRecord(hook) || typeof hook['command'] !== 'string' || !commands.has(hook['command']) || typeof hook['key'] !== 'string') {
        continue;
      }

      ours += 1;

      if (hook['trustStatus'] !== 'trusted' && typeof hook['currentHash'] === 'string') {
        value[hook['key']] = { trusted_hash: hook['currentHash'] };
      }
    }
  }

  return { value, ours };
}

/**
 * Codex runs a new or changed hook only once it is trusted, and only Codex computes the hash it trusts, so the hub asks Codex's
 * app-server for the hooks and writes back the hashes of Switchboard's own (mechanics M31, GC M41). Other hooks keep their trust.
 */
export function trustExchange(commands: ReadonlySet<string>): { start(): unknown; take(reply: unknown): TrustStep } {
  return {
    start: () => ({ id: INITIALIZE, method: 'initialize', params: { clientInfo: { name: 'switchboard', version: '0.0.0' }, capabilities: { experimentalApi: true } } }),
    take(reply) {
      if (!isRecord(reply) || ![INITIALIZE, LIST, WRITE].includes(reply['id'] as number)) {
        return null;
      }

      if (isRecord(reply['error'])) {
        return { done: typeof reply['error']['message'] === 'string' ? reply['error']['message'] : 'Codex refused the request.' };
      }

      if (reply['id'] === INITIALIZE) {
        return { send: { id: LIST, method: 'hooks/list', params: {} } };
      }

      if (reply['id'] === LIST) {
        const edit = trustEdit(reply['result'], commands);

        if (edit.ours === 0) {
          return { done: "Codex listed none of Switchboard's hooks, so it may read another hooks.json." };
        }

        return Object.keys(edit.value).length === 0
          ? { done: null }
          : { send: { id: WRITE, method: 'config/batchWrite', params: { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: edit.value }] } } };
      }

      return { done: null };
    },
  };
}

const TRUST_TIMEOUT_MS = 20_000;

/** Runs the trust exchange with `codex app-server` over stdio; resolves with the error to show, or null. Tests pass a stand-in server's arguments. */
export function trustHooks(codexPath: string, commands: ReadonlySet<string>, env: Record<string, string> = {}, timeoutMs = TRUST_TIMEOUT_MS, args = ['app-server']): Promise<string | null> {
  return new Promise((resolve) => {
    const exchange = trustExchange(commands);
    let settled = false;
    let partial = '';
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(codexPath, args, { env: { ...cliEnvironment(process.env), ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      resolve((error as Error).message);
      return;
    }

    const finish = (result: string | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(`Codex did not answer the hook trust request within ${timeoutMs / 1000} seconds.`), timeoutMs);
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);

    child.on('error', (error) => finish(error.message));
    child.on('exit', () => finish('Codex stopped before it answered the hook trust request.'));
    child.stdin?.on('error', () => {});
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n');

      partial = lines.pop() ?? '';

      for (const line of lines) {
        let reply: unknown;

        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }

        const step = exchange.take(reply);

        if (step === null) {
          continue;
        }

        if ('done' in step) {
          finish(step.done);
          return;
        }

        send(step.send);
      }
    });

    send(exchange.start());
  });
}
