import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempHome(): { home: string; remove(): void } {
  const home = mkdtempSync(join(tmpdir(), 'switchboard-home-'));

  return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

export async function until<T>(what: () => T | null | Promise<T | null>, within = 5000): Promise<T> {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer !== null) {
      return answer;
    }

    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }

    await new Promise((done) => setTimeout(done, 20));
  }
}
