import { DatabaseSync } from 'node:sqlite';

/**
 * Opens a database file for a test to write an older schema and its rows into, before Store.open upgrades it. Each statement of a
 * schema run outside a transaction commits on its own, and in the default rollback journal each commit creates, syncs and deletes a
 * journal file: about a second per schema here and many on a slow CI disk. Without the journal file or the syncs it takes milliseconds.
 */
export function legacyDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);

  db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY');
  return db;
}
