import { mkdirSync } from 'node:fs';
import { switchboardHome } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { holdLock, releaseLock } from '../src/lock.js';
import { tempHome as makeHome } from './helpers.js';

/** A home with its Switchboard directory, as the hub creates it before taking the lock. */
function tempHome(): { home: string; remove(): void } {
  const made = makeHome();

  mkdirSync(switchboardHome(made.home), { recursive: true });

  return made;
}

describe('holdLock', () => {
  it('lets one holder in at a time and frees the lock on release', async () => {
    const { home, remove } = tempHome();

    try {
      const first = await holdLock(home);

      expect(first).not.toBeNull();
      expect(await holdLock(home)).toBeNull();

      await releaseLock(first!);

      const second = await holdLock(home);

      expect(second).not.toBeNull();
      await releaseLock(second!);
    } finally {
      remove();
    }
  });

  it('gives separate homes separate locks', async () => {
    const one = tempHome();
    const two = tempHome();

    try {
      const a = await holdLock(one.home);
      const b = await holdLock(two.home);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      await releaseLock(a!);
      await releaseLock(b!);
    } finally {
      one.remove();
      two.remove();
    }
  });
});
