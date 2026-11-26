import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hubLogPath, LOG_ROTATE_BYTES, switchboardHome } from '@switchboard/core';
import { closeSync, openSync, renameSync } from 'node:fs';
import { logWriter, startDetached } from '../src/start.js';
import { startSuccessor } from '../src/restart.js';

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

const until = async (check: () => boolean): Promise<void> => {
  for (const end = Date.now() + 10_000; !check(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
};

describe('hub.log rotation when a hub starts (architecture.md § Hub log)', () => {
  it('rotates a full hub.log to hub.log.1 before hub.js start appends the new hub to it', async () => {
    home = mkdtempSync(join(tmpdir(), 'switchboard-start-'));
    mkdirSync(switchboardHome(home), { recursive: true });
    const script = join(home, 'hub.js');
    writeFileSync(script, "process.stdout.write('new hub\\n');");
    writeFileSync(hubLogPath(home), 'o'.repeat(LOG_ROTATE_BYTES));

    // Without rotate, as when a hub may still hold the lock, the full log stays where the running hub writes.
    const kept = startDetached(process.execPath, script, home, []);
    await new Promise((done) => kept.once('exit', done));
    expect(existsSync(`${hubLogPath(home)}.1`)).toBe(false);
    writeFileSync(hubLogPath(home), 'o'.repeat(LOG_ROTATE_BYTES));

    const child = startDetached(process.execPath, script, home, [], { rotate: true });
    await new Promise((done) => child.once('exit', done));

    expect(readFileSync(hubLogPath(home), 'utf8')).toBe('new hub\n');
    expect(readFileSync(`${hubLogPath(home)}.1`, 'utf8')).toHaveLength(LOG_ROTATE_BYTES);
  });

  it('rotates a full hub.log before a restart starts the successor, and leaves a smaller one', async () => {
    home = mkdtempSync(join(tmpdir(), 'switchboard-start-'));
    mkdirSync(switchboardHome(home), { recursive: true });
    const script = join(home, 'hub.js');
    writeFileSync(script, "process.stdout.write('successor\\n'); process.exit(1);");
    writeFileSync(hubLogPath(home), 'o'.repeat(LOG_ROTATE_BYTES));

    expect(await startSuccessor({ execPath: process.execPath, bundle: script, args: [], env: process.env, logPath: hubLogPath(home), readyMs: 5_000 })).toMatchObject({ error: expect.stringContaining('exited') });
    await until(() => existsSync(hubLogPath(home)) && readFileSync(hubLogPath(home), 'utf8') === 'successor\n');
    expect(existsSync(`${hubLogPath(home)}.1`)).toBe(true);

    writeFileSync(hubLogPath(home), 'small\n');
    await startSuccessor({ execPath: process.execPath, bundle: script, args: [], env: process.env, logPath: hubLogPath(home), readyMs: 5_000 });
    expect(readFileSync(hubLogPath(home), 'utf8')).toBe('small\nsuccessor\n');
  });
});

describe("the hub's log writer", () => {
  it('writes to its output while that is hub.log, and to hub.log by path once another start rotated its output away', () => {
    home = mkdtempSync(join(tmpdir(), 'switchboard-start-'));
    const path = join(home, 'hub.log');
    const fd = openSync(path, 'a');
    const written: string[] = [];
    // The output stands for the hub's stdout, the file its starter opened.
    const write = logWriter(path, (text) => { written.push(text); appendFileSync(fd, text); }, fd);

    try {
      write('one\n');
      expect(readFileSync(path, 'utf8')).toBe('one\n');
      renameSync(path, `${path}.1`);
      writeFileSync(path, '');
      // The very next line follows the file.
      write('two\n');
      expect(readFileSync(path, 'utf8')).toBe('two\n');
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('one\n');
      expect(written).toEqual(['one\n']);
    } finally {
      closeSync(fd);
    }
  });
});
