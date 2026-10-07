import { mkdirSync, writeFileSync } from 'node:fs';
import { hubRecordPath, switchboardHome } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findHub, readHubRecord } from '../src/discover.js';
import { listenHub } from '../src/server.js';
import { tempHome } from './helpers.js';

let home: string;
let remove: () => void;

beforeEach(() => {
  ({ home, remove } = tempHome());
  mkdirSync(switchboardHome(home), { recursive: true });
});

afterEach(() => remove());

function write(record: object): void {
  writeFileSync(hubRecordPath(home), JSON.stringify(record));
}

describe('findHub', () => {
  it('is null with no record', async () => {
    expect(readHubRecord(home)).toBeNull();
    expect(await findHub(home)).toBeNull();
  });

  it('is null for a malformed record', async () => {
    writeFileSync(hubRecordPath(home), '{"protocol":');

    expect(await findHub(home)).toBeNull();
  });

  it('accepts only a hub that answers with the recorded token and pid', async () => {
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 4321 }, onShutdown: () => {} });

    try {
      const record = { protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', port: server.port, token: server.token, pid: 4321, startedAt: 'now' };

      write(record);
      expect(await findHub(home)).toEqual(record);

      write({ ...record, token: 'wrong' });
      expect(await findHub(home)).toBeNull();

      write({ ...record, pid: 1234 });
      expect(await findHub(home)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('rejects a listener that is not a Switchboard hub', async () => {
    const server = await listenHub({ identity: { hub: 'something-else', protocol: 1, version: '0.1.0', pid: 4321 }, onShutdown: () => {} });

    try {
      write({ protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', port: server.port, token: server.token, pid: 4321, startedAt: 'now' });
      expect(await findHub(home)).toBeNull();
    } finally {
      await server.close();
    }
  });
});
