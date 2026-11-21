import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import type { LimitReading, LiveState, MarkerReading, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason, StopFailure } from '@switchboard/core';
import { artifactsDir, isCodexPermissionMode, PERMISSION_PROMPT } from '@switchboard/core';
import { AppServer, AppServerError, object } from './appServer.js';
import type { Json } from './appServer.js';
import { codexPrompt } from './args.js';
import { answeredSettings, startSettings } from './threadSettings.js';
import type { ThreadSettings } from './threadSettings.js';

export interface AppServerRunnerDeps {
  server: AppServer;
  session(id: string): Session | null;
  sessions(): Session[];
  sessionByNative?(id: string): Session | null;
  canRevive?(session: Session): boolean;
  /** The permission mode and model a resumed thread runs with; without them a resume keeps what the daemon loads. */
  resumeOptions?(session: Session): { permissionMode: string; model: string | null };
  currentInstructions?(session: Session): string;
  configured?(session: Session): void;
  instructionsDelivered?(sessionId: string, hash: string, compactionId: string | null): void;
  log?(line: string): void;
  created(id: string, threadId: string): void;
  instructions(action: StartAction): string;
  /** `limit`: the usage or rate limit a failed turn stopped at (architecture.md § Rate limits). */
  state(id: string, state: LiveState, detail: string | null, limit?: LimitReading): void;
  /** A reset time for a limit read earlier, from a rate-limit update that came after the failed turn (architecture.md § Rate limits). */
  limitFound?(id: string, limit: LimitReading): void;
  now(): number;
}

/** Persistent threads in Codex's built-in daemon; no hook markers and no process kill per thread. */
export class AppServerRunner implements SessionRunner {
  readonly #joined = new Map<string, number>();
  readonly #states = new Map<string, { state: LiveState; detail: string | null }>();
  readonly #stateGeneration = new Map<string, number>();
  readonly #following = new Map<string, Promise<Json>>();
  readonly #subscriptions = new Map<string, number>();
  readonly #instructions = new Map<string, { hash: string; compactionId: string | null }>();
  readonly #configuring = new Map<string, Promise<void>>();
  readonly #compactions = new Map<string, string>();
  readonly #seenCompactions = new Map<string, Set<string>>();
  /** The latest reset time of each rate-limit window, from `account/rateLimits/updated` (mechanics M100). */
  readonly #windows = new Map<string, { resetsAt: number | null; full: boolean }>();
  /** The limit each session's last failed turn stopped at, which a later rate-limit update can give a reset. */
  readonly #limits = new Map<string, LimitReading>();
  /** The settings each thread's first start or resume answer since the hub started reported, by thread ID. */
  readonly #started = new Map<string, ThreadSettings>();

