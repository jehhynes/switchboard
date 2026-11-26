import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustHooks } from '../src/trust.js';
import { EDIT, LISTED, OURS } from './trustFixtures.js';

describe('trustHooks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-codex-trust-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in app-server that answers each request from a script and records what it received. */
  function server(answers: Record<string, unknown>): string {
    const path = join(dir, 'server.mjs');

    writeFileSync(
      path,
      `import { appendFileSync } from 'node:fs';
const answers = ${JSON.stringify(answers)};
let partial = '';
process.stdout.write('not json\\n' + JSON.stringify({ method: 'remoteControl/status' }) + '\\n');
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  const lines = (partial + chunk).split('\\n');
  partial = lines.pop();
  for (const line of lines) {
    const request = JSON.parse(line);
    appendFileSync(${JSON.stringify(join(dir, 'received.jsonl'))}, line + '\\n');
    const answer = answers[request.method];
    if (answer === 'exit') process.exit(0);
    if (answer !== 'silent') process.stdout.write(JSON.stringify({ id: request.id, ...answer }) + '\\n');
  }
});
`,
    );

    return path;
  }

  const received = () => readFileSync(join(dir, 'received.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: unknown });

  it("writes the hashes of Switchboard's hooks through the app-server", async () => {
    const script = server({ initialize: { result: {} }, 'hooks/list': { result: LISTED }, 'config/batchWrite': { result: { status: 'ok' } } });

    expect(await trustHooks(process.execPath, OURS, {}, 10_000, [script])).toBeNull();
    expect(received().map((request) => request.method)).toEqual(['initialize', 'hooks/list', 'config/batchWrite']);
    expect(received()[2]!.params).toEqual({ edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: EDIT }] });
  });

  it('reports a server that refuses, exits or does not answer as a trust failure', async () => {
    expect(await trustHooks(process.execPath, OURS, {}, 10_000, [server({ initialize: { error: { message: 'no' } } })])).toBe("Codex did not trust Switchboard's hooks: no");
    expect(await trustHooks(process.execPath, OURS, {}, 10_000, [server({ initialize: 'exit' })])).toBe("Codex did not trust Switchboard's hooks: Codex stopped before it answered the hook trust request.");
    expect(await trustHooks(process.execPath, OURS, {}, 300, [server({ initialize: 'silent' })])).toBe("Codex did not trust Switchboard's hooks: Codex did not answer the hook trust request within 0.3 seconds.");
  });

  it('reports a Codex CLI that is not found as missing, not as a trust failure', async () => {
    const missing = join(dir, 'missing.exe');

    expect(await trustHooks(missing, OURS, {}, 10_000)).toBe(`Codex was not found at ${missing}. Install it or set sessions.codexPath.`);
  });
});
