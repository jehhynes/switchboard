// Installs the extension for the current user and enables it. Under Wayland GNOME Shell loads a newly installed extension only after the next login.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { uuid } = JSON.parse(readFileSync('src/metadata.json', 'utf8'));
const out = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'gnome-shell', 'extensions', uuid);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of readdirSync('src')) {
  cpSync(join('src', file), join(out, file));
}

console.log(`Installed ${uuid} to ${out}.`);

// A running GNOME Shell enables only an extension it has loaded, so for a new one the uuid goes into the setting it reads at login.
const enabled = spawnSync('gnome-extensions', ['enable', uuid], { encoding: 'utf8' });

if (enabled.status === 0) {
  console.log(`Enabled ${uuid}.`);
} else {
  const listed = spawnSync('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'], { encoding: 'utf8' });
  const uuids = [...(listed.stdout ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);

  if (listed.status !== 0) {
    console.log(`Could not enable ${uuid}: ${(listed.stderr || listed.error?.message || '').trim()}. Log out and back in, then run: gnome-extensions enable ${uuid}`);
  } else {
    if (!uuids.includes(uuid)) {
      spawnSync('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', `[${[...uuids, uuid].map((each) => `'${each}'`).join(', ')}]`], { stdio: 'inherit' });
    }

    console.log(`Enabled ${uuid}; GNOME Shell loads it after you log out and back in.`);
  }
}