  constructor(readonly deps: AppServerRunnerDeps) {
    deps.server.listen((event) => {
      if (event['method'] === 'account/rateLimits/updated') {
        this.#rateLimits(object(object(event['params'])['rateLimits']));
        const resetsAt = this.#resetsAt();
        if (resetsAt !== null) {
          for (const [id, limit] of this.#limits) {
            if (limit.kind !== 'usage' || limit.resetsAt === resetsAt) continue;
            const updated = { ...limit, resetsAt, exact: true };
            this.#limits.set(id, updated);
            deps.limitFound?.(id, updated);
          }
        }
        return;
      }

      if (!['thread/status/changed', 'turn/started', 'turn/completed', 'item/completed'].includes(String(event['method'])) && event['id'] === undefined) return;
      const params = object(event['params']);
      const threadId = params['threadId'];
      if (typeof threadId !== 'string') return;
      const session = deps.sessionByNative?.(threadId) ?? deps.sessions().find(s => s.execution === 'app-server' && s.nativeSessionId === threadId);
      if (session === undefined || session.state === 'ended' || session.released) return;
      if (event['method'] === 'item/completed') {
        const item = object(params['item']);
        if (item['type'] === 'contextCompaction' && typeof item['id'] === 'string') {
          void this.#refreshCompaction(session, item['id']).catch(error => {
            this.#joined.delete(threadId);
            deps.log?.(`Codex instruction refresh failed: ${String(error)}`);
          });
        }
        return;
      }
      let state: { state: LiveState; detail: string | null } | null = null;
      if (event['method'] === 'thread/status/changed') state = threadState(object(params['status']));
      if (event['method'] === 'turn/started') state = { state: 'running', detail: null };
      let limit: LimitReading | undefined;
      if (event['method'] === 'turn/completed') {
        const turn = object(params['turn']);
        limit = turn['status'] === 'failed' ? (turnLimit(object(turn['error']), this.#resetsAt()) ?? undefined) : undefined;
        state = limit !== undefined
          ? { state: 'failed', detail: 'rate_limit' }
          : turn['status'] === 'failed' || turn['status'] === 'interrupted'
          ? { state: 'failed', detail: String(object(turn['error'])['message'] ?? (turn['status'] === 'interrupted' ? 'The turn was interrupted.' : 'The turn failed.')) }
          : { state: 'idle', detail: null };
      }
      if (event['id'] !== undefined && typeof event['method'] === 'string') state = { state: 'waiting', detail: event['method'].endsWith('/requestApproval') ? PERMISSION_PROMPT : null };
      if (state !== null) {
        if (state.state === 'idle' && this.#states.get(session.id)?.state === 'failed') return;
        this.#states.set(session.id, state);
        this.#stateGeneration.set(session.id, deps.server.generation);
        if (limit === undefined) {
          this.#limits.delete(session.id);
          deps.state(session.id, state.state, state.detail);
        } else {
          this.#limits.set(session.id, limit);
          deps.state(session.id, state.state, state.detail, limit);
        }
      }
    });
  }

  /** Keeps each window of a sparse rate-limit update; a window at 100% holds its reset time. */
  #rateLimits(snapshot: Json): void {
    for (const name of ['primary', 'secondary']) {
      const window = snapshot[name];
      if (window === null || typeof window !== 'object') continue;
      const fields = object(window);
      this.#windows.set(`${String(snapshot['limitId'] ?? 'codex')}/${name}`, { resetsAt: typeof fields['resetsAt'] === 'number' ? fields['resetsAt'] * 1000 : null, full: typeof fields['usedPercent'] === 'number' && fields['usedPercent'] >= 100 });
    }
  }

  /** The latest reset of a full window, or null when no update named one. */
  #resetsAt(): number | null {
    const full = [...this.#windows.values()].filter(w => w.full && w.resetsAt !== null && w.resetsAt > this.deps.now()).map(w => w.resetsAt!);
    return full.length === 0 ? null : Math.max(...full);
  }

  async start(action: StartAction): Promise<StartResult> {
    if (!isCodexPermissionMode(action.permissionMode)) return { error: `Codex cannot use permission mode ${action.permissionMode}.` };
    let threadId: string | null = null;
    let attempted = false;
    try {
      const dir = artifactsDir(action.cwd, action.workItemId);
      mkdirSync(dir, { recursive: true });
      try { writeFileSync(`${dir}/.gitignore`, '*\n', { flag: 'wx' }); } catch { /* Already made. */ }
      const permissions = permissionOptions(action.permissionMode);
      const instructions = this.deps.instructions(action);
      const result = await this.deps.server.request('thread/start', {
        cwd: action.cwd, ...permissionOptions(action.permissionMode),
        config: { ...object(permissions['config']), 'shell_environment_policy.set.CLAUDE_ARTIFACTS_DIR': dir },
        ...(action.model === null ? {} : { model: action.model }),
        developerInstructions: instructions,
      });
      const native = object(result['thread'])['id'];
      if (typeof native !== 'string') throw new Error('Codex returned no thread ID.');
      threadId = native;
      this.#answered(native, result);
      this.deps.created(action.sessionId, native);
      this.#joined.set(native, this.deps.server.generation);
      this.#rememberInstructions(action.sessionId, native, instructions, null);
      await this.deps.server.request('thread/name/set', { threadId: native, name: action.name }).catch(() => {});
      if (action.prompt !== '') {
        const attachments: Json[] = [];
        const skill = /^\/([\w:-]+)(?=\s|$)/.exec(action.prompt)?.[1];
        if (skill !== undefined) {
          const listed = await this.deps.server.request('skills/list', { cwds: [action.cwd] }).catch((): Json => ({}));
          const groups = Array.isArray(listed['data']) ? listed['data'].map(object) : [];
          const found = groups.flatMap(g => Array.isArray(g['skills']) ? g['skills'].map(object) : []).find(s => s['enabled'] === true && s['name'] === skill && typeof s['path'] === 'string');
          if (found !== undefined) attachments.push({ type: 'skill', name: skill, path: found['path'] });
        }
        attempted = true;
        await this.send(native, `sb-start-${action.sessionId}`, codexPrompt(action.prompt), attachments, action.cwd);
      }
      return { nativeSessionId: native, shortId: native };
    } catch (error) {
      if (threadId !== null && attempted && !(error instanceof AppServerError && (error.refused || error.notSent))) {
        // A start whose response was lost may already be running. Never start its prompt a second time.
        try {
          const turns = await this.history(threadId);
          if (turns.some(turn => items(turn).some(item => item['clientId'] === `sb-start-${action.sessionId}`))) return { nativeSessionId: threadId, shortId: threadId };
        } catch { /* Keep the start pending until the daemon can confirm it. */ }
        return { nativeSessionId: threadId, shortId: threadId, pending: 'The first Codex message is unconfirmed. Switchboard will check again; Stop or Delete before retrying.' };
      }
      return { error: `Codex app-server start failed: ${String(error)}` };
    }
  }

