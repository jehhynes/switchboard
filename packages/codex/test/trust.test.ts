import { describe, expect, it } from 'vitest';
import { trustEdit, trustExchange } from '../src/trust.js';
import { EDIT, LISTED, OURS } from './trustFixtures.js';


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
