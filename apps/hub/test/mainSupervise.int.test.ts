import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hubBundlePath, hubLogPath, switchboardHome } from '@switchboard/core';
import { buildOf, stopSupervisor, supervisorAddress, supervisorOffPath } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { main, home, useTestHome, start, startWith, launch, record, recorded, status, until, stopAndWait } from './hubProcess.js';

useTestHome();

describe('hub entry point', () => {
  it('drops NO_COLOR and FORCE_COLOR at startup, so the hubs that hub.js start, a restart and the supervisor start run without them (mechanics M149)', async () => {
    const seen = join(home, 'seen.jsonl');
    const colour = { NO_COLOR: '1', FORCE_COLOR: '0' };
    const lines = (): { argv: string[]; NO_COLOR: string | null; FORCE_COLOR: string | null }[] => (existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
    const clean = (from: number): boolean => lines().slice(from).every((line) => line.NO_COLOR === null && line.FORCE_COLOR === null);

    mkdirSync(switchboardHome(home), { recursive: true });
    // The installed bundle notes the environment each process it runs was started with, hubs and their snapshot workers, then runs the hub.
    writeFileSync(
      hubBundlePath(home),
      `import('node:fs').then((fs) => { fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), NO_COLOR: process.env.NO_COLOR ?? null, FORCE_COLOR: process.env.FORCE_COLOR ?? null }) + '\\n'); return import(${JSON.stringify(pathToFileURL(main).href)}); });\n`,
    );

    try {
      // The supervisor's hub, before any deliberate stop, after which the supervisor starts none.
      const supervisor = startWith(colour, 'supervise', '--grace-ms=0', '--check-ms=200');

      await recorded();
      expect(lines().length).toBeGreaterThan(0);
      expect(clean(0)).toBe(true);
      expect(await stopSupervisor(home)).toBe(true);
      expect((await supervisor.exited).code).toBe(0);
      await stopAndWait();
      await until(() => (record() === null ? true : null));

      // Started from a shell that has them, the hub sees them; everything it starts, its successor on hub.js restart included, does not.
      let from = lines().length;

      launch(hubBundlePath(home), colour, ['--idle-ms=60000']);
      await recorded();
      expect(lines()[from]).toMatchObject(colour);
      expect((await startWith(colour, 'restart').exited).code).toBe(0);
      expect(lines().slice(from).some((line) => line.argv.some((argument) => argument.startsWith('--takeover=')))).toBe(true);
      expect(clean(from + 1)).toBe(true);
      await stopAndWait();
      await until(() => (record() === null ? true : null));

      from = lines().length;
      expect((await startWith(colour, 'start').exited).code).toBe(0);
      expect(lines().length).toBeGreaterThan(from);
      expect(clean(from)).toBe(true);
    } finally {
      await stopSupervisor(home).catch(() => false);
      await stopAndWait();
      // The stopped hub may still hold hub.log for a moment; the home is deleted after the test.
      await until(() => (record() === null ? true : null));
    }
  }, 60_000);

  it('starts the installed hub detached on hub.js start, with this runtime and the --config folder, and reports a running one', async () => {
    const missing = await start('start').exited;

    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(`No hub is installed in ${hubBundlePath(home)}; run npm run install-local in the repository, or hub.js install from a build folder, first.\n`);
    expect((await start('start', '--takeover=1').exited).code).toBe(1);

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubBundlePath(home), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    const configDir = join(home, 'config');
    const started = await start('start', `--config=${configDir}`).exited;
    const found = record()!;

    try {
      expect(started.stderr).toBe('');
      expect(started.code).toBe(0);
      expect(started.stdout).toBe(`Started the hub: pid ${found.pid}, build ${buildOf(hubBundlePath(home))}, config folder ${resolve(configDir)}.\n`);
      // The hub outlives the command, runs on the command's runtime, and logs to hub.log.
      expect(found.pid).not.toBe(started.pid);
      expect(found.execPath).toBe(process.execPath);
      expect(await status(found)).toBe(200);
      await until(() => (readFileSync(hubLogPath(home), 'utf8').includes(`as pid ${found.pid}`) ? true : null));

      const again = await start('start').exited;

      expect(again).toMatchObject({ code: 0, stdout: `The hub is already running: pid ${found.pid}, build ${found.build}, config folder ${resolve(configDir)}.\n` });
    } finally {
      await stopAndWait();
    }

    await until(() => (record() === null ? true : null));

    const quick = await start('start', '--no-wait').exited;

    try {
      expect(quick.code).toBe(0);
      expect(quick.stdout).toMatch(/^Starting the hub \(pid \d+\); its output goes to /);
      // The first start imported its --config into config.json, which every later start reads.
      expect((await recorded()).configDir).toBe(resolve(configDir));
    } finally {
      await until(() => (record() !== null ? true : null));
      await stopAndWait();
      await until(() => (record() === null ? true : null));
    }
  }, 60_000);

  it('starts the hub again on hub.js supervise when it is killed, not when it restarts onto a new build or is stopped with --stop, runs one supervisor per home, and stops when asked', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubBundlePath(home), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    const usage = await start('supervise', '--grace-ms=soon').exited;

    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/^Usage: hub\.js supervise \[--config=<dir>\]/);

    // The supervisor passes the serving flags on, here those that keep the test's hubs off the fixed ports.
    const checkMs = 100;
    // A restart delay long enough for a started hub to take the lock, which takes 6 seconds on a slow runner: a check that finds no hub while
    // it waits logs so, which starts() counts, and a start after the delay would find the first hub running.
    const supervisor = start('supervise', '--grace-ms=0', `--check-ms=${checkMs}`, '--restart-delay-ms=15000');
    // What the supervisor did not do shows only after it had the chance: five of its checks.
    const fiveChecks = () => new Promise((done) => setTimeout(done, 5 * checkMs));
    const log = (): string => (existsSync(hubLogPath(home)) ? readFileSync(hubLogPath(home), 'utf8') : '');

    try {
      const first = await recorded();

      expect(first.pid).not.toBe(supervisor.child.pid);
      expect(await status(first)).toBe(200);

      const second = await start('supervise').exited;

      expect(second).toMatchObject({ code: 0, stdout: `A supervisor is already running for this home on ${supervisorAddress(home)}.\n` });

      // A forced exit is a crash: the supervisor starts the hub again.
      process.kill(first.pid, 'SIGKILL');

      const again = await until(() => {
        const found = record();

        return found !== null && found.pid !== first.pid ? found : null;
      }, 40_000);

      expect(await status(again)).toBe(200);
      expect(log()).toContain('supervisor: the hub stopped without hub.js --stop; starting it again');

      // A restart onto a new build hands over to a successor; the supervisor starts no hub of its own meanwhile.
      const starts = (): number => log().split('\n').filter((line) => /supervisor: (no hub is running; starting one|the hub stopped without hub\.js --stop; starting it again|the hub is not running; starting it again)/.test(line)).length;
      const before = starts();
      const restarted = await start('restart').exited;

      expect(restarted.code).toBe(0);
      await fiveChecks();
      expect(starts()).toBe(before);
      expect(log()).not.toContain('a second start found the hub already running');

      // A deliberate stop stays stopped.
      await stopAndWait();
      await until(() => (log().includes('was stopped on purpose (a client asked it to stop)') ? true : null));
      await fiveChecks();
      expect(record()).toBeNull();
      expect(starts()).toBe(before);

      expect(await stopSupervisor(home)).toBe(true);
      expect((await supervisor.exited).code).toBe(0);
      expect(log()).toContain('supervisor: stopping: asked by hub.js autostart');

      // After hub.js autostart off, a supervisor its task had already launched exits once it holds its lock.
      writeFileSync(supervisorOffPath(home), 'off\n');

      const late = await start('supervise', '--grace-ms=0', '--check-ms=200').exited;

      expect(late).toMatchObject({ code: 0, stdout: 'hub.js autostart off removed the supervisor; run hub.js autostart on to turn it on again.\n' });
      expect(record()).toBeNull();
    } finally {
      await stopSupervisor(home).catch(() => false);
      await stopAndWait();
    }
  }, 90_000);
});
