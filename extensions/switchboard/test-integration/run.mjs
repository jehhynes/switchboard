import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'switchboard-vscode-home-'));
// Portable mode keeps the test build from registering itself for vscode:// links on Windows (GC M49).
const portable = mkdtempSync(join(tmpdir(), 'switchboard-vscode-profile-'));
const profile = join(portable, 'user-data');

mkdirSync(join(profile, 'User'), { recursive: true });
// The suite reads settings and playbooks from a config folder outside the Switchboard home, through ~ expansion.
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'switchboard.configDir': '~/repo/switchboard' }));

/** Read the per-user vscode:// handler without changing it. Status 1 means no registration. */
function protocolRegistration() {
  if (process.platform !== 'win32') return null;

  const result = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\vscode', '/s'], { encoding: 'utf8', windowsHide: true });

  if (result.error) throw result.error;

  return { status: result.status, stdout: result.stdout };
}

/** Force-stop the test hub; Windows skips graceful signal handlers (GC M25). */
function stopHub() {
  try {
    process.kill(JSON.parse(readFileSync(join(home, '.switchboard', 'hub.json'), 'utf8')).pid);
  } catch {
    // No record, or the hub already exited.
  }
}

const protocolBefore = protocolRegistration();

const child = spawn('npx', ['vscode-test'], {
  cwd: process.cwd(),
  env: { ...process.env, SWITCHBOARD_TEST_HOME: home, SWITCHBOARD_TEST_PROFILE: profile, SWITCHBOARD_TEST_PORTABLE: portable },
  stdio: 'inherit',
  shell: true,
});

/** R33: the hub must outlive the window that started it. True when the recorded hub still answers with its token. */
function hubSurvived() {
  let record;

  try {
    record = JSON.parse(readFileSync(join(home, '.switchboard', 'hub.json'), 'utf8'));
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const outbound = request(
      { host: '127.0.0.1', port: record.port, path: '/status', headers: { Authorization: `Bearer ${record.token}` }, timeout: 2000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );

    outbound.on('timeout', () => outbound.destroy());
    outbound.on('error', () => resolve(false));
    outbound.end();
  });
}

child.on('exit', async (code) => {
  const survived = await hubSurvived();

  if (!survived) console.error('The hub did not survive the VS Code window that started it (R33).');

  stopHub();

  for (const path of [home, portable]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // A process still holds the directory; the OS temp cleanup removes it later.
    }
  }

  const unchanged = JSON.stringify(protocolRegistration()) === JSON.stringify(protocolBefore);

  if (!unchanged) console.error('The VS Code integration run changed the vscode:// registration.');
  process.exit(unchanged && survived ? (code ?? 1) : 1);
});
