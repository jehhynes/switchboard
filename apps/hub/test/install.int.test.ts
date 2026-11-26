import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubBundlePath, switchboardHome } from '@switchboard/core';
import { buildOf } from '@switchboard/hub';
import { describeBuiltPrograms } from './builtPrograms.js';

// apps/hub's standalone build, which npm run build writes and npm run install-local installs, copied outside the checkout so no node_modules of
// the repository can be reached.
const BUILD = join(import.meta.dirname, '..', 'dist', 'install');
let root: string;
let copy: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-install-'));
  copy = join(root, 'install');
  cpSync(BUILD, copy, { recursive: true });
}, 120_000);

afterAll(() => {
  // Windows releases a loaded native module's file a moment after its process exits.
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

const manifestBuild = (dir: string): string => (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { build: string }).build;

describe('the standalone build (npm run install-local)', () => {
  it('runs in place, as npm run install-local runs it, although apps/hub makes .js files modules', async () => {
    const usage = await run([join(BUILD, 'hub.js'), 'install', '--now', `--home=${join(root, 'home-usage')}`]);

    expect(usage).toMatchObject({ code: 1, stdout: '', stderr: 'Usage: <build folder>/hub.js install [--wait] [--home=<dir>]\n' });
  });
  it('installs every carried build into a new home with no hub running', async () => {
    // Before any test below takes a native binary out of the copy.
    const home = join(root, 'home-install');

    mkdirSync(home);

    const installed = await run([join(copy, 'hub.js'), 'install', '--wait', `--home=${home}`]);
    const web = join(switchboardHome(home), 'web');

    expect(installed.stderr).toBe('');
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`Installed hub build ${buildOf(join(BUILD, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${switchboardHome(home)}.\n`);
    expect(readFileSync(hubBundlePath(home)).equals(readFileSync(join(BUILD, 'hub.js')))).toBe(true);

    for (const program of ['holder', 'voice']) {
      const build = manifestBuild(join(BUILD, program));

      expect(JSON.parse(readFileSync(join(switchboardHome(home), program, 'current.json'), 'utf8'))).toEqual({ build });
      expect(existsSync(join(switchboardHome(home), program, build, `${program}.js`))).toBe(true);
    }

    expect(readFileSync(join(web, 'mermaid.min.js')).equals(readFileSync(join(BUILD, 'mermaid', 'mermaid.min.js')))).toBe(true);
    expect(existsSync(join(web, 'diff', manifestBuild(join(BUILD, 'diff')), 'manifest.json'))).toBe(true);
    expect(readFileSync(join(web, 'chrome', 'manifest.json'), 'utf8')).toBe(readFileSync(join(BUILD, 'chrome', 'manifest.json'), 'utf8'));

    // The installed copy is not a build folder.
    expect((await run([hubBundlePath(home), 'install', `--home=${home}`])).code).toBe(1);
  }, 60_000);
});

describeBuiltPrograms(() => copy, () => root);
