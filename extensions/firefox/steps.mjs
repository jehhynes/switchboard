import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webExt } from './build.mjs';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const signedFile = resolve('switchboard-firefox-signed.xpi');
const record = resolve('switchboard-firefox-signed.json');

/**
 * The real commands for src/release.mjs. The keys file outside the repository serves every checkout and worktree; web-ext reads
 * the keys from the environment (https://addons.mozilla.org/developers/addon/api/key/).
 * @type {import('./src/release.mjs').SignSteps}
 */
export const steps = {
  env: process.env,
  platform: process.platform,
  keysPath: process.env.SWITCHBOARD_AMO_KEYS ?? join(homedir(), '.switchboard', 'amo.env'),
  fileMode: (path) => (existsSync(path) ? statSync(path).mode : null),
  loadEnvFile: (path) => process.loadEnvFile(path),
  uncommitted: () => run('git', ['status', '--porcelain']) !== '',
  head: () => run('git', ['rev-parse', 'HEAD']),
  onGitHub: (commit) => {
    try {
      run('gh', ['api', `repos/{owner}/{repo}/commits/${commit}`, '--silent']);
      return true;
    } catch {
      return false;
    }
  },
  releases: () =>
    run('gh', ['api', '--paginate', 'repos/{owner}/{repo}/releases?per_page=100', '--jq', '.[] | [.tag_name, .draft] | @tsv'])
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ({ tag: line.split('\t')[0], draft: line.split('\t')[1] === 'true' })),
  builtVersion: () => JSON.parse(readFileSync('dist/manifest.json', 'utf8')).version,
  tempDir: () => mkdtempSync(join(tmpdir(), 'switchboard-sign-')),
  sign: (dir) => void execFileSync(process.execPath, [webExt, 'sign', '--channel', 'unlisted', '--source-dir', 'dist', '--artifacts-dir', dir], { stdio: 'inherit' }),
  files: (dir) => readdirSync(dir),
  copy: (from, to) => copyFileSync(from, to),
  remove: (dir) => rmSync(dir, { recursive: true, force: true }),
  signedFile,
  writeRecord: (signed) => writeFileSync(record, `${JSON.stringify(signed)}\n`),
  deleteRecord: () => rmSync(record, { force: true }),
  readRecord: () => (existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null),
  deleteRelease: (tag) => void execFileSync('gh', ['release', 'delete', tag, '--yes', '--cleanup-tag'], { stdio: 'inherit' }),
  createRelease: ({ tag, file, commit, title, notes }) => void execFileSync('gh', ['release', 'create', tag, file, '--target', commit, '--title', title, '--notes', notes], { stdio: 'inherit' }),
};

/**
 * Runs a step of src/release.mjs, printing its message, and exits 1 with the message of its Error.
 * @param {(steps: import('./src/release.mjs').SignSteps) => string} action
 */
export function runSteps(action) {
  try {
    console.log(action(steps));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
