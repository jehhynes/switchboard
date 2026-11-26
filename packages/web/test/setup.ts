import { TransformStream } from 'node:stream/web';
import { afterEach, beforeEach, vi } from 'vitest';

globalThis.TransformStream ??= TransformStream as typeof globalThis.TransformStream;

// The page picks its columns from window.innerWidth (layout.ts); jsdom's 1024 px would give every test the tablet layout, so each test starts at
// a phone's width, as tests did when jsdom had no matchMedia, and one that wants wider sets it. Tests in the node environment have no window.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.innerWidth = 700;
  }
});

/** Pages a test started and has not closed. */
const open = vi.hoisted(() => new Set<{ close(): void }>());

// A test that fails before its page.close() would leave the page listening to the window's events and posting to the next test's fetch, so
// that test fails too; every page still open is closed after its test.
vi.mock('../src/main.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main.js')>();

  return {
    ...actual,
    startPage: (...args: Parameters<typeof actual.startPage>) => {
      const page = actual.startPage(...args);
      const close = page.close;

      page.close = () => {
        if (open.delete(page)) close();
      };
      open.add(page);
      return page;
    },
  };
});

/** A real timer, taken before any test fakes timers. */
const realTimeout = setTimeout;
/** Whether the test, or a page it started, moved through the history, whose popstate jsdom delivers in a later timer task. */
let traversed = false;

if (typeof History !== 'undefined') {
  for (const name of ['back', 'forward', 'go'] as const) {
    const move = History.prototype[name] as (this: History, ...args: unknown[]) => void;

    History.prototype[name] = function (this: History, ...args: unknown[]) {
      traversed = true;
      move.apply(this, args);
    };
  }
}

// A popstate still to come when a test ends would land in the next test and move that test's address, so a test that moved through the
// history ends with two real timer turns, after its pages are closed. A timer turn takes about 15 ms on Windows, so other tests skip it.
afterEach(async () => {
  for (const page of [...open]) page.close();

  // jsdom moves through the history in two timer tasks, the second of which changes the address and fires popstate.
  if (traversed) {
    traversed = false;
    await new Promise((done) => realTimeout(done, 0));
    await new Promise((done) => realTimeout(done, 0));
  }
});
