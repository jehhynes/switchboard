import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessage, ConversationReply, Persona, Piece, SpokenState, VoiceSettings } from '@switchboard/core';
import { spokenText } from '@switchboard/conversation';
import type { HeardTag } from '@switchboard/conversation';
import type { HubMessage, MicState, VoiceMessage, VoiceTarget } from '@switchboard/voice';
import type { VoiceConnection } from './voiceLink.js';
import type { WindowScope } from './windows.js';

/** A window's voice state (architecture.md § Voice): only whether the voice is here and what its own session's speech is doing. */
export interface VoiceView {
  enabled: boolean;
  /** This window's selected conversation's session is the voice target; a window never learns where else the voice is. */
  here: boolean;
  /** What capture is doing for this window: `off` in a window that is not here (architecture.md § Dictation). */
  mic: MicState;
  /** The reply of this window's session playing now, or null. */
  speaking: string | null;
  speakReplies: boolean;
  /** Why capture cannot run, while the mic is `unavailable` here; playback and speech errors are the voice's, which the dock shows. */
  error: string | null;
}

/** A composer's name: a window's draft belongs to one conversation, so a switch never carries it to another session. */
const composerKey = (key: string, sessionId: string): string => `${key}|${sessionId}`;

/** How often a long dictated message still being spoken goes as a `[partial]` while its session works (claude-collab `FRAGMENT_FLUSH_MS`). */
export const FRAGMENT_FLUSH_MS = 10_000;
/** How often open utterances are checked for a `[partial]`. */
const FLUSH_CHECK_MS = 1_000;

/** A window's composer as the hub keeps it for the focus rule (architecture.md § Dictation): its text, its focus, and the dictation in it. */
interface Composer {
  focused: boolean;
  draft: string;
  /** The pieces dictated into the draft since it was last sent or emptied; empty while it holds no dictation. */
  pieces: Piece[];
}

/** An utterance the voice process is hearing, and the window whose draft it goes into. */
interface Heard {
  key: string;
  sessionId: string;
  gen: number;
  startedAt: number;
  /** When it last went as a `[partial]`, or null. */
  flushedAt: number | null;
}

/** What one line of the fragments log records (architecture.md § Dictation). */
export interface Fragment {
  event: 'heard' | 'dropped' | 'submitted' | 'sent' | 'not-sent' | 'refused';
  sessionId: string;
  utteranceId: string | null;
  pieceId: string | null;
  messageId: string | null;
  text: string;
  score?: number | null;
  f0?: number | null;
  error?: string | null;
}

/** How long the voice process runs on after the last demand ends. */
export const VOICE_LINGER_MS = 10 * 60_000;
/** A crashed voice process is started again at most this often. */
export const VOICE_RESTART_MS = 60_000;
/** What a dock row click answers when its session has no window to talk to. */
export const OPEN_ITS_WINDOW = 'Open its window to talk to it.';

