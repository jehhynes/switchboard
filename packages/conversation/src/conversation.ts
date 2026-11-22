import { createHash } from 'node:crypto';
import type { ConversationMessage, ConversationReply, ConversationStatus, TranscriptCheckpoint } from '@switchboard/core';
import { ScreenHold } from './screenHold.js';
import type { HoldOptions, Via } from './screenHold.js';
import { ScreenReader } from './screenReader.js';
import { pasteText } from './input.js';
import { keyOf, stripAside } from './tags.js';
import type { HeardTag } from './tags.js';
import { parseLine, readLines } from './transcript.js';
import type { TranscriptEntry } from './transcript.js';
import type { ScreenRead } from './screen.js';
import { ConversationLog } from './log.js';

/** The store calls the conversation layer makes; the hub's store provides them. */
export interface ConversationStore {
  addMessage(message: Omit<ConversationMessage, 'ord'>): void;
  updateMessage(id: string, patch: Partial<Pick<ConversationMessage, 'at' | 'transcriptUuid' | 'provisional' | 'withdrawn' | 'delivery' | 'error' | 'pastedAt'>>): void;
  message(id: string): ConversationMessage | null;
  replyOfApiMessage(sessionId: string, apiMessageId: string): { replyId: string; blocks: Array<{ uuid: string | null; text: string }> } | null;
  setApiMessage(replyId: string, apiMessageId: string, blocks: Array<{ uuid: string | null; text: string }>): void;
  /** The line texts of a session's newest joined replies. */
  replyBlocks(sessionId: string, limit: number): string[];
  /** The message a transcript line added, by the line's UUID. */
  messageByTranscriptUuid(sessionId: string, uuid: string): ConversationMessage | null;
  provisionalMessages(sessionId: string): ConversationMessage[];
  /** A session's typed messages that were pasted and that no transcript line has confirmed yet. */
  typedAwaitingTranscript(sessionId: string): ConversationMessage[];
  placeLast(id: string): void;
  addReply(reply: Omit<ConversationReply, 'ord' | 'seenAt' | 'spokenState' | 'spokenAtMs' | 'saidChars'>): void;
  updateReply(id: string, patch: Partial<Omit<ConversationReply, 'id' | 'sessionId' | 'workItemId' | 'ord'>>): void;
  reply(id: string): ConversationReply | null;
  /** Newest first; with `before`, only those before that reply in the conversation's order. */
  latestReplies(sessionId: string, limit: number, before?: string): ConversationReply[];
  latestMessageId(sessionId: string): string | null;
  hasTranscriptEntry(sessionId: string, uuid: string): boolean;
  checkpoint(sessionId: string): TranscriptCheckpoint | null;
  setCheckpoint(checkpoint: TranscriptCheckpoint): void;
  /** Adds a status, or updates the one with its ID in place. */
  setStatus(status: Omit<ConversationStatus, 'seenAt'>): void;
  status(id: string): ConversationStatus | null;
}

/** What changed in a session's conversation, for the windows that show it. */
export type ConversationChange =
  | { type: 'message'; message: ConversationMessage }
  | { type: 'reply'; reply: ConversationReply }
  | { type: 'status'; status: ConversationStatus }
  /** A reply's transcript copy carries heard tags, for the voice's glossary (architecture.md § Dictation); sent once per reply. */
  | { type: 'heard'; replyId: string; heard: HeardTag[] };

export interface ConversationDeps {
  store: ConversationStore;
  now(): number;
  newId(): string;
  onChange(change: ConversationChange): void;
  log(line: string): void;
  hold?: HoldOptions;
}

/** After a resize, the screen is read again only after this long, and then whatever it shows counts as read (claude-collab findings). */
export const RESIZE_SETTLE_MS = 1_000;
/** A typed message's transcript entry may carry a time a little before the hub's record of its paste. */
const TYPED_SLACK_MS = 2_000;
/**
 * How long after its paste an entry still confirms a message the transcript did not confirm in time. A sent one has no limit: the transcript
 * already showed it, as a queued message Claude takes later.
 */
export const TYPED_LATE_MS = 120_000;

