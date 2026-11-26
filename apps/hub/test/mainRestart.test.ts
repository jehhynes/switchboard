import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hubBundlePath, hubLogPath, hubRecordPath, switchboardHome } from '@switchboard/core';
import { buildOf, installLockAddress, serveHub, vscodeSettingsPath } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { main, home, useTestHome, start, launch, record, recorded, until, stopAndWait, pageStreamStatus, pageCookie, get } from './hubProcess.js';

useTestHome();

describe('hub entry point', () => {
  it('restarts onto another installed build once quiet, handing its record to the new hub, which pages reach again', async () => {
    // The installed bundle loads the built entry point, so changing the file changes the installed build.
    const bundle = hubBundlePath(home);
    const shim = `import(${JSON.stringify(pathToFileURL(main).href)});\n`;

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(bundle, shim);

    const first = launch(bundle, {}, ['--idle-ms=60000']);
    const before = await recorded();

    expect(before.build).toBe(buildOf(bundle));

    // A page's stream: it ends when the hub hands over, and a new one opens on the new record.
    const cookie = await pageCookie(before);
    let pageOpened = false;
    const pageEnded = new Promise<void>((done) => {
      const outbound = request({ host: '127.0.0.1', port: before.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${before.port}`, Cookie: cookie } }, (response) => {
        pageOpened = response.statusCode === 200;
        response.resume();
        response.on('close', () => done());
      });

      outbound.on('error', () => done());
      outbound.end();
    });

    try {
      await until(() => (pageOpened ? true : null));

      writeFileSync(bundle, `${shim}// another build\n`);

      const after = await until(() => {
        const found = record();

        return found !== null && found.pid !== before.pid ? found : null;
      }, 30_000);
      const old = await first.exited;

      expect(old.code).toBe(0);
      expect(after.build).toBe(buildOf(bundle));
      expect(after.build).not.toBe(before.build);
      expect(old.stdout).toContain(`restarting the hub from build ${before.build} onto build ${after.build}, which is installed`);
      expect(old.stdout).toContain(`hub restart: pid ${after.pid} took over with build ${after.build}`);
      expect(readFileSync(hubLogPath(home), 'utf8')).toContain(`listening on 127.0.0.1:${after.port} as pid ${after.pid}, build ${after.build}`);
      // The successor took the lock: a hub started meanwhile waited for it instead.
      expect(readFileSync(hubLogPath(home), 'utf8')).not.toContain('A hub is already running');

      // The page's stream ended and a new one opens on the new record with the same sign-in; a page's ping names the new build.
      await pageEnded;
      expect(await pageStreamStatus(after, cookie)).toBe(200);
      expect(JSON.parse(await get(after.port, '/page/ping', { Host: `127.0.0.1:${after.port}`, Cookie: cookie }))).toEqual({ build: after.build, signedIn: true });
      expect(JSON.parse(await get(after.port, '/page/ping'))).toEqual({ build: after.build, signedIn: false });
    } finally {
      await stopAndWait();
    }
  }, 60_000);

  it('waits on hub.js install --wait through a restart the hub begins by itself while the programs install, when no hub answers for a moment', async () => {
    // The old hub, in this process, restarts onto the new bundle as soon as it is copied; the holder's install lock, held here, keeps the
    // command installing until the old hub has stopped and removed its record, and the successor starts only once the command waits.
    const board = switchboardHome(home);
    const bundle = hubBundlePath(home);
    const dist = join(home, 'build');

    for (const dir of [join(board, 'holder'), join(dist, 'holder'), join(dist, 'voice')]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(bundle, 'old build');
    writeFileSync(join(dist, 'hub.js'), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    for (const [program, build] of [['holder', '0123456789abcdef'], ['voice', 'fedcba9876543210']] as const) {
      writeFileSync(join(dist, program, `${program}.js`), '');
      writeFileSync(join(dist, program, 'manifest.json'), JSON.stringify({ build, files: [`${program}.js`] }));
    }

    const installLock = createNetServer();

    await new Promise<void>((done) => installLock.listen(installLockAddress(board), done));

    let handingOver!: () => void;
    let oldExited!: () => void;
    const handedOver = new Promise<void>((done) => (handingOver = done));
    const exitedOld = new Promise<void>((done) => (oldExited = done));
    const old = await serveHub({
      home,
      version: 'test',
      build: buildOf(bundle),
      configDir: board,
      browserPort: null,
      pagePort: 0,
      exit: () => oldExited(),
      log: (line) => line === 'stopping: restarting onto the installed build' && handingOver(),
      restart: { bundle, checkMs: 10, takeoverWaitMs: 5000, successor: async () => ({ pid: process.pid, cancel: () => undefined }) },
    });

    expect('served' in old).toBe(true);

    const installing = launch(join(dist, 'hub.js'), {}, ['install', '--wait']);
    const waiting = new Promise<void>((done) => installing.child.stdout?.on('data', (chunk: string) => chunk.includes('waiting for that.') && done()));

    await handedOver;
    await (old as { served: { stop(reason: string): Promise<void> } }).served.stop('test handover');
    expect(record()).toBeNull();
    await new Promise<void>((done) => installLock.close(() => done()));
    expect(await Promise.race([waiting.then(() => 'waiting'), installing.exited.then(() => 'exited')])).toBe('waiting');

    const successor = await serveHub({ home, takeover: process.pid, version: 'test', build: buildOf(bundle), configDir: board, browserPort: null, pagePort: 0, log: () => undefined });

    try {
      const result = await installing.exited;

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Restarted: pid ${process.pid}, build ${buildOf(bundle)}.\n`);
      await exitedOld;
    } finally {
      if ('served' in successor) {
        await successor.served.stop('test done');
      }
    }
  }, 30_000);

  it('restarts the hub on hub.js restart and waits for the new one, with exit codes for no hub and no installed bundle', async () => {
    const none = await start('restart').exited;

    expect(none.code).toBe(2);
    expect(none.stderr).toBe('The Switchboard hub is not running.\n');

    // A hub run from the built entry point, with nothing installed in its home, has no bundle to restart onto.
    start('--idle-ms=60000');

    const plain = await recorded();
    const refused = await start('restart').exited;

    expect(refused.code).toBe(3);
    expect(refused.stderr).toBe('Refused: No hub bundle is installed.\n');
    expect((await start('restart', 'now').exited).code).toBe(1);
    await stopAndWait();
    await until(() => (record() === null ? true : null));

    const bundle = hubBundlePath(home);

    writeFileSync(bundle, `import(${JSON.stringify(pathToFileURL(main).href)});\n`);
    launch(bundle, {}, ['--idle-ms=60000']);

    const before = await until(() => {
      const found = record();

      return found !== null && found.pid !== plain.pid ? found : null;
    });

    try {
      const restarted = await start('restart').exited;
      const after = record()!;

      expect(restarted.code).toBe(0);
      expect(after.pid).not.toBe(before.pid);
      expect(after.build).toBe(before.build);
      expect(restarted.stdout).toBe(`Restarting the hub (pid ${before.pid}, build ${before.build}) onto build ${before.build}.\nRestarted: pid ${after.pid}, build ${after.build}.\n`);
    } finally {
      await stopAndWait();
    }
  }, 60_000);

  it("installs the builds a build folder carries on hub.js install, and refuses to run from another folder", async () => {
    const refused = await start('install').exited;

    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`Run the hub.js of a Switchboard build folder, such as apps/hub/dist/install; ${dirname(main)} carries no terminal holder build.\n`);
    expect(await start('install', '--now').exited).toMatchObject({ code: 1, stderr: 'Usage: <build folder>/hub.js install [--wait] [--home=<dir>]\n' });

    const dist = join(home, 'extension', 'dist');
    const holderBuild = '0123456789abcdef';

    mkdirSync(join(dist, 'holder'), { recursive: true });
    mkdirSync(join(dist, 'voice'), { recursive: true });
    writeFileSync(join(dist, 'hub.js'), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);
    writeFileSync(join(dist, 'holder', 'holder.js'), '');
    writeFileSync(join(dist, 'holder', 'manifest.json'), JSON.stringify({ build: holderBuild, files: ['holder.js'] }));
    writeFileSync(join(dist, 'voice', 'voice.js'), '');
    writeFileSync(join(dist, 'voice', 'manifest.json'), JSON.stringify({ build: 'fedcba9876543210', files: ['voice.js'] }));

    // A scratch VS Code setting under the test home, and a running hub on another folder: the install imports the running hub's folder, which
    // its restart onto the new build then reads, rather than the setting.
    const vscode = vscodeSettingsPath({ home: resolve(home), osHome: homedir(), platform: process.platform, env: process.env });

    mkdirSync(dirname(vscode), { recursive: true });
    writeFileSync(vscode, JSON.stringify({ 'switchboard.configDir': '~/cfg' }));

    const server = createServer((_req, res) => res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid })));

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'old', configDir: resolve(home, 'running'), execPath: process.execPath, port: (server.address() as AddressInfo).port, token: 't', pid: process.pid, startedAt: 'now' }));

    let installed: Awaited<ReturnType<typeof launch>['exited']>;

    try {
      installed = await launch(join(dist, 'hub.js'), {}, ['install']).exited;
    } finally {
      server.close();
      rmSync(hubRecordPath(home));
    }

    expect(installed.stderr).toBe('');
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`Installed hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${resolve(home, 'running')}.\nThe running hub (pid ${process.pid}, build old) restarts onto it once it is quiet; hub.js restart waits for that.\n`);
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'config.json'), 'utf8'))).toEqual({ configDir: resolve(home, 'running') });
    expect(readFileSync(hubBundlePath(home), 'utf8')).toBe(readFileSync(join(dist, 'hub.js'), 'utf8'));
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'holder', 'current.json'), 'utf8'))).toEqual({ build: holderBuild });

    const again = await launch(join(dist, 'hub.js'), {}, ['install']).exited;

    expect(again.stdout).toBe(`Already installed: hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${resolve(home, 'running')}.\n`);
    // The installed copy is not a build folder.
    expect((await launch(hubBundlePath(home), {}, ['install']).exited).code).toBe(1);
  });

  it('waits on hub.js install --wait for the running hub to restart onto the installed build, and not when it already runs that build', async () => {
    const dist = join(home, 'build');
    const shim = `import(${JSON.stringify(pathToFileURL(main).href)});\n`;

    mkdirSync(join(dist, 'holder'), { recursive: true });
    mkdirSync(join(dist, 'voice'), { recursive: true });
    writeFileSync(join(dist, 'hub.js'), shim);
    writeFileSync(join(dist, 'holder', 'holder.js'), '');
    writeFileSync(join(dist, 'holder', 'manifest.json'), JSON.stringify({ build: '0123456789abcdef', files: ['holder.js'] }));
    writeFileSync(join(dist, 'voice', 'voice.js'), '');
    writeFileSync(join(dist, 'voice', 'manifest.json'), JSON.stringify({ build: 'fedcba9876543210', files: ['voice.js'] }));

    const first = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;

    // No hub runs, so there is nothing to wait for.
    expect(first).toMatchObject({ code: 0, stderr: '', stdout: `Installed hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${switchboardHome(home)}.\n` });

    launch(hubBundlePath(home), {}, ['--idle-ms=60000']);

    const before = await recorded();

    try {
      const same = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;

      expect(same).toMatchObject({ code: 0, stdout: `Already installed: hub build ${before.build} in ${hubBundlePath(home)}.\nConfig folder: ${switchboardHome(home)}.\n` });
      expect(record()?.pid).toBe(before.pid);

      writeFileSync(join(dist, 'hub.js'), `${shim}// another build\n`);

      const next = buildOf(join(dist, 'hub.js'));
      const waited = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;
      const after = record()!;

      expect(waited.stderr).toBe('');
      expect(waited.code).toBe(0);
      expect(after.pid).not.toBe(before.pid);
      expect(after.build).toBe(next);
      expect(waited.stdout).toMatch(new RegExp(`^Installed hub build ${next} in .*\\.\\nConfig folder: .*\\.\\nThe running hub \\(pid ${before.pid}, build ${before.build}\\) restarts onto it once it is quiet; waiting for that\\.\\n(It waits until it is quiet: .*\\.\\n)?Restarted: pid ${after.pid}, build ${next}\\.\\n$`));
    } finally {
      await stopAndWait();
    }
  }, 60_000);
});
