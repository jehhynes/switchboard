import { describe, expect, it } from 'vitest';
import { closePseudoTerminal } from '../src/close.js';

/** A node-pty Windows terminal as far as the close reads it. */
function windowsPty(agent: Record<string, unknown>): { pty: unknown; calls: unknown[][] } {
  const calls: unknown[][] = [];

  return { pty: { _agent: { _useConpty: true, _useConptyDll: false, _pty: 3, _ptyNative: { kill: (...args: unknown[]) => calls.push(args) }, ...agent } }, calls };
}

describe('closePseudoTerminal', () => {
  it('closes a ConPTY pseudo-console through the native kill with its id, and reports it closed', () => {
    const { pty, calls } = windowsPty({});

    expect(closePseudoTerminal(pty, 'win32')).toBe(true);
    expect(calls).toEqual([[3, false]]);
  });

  it.each([
    ['conpty.dll, whose native kill also terminates the program', { _useConptyDll: true }],
    ['winpty', { _useConpty: false }],
    ['no pseudo-console id', { _pty: undefined }],
    ['no native kill', { _ptyNative: {} }],
    ['a native kill that is not a function', { _ptyNative: { kill: 1 } }],
  ])('refuses %s on Windows without calling anything', (_name, agent) => {
    const { pty, calls } = windowsPty(agent);

    expect(closePseudoTerminal(pty, 'win32')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses a Windows terminal without an agent, or none at all', () => {
    expect(closePseudoTerminal({ destroy: () => undefined }, 'win32')).toBe(false);
    expect(closePseudoTerminal(null, 'win32')).toBe(false);
  });

  it('destroys a Unix terminal, which closes its master side, and reports it closed', () => {
    const calls: unknown[] = [];
    const pty = { destroy(this: unknown) { calls.push(this); } };

    expect(closePseudoTerminal(pty, 'linux')).toBe(true);
    expect(calls).toEqual([pty]);
  });

  it('refuses a Unix terminal without destroy, or none at all', () => {
    expect(closePseudoTerminal({ _agent: {} }, 'linux')).toBe(false);
    expect(closePseudoTerminal(undefined, 'linux')).toBe(false);
  });
});
