import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hubRecordPath, switchboardHome } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordedHubPid } from '../src/discover.js';
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

describe('recordedHubPid', () => {
  it('is the recorded pid while that process runs, else null', () => {
    const record = { protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', execPath: '', port: 1, token: 't', pid: process.pid, startedAt: 'now' };

    expect(recordedHubPid(home)).toBeNull();

    write(record);
    expect(recordedHubPid(home)).toBe(process.pid);

    const exited = spawnSync(process.execPath, ['-e', '']).pid!;

    write({ ...record, pid: exited });
    expect(recordedHubPid(home)).toBeNull();
  });
});
