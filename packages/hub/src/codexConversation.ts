import type { ConversationMessage, Session, Store } from '@switchboard/core';
import { AppServer, AppServerError, AppServerRunner, items, object } from '@switchboard/codex';
import type { Json } from '@switchboard/codex';
import { ConversationLog } from '@switchboard/conversation';
import type { SlashCommand } from '@switchboard/conversation';
import type { ConversationAdapter, ConversationChanged, DeliveryOutcome, NativeRequest, ResolveGuard, SendGuard } from './conversationAdapter.js';

const UNKNOWN = 'Codex did not confirm delivery. Switchboard will check its history; check the terminal before resending.';

export interface CodexConversationDeps {
  server: AppServer;
  runner: AppServerRunner;
  store: Store;
  now(): number;
  newId(): string;
  log(line: string): void;
  requestsChanged(): void;
}

/** Codex history and structured events, with message confirmation by client ID. No terminal or transcript parsing. */
export class CodexConversationAdapter implements ConversationAdapter {
  #logs = new Map<string, ConversationLog>();
  #followed = new Map<string, string>();
  #requests = new Map<string, { sessionId: string; generation: number; nativeId: string | number; method: string; params: Json; view: NativeRequest }>();
  #commands = new Map<string, SlashCommand[]>();
  #skillPaths = new Map<string, Map<string, string>>();
  #retryAt = new Map<string, number>();
  #errors = new Map<string, string>();
  #buffered = new Map<string, Json[]>();
  #uncertainChecks = new Map<string, number>();
  #toolItems = new Map<string, Json>();
  readonly #unlisten: () => void;
  #closed = false;

