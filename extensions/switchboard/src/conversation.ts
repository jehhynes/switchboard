import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { openConversation, postToHub } from '@switchboard/hub';
import type { EventStream, ItemView, StatusView } from '@switchboard/hub';
import { applyEvent, EMPTY_CONVERSATION, lastSpokenReply, statusLine, totalUnread, voiceStatus, withEarlier } from './conversationModel.js';
import type { ConversationEvent, ConversationState } from './conversationModel.js';
import type { ConversationMessage, SeenTarget, SendTarget } from './webview/conversationRender.js';
import { linkTarget, previewLinks, supportsSecondarySidebar } from './links.js';
import { excludeGlob, fileGlob, rankFiles } from './composerModel.js';
import type { CommandItem, FileItem } from './composerModel.js';
import { writePastedImage } from './pastedImages.js';

/**
 * The Conversation view's two contributions (architecture.md § Conversation view): in the secondary side bar, as Claude Code's own panel, and
 * in an activity bar container for a VS Code without one, chosen by the `switchboard.noSecondarySidebar` context key.
 */
export const CONVERSATION_VIEWS = ['switchboard.conversation', 'switchboard.conversationActivity'] as const;
export const NO_SECONDARY_SIDEBAR = 'switchboard.noSecondarySidebar';
/** The scheme of a status opened in the Markdown preview (architecture.md § Statuses). */
export const STATUS_SCHEME = 'switchboard-status';
/** What a status document says once this window no longer has the status, as after a reload. */
export const STATUS_GONE = 'This status is no longer available in this window. Open it again from the Conversation view.';

/** A status's document: `switchboard-status:/<id>/Status <local time>.md`, so the preview's tab names its time and the `.md` makes it Markdown. */
export function statusUri(status: Pick<StatusView, 'id' | 'at'>): vscode.Uri {
  const at = new Date(status.at);
  const two = (value: number): string => String(value).padStart(2, '0');
  const name = `Status ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.md`;

  return vscode.Uri.from({ scheme: STATUS_SCHEME, path: `/${encodeURIComponent(status.id)}/${name}` });
}

/** The status ID a status document's URI names; empty for a path that is not `/<id>/<name>.md`. */
export function statusIdOf(uri: vscode.Uri): string {
  const match = /^\/([^/]+)\/[^/]+\.md$/.exec(uri.path);

  try {
    return match === null ? '' : decodeURIComponent(match[1]!);
  } catch {
    return '';
  }
}

export interface ConversationViewDeps {
  /** Opens this window's session in its attach terminal, as the pane's Open in terminal does. */
  openTerminal(): Promise<unknown>;
  /** Opens one of the window's artifacts by its path (architecture.md § Artifacts). */
  openArtifact(path: string): Promise<unknown>;
  /** Hears each new state, as the artifacts do, before the page gets it. */
  changed?(state: ConversationState): void;
  /** The paths of the artifacts new or changed since they were last opened in the workspace, which the Artifacts tab marks and counts. */
  unopened?(): string[];
  log(line: string): void;
}

/** The view's badge for the current session's unread replies and statuses; none at 0 (architecture.md § Unread). */
export function unreadBadge(unread: number): vscode.ViewBadge | undefined {
  return unread > 0 ? { value: unread, tooltip: unread === 1 ? '1 unread reply or status' : `${unread} unread replies and statuses` } : undefined;
}

/** A status's time in the earlier statuses list: "Thu, Nov 19, 1:46 PM". */
const STATUS_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** How long a stream that ended waits before it opens again. */
const RECONNECT_MS = 1_000;
const HISTORY_TIMEOUT_MS = 10_000;
/** Statuses the extension keeps for documents already open, beyond the ones a window shows. */
const STATUSES_KEPT = 200;
/** The hub answers `send` once the message is stored, before it is typed. */
const SEND_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
/** How many not-sent messages of other windows, or not yet answered, the view remembers. */
const NOT_SENT_KEPT = 20;
/** How many files the picker asks VS Code for before it ranks them. */
const FILES_FOUND = 500;

/**
 * The Conversation view (architecture.md § Conversation view): follows this window's conversation stream, keeps its state and draws it in a
 * webview view. The view is not retained when hidden; its page asks for the state again when it loads.
 */
