import { describe, expect, it } from 'vitest';
import { closePseudoTerminal, releasePseudoTerminal } from '../src/close.js';

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

  it('closes a node-pty 1.2 pseudo-console, whose agent has no _useConpty', () => {
    const { pty, calls } = windowsPty({ _useConpty: undefined });

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

describe('releasePseudoTerminal', () => {
  /** A node-pty Windows terminal as far as the release reads it, recording each call with its receiver. */
  function windowsAgent(agent: Record<string, unknown> = {}): { pty: unknown; calls: string[] } {
    const calls: string[] = [];
    const thread = {
      on(this: unknown, event: string, listener: () => void) {
        calls.push(this === thread ? `thread.on ${event}` : 'thread.on unbound');
        listener();
      },
    };
    const worker = { _worker: thread, dispose(this: unknown) { calls.push(this === worker ? 'worker.dispose' : 'worker.dispose unbound'); } };
    const input = { destroy(this: unknown) { calls.push(this === input ? 'input.destroy' : 'input.destroy unbound'); } };

    return { pty: { _agent: { _conoutSocketWorker: worker, _inSocket: input, ...agent } }, calls };
  }

  it("disposes node-pty's output Worker, ignoring its errors from then on, and destroys its input pipe on Windows", () => {
    const { pty, calls } = windowsAgent();

    expect(releasePseudoTerminal(pty, 'win32')).toEqual(['worker', 'input']);
    expect(calls).toEqual(['thread.on error', 'worker.dispose', 'input.destroy']);
  });

  it.each([
    ['no Worker', { _conoutSocketWorker: undefined }, ['input'], ['input.destroy']],
    ['a Worker without dispose', { _conoutSocketWorker: { dispose: 1 } }, ['input'], ['input.destroy']],
    ['a Worker without its thread', { _conoutSocketWorker: { dispose: () => undefined } }, ['worker', 'input'], ['input.destroy']],
    ['no input pipe', { _inSocket: null }, ['worker'], ['thread.on error', 'worker.dispose']],
    ['an input pipe without destroy', { _inSocket: {} }, ['worker'], ['thread.on error', 'worker.dispose']],
  ])('frees only what it finds when the agent has %s', (_name, agent, released, called) => {
    const { pty, calls } = windowsAgent(agent);

    expect(releasePseudoTerminal(pty, 'win32')).toEqual(released);
    expect(calls).toEqual(called);
  });

  it('frees nothing for a terminal without an agent, or none at all', () => {
    expect(releasePseudoTerminal({}, 'win32')).toEqual([]);
    expect(releasePseudoTerminal(null, 'win32')).toEqual([]);
  });

  it('frees nothing on other platforms, where node-pty frees its own', () => {
    const { pty, calls } = windowsAgent();

    expect(releasePseudoTerminal(pty, 'linux')).toEqual([]);
    expect(calls).toEqual([]);
  });
});
