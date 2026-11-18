import type { FlowAction, LiveState, ObservedFork, ObservedSession, StopReason } from './flow.js';
import type { Session } from './model.js';

/** `newer` and `older`: a fork of the session's family created after or before its current copy, or a retired copy (PRD R78). */
export type CopyRelation = 'newer' | 'older' | 'unrelated';

export type StartAction = Extract<FlowAction, { type: 'start-session' }>;

/** `startPrompt`: the session runs but waits on a prompt before it starts, which the operator answers through Open in terminal (PRD R41). */
/** `launchId`: the launch of a Code Mode session's process (PRD R93). */
export type StartResult = { shortId: string; nativeSessionId: string; startPrompt?: true; launchId?: string } | { error: string };

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
  /** The session's working directory, when the marker records it. */
  cwd?: string | null;
  observed: { state: LiveState; detail: string | null } | null;
  recheck: boolean;
}

/** What a restarted hub learns about a session it left starting; `pending` says why it cannot tell yet, and the hub asks again at its next roster read. */
export type Reconciled =
  | { sessionId: string; started: { shortId: string; nativeSessionId: string; startPrompt?: true } }
  | { sessionId: string; failed: string }
  | { sessionId: string; pending: string };

/** Starts, observes and stops the sessions of one agent provider (architecture.md § Components). */
export interface SessionRunner {
  /** Starts a background session and resolves once it runs. */
  start(action: StartAction): Promise<StartResult>;
  /**
   * Liveness and state of the given started sessions; a session left out has ended. `forks` holds live forks that may replace a session
   * (PRD R78). A failed read changes nothing.
   */
  observe(sessions: Session[]): Promise<{ sessions: ObservedSession[]; forks?: ObservedFork[] } | { error: string }>;
  /** How a native session relates to the session's current copy; a provider without forks leaves it out (PRD R78). */
  relation?(nativeSessionId: string, session: Session): CopyRelation;
  /** The session of which the native session is a newer fork, among the given sessions, or null. */
  forkOf?(nativeSessionId: string, sessions: Session[]): Session | null;
  /** The live session with this native ID, which the operator started outside Switchboard, or null; a provider that cannot register leaves it out (PRD R81). */
  live?(nativeSessionId: string): Promise<{ shortId: string; cwd: string } | null | { error: string }>;
  /**
   * Continue in Background (PRD R89): the live sessions a Claude tab labelled `label`, or the Claude sidebar (null), in the window whose extension host is `hostPid` may hold, by
   * the roster's session name, with their process and whether they ran in the background before, and how many other live sessions the window holds, which its close would end;
   * a provider that cannot move sessions leaves it out.
   */
  tab?(label: string | null, hostPid: number): Promise<{ candidates: { nativeSessionId: string; pid: number; background: boolean; busy: boolean }[]; others: number } | { error: string }>;
  /** Resumes the session in its background process with `prompt`; `copy` is the short ID of a copy it started instead. */
  resume?(nativeSessionId: string, prompt: string, cwd: string): Promise<{ copy: string | null } | { error: string }>;
  /** The short ID of the session's background process when the roster lists it with a process, null when not. */
  background?(nativeSessionId: string): Promise<{ shortId: string } | null | { error: string }>;
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
