import type { SessionEntry } from '@switchboard/holder';

/** A session the terminal holder lists, joined with the store when the hub reads it (architecture.md § Visibility of held sessions). */
export interface HeldSession {
  /** The Switchboard session ID the holder holds it under. */
  session: string;
  label: string;
  workItemId: number | null;
  /** The work item's key, `<source> <source key>`, from the store, else from the label. */
  key: string | null;
  /** The Claude session ID: the store's current one, else the label's. */
  nativeSessionId: string | null;
  cwd: string;
  /** The session's state for an active session of the store, else the holder's own: `live` or `exited`. */
  state: string;
  /** The last input or output, or the start when there was none. */
  idleSince: number;
  memoryBytes: number | null;
  clients: number;
  exitedAt: number | null;
  exitCode: number | null;
  /** A live process no active session of the store holds. */
  orphan: boolean;
}

/** A restart of the terminal holder to the installed build, as the web page shows it (architecture.md § Restarting the holder). */
export type HolderRestartState =
  | { state: 'running'; at: number }
  | { state: 'done'; at: number; resumed: number; failed: { session: string; key: string | null; error: string }[]; error: string | null };

/** The connected holder's build against the installed one, and the last restart since the hub started; `build` is null while none is connected. */
export interface HolderState {
  build: string | null;
  installed: string | null;
  /** From an older build, as `hub.js holder list` marks it (`olderHolder`). */
  older: boolean;
  restart: HolderRestartState | null;
}

/** `3m`, `2h 5m`. */
export function idleText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A held session's columns as `hub.js holder list` and the page's Held sessions show them (PRD R94). */
export function heldTexts(one: HeldSession, now: number): { item: string; nativeSessionId: string; idle: string; memory: string } {
  return {
    item: one.orphan && one.workItemId === null ? 'No work item' : (one.key ?? 'No work item'),
    nativeSessionId: one.nativeSessionId ?? '-',
    idle: one.exitedAt === null ? idleText(now - one.idleSince) : '-',
    memory: one.memoryBytes === null ? '-' : `${Math.round(one.memoryBytes / (1024 * 1024))} MB`,
  };
}

/**
 * The work item key and Claude session ID a label gives: a start's label is `<session name> <Claude session ID>`, and a session name ends with
 * the key after its last ` · `.
 */
export function labelParts(label: string): { key: string | null; nativeSessionId: string | null } {
  const space = label.lastIndexOf(' ');

  if (space === -1) {
    return { key: null, nativeSessionId: label === '' ? null : label };
  }

  const name = label.slice(0, space);
  const dot = name.lastIndexOf(' · ');
  const key = (dot === -1 ? name : name.slice(dot + 3)).trim();

  return { key: key === '' ? null : key, nativeSessionId: label.slice(space + 1) || null };
}

/** The holder's own view of a session, without the store, as `hub.js holder list` shows it while the hub is down. */
export function heldFromHolder(entry: SessionEntry): HeldSession {
  return {
    session: entry.session,
    label: entry.label,
    workItemId: null,
    ...labelParts(entry.label),
    cwd: entry.cwd,
    state: entry.exitedAt === null ? 'live' : 'exited',
    idleSince: Math.max(entry.startedAt, entry.lastInputAt ?? 0, entry.lastOutputAt ?? 0),
    memoryBytes: entry.memoryBytes,
    clients: entry.clients,
    exitedAt: entry.exitedAt,
    exitCode: entry.exitCode,
    orphan: false,
  };
}

/**
 * The held session `id` names: a Switchboard session ID, a Claude session ID, current or one of `retired`, or its first 8 characters. Refuses
 * an ID that names none, or a prefix that names several.
 */
export function findHeld<T extends Pick<HeldSession, 'session' | 'nativeSessionId'>>(held: readonly T[], id: string, retired: (entry: T) => readonly string[] = () => []): T | { refused: string; status: 404 | 409 } {
  const ids = (entry: T) => [entry.session, ...(entry.nativeSessionId === null ? [] : [entry.nativeSessionId]), ...retired(entry)];
  const exact = held.find((entry) => ids(entry).includes(id));

  if (exact !== undefined) {
    return exact;
  }

  const prefixed = id.length === 8 ? held.filter((entry) => ids(entry).some((one) => one !== entry.session && one.startsWith(id))) : [];

  if (prefixed.length === 1) {
    return prefixed[0]!;
  }

  if (prefixed.length > 1) {
    return { refused: `${id} matches more than one held session: ${prefixed.map((entry) => entry.session).join(', ')}.`, status: 409 };
  }

  return { refused: `No held session ${id}.`, status: 404 };
}
