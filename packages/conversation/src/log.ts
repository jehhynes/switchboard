import type { ConversationMessage, ConversationReply, ConversationStatus } from '@switchboard/core';
import { parseReply } from './tags.js';
import type { ConversationDeps } from './conversation.js';
import type { Via } from './screenHold.js';

/** Shared conversation storage, reply tags, statuses and rewrites. Native IDs make history replay idempotent. */
export class ConversationLog {
  protected lastMessage: string | null;
  protected answers: string | null = null;
  protected transcriptUuid: string | null = null;

  constructor(readonly sessionId: string, readonly workItemId: number | null, protected readonly deps: ConversationDeps) {
    this.lastMessage = deps.store.latestMessageId(sessionId);
  }

  message(nativeId: string, text: string, at: number, clientId: string | null): void {
    const existing = this.deps.store.messageByTranscriptUuid(this.sessionId, nativeId);
    if (existing !== null) { this.lastMessage = existing.id; return; }
    const sent = clientId === null ? null : this.deps.store.message(clientId);
    if (sent !== null && sent.sessionId === this.sessionId) {
      this.deps.store.updateMessage(sent.id, { at, transcriptUuid: nativeId, provisional: false, delivery: 'sent', error: null });
      this.deps.store.placeLast(sent.id);
      this.lastMessage = sent.id;
    } else {
      this.lastMessage = `m-${this.deps.newId()}`;
      this.deps.store.addMessage({ id: this.lastMessage, sessionId: this.sessionId, workItemId: this.workItemId, at, origin: 'terminal', text, transcriptUuid: nativeId, provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    }
    this.deps.onChange({ type: 'message', message: this.deps.store.message(this.lastMessage)! });
  }

  reply(nativeId: string, text: string, at: number): void {
    const existing = this.deps.store.replyOfApiMessage(this.sessionId, nativeId);
    if (existing !== null && existing.blocks[0]?.text === text) return;
    this.transcriptUuid = nativeId;
    const id = this.publish(text, at, false, 'transcript', existing?.replyId, false);
    this.deps.store.setApiMessage(id, nativeId, [{ uuid: nativeId, text }]);
    this.transcriptUuid = null;
  }

  /** Publishes a copy: a new reply, or a later copy of one in place (`replaces`). */
  protected publish(text: string, at: number, _aside: boolean, via: Via, replaces: string | undefined, move = true): string {
    const parsed = parseReply(text);

    // A reply that is only a status rewrites nothing: the view shows it on its Status tab, not in the timeline.
    parsed.rewrite &&= parsed.opening !== '';
    const existing = replaces === undefined ? null : this.deps.store.reply(replaces);

    if (existing !== null) {
      const patch = {
        at: via === 'transcript' ? at : existing.at,
        kind: parsed.kind,
        opening: parsed.opening,
        speak: parsed.speak,
        tone: parsed.tone,
        source: via,
        transcriptUuid: this.transcriptUuid ?? existing.transcriptUuid,
        // A screen copy answered the latest message when it was seen; its transcript line says which message it answers.
        answers: via === 'transcript' ? (this.answers ?? this.lastMessage) : existing.answers,
      };

      this.deps.store.updateReply(existing.id, patch);
      this.status(existing.id, via, parsed.status, patch.at);

      // A screen copy takes its transcript line's place once that is read.
      if (via === 'transcript' && move) {
        this.deps.store.placeLast(existing.id);
      }

      // A transcript copy can show a rewrite tag its screen copy had not drawn yet, and, now in its place, rewrites the reply before that place,
      // which may not be the one its screen copy rewrote.
      if (parsed.rewrite && (existing.replaces === null || (via === 'transcript' && move))) {
        if (existing.replaces !== null) {
          this.deps.store.updateReply(existing.replaces, { rewrittenBy: null });
          this.deps.store.updateReply(existing.id, { replaces: null });
          this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(existing.replaces)! });
        }

        this.rewrite(existing.id);
      }

      this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(existing.id)! });
      return existing.id;
    }

    const reply: Omit<ConversationReply, 'ord' | 'seenAt' | 'spokenState' | 'spokenAtMs' | 'saidChars'> = {
      id: `r-${this.deps.newId()}`,
      sessionId: this.sessionId,
      workItemId: this.workItemId,
      at,
      kind: parsed.kind,
      answers: this.answers ?? this.lastMessage,
      opening: parsed.opening,
      speak: parsed.speak,
      tone: parsed.tone,
      source: via,
      replaces: null,
      rewrittenBy: null,
      withdrawn: false,
      transcriptUuid: this.transcriptUuid,
    };

    this.deps.store.addReply(reply);
    this.status(reply.id, via, parsed.status, at);

    if (parsed.rewrite) {
      this.rewrite(reply.id);
    }

    this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(reply.id)! });
    return reply.id;
  }

  /**
   * The status a reply's transcript copy carries, stored as the reply's own, so a later line of the same reply updates it in place. A screen copy's
   * status is never published: it may be withdrawn, and is still being drawn.
   */
  protected status(replyId: string, via: Via, markdown: string | null, at: number): void {
    if (via !== 'transcript' || markdown === null) {
      return;
    }

    const id = `st-${replyId}`;
    const stored = this.deps.store.status(id);

    if (stored?.markdown === markdown) {
      return;
    }

    this.deps.store.setStatus({ id, sessionId: this.sessionId, workItemId: this.workItemId, replyId, at: stored?.at ?? at, markdown });
    this.deps.onChange({ type: 'status', status: this.deps.store.status(id)! });
  }

  /** A rewrite: it replaces the newest earlier reply that is not an aside, only a status, withdrawn, rewritten already or itself. */
  protected rewrite(id: string): void {
    const target = this.deps.store
      .latestReplies(this.sessionId, 200, id)
      .find((reply) => reply.id !== id && reply.kind === 'reply' && reply.opening !== '' && !reply.withdrawn && reply.rewrittenBy === null && reply.replaces !== id);

    if (target === undefined) {
      return;
    }

    this.deps.store.updateReply(target.id, { rewrittenBy: id });
    this.deps.store.updateReply(id, { replaces: target.id });
    this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(target.id)! });
  }

  /** A screen copy that was never a reply; a rewrite that was not one frees the reply it replaced. */
  protected withdraw(id: string): void {
    const reply = this.deps.store.reply(id);

    if (reply === null) {
      return;
    }

    this.deps.store.updateReply(id, { withdrawn: true, replaces: null });
    this.deps.log(`session ${this.sessionId} reply ${id} withdrawn: no transcript copy came`);
    this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(id)! });

    if (reply.replaces !== null) {
      this.deps.store.updateReply(reply.replaces, { rewrittenBy: null });
      this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(reply.replaces)! });
    }
  }

  protected note(text: string): void {
    const id = `r-${this.deps.newId()}`;

    this.deps.store.addReply({ id, sessionId: this.sessionId, workItemId: this.workItemId, at: this.deps.now(), kind: 'note', answers: null, opening: text, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: null });
    this.deps.onChange({ type: 'reply', reply: this.deps.store.reply(id)! });
  }
}
