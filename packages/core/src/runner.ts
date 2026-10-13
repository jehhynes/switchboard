import type { FlowAction, LiveState, ObservedSession, StopReason } from './flow.js';
import type { Session } from './model.js';

export type StartAction = Extract<FlowAction, { type: 'start-session' }>;

export type StartResult = { shortId: string; nativeSessionId: string } | { error: string };

/** The session a stop acts on; a deleted session's row is gone, so the action carries what the runner needs. */
export interface SessionTarget {
  sessionId: string;
  shortId: string | null;
}

/**
 * What a session's hook marker, or the provider's other fast signals, say without starting a process: when it was last written,
 * the live state it gives, or null when it sets none, and whether only a roster read can decide the session, as when its process
 * may have ended or moved to an interactive process.
 */
export interface MarkerReading {
  at: number;
  observed: { state: LiveState; detail: string | null } | null;
  recheck: boolean;
}

/** What a restarted hub learns about a session it left starting; `pending` says why it cannot tell yet, and the hub asks again at its next roster read. */
export type Reconciled =
  | { sessionId: string; started: { shortId: string; nativeSessionId: string } }
  | { sessionId: string; failed: string }
  | { sessionId: string; pending: string };

/** Starts, observes and stops the sessions of one agent provider (architecture.md § Components). */
export interface SessionRunner {
  /** Starts a background session and resolves once it runs. */
  start(action: StartAction): Promise<StartResult>;
  /** Liveness and state of the given started sessions; a session left out has ended. A failed read changes nothing. */
  observe(sessions: Session[]): Promise<{ sessions: ObservedSession[] } | { error: string }>;
  /** Fast readings of the given started sessions by native session ID, read without starting a process. */
  markers(sessions: Session[]): Map<string, MarkerReading>;
  /** Whether the session runs in Switchboard's background process, so a release may stop it (PRD R39). */
  isBackground(target: SessionTarget): Promise<boolean>;
  stop(target: SessionTarget, reason: StopReason): Promise<{ error: string } | null>;
  /** Settles the sessions a hub that stopped left `starting`, after a restart (PRD R43). */
  reconcile(sessions: Session[]): Promise<Reconciled[]>;
  /** Installs Switchboard's hooks for the provider, and has the provider trust them when it must; returns the error to show, or null. */
  installHooks(): Promise<string | null>;
}