/** Whether a transcript entry written at `at` can be this typed message's. */
function confirms(at: number, message: ConversationMessage): boolean {
  return message.pastedAt !== null && at >= message.pastedAt - TYPED_SLACK_MS && (message.delivery === 'sent' || at <= message.pastedAt + TYPED_LATE_MS);
}

/** A typed `/clear`, which moves the session to a new transcript file that records it. */
const CLEAR = /^\/clear(?:\s|$)/;

/** How many stored replies seed the screen reader, so the screen's old replies, redrawn, are never published again. */
const SEED_REPLIES = 200;

/** Where the session's transcript is now: its file, or null while it has none. */
export interface TranscriptState {
  path: string | null;
}

/**
 * One Code Mode session's conversation (architecture.md § Conversation): its messages and replies from its transcript, the authority, with the
 * screen as an early copy held `TRANSCRIPT_WAIT_MS` for the transcript's, and withdrawn when no transcript copy comes.
 */
export class SessionConversation extends ConversationLog {
  readonly #reader: ScreenReader;
  readonly #hold: ScreenHold;
  #lastAssistantAt = 0;
  #screenSize: string | null = null;
  #resizedAt: number | null = null;
  readonly #seen = new Set<string>();

  constructor(
    sessionId: string,
    workItemId: number | null,
    deps: ConversationDeps,
  ) {
    super(sessionId, workItemId, deps);
    this.#hold = new ScreenHold((text, at, aside, via, replaces) => this.publish(text, at, aside, via, replaces), deps.hold);
    this.#reader = new ScreenReader((text, aside, replaces) => this.#hold.screen(text, aside, replaces), deps.now);

    // A reply read after a hub restart answers the last message stored before it.
    this.lastMessage = deps.store.latestMessageId(sessionId);

    for (const reply of deps.store.latestReplies(sessionId, SEED_REPLIES)) {
      this.#reader.sent.add(keyOf(reply.opening));
    }

    // The screen draws each line of a joined reply as a block of its own.
    for (const text of deps.store.replyBlocks(sessionId, SEED_REPLIES)) {
      this.#reader.sent.add(keyOf(stripAside(text).text));
    }
  }