export interface VoiceControlDeps {
  link: { find(): Promise<VoiceConnection | { error: string }>; connected(): VoiceConnection | null; stop(): void };
  settings(): VoiceSettings;
  store: {
    reply(id: string): ConversationReply | null;
    updateReply(id: string, patch: Partial<Pick<ConversationReply, 'spokenState' | 'spokenAtMs' | 'saidChars'>>): void;
    message(id: string): { spokenRequested?: boolean } | null;
    markSeen(sessionId: string, ids: string[], at: number): unknown;
  };
  /** The connected windows' keys and scopes. */
  windows: { keys(): string[]; scope(key: string): WindowScope | null };
  /** The key of the focused window, or null. */
  focusedWindow(): string | null;
  /** Whether the session is a live, observed Code Mode session (`full`), the only kind the voice speaks for. */
  full(sessionId: string): boolean;
  /** The session's persona, whose voice, style and personality its replies are spoken with; null for the settings' (architecture.md § Personas). */
  persona?(sessionId: string): Persona | null;
  /** Whether the session is in a turn, when a long dictated message goes in `[partial]` parts. */
  busy?(sessionId: string): boolean;
  /** The text of the session's latest reply, which the turn model reads; null with none. */
  lastReply?(sessionId: string): string | null;
  /** The `owner/name` of the repository a folder belongs to, from its `origin` remote, or null. */
  originRepo?(cwd: string): Promise<string | null>;
  /**
   * Types dictated text into the window's selected conversation's session as a `[voice]` message, or a `[partial]` part (architecture.md
   * § Dictation): the message, or why it was refused.
   */
  dictate?(key: string, sessionId: string, text: string, pieces: Piece[], partial: boolean): { message: ConversationMessage } | { refused: string };
  /** Where the fragments log goes, `<home>/voice`; none when left out. */
  fragmentsDir?: string;
  /** A reply's speech changed; the windows showing its session get it again. */
  replyChanged(replyId: string): void;
  /** Sends a window's stream an event. */
  notify(key: string, type: string, payload: Record<string, unknown>): void;
  /** The voice target or the dock's voice problem changed, so the dock view is built again. */
  dockChanged(): void;
  now(): number;
  log(line: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  every?(run: () => void, ms: number): { stop(): void };
}

interface Offered {
  gen: number;
  sessionId: string;
}

const FINAL: ReadonlySet<SpokenState> = new Set(['played', 'interrupted', 'skipped', 'stopped-moved', 'failed']);

/**
 * The hub's side of voice (architecture.md § Voice): it starts the voice process on demand and supervises it through `VoiceLink`, sends it
 * the eligible targets and the focus, offers it the replies that asked to be heard, records what became of their speech, and tells each window
 * only whether the voice is here. The voice process decides the target; the hub mirrors it.
 */
export class VoiceControl {
  /** The runtime toggle, one per machine; on until turned off. */
  speakReplies = true;
  #target: { gen: number; sessionId: string | null } = { gen: 0, sessionId: null };
  #client: VoiceConnection | null = null;
  #starting = false;
  #lastStart = -Infinity;
  #restart: unknown = null;
  #linger: unknown = null;
  /** Why the voice process cannot run, or its last playback error, for the dock. */
  #processError: string | null = null;
  #audioError: string | null = null;
  readonly #offered = new Map<string, Offered>();
  /** The reply playing now, by session. */
  readonly #playing = new Map<string, string>();
  #targetsSent = '';
  readonly #viewSent = new Map<string, string>();
  #closed = false;
  /** The mic as the operator set it, one per machine; the process gets it after each start. */
  #micOn = false;
  /** What capture is doing, as the process last said. */
  #mic: MicState = 'off';
  readonly #composers = new Map<string, Composer>();
  readonly #heard = new Map<string, Heard>();
  /** The window the voice last moved to by its own command, which hears dictation when no focused window shows the target. */
  #talkedFrom: string | null = null;
  #typingSent: boolean | null = null;
  readonly #contextSent = new Map<string, string>();
  readonly #repos = new Map<string, string | null | 'pending'>();
  #flushTimer: { stop(): void } | null = null;

  constructor(private readonly deps: VoiceControlDeps) {}

  /** The voice target's session, or null. */
  get target(): string | null {
    return this.#target.sessionId;
  }

