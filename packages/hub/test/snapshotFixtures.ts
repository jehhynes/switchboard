import { DEFAULT_SETTINGS, Store } from '@switchboard/core';
import type { SnapshotInputs } from '../src/snapshot.js';

export const T0 = Date.UTC(2026, 10, 19, 12);

export const inputs = (): SnapshotInputs => ({
  settings: DEFAULT_SETTINGS,
  playbooks: [],
  settingsError: null,
  playbookErrors: [],
  enabled: [],
  sources: [],
  held: [],
  holder: null,
  guarded: [],
  nodeError: null,
  hookErrors: { claude: null, codex: null },
  sourceErrors: {},
  pullRequests: {},
  kinds: {},
  now: T0,
  configDir: 'C:/cfg',
});

export function storeWithItem(path: string): Store {
  const store = Store.open(path);
  const ticket = store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 'Built in a worker', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' } as never);

  store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: T0 } as never);

  return store;
}

export const until = async (test: () => boolean): Promise<void> => {
  for (const deadline = Date.now() + 10_000; !test(); ) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await new Promise((done) => setTimeout(done, 20));
  }
};

