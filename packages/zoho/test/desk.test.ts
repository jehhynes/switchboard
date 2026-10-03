import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseZohoConfig } from '../src/config.js';
import type { ZohoConfig } from '../src/config.js';
import { commandToken, deskClient } from '../src/desk.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** A loopback stand-in for Desk that answers each request in turn and records method, path and headers. */
async function fakeDesk(...answers: { status: number; body?: unknown }[]) {
  const seen: { method: string; path: string; auth: string; org: string }[] = [];

  server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', path: request.url ?? '', auth: String(request.headers.authorization), org: String(request.headers['orgid']) });
    const answer = answers.shift() ?? { status: 500 };
    response.writeHead(answer.status, { 'Content-Type': 'application/json' });
    response.end(answer.body === undefined ? undefined : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const port = (server!.address() as { port: number }).port;
  const config = (parseZohoConfig({ orgId: '700000001', agentId: '1', apiBase: `http://127.0.0.1:${port}/api/v1/` }) as { config: ZohoConfig }).config;

  return { seen, config };
}

describe('deskClient', () => {
  it('sends GETs with the token and org, reuses the token, and refreshes once on 401', async () => {
    const { seen, config } = await fakeDesk({ status: 200, body: { a: 1 } }, { status: 401 }, { status: 200, body: { b: 2 } }, { status: 204 });
    let minted = 0;
    const get = deskClient(config, async () => ({ token: `t${++minted}` }));

    expect(await get('/teams')).toEqual({ json: { a: 1 } });
    expect(await get('/tickets/1')).toEqual({ json: { b: 2 } });
    expect(await get('/tickets/search?x=1')).toEqual({ empty: true });
    expect(seen).toEqual([
      { method: 'GET', path: '/api/v1/teams', auth: 'Zoho-oauthtoken t1', org: '700000001' },
      { method: 'GET', path: '/api/v1/tickets/1', auth: 'Zoho-oauthtoken t1', org: '700000001' },
      { method: 'GET', path: '/api/v1/tickets/1', auth: 'Zoho-oauthtoken t2', org: '700000001' },
      { method: 'GET', path: '/api/v1/tickets/search?x=1', auth: 'Zoho-oauthtoken t2', org: '700000001' },
    ]);
  });

  it('reports rate limits, HTTP errors, bad JSON, a refused token and a failed token command', async () => {
    const { config } = await fakeDesk({ status: 429 }, { status: 500 }, { status: 200, body: 'not json' }, { status: 401 }, { status: 401 });
    const get = deskClient(config, async () => ({ token: 't' }));

    expect(await get('/teams')).toEqual({ error: 'Zoho Desk rate-limited the read.' });
    expect(await get('/tickets/5?include=assignee')).toEqual({ error: 'Zoho Desk answered HTTP 500 for /tickets/5.' });
    expect(await get('/teams')).toEqual({ error: 'Zoho Desk returned output that is not JSON.' });
    expect(await get('/teams')).toEqual({ error: 'Zoho Desk refused the access token.' });
    expect(await deskClient(config, async () => ({ error: 'no token' }))('/teams')).toEqual({ error: 'no token' });
  });
});

describe('deskClient without a server', () => {
  it('reports an unreachable Desk', async () => {
    const config = (parseZohoConfig({ orgId: '1', agentId: '1', apiBase: 'http://127.0.0.1:1/api/v1' }) as { config: ZohoConfig }).config;

    expect(await deskClient(config, async () => ({ token: 't' }))('/teams')).toEqual({ error: expect.stringMatching(/^Zoho Desk could not be reached: /) });
  });
});

describe('commandToken', () => {
  it('returns what the command prints, and fails when it prints nothing or exits non-zero', async () => {
    expect(await commandToken('echo abc123')()).toEqual({ token: 'abc123' });
    expect(await commandToken('true')()).toEqual({ error: 'The Zoho token command failed: it printed nothing' });
    expect(await commandToken('echo refused >&2; exit 2')()).toEqual({ error: 'The Zoho token command failed: refused' });
  });
});

describe('parseZohoConfig', () => {
  it('applies defaults and requires the org and agent IDs as strings', () => {
    expect(parseZohoConfig({ orgId: '700000001', agentId: '8000000000000000001' })).toEqual({
      config: {
        tokenCommand: 'bash ~/.claude/scripts/desk-token.sh',
        apiBase: 'https://desk.zoho.com/api/v1',
        orgId: '700000001',
        agentId: '8000000000000000001',
        escalationField: 'cf_queue',
        escalationValue: 'Support',
        automationAgentIds: ['8000000000000000002', '8000000000000000003'],
        maxPages: 20,
      },
    });
    expect(parseZohoConfig({ agentId: '1' })).toEqual({ error: 'sources.zoho.orgId must be set to the Desk organization ID, as a string.' });
    expect(parseZohoConfig({ orgId: '1', agentId: 8000000000000000001 })).toEqual({ error: 'sources.zoho.agentId must be set to your Zoho agent ID, as a string.' });
    expect(parseZohoConfig({ orgId: '1', agentId: '1', credentialsPath: 'x' })).toEqual({ error: 'sources.zoho.credentialsPath is not a setting.' });
    expect(parseZohoConfig({ orgId: '1', agentId: '1', tokenCommand: '' })).toEqual({ error: 'sources.zoho.tokenCommand must be a non-empty string.' });
    expect(parseZohoConfig({ orgId: '1', agentId: '1', automationAgentIds: [1] })).toEqual({ error: 'sources.zoho.automationAgentIds must list agent IDs as strings.' });
    expect(parseZohoConfig({ orgId: '1', agentId: '1', maxPages: 0 })).toEqual({ error: 'sources.zoho.maxPages must be a whole number of at least 1.' });
  });
});
