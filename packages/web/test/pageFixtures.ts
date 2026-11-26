import type { ArtifactView, MessageView, PageGroup, PageRow, ReplyView, SessionView } from '@switchboard/protocol';

export const message = (id: string, ord: number, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at: 1_000 + ord, ord, provisional: false, withdrawn: false, origin: 'typed', text: `text ${id}`, delivery: 'sent', error: null, ...patch });
export const reply = (id: string, ord: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's', at: 1_000 + ord, ord, provisional: false, kind: 'reply', answers: null, opening: `reply ${id}`, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
export const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, ...patch });
export const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
export const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, ticketId: null, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
export const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
export const artifact = (path: string, type: ArtifactView['type'], ext: string): ArtifactView => ({ path, owner: 'chat', kind: 'page', title: path, ext, type, updatedAt: 1_500 });
/** Sets the page's width and tells the page, as a window resize does. */
export const resizeTo = (width: number): void => {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
};

export class FakeSource {
  static last: FakeSource | null = null;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ type, ...(data as object) }) });
    }
  }

  close(): void {
    this.closed = true;
  }
}
