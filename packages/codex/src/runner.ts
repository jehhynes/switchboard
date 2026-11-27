import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarkerReading, ObservedSession, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import { executableDirOnPath, hubRunning, stoppedHomes } from '@switchboard/core';
import { CODEX_HOOK_SOURCE, codexHookCommands, planCodexHooks } from './hooks.js';
import { readText } from './records.js';
import { trustHooks } from './trust.js';

/** Why this runner refuses to start or stop a session: every Codex session runs on the app-server daemon (PRD R107). */
export const EXEC_RETIRED = 'Switchboard runs every Codex session on the Codex app-server; it no longer runs codex exec.';

export interface CodexRunnerDeps {
  /** Read at each use, so a change to `sessions.codexPath` applies to the next trust call. */
  codexPath(): string;
  /** The Switchboard home, which holds the hook script. */
  home: string;
  /** Codex's home, `CODEX_HOME` or `~/.codex`, which holds hooks.json. */
  codexHome: string;
  /** Variables for every Codex process besides `CODEX_HOME`, which is always `codexHome`. */
  env: Record<string, string>;
  /** The Node.js the hooks run (`sessions.nodePath`). */
  nodePath(): string;
  trust?: (commands: ReadonlySet<string>) => Promise<string | null>;
  /** Whether another Switchboard home's hub runs, so its hook entries stay. */
  hubRunning?: (home: string) => Promise<boolean>;
}

/**
 * The Codex hooks, and the Codex sessions an earlier hub ran as `codex exec` runs, which the hub ends at startup and shows read only (architecture.md
 * § Codex runner). It starts, follows and stops no session.
 */
export class CodexRunner implements SessionRunner {
  constructor(private readonly deps: CodexRunnerDeps) {}

  start(_action: StartAction): Promise<StartResult> {
    return Promise.resolve({ error: EXEC_RETIRED });
  }

  observe(_sessions: Session[]): Promise<{ sessions: ObservedSession[] }> {
    return Promise.resolve({ sessions: [] });
  }

  markers(_sessions: Session[]): Map<string, MarkerReading> {
    return new Map();
  }

  isBackground(_target: SessionTarget): Promise<boolean> {
    return Promise.resolve(false);
  }

  stop(_target: SessionTarget, _reason: StopReason): Promise<{ error: string } | null> {
    return Promise.resolve({ error: EXEC_RETIRED });
  }

  reconcile(sessions: Session[]): Promise<Reconciled[]> {
    return Promise.resolve(sessions.map((session) => ({ sessionId: session.id, failed: 'Switchboard stopped while the session was starting.' })));
  }

  /** Writes the hook script and Switchboard's entries in hooks.json, then has Codex trust them; the contract hook serves app-server threads. */
  async installHooks(): Promise<string | null> {
    const hookPath = join(this.deps.home, 'codex-hook.mjs').replaceAll('\\', '/');
    const contractPath = join(this.deps.home, 'contract.mjs').replaceAll('\\', '/');
    const hooksPath = join(this.deps.codexHome, 'hooks.json');
    const nodePath = this.deps.nodePath();

    try {
      mkdirSync(this.deps.home, { recursive: true });

      if (readText(hookPath) !== CODEX_HOOK_SOURCE) {
        writeFileSync(hookPath, CODEX_HOOK_SOURCE);
      }

      const text = readText(hooksPath) || null;
      const stopped = await stoppedHomes((stale) => planCodexHooks(text, hookPath, contractPath, nodePath, stale), this.deps.hubRunning ?? hubRunning);
      const plan = planCodexHooks(text, hookPath, contractPath, nodePath, (other) => stopped.has(other));

      if ('error' in plan) {
        return plan.error;
      }

      if ('text' in plan) {
        mkdirSync(this.deps.codexHome, { recursive: true });
        writeFileSync(hooksPath, plan.text);
      }
    } catch (error) {
      return `Switchboard could not add its hooks to ${hooksPath}: ${(error as Error).message}`;
    }

    const commands = codexHookCommands(hookPath, contractPath, nodePath);
    const env = { ...this.deps.env, ...executableDirOnPath(this.deps.codexPath()), CODEX_HOME: this.deps.codexHome };
    const trust = this.deps.trust ?? ((wanted: ReadonlySet<string>) => trustHooks(this.deps.codexPath(), wanted, env));

    return trust(new Set([commands.hook, commands.contract]));
  }
}
