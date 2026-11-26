// Runs several check commands at the same time, for tools/verify.mjs and
// tools/precommit.mjs. Each command's output is printed whole when it ends, so
// outputs do not interleave. See docs/testing.md.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Runs each `{ label, command, args, cwd? }` in `jobs` at once, with `env`. Resolves to the labels of the jobs that
 * failed, in `jobs` order.
 */
export async function runAll(jobs, { cwd = process.cwd(), env = process.env, write = (text) => process.stdout.write(text), spawnFn = spawn } = {}) {
  const started = Date.now();
  const statuses = await Promise.all(jobs.map((job) => new Promise((resolve) => {
    const child = spawnFn(job.command, job.args, { cwd: job.cwd ?? cwd, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      write(`\n=== ${job.label}: failed to start: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => {
      write(`\n=== ${job.label}: ${code === 0 ? 'passed' : 'failed'} after ${Math.round((Date.now() - started) / 1000)} s\n`);
      write(Buffer.concat(chunks).toString('utf8'));
      resolve(code);
    });
  })));

  return jobs.filter((_, n) => statuses[n] !== 0).map((job) => job.label);
}

/**
 * The unit tests of `projects` (every workspace when omitted) in one vitest run, or of `files` alone, without coverage. Named projects may have
 * none, as apps/hub has only integration tests; every workspace's run, or named files, must find some.
 *
 * @param {{ projects?: string[], files?: string[], label?: string }} [options]
 */
export function unitTests({ projects, files = [], label = 'unit tests' } = {}) {
  return {
    label,
    command: 'npx',
    args: ['vitest', 'run', '--coverage.enabled=false', ...(projects !== undefined && files.length === 0 ? ['--passWithNoTests'] : []), '--exclude', '**/*.int.test.ts', '--exclude', '**/node_modules/**', ...(projects ?? []).flatMap((name) => ['--project', name]), ...files],
  };
}

/** `npm run <script>` in each of `workspaces` (`{ dir, name, scripts }`, `dir` under `root`) that has the script, one job each. */
export function workspaceJobs(script, workspaces, root) {
  return workspaces.filter((w) => w.scripts[script]).map((w) => ({ label: `${w.name} ${script}`, command: 'npm', args: ['run', script], cwd: join(root, w.dir) }));
}
