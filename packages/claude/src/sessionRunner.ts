import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarkerReading, ObservedSession, Reconciled, ReplyRequest, Session, SessionQuestion, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import type { Exec } from './exec.js';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';
import { installHooks, readMarkers } from './install.js';
import { entryFor, observe, readRoster, startSession, stopSession } from './runner.js';
import { jobStatePath, readJobQuestion, replyToSession } from './service.js';
import type { ServiceDeps } from './service.js';

export interface ClaudeRunnerDeps {
  claudePath: string;
  exec: Exec;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The Switchboard home, which holds the hook scripts and the activity markers. */
  home: string;
  /** Claude's settings.json; its folder holds the job states and the service's control key. */
  claudeSettings: string;
  service: ServiceDeps;
  /** Whether hook markers decide state (`sessions.installHooks`); without them the roster alone does. */
  hooks(): boolean;
}

/** Claude Code's background sessions (architecture.md § Claude Code runner). */
export class ClaudeRunner implements SessionRunner {
  /** Job state reads by short ID, kept while the file's modification time is unchanged. */
  private questions = new Map<string, { mtimeMs: number; question: SessionQuestion | null }>();

  constructor(private readonly deps: ClaudeRunnerDeps) {}

  private get configDir(): string {
    return dirname(this.deps.claudeSettings);
  }

  start(action: StartAction): Promise<StartResult> {
    return startSession(this.deps.claudePath, action, { exec: this.deps.exec, sleep: this.deps.sleep, now: this.deps.now });
  }

  async observe(sessions: Session[]): Promise<{ sessions: ObservedSession[] } | { error: string }> {
    const roster = await readRoster(this.deps.claudePath, this.deps.exec);

    return 'error' in roster ? roster : { sessions: observe(roster.entries, sessions, this.rawMarkers()) };
  }

  /** Hook markers, or none when hooks are off, so the roster alone decides state. */
  private rawMarkers(): Map<string, Marker> {
    return this.deps.hooks() ? readMarkers(this.deps.home) : new Map();
  }

  markers(_sessions: Session[]): Map<string, MarkerReading> {
    const readings = new Map<string, MarkerReading>();

    for (const [id, marker] of this.rawMarkers()) {
      readings.set(id, { at: marker.at ?? 0, observed: markerState(marker), recheck: false });
    }

    return readings;
  }

  async isBackground(target: SessionTarget): Promise<boolean> {
    if (target.shortId === null) {
      return false;
    }

    const roster = await readRoster(this.deps.claudePath, this.deps.exec);

    return 'entries' in roster && entryFor(roster.entries, target.shortId)?.kind === 'background';
  }

  stop(target: SessionTarget, _reason: StopReason): Promise<{ error: string } | null> {
    return target.shortId === null ? Promise.resolve({ error: 'The session has not started yet.' }) : stopSession(this.deps.claudePath, target.shortId, this.deps.exec);
  }

  /** The question from the job state, read again only when the file changed (PRD R70, mechanics M24). */
  question(session: Session): { question: SessionQuestion | null; version: number } | null {
    if (session.shortId === null) {
      return null;
    }

    let mtimeMs: number;

    try {
      const stat = statSync(jobStatePath(this.configDir, session.shortId), { throwIfNoEntry: false });

      if (stat === undefined) {
        return null;
      }

      mtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }

    const cached = this.questions.get(session.shortId);

    if (cached?.mtimeMs === mtimeMs) {
      return { question: cached.question, version: mtimeMs };
    }

    const read = readJobQuestion(this.configDir, session.shortId);
    const question = read === null ? null : { text: read.questions[0]!.question, options: read.questions[0]!.options, parts: read.questions.length };

    this.questions.set(session.shortId, { mtimeMs, question });

    return { question, version: mtimeMs };
  }

  forgetQuestion(target: SessionTarget): void {
    if (target.shortId !== null) {
      this.questions.delete(target.shortId);
    }
  }

  reply(request: ReplyRequest): Promise<{ error: string } | null> {
    return replyToSession(this.configDir, request.shortId, request.answer, this.deps.service);
  }

  /** A background session started by a hub that stopped cannot be matched to its roster entry, so its start fails (PRD R43). */
  reconcile(sessions: Session[]): Promise<Reconciled[]> {
    return Promise.resolve(sessions.map((session) => ({ sessionId: session.id, failed: 'The hub stopped while the session was starting.' })));
  }

  installHooks(): string | null {
    try {
      return installHooks(this.deps.home, this.deps.claudeSettings);
    } catch (error) {
      return `Switchboard could not add its hooks to ${this.deps.claudeSettings}: ${(error as Error).message}`;
    }
  }
}
