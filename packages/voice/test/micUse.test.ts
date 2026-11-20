import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pactlRecording, parseMicUseLine, watchMicUse } from '../src/micUse.js';
import { settle } from './fakes.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): void {
    this.killed = true;
  }
}

function fakeSpawn() {
  const runs: Array<{ command: string; args: string[]; child: FakeChild }> = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeChild();

    runs.push({ command, args, child });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  return { runs, spawn };
}

describe('other apps recording', () => {
  it('reads the Windows watcher\'s lines and pactl\'s recording streams, leaving out its own, corked ones and level meters', () => {
    expect(parseMicUseLine('{"busy":true,"apps":["Teams",3]}')).toEqual({ busy: true, apps: ['Teams'] });
    expect(parseMicUseLine('{"busy":false}')).toEqual({ busy: false, apps: [] });
    expect(parseMicUseLine('Add-Type failed')).toBeNull();
    expect(parseMicUseLine('{"apps":[]}')).toBeNull();
    expect(
      pactlRecording(
        JSON.stringify([
          { corked: false, properties: { 'application.process.id': '41', 'application.name': 'Firefox' } },
          { corked: false, properties: { 'application.process.id': '7', 'application.name': 'Switchboard voice' } },
          { corked: true, properties: { 'application.process.id': '42', 'application.name': 'Zoom' } },
          { corked: false, properties: { 'application.process.id': '43', 'application.name': 'pavucontrol', 'media.name': 'Peak detect' } },
          { corked: false, properties: { 'application.process.binary': 'arecord' } },
          null,
        ]),
        7,
      ),
    ).toEqual(['Firefox', 'arecord']);
    expect(pactlRecording('[', 7)).toEqual([]);
    expect(pactlRecording('{}', 7)).toEqual([]);
  });

  it('runs micuse.ps1 on Windows, excluding this process, follows its lines, and ends it by closing its input', async () => {
    const { runs, spawn } = fakeSpawn();
    const changes: string[] = [];
    let failed = 0;
    const watch = watchMicUse({ script: 'C:/v/micuse.ps1', changed: (busy, apps) => changes.push(`${busy} ${apps.join(',')}`), failed: () => void failed++, log: () => undefined, spawn, platform: 'win32' })!;

    expect(runs[0]!.command).toBe('powershell.exe');
    expect(runs[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/v/micuse.ps1', '-ExcludePid', String(process.pid)]);
    runs[0]!.child.stdout.write('{"busy":false,"apps":[]}\nnoise\n{"busy":true,"apps":["Teams"]}\n');
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(changes).toEqual(['false ', 'true Teams']);
    runs[0]!.child.emit('exit', 1);
    runs[0]!.child.emit('error', new Error('ENOENT'));
    expect(failed).toBe(2);

    let ended = false;

    runs[0]!.child.stdin.on('finish', () => (ended = true));
    watch.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(true);
  });

  it('reads pactl on Linux at start and on each source-output event, reporting only changes', async () => {
    const { runs, spawn } = fakeSpawn();
    const changes: string[] = [];
    const watch = watchMicUse({ script: '', changed: (busy, apps) => changes.push(`${busy} ${apps.join(',')}`), failed: () => undefined, log: () => undefined, spawn, platform: 'linux' })!;
    const answer = (run: number, outputs: unknown[]): void => {
      runs[run]!.child.stdout.end(JSON.stringify(outputs));
      runs[run]!.child.emit('close', 0);
    };

    expect(runs.map((run) => run.args.join(' '))).toEqual(['subscribe', '-f json list source-outputs']);
    answer(1, []);
    expect(changes).toEqual(['false ']);
    runs[0]!.child.stdout.write("Event 'new' on source-output #12\nEvent 'change' on sink #3\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toHaveLength(3);
    answer(2, [{ corked: false, properties: { 'application.process.id': '9', 'application.name': 'Zoom' } }]);
    expect(changes).toEqual(['false ', 'true Zoom']);
    watch.close();
    expect(runs[0]!.child.killed).toBe(true);
    expect(watchMicUse({ script: '', changed: () => undefined, failed: () => undefined, log: () => undefined, spawn, platform: 'darwin' })).toBeNull();
  });
});
