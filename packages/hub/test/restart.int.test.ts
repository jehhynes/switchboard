import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READY_MESSAGE, startSuccessor } from '../src/restart.js';
import type { Successor } from '../src/restart.js';
import { tempHome, until } from './helpers.js';

let home: string;
let remove: () => void;

beforeEach(() => {
  ({ home, remove } = tempHome());
});

afterEach(() => {
  remove();
});

describe('startSuccessor', () => {
  const script = (body: string): string => {
    const path = join(home, 'successor.cjs');

    writeFileSync(path, body);
    return path;
  };

  it('starts the bundle with this hub\'s arguments and --takeover, and resolves once it reports ready', async () => {
    const argsFile = join(home, 'args.json');
    const bundle = script(`require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.send(${JSON.stringify(READY_MESSAGE)}, () => process.disconnect()); setTimeout(() => {}, 20000);`);
    const started = await startSuccessor({ execPath: process.execPath, bundle, args: ['--home=x', '--takeover=1'], env: process.env, logPath: join(home, 'hub.log') });

    expect('cancel' in started).toBe(true);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['--home=x', `--takeover=${process.pid}`]);
    (started as Successor).cancel();
  });

  it('answers why when the successor exits before it is ready, or does not report in time', async () => {
    const crashing = script("process.stdout.write('broken bundle\\n'); process.exit(3);");
    const log = join(home, 'hub.log');

    expect(await startSuccessor({ execPath: process.execPath, bundle: crashing, args: [], env: process.env, logPath: log })).toEqual({ error: 'the new hub exited (code 3) before it was ready' });
    await until(() => (readFileSync(log, 'utf8').includes('broken bundle') ? true : null));

    const silent = script('setTimeout(() => {}, 20000);');

    expect(await startSuccessor({ execPath: process.execPath, bundle: silent, args: [], env: process.env, logPath: log, readyMs: 300 })).toEqual({ error: 'the new hub did not report ready within 0.3 seconds' });
  });
});
