import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { switchboardHome } from '@switchboard/core';
import { holdLock, releaseLock } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { home, useTestHome, start, record, recorded, status, until, stopAndWait } from './hubProcess.js';

useTestHome();

/** One whole hub log line: its UTC timestamp, its level padded to five characters, and `text`. */
const stamped = (level: string, text: string): RegExp => new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z ${level.padEnd(5)} ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n$`);

describe('hub entry point', () => {
  it('serves, refuses a second hub, and stops on --stop', async () => {
    const first = start('--idle-ms=60000');
    const found = await recorded();

    expect(found.pid).toBe(first.child.pid);
    expect(found.configDir).toBe(resolve(home, '.switchboard'));
    expect(await status(found)).toBe(200);

    const second = await start().exited;

    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(stamped('debug', `hub: a second start found the hub already running on port ${found.port}; it exited`));

    const stop = await start('--stop').exited;

    expect(stop.stdout).toBe('Stopped the hub.\n');
    expect((await first.exited).code).toBe(0);
    expect(record()).toBeNull();
  });

  it('creates the --config folder, and records it', async () => {
    const configDir = join(home, 'repo', 'switchboard');
    const first = start('--idle-ms=60000', `--config=${configDir}`);
    const found = await recorded();

    expect(found.configDir).toBe(resolve(configDir));
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, 'playbooks'))).toBe(false);

    await stopAndWait();
    expect((await first.exited).code).toBe(0);
  });

  it('imports --config into config.json once, then serves the folder config.json names, and refuses a config.json it cannot use', async () => {
    const imported = join(home, 'imported');
    const first = start('--idle-ms=60000', `--config=${imported}`);

    expect((await recorded()).configDir).toBe(resolve(imported));
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'config.json'), 'utf8'))).toEqual({ configDir: resolve(imported) });
    await stopAndWait();
    expect((await first.exited).code).toBe(0);

    const chosen = join(home, 'chosen');

    mkdirSync(chosen);
    expect(await start('config', 'set', 'configDir', chosen).exited).toMatchObject({ code: 0, stdout: `The config folder is now ${resolve(chosen)}.\nThe hub reads it when it starts.\n` });
    expect(await start('config', 'get', 'configDir').exited).toMatchObject({ code: 0, stdout: `${resolve(chosen)}\n` });

    // A stale --config, such as an older login entry's, does not move the hub off the folder config.json names.
    const second = start('--idle-ms=60000', `--config=${imported}`);

    expect((await recorded()).configDir).toBe(resolve(chosen));
    await stopAndWait();
    expect((await second.exited).code).toBe(0);
    await until(() => (record() === null ? true : null));

    writeFileSync(join(switchboardHome(home), 'config.json'), '{');

    const refused = await start('--idle-ms=60000').exited;

    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(stamped('error', `hub: did not start: ${join(switchboardHome(home), 'config.json')} is not valid JSON; fix it, or run hub.js config set configDir <folder>`));
    expect(record()).toBeNull();
  }, 60_000);

  it('reports when there is no hub to stop', async () => {
    const stop = await start('--stop').exited;

    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe('No hub is running for this home.\n');
  });

  it('exits 1 when another process holds the lock and no hub answers', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });

    const lock = await holdLock(home);

    try {
      // A short wait for a hub to answer, in place of the 5 seconds a start waits.
      const refused = await start('--wait-ms=200').exited;

      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(stamped('warn', "hub: did not start: another process holds the hub's lock but does not answer. It usually clears when that process exits; if it repeats, the lines above say which hub holds it."));
      expect(record()).toBeNull();
    } finally {
      await releaseLock(lock!);
    }
  });

  it('records reports through the running hub, with exit codes for usage, refusal and no hub', async () => {
    const usage = await start('report', 'stage', 's1').exited;

    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('report stage <sessionId> <headline>');

    const noHub = await start('report', 'stage', 's1', 'Planning').exited;

    expect(noHub).toMatchObject({ code: 2, stderr: 'The Switchboard hub is not running, so the report was not recorded.\n' });

    const hub = start('--idle-ms=60000');
    await recorded();

    const refused = await start('report', 'stage', 's1', 'Planning').exited;

    expect(refused).toMatchObject({ code: 3, stderr: 'Refused: Unknown session s1.\n' });
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop).toHaveLength(1);

    await stopAndWait();
    expect((await hub.exited).code).toBe(0);
  });

  it('prints a web page link, pairs, lists and signs browsers out through the hub, with exit codes for usage, refusals and no hub', async () => {
    const usage = 'Usage: hub.js web [pair | devices | revoke [<device ID>]]\n';

    expect(await start('web', 'now').exited).toMatchObject({ code: 1, stderr: usage });
    expect(await start('web', 'pair', 'now').exited).toMatchObject({ code: 1, stderr: usage });
    expect(await start('web', 'revoke', 'a', 'b').exited).toMatchObject({ code: 1, stderr: usage });
    expect((await start('web').exited).code).toBe(2);
    expect((await start('web', 'revoke').exited).code).toBe(2);
    expect(await start('--page-port=soon').exited).toMatchObject({ code: 1, stderr: '--page-port takes a port number, not "soon".\n' });

    const hub = start('--idle-ms=60000');
    const found = await recorded();
    const link = await start('web').exited;

    expect(link.code).toBe(0);
    expect(link.stdout).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${found.port}/page\\?t=[0-9a-f]{64}`));
    expect(await start('web', 'revoke').exited).toMatchObject({ code: 0, stdout: 'Signed out every browser (0 sign-ins). Open a new link to use the web page again.\n' });
    expect(await start('web', 'devices').exited).toMatchObject({ code: 0, stdout: 'No device is signed in.\n' });
    // No remote host is set, so there is nothing to pair through.
    expect(await start('web', 'pair').exited).toMatchObject({ code: 3, stderr: expect.stringContaining('Refused: Pairing a device needs remote access') });
    expect(await start('web', 'revoke', 'abcdef12').exited).toMatchObject({ code: 3, stderr: 'Refused: No device has the ID abcdef12.\n' });
    expect(await start('web', 'revoke', 'nope').exited).toMatchObject({ code: 3, stderr: 'Refused: Expected {id}, a device ID of 8 hex characters.\n' });

    await stopAndWait();
    expect((await hub.exited).code).toBe(0);
  });

  it('takes --code-mode-idle-ms as a whole number of milliseconds and refuses anything else', async () => {
    expect(await start('--code-mode-idle-ms=soon').exited).toMatchObject({ code: 1, stderr: '--code-mode-idle-ms takes a whole number of milliseconds above 0, not "soon".\n' });

    const hub = start('--idle-ms=60000', '--code-mode-idle-ms=60000');

    await recorded();
    await stopAndWait();
    expect(await hub.exited).toMatchObject({ code: 0, stdout: expect.stringContaining('Code Mode idle limit: 60000 ms') });
  });

  it('exits after the idle time with no client and removes its record', async () => {
    const hub = start('--idle-ms=200');

    await recorded();

    expect((await hub.exited).code).toBe(0);
    expect(record()).toBeNull();
  });
});
