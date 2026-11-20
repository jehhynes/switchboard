import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { openConversation, postToHub } from '@switchboard/hub';
import type { EventStream, ItemView, StatusView } from '@switchboard/hub';
import { applyEvent, EMPTY_CONVERSATION, statusLine, withEarlier } from './conversationModel.js';
import type { ConversationEvent, ConversationState } from './conversationModel.js';
import type { ConversationMessage, SendTarget } from './webview/conversationRender.js';
import { linkTarget, previewLinks, supportsSecondarySidebar } from './links.js';

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
  /** Hears each new state, as the Artifacts view does. */
  changed?(state: ConversationState): void;
  log(line: string): void;
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
  /** Texts of messages that were not sent, kept until a loaded page took them, since a hidden view's page is not kept. */
  #returned: Array<{ text: string; error: string }> = [];
  #giving: Promise<void> | null = null;
  #giveAgain = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ConversationViewDeps,
  ) {}

  register(): vscode.Disposable {
    void vscode.commands.executeCommand('setContext', NO_SECONDARY_SIDEBAR, !supportsSecondarySidebar(vscode.version));

    return vscode.Disposable.from(
      ...CONVERSATION_VIEWS.map((id) => vscode.window.registerWebviewViewProvider(id, this)),
      vscode.workspace.registerTextDocumentContentProvider(STATUS_SCHEME, this),
      this.#statusChanged,
      { dispose: () => this.disconnect() },
    );
  }

  /** What the view shows now, for the integration suite. */
  state(): ConversationState {
    return this.#state;
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

      if (this.#mine.delete(message.id)) {
        this.#returned.push({ text: message.text, error });
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

  /** Opens a status in the Markdown preview: the one the status row shows, or one the earlier statuses list gave. */
  async openStatus(status: StatusView): Promise<void> {
    this.#keep(status);
    await vscode.commands.executeCommand('markdown.showPreview', statusUri(status));
  }

  /**
   * Lists the current session's statuses before the one the status row shows, newest first, from the hub's `statuses` command, and opens the one
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
    this.#post({ type: 'state', state });
    this.deps.changed?.(state);
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
  async send(text: string, shown: SendTarget): Promise<string | null> {
    const target = this.#target;

    if (target === null) {
      return 'This window has no session to send to.';
    }

    // The session, launch and scope generation the page showed, so the hub refuses the message rather than send it elsewhere.
    const body = { window: target.key, scopeGen: shown.scopeGen, opId: randomUUID(), sessionId: shown.sessionId, launch: shown.launch, text };
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
      this.#returned.push({ text: message.type === 'message' ? message.text : '', error: notSent });
      void this.#giveBack();
      return null;
    }

    this.#mine.add(message.id);

    if (this.#state.scope?.sessionId === shown.sessionId && !this.#state.items.some((item) => item.id === message.id)) {
      this.receive({ type: 'message', message });
    }

    return null;
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
            return Promise.resolve(view.webview.postMessage({ type: 'state', state: this.#state })).then(() => this.#giveBack());
          case 'earlier':
            return this.earlier();
          case 'open':
            return this.open(String(message.href));
          case 'terminal':
            return this.deps.openTerminal();
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
            return this.send(String(message.text), message.target).then((error) => view.webview.postMessage({ type: 'sent', id: message.id, error }));
          default:
            return Promise.resolve();
        }
      };

      void run().catch((error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${error instanceof Error ? error.message : String(error)}`));
    });
    view.onDidDispose(() => this.#views.delete(view.viewType));
    this.#views.set(view.viewType, view);
  }
}
