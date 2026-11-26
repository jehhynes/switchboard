import { afterEach, beforeEach, vi } from 'vitest';

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

afterEach(() => {
  for (const page of [...open]) page.close();
});
