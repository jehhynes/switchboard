/**
 * Test and hook timeouts for GitHub Actions, whose Windows runner with coverage runs CPU-heavy tests 5 to 25 times slower than a
 * developer machine (docs/testing.md). Locally Vitest's defaults stand, so a test that grows slow still fails there.
 */
export const ciTimeouts: { testTimeout?: number; hookTimeout?: number } = process.env.CI ? { testTimeout: 30_000, hookTimeout: 30_000 } : {};