  /** The dock's voice problem: the voice process cannot start or run, or playback fails. */
  dockError(): string | null {
    return this.deps.settings().enabled ? (this.#processError ?? this.#audioError) : null;
  }

  /** Whether a message typed to this session now asks for a spoken reply, and an expressive one; never for a slash command. */
  spokenFor(sessionId: string, command: boolean): { spoken: boolean; expressive: boolean } {
    const settings = this.deps.settings();
    const spoken = !command && settings.enabled && this.speakReplies && this.#client !== null && this.#target.sessionId === sessionId;

    return { spoken, expressive: spoken && settings.expressive };
  }

  view(key: string): VoiceView {
    const settings = this.deps.settings();
    const session = this.deps.windows.scope(key)?.sessionId ?? null;
    const here = settings.enabled && session !== null && this.#target.sessionId === session;

    // A playback or speech error is the voice's, not this window's, so only the dock shows it; a reply it failed shows so in its window. Capture
    // that cannot run is this window's mic's.
    return {
      enabled: settings.enabled,
      here,
      mic: here ? this.#mic : 'off',
      speaking: session === null ? null : (this.#playing.get(session) ?? null),
      speakReplies: this.speakReplies,
      error: here && this.#mic === 'unavailable' ? this.#audioError : null,
    };
  }

  /** Sends each window its voice state when it changed. */
  viewsChanged(): void {
    for (const key of this.deps.windows.keys()) {
      const view = this.view(key);
      const text = JSON.stringify(view);

      if (this.#viewSent.get(key) !== text) {
        this.#viewSent.set(key, text);
        this.deps.notify(key, 'voice', { voice: view });
      }
    }
  }

  /** A window's `hello` carries its voice state; later changes are events. */
  shown(key: string): VoiceView {
    const view = this.view(key);

    this.#viewSent.set(key, JSON.stringify(view));
    return view;
  }

  windowClosed(key: string): void {
    this.#viewSent.delete(key);
    for (const one of [...this.#composers.keys()].filter((name) => name.startsWith(`${key}|`))) {
      this.#composers.delete(one);
    }

    if (this.#talkedFrom === key) {
      this.#talkedFrom = null;
    }

    this.update();
  }

  /**
   * Windows, their selections, the focus or the sessions changed: starts or stops the process for the demand, and sends it the eligible targets
   * and the focus when they changed.
   */
  update(): void {
    if (this.#closed) {
      return;
    }

    const settings = this.deps.settings();
    const scopes = this.deps.windows.keys().flatMap((key) => {
      const scope = this.deps.windows.scope(key);

      return scope === null ? [] : [{ key, scope }];
    });
    const wanted = settings.enabled && scopes.length > 0;

    this.#demand(wanted);
    this.viewsChanged();

    const targets = new Map<string, VoiceTarget>();

    for (const { scope } of scopes) {
      if (scope.sessionId !== null && scope.workItemId !== null && this.deps.full(scope.sessionId)) {
        targets.set(scope.sessionId, { sessionId: scope.sessionId, workItemId: scope.workItemId, repo: this.#repoOf(scope.cwd) });
      }
    }

    const focused = this.deps.focusedWindow();
    const session = focused === null ? null : (this.deps.windows.scope(focused)?.sessionId ?? null);
    const message: HubMessage = { type: 'targets', targets: [...targets.values()], focus: session === null ? null : { sessionId: session, via: 'window' } };
    const text = JSON.stringify(message);

    if (this.#client !== null && text !== this.#targetsSent) {
      this.#targetsSent = text;
      this.#client.send(message);
    }

    this.#syncTyping();
  }

  /** A folder's repository, looked up once; null until the lookup answers, which sends the targets again. */
  #repoOf(cwd: string | null): string | null {
    if (cwd === null || this.deps.originRepo === undefined) {
      return null;
    }

    const known = this.#repos.get(cwd);

    if (known === undefined) {
      this.#repos.set(cwd, 'pending');
      void this.deps.originRepo(cwd).then(
        (repo) => {
          this.#repos.set(cwd, repo);

          if (repo !== null) {
            this.update();
          }
        },
        () => this.#repos.set(cwd, null),
      );
    }

    return known === undefined || known === 'pending' ? null : known;
  }

  /** The settings were reloaded: the process and the windows get them; with voice turned off, nothing goes on speaking. */
  settingsChanged(): void {
    this.#client?.send({ type: 'settings', settings: this.deps.settings() });

    if (!this.deps.settings().enabled) {
      this.#client?.send({ type: 'stop' });
      this.#micOn = false;
    }

    for (const key of this.deps.windows.keys()) {
      this.deps.notify(key, 'settings', { settings: { expandReplies: this.deps.settings().expandReplies } });
    }

    this.update();
    this.deps.dockChanged();
  }

  /**
   * A reply was added or changed: it is offered for speech when it is the transcript copy of a reply with a `[speak]` passage, answering a message
   * that asked for a spoken reply, in the voice target's session, while Speak replies is on (architecture.md § Voice); a rewritten one that was
   * offered is cancelled.
   */
  replyChanged(reply: ConversationReply): void {
    const offered = this.#offered.get(reply.id);

    if (offered !== undefined) {
      if (reply.rewrittenBy !== null || reply.withdrawn) {
        this.#client?.send({ type: 'cancel', replyId: reply.id });
      }

      return;
    }

    if ((reply.spokenState ?? 'none') !== 'none' || reply.rewrittenBy !== null || reply.withdrawn || reply.source !== 'transcript' || reply.kind !== 'reply' || reply.speak == null) {
      return;
    }

    const settings = this.deps.settings();
    const asked = reply.answers === null ? false : this.deps.store.message(reply.answers)?.spokenRequested === true;

    this.#sendContext(reply.sessionId);

    if (!settings.enabled || !this.speakReplies || !asked || this.#client === null || this.#target.sessionId !== reply.sessionId) {
      return;
    }

    this.#offer(reply, reply.answers);
  }

  /** The target's latest reply, for the turn model, when it changed. */
  #sendContext(sessionId: string | null): void {
    const lastReply = sessionId === null ? null : (this.deps.lastReply?.(sessionId) ?? null);

    if (this.#client !== null && sessionId !== null && sessionId === this.#target.sessionId && lastReply !== null && this.#contextSent.get(sessionId) !== lastReply) {
      this.#contextSent.set(sessionId, lastReply);
      this.#client.send({ type: 'context', sessionId, lastReply });
    }
  }

  /**
   * The mic command (architecture.md § Dictation): turning it on also moves the voice to this window's session, so the mic is on where the
   * operator turned it on; turning it off stops capture wherever the voice is. Why not, or null.
   */
  mic(key: string, on: boolean): string | null {
    if (on) {
      const refused = this.talkHere(key);

      if (refused !== null) {
        return refused;
      }
    } else if (!this.view(key).here && this.#micOn) {
      return 'Voice is not in this window.';
    }

    this.#micOn = on;
    this.#client?.send({ type: 'mic', on });
    return null;
  }

  /**
   * The composer's focus and draft (architecture.md § Dictation, the focus rule): the hub keeps each window's draft as the one text dictation
   * joins, and while the here window's composer has the focus the voice process holds every send and stops listening. A draft emptied by the
   * operator no longer holds dictation.
   */
  composer(key: string, focused: boolean, draft: string): void {
    const composer = this.#composer(key, this.deps.windows.scope(key)?.sessionId ?? '');

    composer.focused = focused;
    composer.draft = draft;

    if (draft.trim() === '') {
      composer.pieces = [];
    }

    this.#syncTyping();
  }

  /**
   * A message the window sends from its composer: the pieces of the dictation it holds, so it goes as a `[voice]` message, or null for one with
   * none. The draft is then the composer's again, empty.
   */
  dictated(key: string, sessionId: string): Piece[] | null {
    const composer = this.#composers.get(composerKey(key, sessionId));

    if (composer === undefined || composer.pieces.length === 0) {
      return null;
    }

    const pieces = composer.pieces;

    composer.pieces = [];
    composer.draft = '';
    return pieces;
  }

  /** A reply's heard tags go to the glossary (architecture.md § Dictation). */
  heard(tags: HeardTag[]): void {
    for (const tag of tags) {
      this.#client?.send({ type: 'heard', heard: tag.heard, meant: tag.meant });
    }
  }

  /** A dictated message settled: its pieces go to the fragments log with its delivery. */
  delivered(message: ConversationMessage): void {
    if (message.origin !== 'voice' || (message.delivery !== 'sent' && message.delivery !== 'not-sent')) {
      return;
    }

    for (const piece of message.pieces ?? []) {
      this.#fragment({ event: message.delivery, sessionId: message.sessionId, utteranceId: null, pieceId: null, messageId: message.id, text: piece.text, error: message.error });
    }
  }

  #composer(key: string, sessionId: string): Composer {
    let composer = this.#composers.get(composerKey(key, sessionId));

    if (composer === undefined) {
      composer = { focused: false, draft: '', pieces: [] };
      this.#composers.set(composerKey(key, sessionId), composer);
    }

    return composer;
  }

  /** The window dictation goes to: the focused window showing the target, else the one that last moved the voice there, else any showing it. */
  #hereKey(): string | null {
    const session = this.#target.sessionId;

    if (session === null) {
      return null;
    }

    const showing = this.deps.windows.keys().filter((key) => this.deps.windows.scope(key)?.sessionId === session);
    const focused = this.deps.focusedWindow();

    if (focused !== null && showing.includes(focused)) {
      return focused;
    }

    return this.#talkedFrom !== null && showing.includes(this.#talkedFrom) ? this.#talkedFrom : (showing[0] ?? null);
  }

  /** Tells the process whether the here window's composer has the focus, when that changed. */
  #syncTyping(): void {
    const key = this.#hereKey();
    const typing = key !== null && this.#composers.get(composerKey(key, this.#target.sessionId ?? ''))?.focused === true;

    if (this.#client !== null && typing !== this.#typingSent) {
      this.#typingSent = typing;
      this.#client.send({ type: 'typing', on: typing });
    }
  }

