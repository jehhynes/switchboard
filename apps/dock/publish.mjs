// Publishes the dock to <user home>/.switchboard/dock, where the VS Code extension's status bar item starts it.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = join(homedir(), '.switchboard', 'dock');
const result = spawnSync('dotnet', ['publish', 'src/Switchboard.Dock/Switchboard.Dock.csproj', '-c', 'Release', '--nologo', '-v', 'q', '-o', out], { stdio: 'inherit' });

process.exit(result.status ?? 1);
