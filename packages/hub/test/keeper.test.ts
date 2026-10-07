import type { HubRecord } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import type { EventStream } from '../src/client.js';
import type { Ensured } from '../src/ensure.js';
import { keepHub } from '../src/keeper.js';
import type { KeeperDeps } from '../src/keeper.js';
import { until } from './helpers.js';

const record: HubRecord = { protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', port: 5000, token: 't', pid: 7, startedAt: 'now' };

function harness(ensured: () => Ensured, opens: () => boolean = () => true) {
  let time = 0;
  const ends: (() => void)[] = [];
  const closed: number[] = [];
  const ensure = vi.fn(async () => ensured());
  const onFailed = vi.fn();
  const deps: KeeperDeps = {
    ensure,
    open: async (_: HubRecord, onEnd: () => void): Promise<EventStream | null> => {
      if (!opens()) {
        return null;
      }

      const index = ends.length;

      ends.push(onEnd);

      return { close: () => closed.push(index) };
    },
    now: () => time,
    sleep: async () => {},
    onFailed,
  };

  return {
    deps,
    ensure,
    onFailed,
    ends,
    closed,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('keepHub', () => {
  it('connects to the ensured hub', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    expect(await until(() => keeper.current())).toEqual(record);
    keeper.dispose();
    await keeper.done;
  });

  it('reconnects after a stable connection ends, without counting a failure', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    for (let round = 1; round <= 3; round++) {
      await until(() => (h.ends.length === round ? true : null));
      h.advance(10_000);
      h.ends[round - 1]!();
    }

    await until(() => (h.ends.length === 4 ? true : null));
    expect(h.onFailed).not.toHaveBeenCalled();
    keeper.dispose();
    await keeper.done;
  });

  it('gives up when connections keep ending quickly', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    for (let round = 1; round <= 3; round++) {
      await until(() => (h.ends.length === round ? true : null));
      h.ends[round - 1]!();
    }

    await keeper.done;
    expect(h.onFailed).toHaveBeenCalledWith('The hub kept stopping shortly after starting.');
    expect(h.ends).toHaveLength(3);
    expect(keeper.current()).toBeNull();
  });

  it('does not count a quick end it was told to expect, and counts the next one again', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    for (let round = 1; round <= 3; round++) {
      await until(() => (h.ends.length === round ? true : null));
      keeper.expectEnd();
      h.ends[round - 1]!();
    }

    await until(() => (h.ends.length === 4 ? true : null));
    expect(h.onFailed).not.toHaveBeenCalled();

    for (let round = 4; round <= 6; round++) {
      await until(() => (h.ends.length === round ? true : null));
      h.ends[round - 1]!();
    }

    await keeper.done;
    expect(h.onFailed).toHaveBeenCalledWith('The hub kept stopping shortly after starting.');
  });

  it('gives up after repeated start failures with the last reason', async () => {
    const h = harness(() => ({ failed: 'no hub' }));
    const keeper = keepHub(h.deps);

    await keeper.done;
    expect(h.ensure).toHaveBeenCalledTimes(3);
    expect(h.onFailed).toHaveBeenCalledWith('no hub');
  });

  it('gives up when the hub keeps refusing the stream', async () => {
    const h = harness(
      () => ({ record }),
      () => false,
    );
    const keeper = keepHub(h.deps);

    await keeper.done;
    expect(h.ensure).toHaveBeenCalledTimes(3);
    expect(h.onFailed).toHaveBeenCalledWith('The hub on port 5000 refused the connection.');
  });

  it('counts a connection that lasts 9,999 ms as a failure', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    for (let round = 1; round <= 3; round++) {
      await until(() => (h.ends.length === round ? true : null));
      h.advance(9_999);
      h.ends[round - 1]!();
    }

    await keeper.done;
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.ends).toHaveLength(3);
  });

  it('clears earlier failures after a stable connection', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);
    const lasting = [0, 0, 10_000, 0, 0];

    for (const [index, ms] of lasting.entries()) {
      await until(() => (h.ends.length === index + 1 ? true : null));
      h.advance(ms);
      h.ends[index]!();
    }

    await until(() => (h.ends.length === 6 ? true : null));
    expect(h.onFailed).not.toHaveBeenCalled();

    h.ends[5]!();
    await keeper.done;
    expect(h.onFailed).toHaveBeenCalledTimes(1);
  });

  it('closes the stream and stops on dispose', async () => {
    const h = harness(() => ({ record }));
    const keeper = keepHub(h.deps);

    await until(() => keeper.current());
    keeper.dispose();
    await keeper.done;

    expect(h.closed).toEqual([0]);
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(keeper.current()).toBeNull();
  });

  it('closes a stream that opens after dispose', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(() => ({ record }));
    const open = h.deps.open;

    h.deps.open = async (r, onEnd) => {
      await gate;

      return open(r, onEnd);
    };

    const keeper = keepHub(h.deps);

    await until(() => (h.ensure.mock.calls.length === 1 ? true : null));
    keeper.dispose();
    release();
    await keeper.done;

    expect(h.closed).toEqual([0]);
    expect(keeper.current()).toBeNull();
  });
});
