import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseZohoConfig } from '../src/config.js';
import type { ZohoConfig } from '../src/config.js';
import { deskClient } from '../src/desk.js';

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
  const config = (parseZohoConfig({ ...REQUIRED, orgId: '700000001', agentId: '1', apiBase: `http://127.0.0.1:${port}/api/v1/` }) as { config: ZohoConfig }).config;

  return { seen, config };
}

const REQUIRED = { tokenCommand: 'print-token', scopeField: 'cf_queue', scopeValue: 'Support' };

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

    expect(await get('/teams')).toEqual({ error: 'Zoho Desk rate-limited the read.', status: 429 });
    expect(await get('/tickets/5?include=assignee')).toEqual({ error: 'Zoho Desk answered HTTP 500 for /tickets/5.', status: 500 });
    expect(await get('/teams')).toEqual({ error: 'Zoho Desk returned output that is not JSON.' });
    expect(await get('/teams')).toEqual({ error: 'Zoho Desk refused the access token.' });
    expect(await deskClient(config, async () => ({ error: 'no token' }))('/teams')).toEqual({ error: 'no token' });
  });
});

describe('deskClient without a server', () => {
  it('reports an unreachable Desk', async () => {
    // A listener of the test's own that drops every connection unanswered, as an unreachable Desk would.
    const dropping = createNetServer((socket) => socket.destroy());

    await new Promise<void>((done) => dropping.listen(0, '127.0.0.1', done));

    try {
      const port = (dropping.address() as AddressInfo).port;
      const config = (parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', apiBase: `http://127.0.0.1:${port}/api/v1` }) as { config: ZohoConfig }).config;

      expect(await deskClient(config, async () => ({ token: 't' }))('/teams')).toEqual({ error: expect.stringMatching(/^Zoho Desk could not be reached: /) });
    } finally {
      await new Promise((done) => dropping.close(done));
    }
  });
});

describe('parseZohoConfig', () => {
  it('applies defaults and requires the IDs, the token command and the scope', () => {
    expect(parseZohoConfig({ ...REQUIRED, orgId: '700000001', agentId: '8000000000000000001' })).toEqual({
      config: {
        tokenCommand: 'print-token',
        apiBase: 'https://desk.zoho.com/api/v1',
        orgId: '700000001',
        agentId: '8000000000000000001',
        scopeField: 'cf_queue',
        scopeValue: 'Support',
        scopeHistoryField: '',
        poolTeams: [],
        automationAgentIds: [],
        contextFields: ['cf_queue'],
        historyFields: ['Status', 'Case Owner', 'Team'],
        maxPages: 20,
      },
    });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', scopeHistoryField: 'Queue', historyFields: ['Status'], contextFields: [] })).toMatchObject({
      config: { scopeHistoryField: 'Queue', historyFields: ['Queue', 'Status'], contextFields: [] },
    });
    expect(parseZohoConfig({ ...REQUIRED, agentId: '1' })).toEqual({ error: 'sources.zoho.orgId must be set to the Desk organization ID, as a string.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: 8000000000000000001 })).toEqual({ error: 'sources.zoho.agentId must be set to your Zoho agent ID, as a string.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', credentialsPath: 'x' })).toEqual({ error: 'sources.zoho.credentialsPath is not a setting.' });
    expect(parseZohoConfig({ orgId: '1', agentId: '1', escalationValue: 'x' }, 'desk')).toEqual({ error: 'sources.desk.escalationValue is now scopeValue.' });
    for (const key of ['tokenCommand', 'scopeField', 'scopeValue'] as const) {
      expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', [key]: undefined })).toEqual({ error: `sources.zoho.${key} must be a non-empty string.` });
    }
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', tokenCommand: '' })).toEqual({ error: 'sources.zoho.tokenCommand must be a non-empty string.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', scopeHistoryField: 1 })).toEqual({ error: 'sources.zoho.scopeHistoryField must be a string.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', automationAgentIds: [1] })).toEqual({ error: 'sources.zoho.automationAgentIds must list agent IDs as strings.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', poolTeams: [''] })).toEqual({ error: 'sources.zoho.poolTeams must list names as non-empty strings.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', contextFields: 'cf_queue' })).toEqual({ error: 'sources.zoho.contextFields must list names as non-empty strings.' });
    expect(parseZohoConfig({ ...REQUIRED, orgId: '1', agentId: '1', maxPages: 0 })).toEqual({ error: 'sources.zoho.maxPages must be a whole number of at least 1.' });
  });
});
