import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { currentHolderBuild, installHolder, installLockAddress, reserveHolderBuild } from '../src/holderInstall.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'holder-install-'));

  temps.push(dir);

  return dir;
}

/** A built holder folder with the given build and holder.js text. */
function carried(build: string, text = 'holder'): string {
  const dir = temp();

  mkdirSync(join(dir, 'node_modules', 'node-pty'), { recursive: true });
  writeFileSync(join(dir, 'holder.js'), text);
  writeFileSync(join(dir, 'node_modules', 'node-pty', 'package.json'), '{}');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ build, files: ['holder.js', 'node_modules/node-pty/package.json'] }));

  return dir;
}

const BUILD_A = 'aaaaaaaaaaaaaaaa';
const BUILD_B = 'bbbbbbbbbbbbbbbb';

describe('installHolder', () => {
  it('copies the build into its own folder and names it current', async () => {
    const home = temp();

    expect(await installHolder(carried(BUILD_A), home)).toEqual({ build: BUILD_A });
    expect(readFileSync(join(home, 'holder', BUILD_A, 'holder.js'), 'utf8')).toBe('holder');
    expect(existsSync(join(home, 'holder', BUILD_A, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
    expect(currentHolderBuild(home)).toBe(BUILD_A);
  });

  it('leaves an installed build as it is', async () => {
    const home = temp();

    await installHolder(carried(BUILD_A, 'first'), home);
    await installHolder(carried(BUILD_A, 'second'), home);
    expect(readFileSync(join(home, 'holder', BUILD_A, 'holder.js'), 'utf8')).toBe('first');
  });

  it('removes other builds, except the build of a holder that still runs', async () => {
    const home = temp();
    const old = 'cccccccccccccccc';

    await installHolder(carried(old), home);
    await installHolder(carried(BUILD_A), home);
    writeFileSync(join(home, 'holder.json'), JSON.stringify({ protocol: 1, build: BUILD_A, port: 5000, token: 't', pid: 4242, startedAt: 'x' }));
    expect(await installHolder(carried(BUILD_B), home, (pid) => pid === 4242)).toEqual({ build: BUILD_B });
    expect(existsSync(join(home, 'holder', old))).toBe(false);
    expect(existsSync(join(home, 'holder', BUILD_A, 'holder.js'))).toBe(true);
    expect(currentHolderBuild(home)).toBe(BUILD_B);
    await installHolder(carried(BUILD_B), home, () => false);
    expect(existsSync(join(home, 'holder', BUILD_A))).toBe(false);
  });

  it('keeps a build a hub reserved in the last 10 minutes, and removes it once the reservation is older', async () => {
    const home = temp();
    const old = 'cccccccccccccccc';

    await installHolder(carried(old), home);
    expect(await reserveHolderBuild(home, old)).toBe(true);
    await installHolder(carried(BUILD_A), home, () => false);
    expect(existsSync(join(home, 'holder', old, 'holder.js'))).toBe(true);
    await installHolder(carried(BUILD_A), home, () => false, () => Date.now() + 11 * 60_000);
    expect(existsSync(join(home, 'holder', old))).toBe(false);
  });

  it('copies an installed build again when a file it lists is missing', async () => {
    const home = temp();

    await installHolder(carried(BUILD_A, 'first'), home);
    rmSync(join(home, 'holder', BUILD_A, 'node_modules', 'node-pty', 'package.json'));
    expect(await installHolder(carried(BUILD_A, 'second'), home)).toEqual({ build: BUILD_A });
    expect(readFileSync(join(home, 'holder', BUILD_A, 'holder.js'), 'utf8')).toBe('second');
    expect(existsSync(join(home, 'holder', BUILD_A, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
  });

  it('waits while another process holds the install lock', async () => {
    const home = temp();

    mkdirSync(join(home, 'holder'), { recursive: true });

    const other = createServer();

    await new Promise<void>((done) => other.listen(installLockAddress(home), () => done()));

    let released = false;

    setTimeout(() => other.close(() => (released = true)), 300);
    expect(await installHolder(carried(BUILD_A), home)).toEqual({ build: BUILD_A });
    expect(released).toBe(true);
  });

  it('lets two installs at once take turns, leaving the current build whole', async () => {
    const home = temp();
    const results = await Promise.all([installHolder(carried(BUILD_A), home, () => false), installHolder(carried(BUILD_B), home, () => false)]);

    expect(results).toEqual([{ build: BUILD_A }, { build: BUILD_B }]);

    const current = currentHolderBuild(home);

    expect(current).not.toBeNull();
    expect(existsSync(join(home, 'holder', current!, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
  });

  it('refuses to reserve a build that is not installed whole', async () => {
    const home = temp();

    await installHolder(carried(BUILD_A), home);
    rmSync(join(home, 'holder', BUILD_A, 'holder.js'));
    expect(await reserveHolderBuild(home, BUILD_A)).toBe(false);
    expect(await reserveHolderBuild(home, BUILD_B)).toBe(false);
  });

  it('returns an error instead of throwing when the holder folder cannot be made', async () => {
    const home = temp();

    writeFileSync(join(home, 'holder'), 'a file');
    expect(await installHolder(carried(BUILD_A), home)).toMatchObject({ error: expect.stringContaining('could not be taken') as unknown });
  });

  it('refuses a carried folder without a valid manifest and changes nothing', async () => {
    const home = temp();
    const source = carried(BUILD_A);

    writeFileSync(join(source, 'manifest.json'), '{"build":"short","files":[]}');
    expect(await installHolder(source, home)).toEqual({ error: `${join(source, 'manifest.json')} is missing or invalid.` });
    expect(currentHolderBuild(home)).toBeNull();
  });

  it('returns the error of a copy that fails, and names no build current', async () => {
    const home = temp();
    const source = carried(BUILD_A);

    rmSync(join(source, 'holder.js'));

    const result = await installHolder(source, home);

    expect(result).toMatchObject({ error: expect.stringContaining(`The terminal holder could not be installed in ${join(home, 'holder', BUILD_A)}:`) as unknown });
    expect(currentHolderBuild(home)).toBeNull();
  });

  it('reads no current build when its folder is gone', async () => {
    const home = temp();

    await installHolder(carried(BUILD_A), home);
    rmSync(join(home, 'holder', BUILD_A), { recursive: true });
    expect(currentHolderBuild(home)).toBeNull();
  });
});
