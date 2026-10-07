import * as vscode from 'vscode';
import type { HubRecord, TicketHistory } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';
import { historyMarkdown } from './history.js';

const HISTORY_SCHEME = 'switchboard-history';
const TIMEOUT_MS = 10_000;

/** A row's History message: the ticket, and its key, such as `gh 18941`, for the tab. */
export interface HistoryMessage {
  ticketId: number;
  key: string;
}

/** The ticket's history from the hub, or the error to show. */
async function readHistory(record: HubRecord | null, ticketId: number): Promise<{ text: string } | { error: string }> {
  const reply = record === null ? null : await postToHub(record, '/history', { ticketId }, TIMEOUT_MS);

  if (reply === null) {
    return { error: 'the hub did not answer.' };
  }

  return reply.status === 200 ? { text: historyMarkdown(reply.body as TicketHistory, Date.now()) } : { error: reply.error ?? `the hub answered ${reply.status}.` };
}

/**
 * Read-only History documents (PRD R59), one per ticket at `switchboard-history:/<key> History.md?<ticketId>`. Opening one again
 * reads the hub again; a document VS Code restores after a reload reads it on first show, and again when the window connects if that read failed.
 */
export class HistoryDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly failed = new Set<string>();
  /** The hub whose stream last said hello; used while the keeper has no current hub. */
  private greeted: HubRecord | null = null;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly hub: () => HubRecord | null) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, this), this.changed);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cached = this.texts.get(uri.toString());

    if (cached !== undefined) {
      return cached;
    }

    const read = await readHistory(this.hub() ?? this.greeted, Number(uri.query));

    if ('error' in read) {
      this.failed.add(uri.toString());
      return `Switchboard: ${read.error}\n`;
    }

    return read.text;
  }

  /**
   * Reads again every document whose read failed, such as a tab restored before the window reached the hub. Runs on the stream's
   * `hello`, which arrives before the keeper names the hub as current, so the read uses the hub that sent it.
   */
  retryFailed(record: HubRecord): void {
    this.greeted = record;

    const uris = [...this.failed];

    this.failed.clear();

    for (const uri of uris) {
      this.changed.fire(vscode.Uri.parse(uri));
    }
  }

  /** Opens the ticket's History, or shows why it cannot. */
  async open(message: HistoryMessage): Promise<vscode.TextEditor | null> {
    const read = await readHistory(this.hub(), message.ticketId);

    if ('error' in read) {
      void vscode.window.showWarningMessage(`Switchboard: ${read.error}`);
      return null;
    }

    const uri = vscode.Uri.from({ scheme: HISTORY_SCHEME, path: `/${message.key} History.md`, query: String(message.ticketId) });

    this.texts.set(uri.toString(), read.text);
    this.failed.delete(uri.toString());
    this.changed.fire(uri);

    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
}
