import { beforeEach } from 'vitest';

// The page picks its columns from window.innerWidth (layout.ts); jsdom's 1024 px would give every test the tablet layout, so each test starts at
// a phone's width, as tests did when jsdom had no matchMedia, and one that wants wider sets it. Tests in the node environment have no window.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.innerWidth = 700;
  }
});