  /** Reads what the transcript added since the checkpoint, following the session to a new transcript file. */
  readTranscript(path: string | null): void {
    if (path === null) {
      return;
    }

    let checkpoint = this.deps.store.checkpoint(this.sessionId);

    if (checkpoint === null || checkpoint.transcript !== path) {
      checkpoint = this.#switchTo(path, checkpoint);
    }

    // After a hub restart, the lines read before it rebuild the index `#answered` follows.
    if (!this.#indexed) {
      this.#indexed = true;

      if (checkpoint.offset > 0) {
        for (const line of readLines(path, 0)?.lines ?? []) {
          this.#index(parseLine(line));
        }
      }
    }

    const read = readLines(path, checkpoint.offset);

    if (read === null || (read.lines.length === 0 && read.offset === checkpoint.offset)) {
      return;
    }

    let { lastUuid, lastAt } = checkpoint;

    // Line order is the conversation's order; the lines' timestamps are not in order (claude-collab findings 2026-11-19).
    for (const line of read.lines) {
      const parsed = parseLine(line);
      const { entry, assistantAt, uuid, parent, at, received } = parsed;

      this.#index(parsed);

      if (assistantAt !== null) {
        this.#lastAssistantAt = Math.max(this.#lastAssistantAt, assistantAt);
      }

      lastUuid = uuid ?? lastUuid;
      lastAt = at ?? lastAt;

      // An entry is read once, also across a restart and a transcript replaced by a shorter copy.
      if (entry !== null && (entry.uuid === null || (!this.#seen.has(entry.uuid) && !this.deps.store.hasTranscriptEntry(this.sessionId, entry.uuid)))) {
        if (entry.uuid !== null) {
          this.#seen.add(entry.uuid);
        }

        this.answers = entry.kind === 'reply' ? this.#answered(parent) : null;
        this.#entry(entry);
        this.answers = null;
      } else if (entry === null && received !== null) {
        this.#withdrawSent(received);
      }
    }

    this.deps.store.setCheckpoint({ sessionId: this.sessionId, transcript: path, offset: read.offset, lastUuid, lastAt });
  }

  /**
   * A new transcript file for the session. The first one is read from its start. After `/clear` the new file starts empty; after `/branch` or
   * `/resume` its entries are history copied from another conversation, older than the last entry read, so the reader starts at its end and the
   * view says the conversation continued from another session.
   */
  #switchTo(path: string, previous: TranscriptCheckpoint | null): TranscriptCheckpoint {
    let offset = 0;

    if (previous !== null) {
      const read = readLines(path, 0);
      const copied = read !== null && read.lines.some((line) => {
        const { at } = parseLine(line);

        return at !== null && previous.lastAt !== null && at < previous.lastAt;
      });

      // A message typed into the earlier transcript is never confirmed by an entry of this one, so it keeps its place; a typed `/clear` is the
      // first line of the file it starts (mechanics M88), so it waits for that line.
      for (const message of this.deps.store.typedAwaitingTranscript(this.sessionId)) {
        if (copied || !CLEAR.test(message.text.trim())) {
          this.deps.store.updateMessage(message.id, { pastedAt: null, provisional: false });
        }
      }

      if (copied) {
        offset = read.offset;
        this.note('Conversation continued from another session.');
      }

      this.deps.log(`session ${this.sessionId} transcript moved to ${path}${copied ? ', after copied history' : ''}`);
    }

    // Chains do not cross transcripts.
    this.#parents.clear();
    this.#messageLines.clear();
    this.#indexed = true;

    if (offset > 0) {
      for (const line of readLines(path, 0)?.lines ?? []) {
        this.#index(parseLine(line));
      }
    }

    const checkpoint = { sessionId: this.sessionId, transcript: path, offset, lastUuid: null, lastAt: previous?.lastAt ?? null };

    this.deps.store.setCheckpoint(checkpoint);

    return checkpoint;
  }

  /** Reads a screen the holder serialized; after a resize, nothing for `RESIZE_SETTLE_MS`, and then the screen as already read. */
  readScreen(screen: ScreenRead): void {
    const size = `${screen.cols}x${screen.rows}`;
    const now = this.deps.now();

    if (this.#screenSize !== null && this.#screenSize !== size) {
      this.#resizedAt = now;
    }

    this.#screenSize = size;

    const bullet = (index: number): boolean => screen.bullets[index] === true;

    if (this.#resizedAt !== null) {
      if (now - this.#resizedAt < RESIZE_SETTLE_MS) {
        return;
      }

      this.#resizedAt = null;
      this.#reader.skip(screen.lines, bullet);
      return;
    }

    this.#reader.read(screen.lines, bullet);
  }

  /** Withdraws screen copies that got no transcript copy in time; `busy` says whether the session is in a turn. */
  tick(busy: boolean): void {
    for (const handle of this.#reader.unconfirmed(this.#lastAssistantAt, busy)) {
      const id = this.#hold.withdraw(handle);

      if (id !== null) {
        this.withdraw(id);
      }
    }
  }

  /**
   * The session ended: its transcript has been read to the end, so a screen copy still waiting for its transcript copy was never a reply, and one
   * still held is dropped.
   */
  end(): void {
    for (const handle of this.#reader.drain()) {
      const id = this.#hold.withdraw(handle);

      if (id !== null) {
        this.withdraw(id);
      }
    }

    // A message sent while the session was busy that Claude never received.
    for (const message of this.deps.store.provisionalMessages(this.sessionId)) {
      this.#withdrawSent(message.text);
    }
  }

  /**
   * The message a reply answers: the first operator's message line on the reply's `parentUuid` chain, which matched the API requests for every
   * reply checked (claude-collab findings 2026-11-19); null when the chain leaves the lines this hub has read, such as after a restart.
   */
  #answered(parent: string | null): string | null {
    for (let uuid = parent, steps = 0; uuid !== null && steps < 100_000; uuid = this.#parents.get(uuid) ?? null, steps++) {
      const message = this.#messageLines.get(uuid);

      if (message !== undefined) {
        return message;
      }
    }

    return null;
  }