  /** The window an utterance's dictation goes to, chosen at its first report while its generation is current; null for one of another. */
  #heardFor(gen: number, utteranceId: string, sessionId: string): Heard | null {
    const known = this.#heard.get(utteranceId);

    if (known !== undefined) {
      return known;
    }

    const key = this.#hereKey();

    if (gen !== this.#target.gen || sessionId !== this.#target.sessionId || key === null) {
      return null;
    }

    const heard = { key, sessionId, gen, startedAt: this.deps.now(), flushedAt: null };

    this.#heard.set(utteranceId, heard);
    this.#armFlush();
    return heard;
  }

  /** A piece settled: it joins its window's draft after the text already there, and goes to the fragments log. */
  #piece(message: Extract<VoiceMessage, { type: 'piece' }>): void {
    const heard = this.#heardFor(message.gen, message.utteranceId, message.sessionId);

    if (heard === null) {
      this.deps.log(`voice: piece of utterance ${message.utteranceId} dropped: generation ${message.gen} is not ${this.#target.gen}`);
      return;
    }

    const piece: Piece = { text: message.text, score: message.score, f0: message.f0, dropped: message.dropped };

    this.#fragment({ event: message.dropped ? 'dropped' : 'heard', sessionId: message.sessionId, utteranceId: message.utteranceId, pieceId: message.pieceId, messageId: null, text: message.text, score: message.score, f0: message.f0 });

