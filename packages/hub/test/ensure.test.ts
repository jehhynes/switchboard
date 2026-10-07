import type { HubRecord } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { makeEnsure } from '../src/ensure.js';
import type { EnsureDeps } from '../src/ensure.js';

const current: HubRecord = { protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', port: 5000, token: 't1', pid: 7, startedAt: 'now' };
const old: HubRecord = { ...current, build: 'b0', port: 5001, token: 't0', pid: 6 };

/** `find` returns the answers in order and then repeats the last one. */
function fakes(answers: (HubRecord | null)[], overrides: Partial<Pick<EnsureDeps, 'build' | 'configDir' | 'stop' | 'start'>> = {}) {
  let time = 0;

  return {
    find: vi.fn(async (): Promise<HubRecord | null> => (answers.length > 1 ? answers.shift()! : answers[0]!)),
    build: overrides.build ?? (() => 'b1'),
    configDir: overrides.configDir ?? (() => 'C:/cfg'),
    stop: vi.fn(overrides.stop ?? (async () => true)),
    start: vi.fn(overrides.start ?? (() => {})),
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    logPath: 'C:/home/.switchboard/hub.log',
  };
}

describe('makeEnsure', () => {
  it('uses a running hub of the installed build without starting one', async () => {
    const deps = fakes([current]);

    expect(await makeEnsure(deps)()).toEqual({ record: current });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('starts a hub and waits for it', async () => {
    const deps = fakes([null, null, null, current]);

    expect(await makeEnsure(deps)()).toEqual({ record: current });
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it('fails with the log path when the hub never appears', async () => {
    const deps = fakes([null]);

    expect(await makeEnsure(deps)()).toEqual({ failed: 'The hub did not start within 5 seconds. Log: C:/home/.switchboard/hub.log' });
    expect(deps.start).toHaveBeenCalledTimes(1);
    // One check before starting, then one per 100 ms poll for 5 seconds.
    expect(deps.find).toHaveBeenCalledTimes(51);
  });

  it('fails when the hub cannot be started', async () => {
    const deps = fakes([null], {
      start: () => {
        throw new Error('ENOENT');
      },
    });

    expect(await makeEnsure(deps)()).toEqual({ failed: 'Could not start the hub: Error: ENOENT' });
  });

  it('replaces a hub of another build once it has gone', async () => {
    const deps = fakes([old, old, null, current]);

    expect(await makeEnsure(deps)()).toEqual({ record: current });
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.stop).toHaveBeenCalledWith(old);
    expect(deps.start).toHaveBeenCalledTimes(1);
    // Started only after the third find saw the old hub gone.
    expect(deps.start.mock.invocationCallOrder[0]).toBeGreaterThan(deps.find.mock.invocationCallOrder[2]!);
  });

  it('replaces a hub of the installed build that reads another config folder', async () => {
    const elsewhere: HubRecord = { ...current, configDir: 'C:/other', token: 't2', pid: 8 };
    const deps = fakes([elsewhere, null, null, current]);

    expect(await makeEnsure(deps)()).toEqual({ record: current });
    expect(deps.stop).toHaveBeenCalledWith(elsewhere);
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it('follows the config folder set at the time of each attempt, so a window does not restore a hub on the old folder', async () => {
    let configDir = 'C:/old';
    const onOld: HubRecord = { ...current, configDir: 'C:/old' };
    const deps = fakes([onOld], { configDir: () => configDir });
    const ensure = makeEnsure(deps);

    expect(await ensure()).toEqual({ record: onOld });

    configDir = 'C:/cfg';
    deps.find.mockResolvedValueOnce(onOld).mockResolvedValueOnce(null).mockResolvedValue(current);

    expect(await ensure()).toEqual({ record: current });
    expect(deps.stop).toHaveBeenCalledWith(onOld);
  });

  it('follows the build installed at the time of each attempt', async () => {
    let installed = 'b0';
    const deps = fakes([old], { build: () => installed });
    const ensure = makeEnsure(deps);

    expect(await ensure()).toEqual({ record: old });
    expect(deps.stop).not.toHaveBeenCalled();

    installed = 'b1';
    deps.find.mockResolvedValueOnce(old).mockResolvedValueOnce(null).mockResolvedValue(current);

    expect(await ensure()).toEqual({ record: current });
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('fails without starting when a hub of another build refuses to stop', async () => {
    const deps = fakes([old], { stop: async () => false });

    expect(await makeEnsure(deps)()).toEqual({ failed: 'The running hub (pid 6) is from another build or config folder and refused to stop.' });
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('fails without starting when a hub of another build agrees but keeps running', async () => {
    const deps = fakes([old]);

    expect(await makeEnsure(deps)()).toEqual({ failed: 'The running hub (pid 6) agreed to stop but is still running.' });
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('waits past a hub of another build that appears after starting', async () => {
    const deps = fakes([null, old, current]);

    expect(await makeEnsure(deps)()).toEqual({ record: current });
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('shares one attempt between concurrent callers and allows a later one', async () => {
    const deps = fakes([null, current]);
    const ensure = makeEnsure(deps);
    const [one, two] = await Promise.all([ensure(), ensure()]);

    expect(one).toEqual({ record: current });
    expect(two).toEqual({ record: current });
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.find).toHaveBeenCalledTimes(2);

    await ensure();
    expect(deps.find).toHaveBeenCalledTimes(3);
  });
});
