import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustEdit, trustExchange, trustHooks } from '../src/trust.js';

const OURS = new Set(['node "C:/h/codex-hook.mjs"', 'node "C:/h/contract.mjs"']);
/** The edit for LISTED: Switchboard's untrusted and modified hooks. */
const EDIT = { 'C:\\c\\hooks.json:stop:1:0': { trusted_hash: 'sha256:a' }, 'C:\\c\\hooks.json:session_start:1:0': { trusted_hash: 'sha256:c' } };

/** A `hooks/list` result as Codex 0.160 gives it (mechanics M31). */
const LISTED = {
  data: [
    {
      hooks: [
        { key: 'C:\\c\\hooks.json:stop:0:0', command: 'node support.js', trustStatus: 'untrusted', currentHash: 'sha256:support' },
        { key: 'C:\\c\\hooks.json:stop:1:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'untrusted', currentHash: 'sha256:a' },
        { key: 'C:\\c\\hooks.json:session_start:0:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'trusted', currentHash: 'sha256:b' },
        { key: 'C:\\c\\hooks.json:session_start:1:0', command: 'node "C:/h/contract.mjs"', trustStatus: 'modified', currentHash: 'sha256:c' },
        { key: 'C:\\c\\hooks.json:stop:2:0', command: 'node "C:/h/codex-hook.mjs"', trustStatus: 'untrusted' },
      ],
    },
  ],
};

describe('trustEdit', () => {
  it("trusts Switchboard's untrusted and modified hooks only, and counts them", () => {
    expect(trustEdit(LISTED, OURS)).toEqual({
      value: { 'C:\\c\\hooks.json:stop:1:0': { trusted_hash: 'sha256:a' }, 'C:\\c\\hooks.json:session_start:1:0': { trusted_hash: 'sha256:c' } },
      ours: 4,
    });
    expect(trustEdit({ data: 'x' }, OURS)).toEqual({ value: {}, ours: 0 });
    expect(trustEdit(null, OURS)).toEqual({ value: {}, ours: 0 });
  });
});

describe('trustExchange', () => {
  it('initializes, lists the hooks, then writes the trust edit', () => {
    const exchange = trustExchange(OURS);

    expect(exchange.start()).toMatchObject({ id: 1, method: 'initialize' });
    expect(exchange.take({ method: 'notice' })).toBeNull();
    expect(exchange.take({ id: 1, result: {} })).toEqual({ send: { id: 2, method: 'hooks/list', params: {} } });
    expect(exchange.take({ id: 2, result: LISTED })).toEqual({
      send: { id: 3, method: 'config/batchWrite', params: { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: EDIT }] } },
    });
    expect(exchange.take({ id: 3, result: { status: 'ok' } })).toEqual({ done: null });
  });

  it('finishes without a write when everything is trusted, and fails when Codex lists none of the hooks or refuses', () => {
    expect(trustExchange(OURS).take({ id: 2, result: { data: [{ hooks: [{ key: 'k', command: 'node "C:/h/contract.mjs"', trustStatus: 'trusted', currentHash: 'h' }] }] } })).toEqual({ done: null });
    expect(trustExchange(OURS).take({ id: 2, result: { data: [] } })).toEqual({ done: "Codex listed none of Switchboard's hooks, so it may read another hooks.json." });
    expect(trustExchange(OURS).take({ id: 1, error: { message: 'no' } })).toEqual({ done: 'no' });
    expect(trustExchange(OURS).take({ id: 3, error: {} })).toEqual({ done: 'Codex refused the request.' });
  });
});

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

    expect(await trustHooks(missing, OURS, {}, 10_000)).toBe(`Codex was not found at ${missing}. Install it or set sessions.codex.path.`);
  });
});