  async follow(session: Session): Promise<Json> {
    const id = session.nativeSessionId;
    if (id === null) throw new Error('The Codex session has no thread ID.');
    const pending = this.#following.get(id);
    if (pending !== undefined) return pending;
    const work = (async () => {
      const revision = this.subscription(session);
      const joined = this.#joined.get(id) === this.deps.server.generation;
      const instructions = joined ? undefined : this.deps.currentInstructions?.(session);
      const result = await this.deps.server.request(joined ? 'thread/read' : 'thread/resume', { threadId: id, ...(joined ? {} : { excludeTurns: true, ...this.#resumeOptions(session) }) });
      if (!joined) this.#answered(id, result);
      if (!joined && this.subscription(session) === revision) {
        await this.#configure(session, instructions);
        this.#joined.set(id, this.deps.server.generation);
        this.deps.configured?.(session);
      }
      return object(result['thread']);
    })().finally(() => this.#following.delete(id));
    this.#following.set(id, work);
    return work;
  }

  subscription(session: Session): number { return this.#subscriptions.get(session.nativeSessionId ?? '') ?? 0; }

  /**
   * Joins the thread and gives it the current instructions when they changed, as before `/compact` and when an ended session resumes (Open in
   * terminal or a message to it). The thread's history keeps the instructions it was given, also when the daemon loads it again from disk.
   */
  async configure(session: Session): Promise<void> {
    if (session.nativeSessionId === null) throw new Error('The Codex session has no thread ID.');
    const instructions = this.deps.currentInstructions?.(session);
    this.#answered(session.nativeSessionId, await this.deps.server.request('thread/resume', { threadId: session.nativeSessionId, excludeTurns: true, ...this.#resumeOptions(session) }));
    await this.#configure(session, instructions);
    if (session.nativeSessionId !== null) this.#joined.set(session.nativeSessionId, this.deps.server.generation);
    this.deps.configured?.(session);
  }

  /**
   * Resumes an ended session's thread as `configure` does, then leaves it unjoined, so the conversation's next follow rejoins it and the daemon
   * replays a question or approval that arrived while the session still read as ended (mechanics M92).
   */
  async resumeThread(session: Session): Promise<void> {
    await this.configure(session);
    if (session.nativeSessionId !== null) this.#joined.delete(session.nativeSessionId);
  }

  /**
   * The start's working folder, permissions, artifact folder and model, for a thread the daemon loads again from disk; a loaded thread keeps its
   * sandbox (mechanics M95).
   */
  #resumeOptions(session: Session): Json {
    const options = this.deps.resumeOptions?.(session);
    if (options === undefined || !isCodexPermissionMode(options.permissionMode)) return {};
    const permissions = permissionOptions(options.permissionMode);
    return {
      cwd: session.cwd, ...permissions,
      config: { ...object(permissions['config']), 'shell_environment_policy.set.CLAUDE_ARTIFACTS_DIR': artifactsDir(session.cwd, session.workItemId) },
      ...(options.model === null ? {} : { model: options.model }),
    };
  }

  async #configure(session: Session, instructions: string | undefined): Promise<void> {
    const id = session.nativeSessionId;
    if (id === null || instructions === undefined) return;
    const work = (this.#configuring.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const stored = this.deps.session(session.id);
      const compactionId = this.#compactions.get(id) ?? stored?.instructionsCompactionId ?? null;
      const delivered = this.#instructions.get(id) ?? { hash: stored?.instructionsHash, compactionId: stored?.instructionsCompactionId ?? null };
      if (delivered.hash === createHash('sha256').update(instructions).digest('hex') && delivered.compactionId === compactionId) return;
      // resume ignores changed developerInstructions on an already loaded thread (mechanics M92).
      await this.deps.server.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }] });
      this.#rememberInstructions(session.id, id, instructions, compactionId);
    }).finally(() => { if (this.#configuring.get(id) === work) this.#configuring.delete(id); });
    this.#configuring.set(id, work);
    await work;
  }

  #rememberInstructions(sessionId: string, threadId: string, instructions: string, compactionId: string | null): void {
    const hash = createHash('sha256').update(instructions).digest('hex');
    this.#instructions.set(threadId, { hash, compactionId });
    this.deps.instructionsDelivered?.(sessionId, hash, compactionId);
  }

  async #refreshCompaction(session: Session, compactionId: string): Promise<void> {
    if (session.nativeSessionId === null || session.releasing || session.released || session.state === 'ended') return;
    const stored = this.deps.session(session.id);
    const current = this.#compactions.get(session.nativeSessionId) ?? stored?.instructionsCompactionId ?? null;
    let seen = this.#seenCompactions.get(session.nativeSessionId);
    if (seen === undefined) {
      seen = new Set(current === null ? [] : [current]);
      this.#seenCompactions.set(session.nativeSessionId, seen);
    }
    if (seen.has(compactionId) && current !== compactionId) return;
    seen.add(compactionId);
    this.#compactions.set(session.nativeSessionId, compactionId);
    const delivered = this.#instructions.get(session.nativeSessionId) ?? { hash: stored?.instructionsHash, compactionId: stored?.instructionsCompactionId };
    if (delivered.hash != null && delivered.compactionId === compactionId) return;
    await this.#configure(session, this.deps.currentInstructions?.(session));
    this.deps.configured?.(session);
  }