  constructor(private readonly deps: CodexConversationDeps, private readonly changed: ConversationChanged) {
    this.#unlisten = deps.server.listen(event => this.#event(event));
  }
  supports(session: Session): boolean { return session.execution === 'app-server'; }
  cannotSend(session: Session): string | null { return this.#errors.get(session.id) ?? null; }
  close(): void { this.#closed = true; this.#unlisten(); this.#logs.clear(); this.#requests.clear(); }
  commands(session: Session): SlashCommand[] { return this.#commands.get(session.id) ?? []; }
  requests(session: Session): NativeRequest[] { return [...this.#requests.values()].filter(r => r.sessionId === session.id && r.generation === this.deps.server.generation).map(r => r.view); }

  #log(session: Session): ConversationLog {
    let log = this.#logs.get(session.id);
    if (log === undefined) {
      log = new ConversationLog(session.id, session.workItemId, { ...this.deps, onChange: change => this.changed(session.id, change) });
      this.#logs.set(session.id, log);
    }
    return log;
  }

  #revision(session: Session): string { return `${this.deps.server.generation}/${this.deps.runner.subscription(session)}/${session.launchId ?? ''}`; }

  async poll(sessions: Session[]): Promise<void> {
    for (const session of sessions.filter(s => this.supports(s) && !s.releasing && s.state !== 'starting' && s.state !== 'ended' && s.nativeSessionId !== null)) {
      if ((this.#retryAt.get(session.id) ?? 0) > this.deps.now()) continue;
      const uncertain = this.deps.store.openMessages().some(m => m.sessionId === session.id && m.delivery === 'uncertain');
      const changed = this.#followed.get(session.id) !== this.#revision(session);
      if (!changed && (!uncertain || (this.#uncertainChecks.get(session.id) ?? 0) >= 3)) continue;
      if (changed) this.#uncertainChecks.delete(session.id);
      if (uncertain) this.#uncertainChecks.set(session.id, (this.#uncertainChecks.get(session.id) ?? 0) + 1);
      try {
        await this.deps.runner.follow(session);
        if (this.#closed) return;
        await this.#history(session);
        if (this.#closed) return;
        this.#followed.set(session.id, this.#revision(session));
        for (const item of this.#buffered.get(session.id) ?? []) this.#item(session, item, this.deps.now());
        this.#buffered.delete(session.id);
        await this.#skills(session).catch(error => this.deps.log(`Codex skill list unavailable: ${String(error)}`));
        this.#errors.delete(session.id);
      } catch (error) {
        const message = `Codex conversation unavailable: ${String(error)}`;
        if (this.#errors.get(session.id) !== message) this.deps.log(message);
        this.#errors.set(session.id, message);
      }
      this.#retryAt.set(session.id, this.deps.now() + 5_000);
      if (!this.#closed) this.deps.requestsChanged();
    }
  }

  /** Whether a reply of the session may be held back: its thread is not followed under its current subscription yet, or live items wait for its history. */
  pending(session: Session): boolean {
    return this.supports(session) && session.nativeSessionId !== null && (this.#followed.get(session.id) !== this.#revision(session) || (this.#buffered.get(session.id)?.length ?? 0) > 0);
  }

  /** Follows the session's thread and imports its history and the live items held for it now, as a poll does, so its last reply is stored. */
  async catchUp(session: Session): Promise<void> {
    if (!this.pending(session)) return;
    await this.deps.runner.follow(session);
    if (this.#closed) return;
    await this.#history(session);
    if (this.#closed) return;
    this.#followed.set(session.id, this.#revision(session));
    for (const item of this.#buffered.get(session.id) ?? []) this.#item(session, item, this.deps.now());
    this.#buffered.delete(session.id);
  }

  readEnded(session: Session): void {
    if (session.state !== 'ended' || session.nativeSessionId === null || this.#followed.get(session.id) === `ended:${this.#revision(session)}`) return;
    this.#log(session);
    this.#followed.set(session.id, `ended:${this.#revision(session)}`);
    void this.#history(session).then(() => {
      for (const item of this.#buffered.get(session.id) ?? []) this.#item(session, item, this.deps.now());
      this.#buffered.delete(session.id);
    }).catch(error => { this.#followed.delete(session.id); this.deps.log(`Codex history unavailable: ${String(error)}`); });
  }

  async #history(session: Session): Promise<Json[]> {
    const turns = await this.deps.runner.history(session.nativeSessionId!);
    if (this.#closed) return turns;
    for (const turn of turns) for (const item of items(turn)) this.#item(session, item, Number(turn['startedAt'] ?? 0) * 1_000);
    await this.deps.runner.restoreInstructions(session, turns);
    return turns;
  }

  #item(session: Session, item: Json, at: number): void {
    if (typeof item['id'] !== 'string') return;
    const time = typeof item['completedAtMs'] === 'number' ? item['completedAtMs'] : at || this.deps.now();
    if (item['type'] === 'userMessage') {
      const content = Array.isArray(item['content']) ? item['content'].map(object) : [];
      const text = content.filter(c => c['type'] === 'text').map(c => String(c['text'] ?? '')).join('\n').replace(/^(?:\[(?:spoken|expressive)\]\s*)+/, '');
      this.#log(session).message(item['id'], text, time, typeof item['clientId'] === 'string' ? item['clientId'] : null);
    } else if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
      this.#log(session).reply(item['id'], item['text'], time);
    }
  }

  #event(event: Json): void {
    if (!['item/started', 'item/completed', 'serverRequest/resolved', 'turn/completed'].includes(String(event['method'])) && event['id'] === undefined) return;
    const params = object(event['params']);
    const session = typeof params['threadId'] === 'string' ? this.deps.store.sessionByNativeId(params['threadId']) : null;
    if (session === null || !this.supports(session) || session.state === 'ended') return;
    if (event['method'] === 'item/started' && object(params['item'])['type'] === 'fileChange') {
      const item = object(params['item']);
      this.#toolItems.set(`${session.id}:${String(item['id'])}`, item);
    }
    if (event['method'] === 'turn/completed') this.#uncertainChecks.delete(session.id);
    if (event['method'] === 'item/completed') {
      const item = object(params['item']);
      if (this.#followed.get(session.id) !== this.#revision(session)) this.#buffered.set(session.id, [...(this.#buffered.get(session.id) ?? []), item]);
      else this.#item(session, item, this.deps.now());
    }
    if (event['method'] === 'serverRequest/resolved') {
      for (const [id, request] of this.#requests) if (request.sessionId === session.id && request.nativeId === params['requestId']) this.#requests.delete(id);
      this.deps.requestsChanged();
    }
    if (event['id'] !== undefined && typeof event['method'] === 'string' && (typeof event['id'] === 'string' || typeof event['id'] === 'number')) {
      const id = `${this.deps.server.generation}:${event['id']}`;
      const method = event['method'];
      const question = method === 'item/tool/requestUserInput';
      const permission = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
      const questions = Array.isArray(params['questions']) ? params['questions'].map(object).map(q => ({ id: String(q['id']), question: String(q['question'] ?? q['header'] ?? ''), options: Array.isArray(q['options']) ? q['options'].map(o => String(object(o)['label'] ?? '')) : [], ...(q['isSecret'] === true ? { secret: true } : {}) })) : [];
      const available = Array.isArray(params['availableDecisions']) ? params['availableDecisions'].filter((d): d is string => typeof d === 'string') : ['accept', 'decline', 'cancel'];
      const file = this.#toolItems.get(`${session.id}:${String(params['itemId'])}`);
      const diffs = Array.isArray(file?.['changes']) ? file['changes'].map(object).map(change => `${String(change['path'] ?? '')}\n${String(change['diff'] ?? '')}`).join('\n\n') : '';
      const title = [String(params['command'] ?? params['reason'] ?? (question ? 'Codex has a question' : 'Codex needs permission')), diffs, params['additionalPermissions'] === undefined ? '' : JSON.stringify(params['additionalPermissions']), params['networkApprovalContext'] === undefined ? '' : JSON.stringify(params['networkApprovalContext'])].filter(Boolean).join('\n\n');
      this.#requests.set(id, { sessionId: session.id, generation: this.deps.server.generation, nativeId: event['id'], method, params, view: { id, kind: question ? 'question' : permission && available.length > 0 ? 'permission' : 'unsupported', title, questions, decisions: available } });
      this.deps.requestsChanged();
    }
  }

  async answer(session: Session, id: string, answer: unknown): Promise<void> {
    const request = this.#requests.get(id);
    if (request === undefined || request.sessionId !== session.id || request.generation !== this.deps.server.generation) throw new Error('This Codex request is no longer pending.');
    if (request.view.kind === 'permission') {
      if (typeof answer !== 'string' || !request.view.decisions.includes(answer)) throw new Error('Choose one of the offered decisions.');
      await this.deps.server.respond(request.nativeId, { decision: answer });
    } else if (request.view.kind === 'question') {
      const answers = object(answer);
      if (request.view.questions.some(q => typeof answers[q.id] !== 'string' || String(answers[q.id]).trim() === '')) throw new Error('Answer every question.');
      await this.deps.server.respond(request.nativeId, { answers: Object.fromEntries(request.view.questions.map(q => [q.id, { answers: [answers[q.id]] }])) });
    } else throw new Error('Answer this Codex request in its terminal.');
    this.#requests.delete(id);
  }

  send(session: Session, message: ConversationMessage, text: string, done: (outcome: DeliveryOutcome) => void, guard: SendGuard): void {
    void (async () => {
      const why = guard.check?.();
      if (why != null) { done({ delivery: 'not-sent', error: why }); return; }
      if (this.deps.store.session(session.id)?.releasing) { done({ delivery: 'not-sent', error: 'This session is being released. Open it again before sending.' }); return; }
      try {
        if (guard.command === true && text.trim() === '/compact') {
          await this.deps.runner.configure(session);
          await this.deps.server.request('thread/compact/start', { threadId: session.nativeSessionId });
          this.deps.store.updateMessage(message.id, { provisional: false });
          done({ delivery: 'sent' }); return;
        }
        const attachments: Json[] = [];
        if (guard.command === true && text.startsWith('/')) {
          const name = /^\/([^\s]+)/.exec(text)?.[1] ?? '';
          const path = this.#skillPaths.get(session.id)?.get(name);
          if (path === undefined) { done({ delivery: 'not-sent', error: `Codex does not offer /${name} here.` }); return; }
          attachments.push({ type: 'skill', name, path });
          text = `$${text.slice(1)}`;
        }
        this.deps.store.updateMessage(message.id, { pastedAt: this.deps.now() });
        await this.deps.runner.send(session.nativeSessionId!, message.id, text, attachments);
        done({ delivery: 'sent' });
      } catch (error) {
        if (error instanceof AppServerError && (error.refused || error.notSent)) { done({ delivery: 'not-sent', error: error.message }); return; }
        await this.#settle(message, done);
      }
    })();
  }

  resolve(message: ConversationMessage, _text: string, done: (outcome: DeliveryOutcome) => void, _guard: ResolveGuard): void {
    if (message.pastedAt === null && message.delivery !== 'uncertain') { done({ delivery: 'not-sent', error: 'Switchboard restarted before sending the message.' }); return; }
    void this.#settle(message, done);
  }
  async #settle(message: ConversationMessage, done: (outcome: DeliveryOutcome) => void): Promise<void> {
    const session = this.deps.store.session(message.sessionId);
    try {
      if (session !== null && session.nativeSessionId !== null) {
        await this.#history(session);
        if (this.deps.store.message(message.id)?.delivery === 'sent') { done({ delivery: 'sent' }); return; }
      }
    } catch (error) { this.deps.log(`Codex delivery check failed: ${String(error)}`); }
    done({ delivery: 'uncertain', error: UNKNOWN });
  }

  async #skills(session: Session): Promise<void> {
    const result = await this.deps.server.request('skills/list', { cwds: [session.cwd] });
    const skills = Array.isArray(result['data']) ? result['data'].flatMap(entry => Array.isArray(object(entry)['skills']) ? (object(entry)['skills'] as unknown[]).map(object) : []) : [];
    this.#skillPaths.set(session.id, new Map(skills.filter(s => s['enabled'] === true && typeof s['name'] === 'string' && typeof s['path'] === 'string').map(s => [String(s['name']), String(s['path'])])));
    this.#commands.set(session.id, [{ name: 'compact', description: 'Compact the conversation' }, ...skills.filter(s => s['enabled'] === true && typeof s['name'] === 'string').map(s => ({ name: String(s['name']), description: String(s['description'] ?? '') }))]);
  }
}