    if (message.dropped) {
      return;
    }

    const composer = this.#composer(heard.key, heard.sessionId);

    composer.draft = composer.draft === '' || /\s$/.test(composer.draft) ? `${composer.draft}${message.text}` : `${composer.draft} ${message.text}`;
    composer.pieces.push(piece);
    this.deps.notify(heard.key, 'draft', { text: composer.draft, sessionId: heard.sessionId });
  }

  /**
   * An utterance ended. Turn detection's end, while its generation is current and its window's composer does not have the focus, sends the
   * whole draft as one `[voice]` message and empties it; a refusal leaves the draft and says why in that window. An utterance cut short sends
   * nothing and leaves its words in the draft.
   */
  #utterance(message: Extract<VoiceMessage, { type: 'utterance' }>): void {
    const heard = this.#heard.get(message.utteranceId);

    this.#heard.delete(message.utteranceId);

    if (heard === undefined || !message.final || message.gen !== this.#target.gen) {
      return;
    }

    const composer = this.#composer(heard.key, heard.sessionId);

    if (composer.focused) {
      return;
    }

    this.#submit(heard, composer, false);
  }

  /** Types the window's draft as a dictated message or a `[partial]` part, and empties the draft once it was taken; false when refused. */
  #submit(heard: Heard, composer: Composer, partial: boolean): boolean {
    let text = composer.draft.trim();
    let pieces = composer.pieces;
    // A [partial] part leaves the last settled piece in the draft, so the message that ends the utterance always has words to carry.
    const kept = partial ? pieces.at(-1) : undefined;

    if (partial) {
      const draft = composer.draft.trimEnd();

      if (kept === undefined || pieces.length < 2 || !draft.endsWith(kept.text)) {
        return false;
      }

      text = draft.slice(0, draft.length - kept.text.length).trim();
      pieces = pieces.slice(0, -1);
    }

    if (text === '' || this.deps.dictate === undefined) {
      return false;
    }

    const sent = this.deps.dictate(heard.key, heard.sessionId, text, pieces, partial);

    if ('refused' in sent) {
      this.deps.log(`voice: dictated message refused: ${sent.refused}`);

      for (const piece of pieces) {
        this.#fragment({ event: 'refused', sessionId: heard.sessionId, utteranceId: null, pieceId: null, messageId: null, text: piece.text, error: sent.refused });
      }

      this.deps.notify(heard.key, 'refused', { error: sent.refused });
      return false;
    }

    for (const piece of pieces) {
      this.#fragment({ event: 'submitted', sessionId: heard.sessionId, utteranceId: null, pieceId: null, messageId: sent.message.id, text: piece.text });
    }

    composer.draft = kept?.text ?? '';
    composer.pieces = kept === undefined ? [] : [kept];
    this.deps.notify(heard.key, 'draft', { text: composer.draft, sessionId: heard.sessionId });
    return true;
  }

  /**
   * While an utterance is open in a window whose composer does not have the focus and its session works, the draft goes as a `[partial]` at most
   * every `FRAGMENT_FLUSH_MS` (architecture.md § Dictation).
   */
  #flush(): void {
    const now = this.deps.now();

    for (const heard of new Set(this.#heard.values())) {
      const composer = this.#composers.get(composerKey(heard.key, heard.sessionId));

      if (
        composer === undefined ||
        composer.focused ||
        this.#mic === 'paused-other-app' ||
        heard.gen !== this.#target.gen ||
        this.deps.busy?.(heard.sessionId) !== true ||
        now - (heard.flushedAt ?? heard.startedAt) < FRAGMENT_FLUSH_MS
      ) {
        continue;
      }

      if (this.#submit(heard, composer, true)) {
        heard.flushedAt = now;
      }
    }

    if (this.#heard.size === 0) {
      this.#stopFlush();
    }
  }

  #armFlush(): void {
    this.#flushTimer ??= (this.deps.every ?? every)(() => this.#flush(), FLUSH_CHECK_MS);
  }

  #stopFlush(): void {
    this.#flushTimer?.stop();
    this.#flushTimer = null;
  }

  /** Appends a line to the day's fragments log, `<home>/voice/fragments-<local date>.jsonl`. */
  #fragment(fragment: Fragment): void {
    if (this.deps.fragmentsDir === undefined) {
      return;
    }

    const at = new Date(this.deps.now());
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

    try {
      mkdirSync(this.deps.fragmentsDir, { recursive: true });
      appendFileSync(join(this.deps.fragmentsDir, `fragments-${date}.jsonl`), `${JSON.stringify({ at: at.toISOString(), ...fragment })}\n`);
    } catch (error) {
      this.deps.log(`voice: the fragments log could not be written: ${(error as Error).message}`);
    }
  }

  /** Talk here from a window: the voice moves to its selected conversation's session; why not, or null. */
  talkHere(key: string): string | null {
    const session = this.deps.windows.scope(key)?.sessionId ?? null;
    const refused = session === null ? 'This window has no session to talk to.' : this.#talkTo(session);

    if (refused === null) {
      this.#talkedFrom = key;
    }

    return refused;
  }

  /** A dock row's click (architecture.md § Dock): Talk here for that work item's session when one of its windows is connected; why not, or null. */
  dockSelect(workItemId: number): string | null {
    const key = this.deps.windows.keys().find((one) => this.deps.windows.scope(one)?.workItemId === workItemId && this.deps.windows.scope(one)?.sessionId != null);

    return key === undefined ? OPEN_ITS_WINDOW : this.talkHere(key);
  }

  /** The window selected another conversation: while it has the focus, Talk here for it, without the focus debounce (voice-design § 2.3). */
  selected(key: string): void {
    if (this.deps.settings().enabled && this.#client !== null && this.deps.focusedWindow() === key) {
      this.talkHere(key);
    }
  }

  /** Stop speaking, only from the window the voice is in. */
  stopSpeaking(key: string): string | null {
    if (!this.view(key).here) {
      return 'Voice is not in this window.';
    }

    this.#client?.send({ type: 'stop' });
    return null;
  }

  /** Speak replies on or off; turning it off cancels every reply offered and not yet played. */
  setSpeakReplies(on: boolean): void {
    this.speakReplies = on;

    if (!on) {
      for (const replyId of this.#offered.keys()) {
        this.#client?.send({ type: 'cancel', replyId });
      }
    }

    this.viewsChanged();
  }

  /** Speaks a reply of the window's session again, only while the voice is here. */
  replay(key: string, replyId: string): string | null {
    const scope = this.deps.windows.scope(key);
    const reply = this.deps.store.reply(replyId);

    if (scope === null || reply === null || reply.sessionId !== scope.sessionId) {
      return 'Not in this window.';
    }

    if (!this.view(key).here || this.#client === null) {
      return 'Voice is not in this window.';
    }

    if (reply.speak == null) {
      return 'This reply has no spoken passage.';
    }

    // One request per reply at a time, so its reports stay its own.
    if (this.#offered.has(replyId)) {
      return 'This reply is being spoken.';
    }

    this.#offer(reply, reply.answers);
    return null;
  }

  /** A work item other than the voice target's started needing the operator: the process plays the needs-you sound. */
  needsYou(workItemIds: number[], targetWorkItem: number | null): void {
    const settings = this.deps.settings();

    if (settings.enabled && settings.needsYouSound && this.#client !== null && workItemIds.some((id) => id !== targetWorkItem)) {
      this.#client.send({ type: 'earcon', kind: 'needs-you' });
    }
  }

  close(): void {
    this.#closed = true;
    this.#stopFlush();
    this.#clear('linger');
    this.#clear('restart');
    this.#client?.close();
    this.#client = null;
  }

  #talkTo(sessionId: string): string | null {
    if (!this.deps.settings().enabled) {
      return 'Voice is off (voice.enabled).';
    }

    if (!this.deps.full(sessionId)) {
      return 'The voice speaks only for a live session.';
    }

    if (this.#client === null) {
      return this.#processError ?? 'The voice process is starting.';
    }

    this.update();
    this.#client.send({ type: 'talk-here', sessionId });
    return null;
  }

  #offer(reply: ConversationReply, turn: string | null): void {
    const gen = this.#target.gen;

    const settings = this.deps.settings();
    // The persona is read at each offer, so a pin changes the voice from the next spoken reply.
    const persona = this.deps.persona?.(reply.sessionId) ?? null;

    this.#offered.set(reply.id, { gen, sessionId: reply.sessionId });
    this.#client!.send({
      type: 'speak',
      gen,
      replyId: reply.id,
      sessionId: reply.sessionId,
      text: spokenText(reply.speak!),
      tone: reply.tone ?? null,
      turn,
      voice: persona?.voice ?? settings.voice,
      style: persona?.style ?? settings.style,
      personality: persona === null || persona.personality === '' ? null : persona.personality,
    });
    this.#setState(reply.id, 'queued', null, null);
  }

  #setState(replyId: string, state: SpokenState, atMs: number | null, said: number | null): void {
    if (this.deps.store.reply(replyId) === null) {
      return;
    }

    this.deps.store.updateReply(replyId, { spokenState: state, spokenAtMs: atMs, saidChars: said });
    this.deps.replyChanged(replyId);
  }

  #receive(message: VoiceMessage): void {
    switch (message.type) {
      case 'active': {
        const moved = message.gen !== this.#target.gen;

        this.#target = { gen: message.gen, sessionId: message.sessionId };

        // Everything offered before the move was stopped or dropped by it.
        if (moved) {
          for (const [replyId, offered] of [...this.#offered]) {
            if (offered.gen !== message.gen) {
              this.#offered.delete(replyId);
              this.#playing.delete(offered.sessionId);
              this.#setState(replyId, 'stopped-moved', this.deps.store.reply(replyId)?.spokenAtMs ?? null, this.deps.store.reply(replyId)?.saidChars ?? null);
            }
          }
        }

        this.deps.log(`voice target ${message.sessionId ?? 'none'} (${message.reason}), generation ${message.gen}`);
        this.viewsChanged();
        this.deps.dockChanged();
        this.#syncTyping();
        this.#sendContext(message.sessionId);
        return;
      }
      case 'words': {
        const heard = message.text === '' ? (this.#heard.get(message.utteranceId) ?? null) : this.#heardFor(message.gen, message.utteranceId, message.sessionId);

        // Live words only in the window the voice is in.
        if (heard !== null && heard.gen === this.#target.gen) {
          this.deps.notify(heard.key, 'words', { messageId: message.utteranceId, text: message.text });
        }

        return;
      }
      case 'piece':
        this.#piece(message);
        return;
      case 'utterance':
        this.#utterance(message);
        return;
      case 'speech': {
        if (message.gen !== this.#target.gen || !this.#offered.has(message.replyId)) {
          return;
        }

        this.#setState(message.replyId, message.state, message.atMs, message.said);

        if (message.state === 'playing') {
          this.#playing.set(message.sessionId, message.replyId);
        } else if (FINAL.has(message.state)) {
          this.#offered.delete(message.replyId);

          if (this.#playing.get(message.sessionId) === message.replyId) {
            this.#playing.delete(message.sessionId);
          }

          // A reply whose whole text was its passage, heard to the end, has been seen (architecture.md § Unread).
          const reply = this.deps.store.reply(message.replyId);

          if (message.state === 'played' && reply !== null && reply.speak != null && reply.speak.trim() === reply.opening.trim()) {
            this.deps.store.markSeen(reply.sessionId, [reply.id], this.deps.now());
            this.deps.replyChanged(reply.id);
          }
        }

        this.viewsChanged();
        return;
      }
      case 'progress': {
        if (message.gen !== this.#target.gen || !this.#offered.has(message.replyId)) {
          return;
        }

        for (const key of this.deps.windows.keys()) {
          if (this.deps.windows.scope(key)?.sessionId === message.sessionId) {
            this.deps.notify(key, 'progress', { replyId: message.replyId, chars: message.chars, atMs: message.atMs });
          }
        }

        return;
      }
      case 'audio':
        if (message.mic !== this.#mic) {
          this.#mic = message.mic;
          this.viewsChanged();
        }

        if (message.error !== this.#audioError) {
          this.#audioError = message.error;

          if (message.error !== null) {
            this.deps.log(`voice: ${message.error}`);
          }

          this.viewsChanged();
          this.deps.dockChanged();
        }

        return;
      default:
        return;
    }
  }

  /** Starts the process while it is wanted, restarting it after a crash at most once a minute, and stops it 10 minutes after it is not. */
  #demand(wanted: boolean): void {
    if (!wanted) {
      if (this.#client !== null && this.#linger === null) {
        this.#linger = this.#timer(() => {
          this.#linger = null;
          this.deps.log('stopped the voice process: no window has wanted it for 10 minutes');
          this.#client = null;
          this.deps.link.stop();
        }, VOICE_LINGER_MS);
      }

      this.#clear('restart');
      return;
    }

    this.#clear('linger');

    if (this.#client !== null || this.#starting || this.#restart !== null) {
      return;
    }

    const wait = this.#lastStart + VOICE_RESTART_MS - this.deps.now();

    if (wait > 0) {
      this.#restart = this.#timer(() => {
        this.#restart = null;
        this.update();
      }, wait);
      return;
    }

    void this.#start();
  }

  async #start(): Promise<void> {
    this.#starting = true;
    this.#lastStart = this.deps.now();

    const found = await this.deps.link.find();

    this.#starting = false;

    if (this.#closed) {
      if (!('error' in found)) {
        found.close();
      }

      return;
    }

    if ('error' in found) {
      if (this.#processError !== found.error) {
        this.#processError = found.error;
        this.deps.log(`voice: ${found.error}`);
        this.deps.dockChanged();
      }

      this.update();
      return;
    }

    this.#client = found;
    this.#processError = null;
    this.#targetsSent = '';
    found.onClose(() => {
      if (this.#client !== found) {
        return;
      }

      this.#client = null;
      this.#processError = 'The voice process stopped; it is started again within a minute.';
      this.deps.log('voice: the voice process stopped');
      this.#lost();
      this.deps.dockChanged();
      this.update();
    });
    found.onMessage((message) => this.#receive(message));
    found.send({ type: 'settings', settings: this.deps.settings() });
    this.#typingSent = null;
    this.#contextSent.clear();

    if (this.#micOn) {
      found.send({ type: 'mic', on: true });
    }

    this.deps.dockChanged();
    this.update();
  }

  /** The process is gone, so nothing it was speaking will play. */
  #lost(): void {
    for (const replyId of [...this.#offered.keys()]) {
      this.#setState(replyId, 'failed', null, null);
    }

    this.#offered.clear();
    this.#playing.clear();
    this.#heard.clear();
    this.#stopFlush();
    this.#mic = 'off';
    this.#target = { gen: this.#target.gen, sessionId: null };
    this.viewsChanged();
  }

  #timer(run: () => void, ms: number): unknown {
    return this.deps.setTimer === undefined ? setTimeout(run, ms) : this.deps.setTimer(run, ms);
  }

  #clear(which: 'linger' | 'restart'): void {
    const timer = which === 'linger' ? this.#linger : this.#restart;

    if (timer !== null) {
      if (this.deps.clearTimer === undefined) {
        clearTimeout(timer as NodeJS.Timeout);
      } else {
        this.deps.clearTimer(timer);
      }
    }

    if (which === 'linger') {
      this.#linger = null;
    } else {
      this.#restart = null;
    }
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
