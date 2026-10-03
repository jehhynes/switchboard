import { mkdirSync } from 'node:fs';
import { switchboardHome } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { holdLock, lockAddress, releaseLock } from '../src/lock.js';
import { tempHome as makeHome } from './helpers.js';

/** A home with its Switchboard directory, as the hub creates it before taking the lock. */
function tempHome(): { home: string; remove(): void } {
  const made = makeHome();

  mkdirSync(switchboardHome(made.home), { recursive: true });

  return made;
}

describe('lockAddress', () => {
  it('is a named pipe on Windows that ignores case and differs per home', () => {
    const one = lockAddress('C:\\Users\\Someone', 'win32');

    expect(one).toMatch(/^\\\\\.\\pipe\\switchboard-[0-9a-f]{16}$/);
    expect(lockAddress('c:\\users\\someone', 'win32')).toBe(one);
    expect(lockAddress('C:\\Users\\Other', 'win32')).not.toBe(one);
  });

  it('is a socket file in the Switchboard home elsewhere', () => {
    expect(lockAddress('/home/someone', 'linux')).toMatch(/[\\/]home[\\/]someone[\\/]\.switchboard[\\/]hub\.sock$/);
  });
});

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
