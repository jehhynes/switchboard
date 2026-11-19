import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { openConversation, postToHub } from '@switchboard/hub';
import type { EventStream, ItemView } from '@switchboard/hub';
import { applyEvent, EMPTY_CONVERSATION, withEarlier } from './conversationModel.js';
import type { ConversationEvent, ConversationState } from './conversationModel.js';
import type { ConversationMessage } from './webview/conversationRender.js';
import { linkTarget, supportsSecondarySidebar } from './links.js';

/**
 * The Conversation view's two contributions (architecture.md § Conversation view): in the secondary side bar, as Claude Code's own panel, and
 * in an activity bar container for a VS Code without one, chosen by the `switchboard.noSecondarySidebar` context key.
 */
export const CONVERSATION_VIEWS = ['switchboard.conversation', 'switchboard.conversationActivity'] as const;
export const NO_SECONDARY_SIDEBAR = 'switchboard.noSecondarySidebar';

export interface ConversationViewDeps {
  /** Opens this window's session in its attach terminal, as the pane's Open in terminal does. */
  openTerminal(): Promise<unknown>;
  log(line: string): void;
}

/** How long a stream that ended waits before it opens again. */
const RECONNECT_MS = 1_000;
const HISTORY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

/**
 * The Conversation view (architecture.md § Conversation view): follows this window's conversation stream, keeps its state and draws it in a
 * webview view. The view is not retained when hidden; its page asks for the state again when it loads.
 */
export class ConversationView implements vscode.WebviewViewProvider {
  #state: ConversationState = EMPTY_CONVERSATION;
  readonly #views = new Map<string, vscode.WebviewView>();
  #stream: EventStream | null = null;
  #target: { record: HubRecord; key: string } | null = null;
  #retry: NodeJS.Timeout | undefined;
  /** Attempts since the stream last opened; a refused key and a failed connection look alike, so a few retries cover both. */
  #attempts = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ConversationViewDeps,
  ) {}

  register(): vscode.Disposable {
    void vscode.commands.executeCommand('setContext', NO_SECONDARY_SIDEBAR, !supportsSecondarySidebar(vscode.version));

    return vscode.Disposable.from(...CONVERSATION_VIEWS.map((id) => vscode.window.registerWebviewViewProvider(id, this)), { dispose: () => this.disconnect() });
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

  /** Applies a stream event and redraws. */
  receive(event: ConversationEvent): void {
    this.#set(applyEvent(this.#state, event));
  }

  #set(state: ConversationState): void {
    this.#state = state;

    for (const view of this.#views.values()) {
      void view.webview.postMessage({ type: 'state', state });
    }
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
</head><body><div id="root"></div><div id="live" class="live" aria-live="polite"></div><script nonce="${nonce}" src="${uri('conversation.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage((message: ConversationMessage) => {
      const run = (): Promise<unknown> => {
        switch (message.type) {
          case 'ready':
            return Promise.resolve(view.webview.postMessage({ type: 'state', state: this.#state }));
          case 'earlier':
            return this.earlier();
          case 'open':
            return this.open(String(message.href));
          case 'terminal':
            return this.deps.openTerminal();
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