  /** Adds a line to the index `#answered` follows; a message line already stored names its message. */
  #index({ entry, uuid, parent }: ReturnType<typeof parseLine>): void {
    if (uuid === null) {
      return;
    }

    this.#parents.set(uuid, parent);

    if (entry?.kind === 'message' && !this.#messageLines.has(uuid)) {
      const stored = this.deps.store.messageByTranscriptUuid(this.sessionId, uuid);

      if (stored !== null) {
        this.#messageLines.set(uuid, stored.id);
      }
    }
  }

  /** Each line's parent, and the operator's message lines, by line UUID, of the current transcript, for `#answered`. */
  readonly #parents = new Map<string, string | null>();
  readonly #messageLines = new Map<string, string>();
  #indexed = false;

  /** The oldest sent message with `text` that Claude has not received yet, typed in a terminal; a typed message is matched by `#typed`. */
  #sent(text: string): ConversationMessage | undefined {
    return this.deps.store.provisionalMessages(this.sessionId).find((message) => message.origin === 'terminal' && message.text === text);
  }

  /** The typed message a transcript line written at `at` with `text` records: the latest attempt pasted before it, never an older one with the same words. */
  #typed(text: string, at: number): ConversationMessage | undefined {
    return this.deps.store
      .typedAwaitingTranscript(this.sessionId)
      // A message goes escaped, and a slash command chosen from the composer's list as it is.
      .filter((message) => (pasteText(message.text) === text.trim() || pasteText(message.text, true) === text.trim()) && confirms(at, message))
      .sort((a, b) => b.pastedAt! - a.pastedAt!)[0];
  }

  /** A sent message Claude received as something other than a message from the operator, or never received. */
  #withdrawSent(text: string): void {
    const sent = this.#sent(text);

    if (sent !== undefined) {
      this.deps.store.updateMessage(sent.id, { withdrawn: true });
      this.deps.onChange({ type: 'message', message: this.deps.store.message(sent.id)! });
    }
  }

  /**
   * Claude Code delivers the operator's queued messages in the order they were queued, so a terminal message added before `before` (an `ord`,
   * the order its queue line was read in) that is still waiting when a message queued after it is received never will be: an earlier run exited
   * with it queued, or it went to another agent (mechanics M118).
   */
  #withdrawPassed(before: number, except?: string): void {
    for (const message of this.deps.store.provisionalMessages(this.sessionId)) {
      if (message.origin === 'terminal' && message.id !== except && message.ord < before) {
        this.deps.store.updateMessage(message.id, { withdrawn: true });
        this.deps.onChange({ type: 'message', message: this.deps.store.message(message.id)! });
      }
    }
  }

  #entry(entry: TranscriptEntry): void {
    if (entry.kind === 'sent') {
      // The queue line of a message typed from the view: Claude has it and receives it later, where it then takes its place.
      const typed = this.#typed(entry.text, entry.at);

      if (typed !== undefined) {
        if (typed.delivery !== 'sent') {
          this.deps.store.updateMessage(typed.id, { delivery: 'sent', error: null });
          this.deps.onChange({ type: 'message', message: this.deps.store.message(typed.id)! });
        }

        return;
      }

      // A queue line has no UUID; its session, time and text name it, so a transcript read again from its start never adds it twice.
      const id = `m-q-${createHash('sha256').update(`${this.sessionId}\n${entry.at}\n${entry.text}`).digest('hex').slice(0, 24)}`;
      const stored = this.deps.store.message(id);

      if (stored !== null && stored.sessionId === this.sessionId && stored.text === entry.text) {
        return;
      }

      this.deps.store.addMessage({ id, sessionId: this.sessionId, workItemId: this.workItemId, at: entry.at, origin: 'terminal', text: entry.text, transcriptUuid: null, provisional: true, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
      this.deps.onChange({ type: 'message', message: this.deps.store.message(id)! });
      return;
    }

    if (entry.kind === 'message') {
      // A message typed from the view is already in the conversation: the line where Claude received it confirms it and gives it its place.
      const typed = this.#typed(entry.text, entry.at);

      if (typed !== undefined) {
        // Typed from the view, it was added when it was pasted, after the terminal messages queued before it.
        this.#withdrawPassed(typed.ord);
        this.deps.store.updateMessage(typed.id, { at: entry.at, transcriptUuid: entry.uuid, provisional: false, delivery: 'sent', error: null });
        this.deps.store.placeLast(typed.id);
        this.lastMessage = typed.id;

        if (entry.uuid !== null) {
          this.#messageLines.set(entry.uuid, typed.id);
        }

        this.deps.onChange({ type: 'message', message: this.deps.store.message(typed.id)! });
        return;
      }

      // A message sent while Claude was busy moves to where Claude received it.
      const sent = this.#sent(entry.text);
      const id = sent?.id ?? `m-${this.deps.newId()}`;

      // A prompt line comes when nothing is queued, so every message still waiting was passed over; a queued command that matches no queue line
      // cannot say where it was queued, so it passes over nothing.
      if (sent !== undefined || entry.queued !== true) {
        this.#withdrawPassed(sent?.ord ?? Infinity, sent?.id);
      }

      if (sent === undefined) {
        this.deps.store.addMessage({ id, sessionId: this.sessionId, workItemId: this.workItemId, at: entry.at, origin: 'terminal', text: entry.text, transcriptUuid: entry.uuid, provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
      } else {
        this.deps.store.updateMessage(id, { at: entry.at, transcriptUuid: entry.uuid, provisional: false });
        this.deps.store.placeLast(id);
      }

      this.lastMessage = id;

      if (entry.uuid !== null) {
        this.#messageLines.set(entry.uuid, id);
      }

      this.deps.onChange({ type: 'message', message: this.deps.store.message(id)! });
      return;
    }

    this.transcriptUuid = entry.uuid;

    const { text, aside } = stripAside(entry.text);
    const key = keyOf(text);

    // So a later redraw of it is not published again.
    this.#reader.sent.add(key);

    // Its screen copy, whole or cut off while still being drawn, if one waits: the raw Markdown replaces the screen's rendered copy. Only copies
    // still waiting count, because each transcript reply is a reply of its own, and a second "Yes." is a second answer.
    const shown = this.#reader.ids.has(key) ? key : [...this.#reader.ids.keys()].find((waiting) => waiting !== '' && key.startsWith(waiting));
    const handle = shown === undefined ? undefined : this.#reader.take(shown);
    // The store keeps which reply each API message became, so a hub restart between two of its lines still joins them.
    const joined = entry.messageId === null ? null : this.deps.store.replyOfApiMessage(this.sessionId, entry.messageId);

    if (joined !== null && entry.messageId !== null) {
      // Another text block of the same API message joins its reply, which keeps the place, UUID and answer of its first line; a screen copy of
      // this block is not a reply of its own. A block read before, as when a shorter copy of the transcript is read again, is not added twice.
      const copy = handle === undefined ? null : this.#hold.withdraw(handle);

      if (copy !== null) {
        this.withdraw(copy);
      }

      // The reply's text is always its blocks joined, so a block that was recorded before a crash kept its text is written again.
      const read = joined.blocks.some((block) => block.uuid !== null && block.uuid === entry.uuid);
      const blocks = read ? joined.blocks : [...joined.blocks, { uuid: entry.uuid, text: entry.text }];
      const first = this.deps.store.reply(joined.replyId);

      this.answers = first?.answers ?? this.answers;
      this.transcriptUuid = null;
      this.deps.store.setApiMessage(joined.replyId, entry.messageId, blocks);
      this.publish(blocks.map((block) => block.text).join('\n\n'), first?.at ?? entry.at, stripAside(blocks[0]!.text).aside, 'transcript', joined.replyId, false);
    } else {
      const id = this.#hold.transcript(handle, entry.text, entry.at, aside);

      if (entry.messageId !== null) {
        this.deps.store.setApiMessage(id, entry.messageId, [{ uuid: entry.uuid, text: entry.text }]);
      }
    }

    this.transcriptUuid = null;
  }


}