  /** Conversation recovery only; history reads and Stop never depend on injecting instructions. */
  async restoreInstructions(session: Session, turns: Json[]): Promise<void> {
    const compacted = turns.flatMap(items).filter(item => item['type'] === 'contextCompaction').at(-1);
    if (typeof compacted?.['id'] !== 'string') return;
    try { await this.#refreshCompaction(session, compacted['id']); }
    catch (error) {
      if (session.nativeSessionId !== null) this.#joined.delete(session.nativeSessionId);
      this.deps.log?.(`Codex instruction refresh failed: ${String(error)}`);
    }
  }

  /**
   * The settings the session's thread ran with when this hub first started or joined it, as the daemon answered; else those its options give,
   * or null with no `resumeOptions`. A settings change found later is measured against them (mechanics M108).
   */
  startSettings(session: Session): ThreadSettings | null {
    const answered = session.nativeSessionId === null ? undefined : this.#started.get(session.nativeSessionId);
    if (answered !== undefined) return answered;
    const options = this.deps.resumeOptions?.(session);
    return options === undefined ? null : startSettings(options.permissionMode, options.model);
  }

  /** Keeps the first settings the daemon answered for a thread; a later answer can already hold a change made outside Switchboard. */
  #answered(threadId: string, answer: Json): void {
    const settings = answeredSettings(answer);
    if (settings !== null && !this.#started.has(threadId)) this.#started.set(threadId, settings);
  }

  /** Whether the thread has a turn; Codex keeps no rollout of a thread before its first, so no other client can resume it yet (mechanics M108). */
  async hasTurns(threadId: string): Promise<boolean> {
    try {
      const page = await this.deps.server.request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
      return Array.isArray(page['data']) && page['data'].length > 0;
    } catch (error) {
      // "thread … is not materialized yet; thread/turns/list is unavailable before first user message"
      if (error instanceof AppServerError && error.refused && /not materialized/i.test(error.message)) return false;
      throw error;
    }
  }

  async history(threadId: string): Promise<Json[]> {
    const turns: Json[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.server.request('thread/turns/list', { threadId, sortDirection: 'asc', itemsView: 'full', limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(page['data'])) throw new Error('Codex returned no history.');
      turns.push(...page['data'].map(object));
      cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : undefined;
      if (turns.length > 10_000) throw new Error('Codex history exceeds 10,000 turns.');
    } while (cursor !== undefined);
    return turns;
  }

  async send(threadId: string, clientId: string, text: string, attachments: Json[] = [], cwd?: string): Promise<void> {
    const session = this.deps.sessionByNative?.(threadId) ?? this.deps.sessions().find(s => s.nativeSessionId === threadId);
    await this.deps.server.request('turn/start', { threadId, clientUserMessageId: clientId, input: [...codexInput(text, cwd ?? session?.cwd ?? process.cwd()), ...attachments] });
  }

  async observe(sessions: Session[]): Promise<Awaited<ReturnType<SessionRunner['observe']>>> {
    try {
      const observed = [];
      for (const session of sessions) {
        if (session.nativeSessionId === null || session.releasing) continue;
        if ((session.state === 'ended' || session.released) && this.deps.canRevive?.(session) !== true) continue;
        try {
        const thread = session.state === 'ended' || session.released
          ? object((await this.deps.server.request('thread/read', { threadId: session.nativeSessionId }))['thread'])
          : await this.follow(session);
        if ((session.state === 'ended' || session.released) && object(thread['status'])['type'] !== 'active') continue;
        let state = threadState(object(thread['status']));
        // A status notification can say idle after a failed turn; the turn's explicit failure takes precedence.
        let last = this.#states.get(session.id);
        if (state.state === 'idle' && (last === undefined || this.#stateGeneration.get(session.id) !== this.deps.server.generation)) {
          const result = await this.deps.server.request('thread/turns/list', { threadId: session.nativeSessionId, sortDirection: 'desc', itemsView: 'notLoaded', limit: 1 });
          const tail = Array.isArray(result['data']) ? object(result['data'][0]) : null;
          last = undefined;
          const tailLimit = tail?.['status'] === 'failed' ? turnLimit(object(tail['error']), this.#resetsAt()) : null;
          if (tailLimit !== null) {
            last = { state: 'failed', detail: 'rate_limit' };
            this.#limits.set(session.id, tailLimit);
          } else if (tail?.['status'] === 'failed' || tail?.['status'] === 'interrupted') last = { state: 'failed', detail: String(object(tail['error'])['message'] ?? 'The turn was interrupted.') };
        }
        if (state.state === 'idle' && last?.state === 'failed') state = last;
        this.#states.set(session.id, state);
        this.#stateGeneration.set(session.id, this.deps.server.generation);
        const replayed = state.state === 'failed' && state.detail === 'rate_limit' ? this.#limits.get(session.id) : undefined;
        observed.push({ sessionId: session.id, ...state, ...(replayed === undefined ? {} : { limit: replayed }) });
        } catch (error) {
          if (error instanceof AppServerError && error.refused) {
            if (session.state !== 'ended' && !/not found|no .*thread|archived|does not exist/i.test(error.message)) observed.push({ sessionId: session.id, state: 'failed' as const, detail: error.message });
            continue;
          }
          throw error;
        }
      }
      return { sessions: observed };
    } catch (error) { return { error: String(error) }; }
  }

  markers(_sessions: Session[]): Map<string, MarkerReading> { return new Map(); }
  async isBackground(): Promise<boolean> { return true; }
  async installHooks(): Promise<null> { return null; }

  async stop(target: SessionTarget, reason: StopReason): Promise<StopFailure | null> {
    const threadId = target.shortId ?? this.deps.session(target.sessionId)?.nativeSessionId;
    if (threadId == null) return null;
    try {
      const thread = await this.deps.server.request('thread/read', { threadId });
      if (object(object(thread['thread'])['status'])['type'] === 'active') {
        if (reason === 'release') return { error: 'The Codex thread started a new turn; release was cancelled.', cancelled: true };
        const turns = await this.history(threadId);
        const active = turns.filter(t => t['status'] === 'inProgress');
        if (active.length === 0) return { error: 'Codex has not identified its running turn; try Stop again.' };
        for (const turn of active) await this.deps.server.request('turn/interrupt', { threadId, turnId: turn['id'] });
      }
      this.#subscriptions.set(threadId, (this.#subscriptions.get(threadId) ?? 0) + 1);
      this.#joined.delete(threadId);
      await this.#following.get(threadId)?.catch(() => {});
      await this.deps.server.request('thread/unsubscribe', { threadId });
      this.#joined.delete(threadId);
      return null;
    } catch (error) { return { error: `Codex ${reason} failed: ${String(error)}` }; }
  }

  async reconcile(sessions: Session[]): Promise<Reconciled[]> {
    const results: Reconciled[] = [];
    for (const session of sessions) {
      if (session.nativeSessionId === null) { results.push({ sessionId: session.id, failed: 'Switchboard stopped before Codex returned its thread ID.' }); continue; }
      try {
        await this.follow(session);
        const history = await this.history(session.nativeSessionId);
        if (session.promptless !== true && !history.some(t => items(t).some(i => i['clientId'] === `sb-start-${session.id}`))) {
          results.push({ sessionId: session.id, pending: 'The first Codex message is unconfirmed. Stop or Delete before retrying.' });
        } else results.push({ sessionId: session.id, started: { shortId: session.nativeSessionId, nativeSessionId: session.nativeSessionId } });
      } catch (error) { results.push({ sessionId: session.id, pending: String(error) }); }
    }
    return results;
  }
}

/**
 * The limit a failed turn's error names (mechanics M100): `usageLimitExceeded` a usage limit, `rateLimitExceeded` a throttle, with the reset of a
 * full rate-limit window when an update gave one. Null for any other error.
 */
export function turnLimit(error: Json, resetsAt: number | null): LimitReading | null {
  const info = error['codexErrorInfo'];
  if (info !== 'usageLimitExceeded' && info !== 'rateLimitExceeded') return null;
  const message = typeof error['message'] === 'string' ? error['message'].slice(0, 500) : null;
  return { kind: info === 'usageLimitExceeded' ? 'usage' : 'throttle', window: null, resetsAt, exact: resetsAt !== null, cli: false, message };
}

export function items(turn: Json): Json[] { return Array.isArray(turn['items']) ? turn['items'].map(object) : []; }

export function threadState(status: Json): { state: LiveState; detail: string | null } {
  if (status['type'] === 'systemError') return { state: 'failed', detail: 'Codex reported a system error.' };
  const flags = Array.isArray(status['activeFlags']) ? status['activeFlags'] : [];
  if (flags.includes('waitingOnApproval')) return { state: 'waiting', detail: PERMISSION_PROMPT };
  if (flags.includes('waitingOnUserInput')) return { state: 'waiting', detail: null };
  return { state: status['type'] === 'active' ? 'running' : 'idle', detail: null };
}

export function permissionOptions(mode: string): Json {
  return {
    approvalPolicy: mode === 'auto' ? 'on-request' : 'never',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox: mode === 'plan' ? 'read-only' : mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
    ...(mode === 'auto' || mode === 'dontAsk' ? { config: { 'sandbox_workspace_write.network_access': true } } : {}),
  };
}

/** Text file mentions remain readable paths; local image mentions are explicit app-server image inputs. */
export function codexInput(text: string, cwd: string): Json[] {
  const images = new Set<string>();
  for (const match of text.matchAll(/@(?:"([^"]+)"|([^\s]+))/g)) {
    const path = resolve(cwd, match[1] ?? match[2]!);
    if (/^\.(png|jpe?g|gif|webp)$/i.test(extname(path)) && existsSync(path)) images.add(path);
  }
  return [{ type: 'text', text }, ...[...images].map(path => ({ type: 'localImage', path }))];
}