export class ConversationView implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider {
  #state: ConversationState = EMPTY_CONVERSATION;
  /** Statuses this window was sent, by ID, with the session's folder for their links, which a status document reads; cleared when the scope moves. */
  readonly #statuses = new Map<string, { markdown: string; cwd: string | null }>();
  readonly #statusChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#statusChanged.event;
  readonly #views = new Map<string, vscode.WebviewView>();
  #stream: EventStream | null = null;
  #target: { record: HubRecord; key: string } | null = null;
  #retry: NodeJS.Timeout | undefined;
  /** Attempts since the stream last opened; a refused key and a failed connection look alike, so a few retries cover both. */
  #attempts = 0;
  /** Messages this window sent that the hub took, until they go or are not sent. */
  readonly #mine = new Set<string>();
  /** Messages the stream said were not sent before the `send` that added them was answered, with why. */
  readonly #notSentEarly = new Map<string, string>();
  /**
   * Texts of messages that were not sent, with the conversation each goes back to, kept until a loaded page took them, since a hidden view's page
   * is not kept.
   */
  #returned: Array<{ text: string; error: string; workItemId: number | null }> = [];
  #giving: Promise<void> | null = null;
  #giveAgain = false;
  /** The voice's status bar item (architecture.md § Voice), shown while `voice.enabled` is on. */
  readonly #voiceItem = vscode.window.createStatusBarItem('switchboard.voice', vscode.StatusBarAlignment.Left, 99);

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ConversationViewDeps,
  ) {}

  register(): vscode.Disposable {
    void vscode.commands.executeCommand('setContext', NO_SECONDARY_SIDEBAR, !supportsSecondarySidebar(vscode.version));

    return vscode.Disposable.from(
      ...CONVERSATION_VIEWS.map((id) => vscode.window.registerWebviewViewProvider(id, this)),
      vscode.workspace.registerTextDocumentContentProvider(STATUS_SCHEME, this),
      // The page counts an unread item as seen only while this window has the focus (architecture.md § Unread).
      vscode.window.onDidChangeWindowState((state) => this.#post({ type: 'focus', focused: state.focused })),
      this.#statusChanged,
      this.#voiceItem,
      { dispose: () => this.disconnect() },
    );
  }

  /** What the view shows now, for the integration suite. */
  state(): ConversationState {
    return this.#state;
  }

  /** The badge of a resolved view, for the integration suite. */
  badge(): vscode.ViewBadge | undefined {
    return [...this.#views.values()][0]?.badge;
  }

  /** Follows the conversation stream of the window key a hub's `/events` hello gave; a new hello replaces it. */
  connect(record: HubRecord, key: string): void {
    if (this.#target?.key === key && this.#target.record.pid === record.pid && this.#stream !== null) {
      return;
    }

    this.disconnect();
    this.#target = { record, key };
    this.#attempts = 0;
    void this.#open();
  }

  disconnect(): void {
    clearTimeout(this.#retry);
    this.#target = null;
    this.#stream?.close();
    this.#stream = null;
  }

  async #open(): Promise<void> {
    const target = this.#target;

    if (target === null) {
      return;
    }

    const stream = await openConversation(
      target.record,
      target.key,
      () => {
        if (this.#target === target) {
          this.#stream = null;
          this.#set({ ...this.#state, connected: false });
          this.#retry = setTimeout(() => void this.#open(), RECONNECT_MS);
        }
      },
      (event, data) => {
        if (this.#target === target) {
          this.receive({ type: event, ...(JSON.parse(data) as object) } as ConversationEvent);
        }
      },
    );

    if (this.#target !== target) {
      stream?.close();
      return;
    }

    if (stream === null) {
      // A failed connection is tried again; a key the hub refuses dies with the window's `/events` stream, and the next hello brings a new one.
      if (++this.#attempts <= MAX_ATTEMPTS) {
        this.#retry = setTimeout(() => void this.#open(), RECONNECT_MS * this.#attempts);
      } else {
        this.deps.log('the conversation stream did not open; waiting for the window to connect again');
      }

      return;
    }

    this.#attempts = 0;
    this.#stream = stream;
  }

  /**
   * Applies a stream event and redraws. A typed message that was not sent leaves the timeline (architecture.md § Typing a message); one this window
   * sent goes back into the composer with why.
   */
  receive(event: ConversationEvent): void {
    const message = event.type === 'message' ? (event as { message: ItemView }).message : null;

    if (message?.type === 'message' && message.delivery === 'not-sent') {
      const error = message.error ?? 'The message was not sent.';

      // A message a restarted hub settled has no known sender, so every window showing its session takes its text back.
      if (this.#mine.delete(message.id) || (event as { giveBack?: unknown }).giveBack === true) {
        this.#returned.push({ text: message.text, error, workItemId: message.workItemId });
        void this.#giveBack();
      } else {
        this.#notSentEarly.set(message.id, error);

        for (const id of [...this.#notSentEarly.keys()].slice(0, -NOT_SENT_KEPT)) {
          this.#notSentEarly.delete(id);
        }
      }
    } else if (message?.type === 'message' && message.delivery !== 'open') {
      this.#mine.delete(message.id);
    }

    const before = this.#state.scope;

    this.#set(applyEvent(this.#state, event));

    // A status document shows only statuses of the window's current work item and session; open ones say so once the scope moved.
    if (this.#state.scope?.workItemId !== before?.workItemId || this.#state.scope?.sessionId !== before?.sessionId) {
      this.#statuses.clear();

      for (const document of vscode.workspace.textDocuments.filter((one) => one.uri.scheme === STATUS_SCHEME)) {
        this.#statusChanged.fire(document.uri);
      }
    }

    if (this.#state.status !== null) {
      this.#keep(this.#state.status);
    }
  }

  /** Keeps a status for its documents, and redraws an open one whose text changed. */
  #keep(status: Pick<StatusView, 'id' | 'markdown'>): void {
    const known = this.#statuses.get(status.id)?.markdown;

    this.#statuses.delete(status.id);
    this.#statuses.set(status.id, { markdown: status.markdown, cwd: this.#state.scope?.cwd ?? null });

    for (const id of [...this.#statuses.keys()].slice(0, -STATUSES_KEPT)) {
      this.#statuses.delete(id);
    }

    if (known !== undefined && known !== status.markdown) {
      for (const document of vscode.workspace.textDocuments.filter((one) => one.uri.scheme === STATUS_SCHEME && statusIdOf(one.uri) === status.id)) {
        this.#statusChanged.fire(document.uri);
      }
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const status = this.#statuses.get(statusIdOf(uri));

    return status === undefined ? STATUS_GONE : previewLinks(status.markdown, status.cwd);
  }

  /** Opens a status in the Markdown preview: the one the Status tab shows, or one the earlier statuses list gave. */
  async openStatus(status: StatusView): Promise<void> {
    this.#keep(status);
    await vscode.commands.executeCommand('markdown.showPreview', statusUri(status));
  }

  /**
   * Lists the current session's statuses before the one the Status tab shows, newest first, from the hub's `statuses` command, and opens the one
   * picked in the Markdown preview; each page's last pick loads the next.
   */
  async earlierStatuses(): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;
    const shown = this.#state.status;

    if (target === null || scope === null || scope.sessionId === null) {
      return;
    }

    const unmoved = (): boolean => {
      const now = this.#state.scope;

      return this.#target === target && now?.workItemId === scope.workItemId && now.sessionId === scope.sessionId && now.scopeGen === scope.scopeGen;
    };
    type StatusPick = vscode.QuickPickItem & { status?: StatusView; more?: string };
    const picks: StatusPick[] = [];
    let before = shown === null || shown.fallback ? null : shown.id;

    for (;;) {
      const reply = await postToHub(target.record, '/v1/conversation/statuses', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), sessionId: scope.sessionId, before }, HISTORY_TIMEOUT_MS);

      if (reply?.status !== 200) {
        void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
        return;
      }

      // The scope may have moved while the request ran.
      if (!unmoved()) {
        return;
      }

      const { statuses, more } = reply.body as { statuses: StatusView[]; more: boolean };

      picks.push(...statuses.map((status) => ({ label: statusLine(status.markdown) || 'Status', description: STATUS_TIME.format(status.at), status })));

      if (picks.length === 0) {
        void vscode.window.showInformationMessage('Switchboard: this session has no earlier statuses.');
        return;
      }

      const last = statuses.at(-1);
      const chosen = await vscode.window.showQuickPick<StatusPick>(more && last !== undefined ? [...picks, { label: '$(history) Older statuses…', more: last.id }] : picks, {
        title: 'Earlier statuses',
        placeHolder: 'Open a status in the Markdown preview',
        matchOnDescription: true,
      });

      // Or while the list was open: a status of a session the window no longer shows is not opened.
      if (!unmoved()) {
        return;
      }

      if (chosen?.status !== undefined) {
        await this.openStatus(chosen.status);
        return;
      }

      if (chosen?.more === undefined) {
        return;
      }

      before = chosen.more;
    }
  }

  /** Hands the texts of messages that were not sent to a visible page, keeping them when none took them; a call during a hand-off tries again after it. */
  #giveBack(): Promise<void> {
    if (this.#giving !== null) {
      this.#giveAgain = true;
      return this.#giving;
    }

    this.#giving = (async () => {
      do {
        this.#giveAgain = false;

        const views = [...this.#views.values()].filter((view) => view.visible);

        if (views.length === 0 || this.#returned.length === 0) {
          continue;
        }

        const returned = this.#returned;

        this.#returned = [];

        // postMessage answers false for a page that is not loaded.
        if (!(await Promise.all(views.map((view) => view.webview.postMessage({ type: 'unsent', returned })))).some(Boolean)) {
          this.#returned = [...returned, ...this.#returned];
        }
      } while (this.#giveAgain);
    })().finally(() => {
      this.#giving = null;
    });

    return this.#giving;
  }

  #post(message: unknown): void {
    for (const view of this.#views.values()) {
      void view.webview.postMessage(message);
    }
  }

  #set(state: ConversationState): void {
    this.#state = state;
    this.deps.changed?.(state);
    this.refresh();
    this.#showVoice();

    for (const view of this.#views.values()) {
      view.badge = unreadBadge(totalUnread(state));
    }
  }

  #stateMessage(): { type: 'state'; state: ConversationState; unopened: string[] } {
    return { type: 'state', state: this.#state, unopened: this.deps.unopened?.() ?? [] };
  }

  /** Draws the state again, as after the artifacts opened in the workspace changed. */
  refresh(): void {
    this.#post(this.#stateMessage());
  }

  /**
   * Tells the hub which unread items the page showed in a focused window for a second (architecture.md § Unread), for the scope generation and
   * session it showed them in; a refusal, as after the scope moved, leaves them unread.
   */
  async seen(ids: string[], shown: SeenTarget): Promise<void> {
    const target = this.#target;

    if (target === null) {
      this.#post({ type: 'seen-failed', ids });
      return;
    }

    if (ids.length === 0) {
      return;
    }

    const reply = await postToHub(target.record, '/v1/conversation/seen', { window: target.key, scopeGen: shown.scopeGen, opId: randomUUID(), sessionId: shown.sessionId, ids }, HISTORY_TIMEOUT_MS);

    if (reply?.status !== 200) {
      this.deps.log(`seen not recorded: ${reply?.error ?? 'the hub did not answer'}`);
      // The page reports them again; a refusal for a session the window no longer shows starts over with its next state anyway.
      this.#post({ type: 'seen-failed', ids });
    }
  }

  /** Draws the voice's status bar item from this window's voice state. */
  #showVoice(): void {
    const shown = voiceStatus(this.#state.voice);

    if (shown === null) {
      this.#voiceItem.hide();
      return;
    }

    this.#voiceItem.name = 'Switchboard Voice';
    this.#voiceItem.text = shown.text;
    this.#voiceItem.tooltip = shown.tooltip;
    this.#voiceItem.command = shown.command ?? undefined;
    this.#voiceItem.backgroundColor = shown.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.#voiceItem.show();
  }

  /** A voice command for this window (architecture.md § Voice); a refusal shows as a warning, except Stop speaking's, which has nothing to stop. */
  async #voiceCommand(name: 'talk-here' | 'stop-speaking' | 'speak-replies' | 'replay', extra: Record<string, unknown> = {}): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;

    if (target === null || scope === null) {
      void vscode.window.showWarningMessage('Switchboard: this window has no session for the voice.');
      return;
    }

    const reply = await postToHub(target.record, `/v1/conversation/${name}`, { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), ...extra }, HISTORY_TIMEOUT_MS);

    if (reply?.status !== 200 && name !== 'stop-speaking') {
      void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
    }
  }

  /**
   * Choose Persona… and the header's persona button (architecture.md § Personas): lists the roster from the hub's `personas`, and pins the one
   * picked to this window's selected conversation's session, or clears its pin.
   */
  async choosePersona(): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;
    const session = this.#state.session;

    if (target === null || scope === null || scope.sessionId === null || session === null) {
      void vscode.window.showWarningMessage('Switchboard: this window has no session to give a persona.');
      return;
    }

    const listed = await postToHub(target.record, '/v1/conversation/personas', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID() }, HISTORY_TIMEOUT_MS);

    if (listed?.status !== 200) {
      void vscode.window.showWarningMessage(`Switchboard: ${listed?.error ?? 'the hub did not answer.'}`);
      return;
    }

    const { personas } = listed.body as { personas: Array<{ id: string; name: string }> };

    if (personas.length === 0) {
      void vscode.window.showInformationMessage('Switchboard: no personas. Add them to voice.personas in settings.json, with voice.enabled on.');
      return;
    }

    type PersonaPick = vscode.QuickPickItem & { personaId: string | null };
    const current = session.persona;
    const picks: PersonaPick[] = [
      ...personas.map((persona) => ({ label: persona.name, description: current?.id === persona.id ? (current.pinned ? 'pinned' : 'current') : '', personaId: persona.id })),
      ...(current?.pinned === true ? [{ label: '$(pinned-dirty) Clear pin', description: "Use the playbook's persona or a free one", personaId: null }] : []),
    ];
    const chosen = await vscode.window.showQuickPick<PersonaPick>(picks, { title: 'Persona', placeHolder: 'Pin a persona to this session' });

    // The window may have moved to another session while the list was open.
    if (chosen === undefined || this.#target !== target || this.#state.scope?.sessionId !== scope.sessionId) {
      return;
    }

    const reply = await postToHub(target.record, '/v1/conversation/persona', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), sessionId: scope.sessionId, personaId: chosen.personaId }, HISTORY_TIMEOUT_MS);

    if (reply?.status !== 200) {
      void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
    }
  }

  /** Talk here: the voice moves to this window's selected conversation's session. */
  talkHere(): Promise<void> {
    return this.#voiceCommand('talk-here');
  }

  stopSpeaking(): Promise<void> {
    return this.#voiceCommand('stop-speaking');
  }

  /** Speak replies on or off; with no value, the opposite of what it is. */
  speakReplies(on = !(this.#state.voice?.speakReplies ?? true)): Promise<void> {
    return this.#voiceCommand('speak-replies', { on });
  }

  /** Speaks a reply's passage again, or the newest reply's that has one. */
  replay(replyId = lastSpokenReply(this.#state)?.id): Promise<void> {
    if (replyId === undefined) {
      void vscode.window.showInformationMessage('Switchboard: no reply here has a passage to speak.');
      return Promise.resolve();
    }

    return this.#voiceCommand('replay', { replyId });
  }

  /** Loads the items before the oldest the view shows. */
  async earlier(): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;
    const oldest = this.#state.items[0];

    if (target === null || scope === null || scope.sessionId === null) {
      return;
    }

    const reply = await postToHub(target.record, '/v1/conversation/history', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), sessionId: scope.sessionId, before: oldest?.id ?? null }, HISTORY_TIMEOUT_MS);

    if (reply?.status !== 200) {
      void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
      return;
    }

    // The scope may have moved while the request ran; a page for another session is dropped.
    if (this.#state.scope?.sessionId === scope.sessionId) {
      const { items, more } = reply.body as { items: ItemView[]; more: boolean };

      this.#set(withEarlier(this.#state, items, more));
    }
  }

  /**
   * Sends the composer's text to this window's current session (architecture.md § Typing a message). A command that got no answer is posted once
   * more with the same `opId`, which the hub answers with the message it already added. Resolves the refusal, or null once the hub took it.
   */
  async send(text: string, shown: SendTarget, command = false): Promise<string | null> {
    const target = this.#target;

    if (target === null) {
      return 'This window has no session to send to.';
    }

    // The session, launch and scope generation the page showed, so the hub refuses the message rather than send it elsewhere.
    const body = { window: target.key, scopeGen: shown.scopeGen, opId: randomUUID(), sessionId: shown.sessionId, launch: shown.launch, text, ...(command ? { command: true } : {}) };
    const reply = (await postToHub(target.record, '/v1/conversation/send', body, SEND_TIMEOUT_MS)) ?? (await postToHub(target.record, '/v1/conversation/send', body, SEND_TIMEOUT_MS));

    if (reply === null) {
      return 'The hub did not answer; the message may not have been sent.';
    }

    if (reply.status !== 200) {
      return reply.error ?? `The hub refused the message (${reply.status}).`;
    }

    // The stream brings the message too; shown now, so the composer never empties before its message appears, unless the stream already brought
    // it, maybe with a later delivery.
    const message = (reply.body as { message: ItemView }).message;
    const notSent = this.#notSentEarly.get(message.id);

    // The stream already said it was not sent: its text comes back as for one that ends later, so a page loaded meanwhile still gets it.
    if (notSent !== undefined) {
      this.#notSentEarly.delete(message.id);
      this.#returned.push({ text: message.type === 'message' ? message.text : '', error: notSent, workItemId: message.type === 'message' ? message.workItemId : null });
      void this.#giveBack();
      return null;
    }

    this.#mine.add(message.id);

    if (this.#state.scope?.sessionId === shown.sessionId && !this.#state.items.some((item) => item.id === message.id)) {
      this.receive({ type: 'message', message });
    }

    return null;
  }

  /** The folder the composer's mentions are relative to: the session's, or the window's first folder before the session has one. */
  #folder(): string | null {
    return this.#state.scope?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  /**
   * The composer's file picker (architecture.md § Conversation view): files under the session's folder whose path holds the query, without
   * case, and the folders above them, leaving out `files.exclude`, `search.exclude` and the folders Claude Code's panel leaves out.
   */
  async files(query: string): Promise<FileItem[]> {
    const folder = this.#folder();

    if (folder === null) {
      return [];
    }

    const exclude = excludeGlob(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude'), vscode.workspace.getConfiguration('search').get<Record<string, unknown>>('exclude'));
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(folder), fileGlob(query)), exclude, FILES_FOUND);
    const base = vscode.Uri.file(folder).path.replace(/\/$/, '');

    return rankFiles(
      found.map((uri) => (uri.path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? uri.path.slice(base.length + 1) : null)).filter((path): path is string => path !== null),
      query,
    );
  }

  /** The window's current session's slash commands from the hub's `commands`, or why there are none. */
  async commands(): Promise<{ commands: CommandItem[] | null; error: string | null }> {
    const target = this.#target;
    const scope = this.#state.scope;

    if (target === null || scope === null || scope.sessionId === null) {
      return { commands: null, error: 'This window has no session.' };
    }

    const reply = await postToHub(target.record, '/v1/conversation/commands', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), sessionId: scope.sessionId }, HISTORY_TIMEOUT_MS);

    return reply?.status === 200 ? { commands: (reply.body as { commands: CommandItem[] }).commands, error: null } : { commands: null, error: reply?.error ?? 'The hub did not answer.' };
  }

  /** Files picked in VS Code's open dialog, from the session's folder, for the composer to mention. */
  async attach(): Promise<string[]> {
    const folder = this.#folder();
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'Attach', title: 'Attach files', ...(folder === null ? {} : { defaultUri: vscode.Uri.file(folder) }) });

    return (picked ?? []).map((uri) => uri.fsPath);
  }

  /** Selects one of the window's conversations (architecture.md § Window scope); the stream then brings its scope and hello. */
  async select(workItemId: number): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;

    if (target === null || scope === null || scope.workItemId === workItemId) {
      return;
    }

    const reply = await postToHub(target.record, '/v1/conversation/select', { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID(), workItemId }, HISTORY_TIMEOUT_MS);

    if (reply?.status !== 200) {
      void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
    }
  }

  /**
   * Starts a new conversation hosted by this window (architecture.md § Hosted conversations), the view's plus button and Switchboard: New Session.
   * A command that got no answer is posted once more with the same `opId`, which the hub answers with the conversation it already made.
   */
  async newConversation(): Promise<void> {
    const target = this.#target;
    const scope = this.#state.scope;

    if (target === null || scope === null) {
      void vscode.window.showWarningMessage('Switchboard: this window has no Switchboard work item to start a session beside.');
      return;
    }

    const body = { window: target.key, scopeGen: scope.scopeGen, opId: randomUUID() };
    const reply = (await postToHub(target.record, '/v1/conversation/new-conversation', body, SEND_TIMEOUT_MS)) ?? (await postToHub(target.record, '/v1/conversation/new-conversation', body, SEND_TIMEOUT_MS));

    if (reply?.status !== 200) {
      void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
    }
  }

  /** Opens a reply's link: a web page in the browser, a file at its line in an editor; anything else is dropped. */
  async open(href: string): Promise<void> {
    const target = linkTarget(href, this.#state.scope?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null);

    if (target === null) {
      return;
    }

    if ('url' in target) {
      await vscode.env.openExternal(vscode.Uri.parse(target.url));
      return;
    }

    const at = target.line === null ? undefined : new vscode.Range(target.line - 1, 0, target.line - 1, 0);

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.file), at === undefined ? {} : { selection: at });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const nonce = randomBytes(16).toString('hex');
    const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; script-src 'nonce-${nonce}';`;
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();

    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}"><link rel="stylesheet" href="${uri('conversation.css')}">
</head><body><div id="root"></div><div id="composer"></div><div id="live" class="live" aria-live="polite"></div><script nonce="${nonce}" src="${uri('conversation.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage((message: ConversationMessage) => {
      const run = (): Promise<unknown> => {
        switch (message.type) {
          case 'ready':
            return Promise.resolve(view.webview.postMessage(this.#stateMessage()))
              .then(() => view.webview.postMessage({ type: 'focus', focused: vscode.window.state.focused }))
              .then(() => this.#giveBack());
          case 'seen':
            return this.seen(Array.isArray(message.ids) ? message.ids.map(String) : [], message.target);
          case 'earlier':
            return this.earlier();
          case 'open':
            return this.open(String(message.href));
          case 'terminal':
            return this.deps.openTerminal();
          case 'select':
            return this.select(Number(message.workItemId));
          case 'talk-here':
            return this.talkHere();
          case 'stop-speaking':
            return this.stopSpeaking();
          case 'speak-replies':
            return this.speakReplies(message.on === true);
          case 'replay':
            return this.replay(String(message.replyId));
          case 'new':
            return this.newConversation();
          case 'persona':
            return this.choosePersona();
          case 'status-open':
            return this.#state.status === null ? Promise.resolve() : this.openStatus(this.#state.status);
          case 'statuses':
            return this.earlierStatuses();
          case 'artifact':
            return this.deps.openArtifact(String(message.path));
          case 'copy':
            return Promise.resolve(vscode.env.clipboard.writeText(String(message.text))).then(
              () => view.webview.postMessage({ type: 'copied', id: message.id, ok: true }),
              () => view.webview.postMessage({ type: 'copied', id: message.id, ok: false }),
            );
          case 'send':
            return this.send(String(message.text), message.target, message.command === true).then((error) => view.webview.postMessage({ type: 'sent', id: message.id, error }));
          case 'files':
            return this.files(String(message.query)).then(
              (items) => view.webview.postMessage({ type: 'files', id: message.id, items }),
              () => view.webview.postMessage({ type: 'files', id: message.id, items: [] }),
            );
          case 'commands':
            return this.commands().then((answer) => view.webview.postMessage({ type: 'commands', id: message.id, ...answer }));
          case 'attach':
            return this.attach().then((paths) => (paths.length === 0 ? undefined : view.webview.postMessage({ type: 'mentions', paths })));
          case 'image': {
            let written: { path: string } | { error: string };

            try {
              written = writePastedImage(String(message.mime), String(message.data), Date.now());
            } catch (error) {
              written = { error: `The pasted image could not be saved: ${error instanceof Error ? error.message : String(error)}` };
            }

            return Promise.resolve(view.webview.postMessage({ type: 'image', id: message.id, path: 'path' in written ? written.path : null, error: 'error' in written ? written.error : null }));
          }
          default:
            return Promise.resolve();
        }
      };

      void run().catch((error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${error instanceof Error ? error.message : String(error)}`));
    });
    view.onDidDispose(() => this.#views.delete(view.viewType));
    view.badge = unreadBadge(totalUnread(this.#state));
    this.#views.set(view.viewType, view);
  }
}
