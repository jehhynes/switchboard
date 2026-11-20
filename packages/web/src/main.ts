import { applyEvent, commandQuery, EMPTY, mentionOf, mentionQuery, selectedEntry, sentTexts, shortTitle, withEarlier } from './model.js';
import type { PageState } from './model.js';
import { escape, renderMarkdown } from './markdown.js';
import { answerText, artifactUrl, complete, markdownBody, newView, parseQuestions, renderArtifacts, renderArtifactView, renderHeader, renderList, renderStatus, renderTabs, renderTimeline, renderVoice, TABS } from './render.js';
import type { CardDraft, Tab, View } from './render.js';
import type { ItemView } from './types.js';

/** The stream's event types the page reads. */
export const EVENTS = ['hello', 'list', 'scope', 'conversations', 'session', 'message', 'reply', 'status', 'artifact', 'unread', 'voice', 'settings', 'progress', 'words', 'draft'];
/** How long an unread reply or status must be visible on a focused page before it counts as seen (architecture.md § Unread). */
export const SEEN_MS = 1_000;
const SEEN_CHECK_MS = 250;
const COMPOSER_MAX_PX = 200;
/** Where the page keeps each work item's draft, over a reload. */
const DRAFTS = 'switchboard.drafts';

export interface PageDeps {
  fetch: typeof fetch;
  EventSource: new (url: string) => EventSource;
  now(): number;
  /** Loads Mermaid's script on first use; resolves false when the hub has none. */
  loadMermaid?(): Promise<boolean>;
}

type Answer = { status: number; body: Record<string, unknown> };

/**
 * The web page (architecture.md § Web page): the list of work items on the left; the selected one's conversation, status and artifacts tabs and
 * the composer on the right. Everything it shows comes from its own conversation stream, bound to the work item it selected.
 */
export function startPage(root: HTMLElement, deps: PageDeps): { state(): PageState; close(): void } {
  root.innerHTML =
    '<aside class="side"><div class="side-head">Switchboard</div><div id="list"></div></aside>' +
    '<main class="main"><div id="head"></div><div id="panel" class="scroll"></div><div id="composer" hidden></div></main><div class="live" aria-live="polite"></div>';

  const list = root.querySelector<HTMLElement>('#list')!;
  const head = root.querySelector<HTMLElement>('#head')!;
  const panel = root.querySelector<HTMLElement>('#panel')!;
  const composerHost = root.querySelector<HTMLElement>('#composer')!;
  let state: PageState = EMPTY;
  const view: View = newView();
  let wanted: number | null = Number(/^#w=(\d+)$/.exec(location.hash)?.[1] ?? NaN) || null;
  let expired = false;
  let opId = 0;
  const newOp = (): string => `${deps.now().toString(36)}-${(++opId).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const post = async (name: string, body: Record<string, unknown>): Promise<Answer> => {
    try {
      const response = await deps.fetch(`/v1/conversation/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window: state.key, opId: newOp(), ...body }) });

      expired ||= response.status === 401;
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (error) {
      return { status: 0, body: { error: `Switchboard did not answer: ${String(error)}` } };
    }
  };
  /** A command for the conversation the page shows, refused by the hub when the page has moved on since. */
  const command = (name: string, body: Record<string, unknown> = {}): Promise<Answer> => post(name, { scopeGen: state.scope?.scopeGen ?? -1, ...body });

  // ---- The composer ----
  composerHost.innerHTML =
    '<div class="composer-error" role="alert" hidden><span class="composer-error-text"></span><button class="dismiss" type="button" aria-label="Dismiss"><span class="codicon codicon-close"></span></button></div>' +
    '<div class="composer"><div class="composer-menu" role="listbox" hidden></div><div class="composer-input"><div class="live-mirror"><span class="mirror-text" aria-hidden="true"></span><span class="live-words" aria-live="polite" hidden></span></div><textarea rows="1" aria-label="Message"></textarea></div><div class="composer-footer"><div class="composer-controls">' +
    '<button class="composer-tool slash" type="button" title="Show slash commands (/)" aria-label="Show slash commands"><span class="slash-glyph">/</span></button><div class="voice-controls"></div></div>' +
    // The microphone's place, for dictation in a later slice.
    '<span class="composer-mic" hidden></span><button class="send" type="button" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up"></span></button></div></div>';

  const input = composerHost.querySelector('textarea')!;
  const send = composerHost.querySelector<HTMLButtonElement>('button.send')!;
  const errorBox = composerHost.querySelector<HTMLElement>('.composer-error')!;
  const menu = composerHost.querySelector<HTMLElement>('.composer-menu')!;
  const voiceControls = composerHost.querySelector<HTMLElement>('.voice-controls')!;
  const liveWords = composerHost.querySelector<HTMLElement>('.live-words')!;
  const mirror = composerHost.querySelector<HTMLElement>('.live-mirror')!;
  const mirrorText = composerHost.querySelector<HTMLElement>('.mirror-text')!;
  // The draft the hub last sent for dictation, per session, so a newer one replaces it in the box but never text typed over it, and one that came
  // while a message was being sent, which fills the box once the send answered.
  const hubDrafts = new Map<string, string>();
  let heldDraft: { sessionId: string; text: string } | null = null;
  const takeHubDraft = (sessionId: string, text: string): void => {
    const before = hubDrafts.get(sessionId) ?? '';

    hubDrafts.set(sessionId, text);

    if (sessionId !== state.session?.id) {
      return;
    }

    if (sending) {
      heldDraft = { sessionId, text };
      return;
    }

    if (input.value === '' || input.value === before) {
      input.value = text;
      keepDraft();
      grow();
      refresh();
    }
  };
  let sending = false;
  let draftOf: number | null = null;
  let chosen: string | null = null;
  let walk: { index: number; draft: string } | null = null;
  // Why a message of another work item was not sent, shown when the composer shows that work item again.
  const errors = new Map<number, string>();
  // The messages this page sent, by ID, and not-sent events whose send had not answered yet, so a late refusal finds its text.
  const mine = new Set<string>();
  const unsent = new Map<string, { text: string; error: string; workItemId: number | null }>();
  // Returns that arrived while the composer was sending, put back once it answered.
  const held: Array<{ text: string; error: string; workItemId: number | null }> = [];
  let menuOpen: { kind: 'files'; start: number; items: Array<{ path: string; dir: boolean }> } | { kind: 'commands'; items: Array<{ name: string; description: string }> } | null = null;
  let active = 0;
  let asked = 0;

  const drafts = (): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  const keepDraft = (): void => {
    if (draftOf === null || sending) {
      return;
    }

    const all = drafts();

    if (input.value === '') {
      delete all[draftOf];
    } else {
      all[draftOf] = input.value;
    }

    localStorage.setItem(DRAFTS, JSON.stringify(all));
  };
  const showError = (text: string | null): void => {
    errorBox.querySelector('.composer-error-text')!.textContent = text ?? '';
    errorBox.hidden = text === null;
  };
  /** Live words show dimmed right after the box's text, on its line, from a copy of the text laid out under the box (architecture.md § Web page). */
  const syncLive = (): void => {
    const shown = !liveWords.hidden;

    mirrorText.textContent = shown ? input.value : '';
    liveWords.dataset['lead'] = shown && input.value !== '' && !/\s$/.test(input.value) ? ' ' : '';
    composerHost.classList.toggle('live-showing', shown);
  };
  const grow = (): void => {
    syncLive();
    input.style.paddingBottom = '';
    input.style.height = 'auto';

    // Live words that wrap past the text add their height below it, so the box's scroll range and the copy's match at any height.
    const extra = liveWords.hidden ? 0 : Math.max(0, mirror.scrollHeight - input.scrollHeight);

    if (extra > 0) {
      input.style.paddingBottom = `${10 + extra}px`;
    }

    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_PX)}px`;
    mirror.scrollTop = input.scrollTop;
  };
  /** New live words scroll into view at the end of the box. */
  const showLive = (): void => {
    grow();

    if (!liveWords.hidden) {
      input.scrollTop = input.scrollHeight;
      mirror.scrollTop = input.scrollTop;
    }
  };
  const canSend = (): boolean => state.connected && state.session?.conversation === 'full' && !sending && input.value.trim() !== '';
  const refresh = (): void => {
    send.disabled = !canSend();
  };
  const closeMenu = (): void => {
    menuOpen = null;
    menu.hidden = true;
    menu.replaceChildren();
  };
  const drawMenu = (): void => {
    if (menuOpen === null) {
      closeMenu();
      return;
    }

    menu.innerHTML =
      menuOpen.items.length === 0
        ? `<div class="menu-empty">${menuOpen.kind === 'files' ? 'No matching files' : 'No matching commands'}</div>`
        : menuOpen.kind === 'files'
          ? menuOpen.items.map((item, index) => `<div class="menu-item${index === active ? ' active' : ''}" role="option" data-index="${index}"><span class="codicon codicon-${item.dir ? 'folder' : 'file'}"></span><span class="menu-name">${escape(item.path)}</span></div>`).join('')
          : menuOpen.items.map((item, index) => `<div class="menu-item command${index === active ? ' active' : ''}" role="option" data-index="${index}"><span class="menu-label">/${escape(item.name)}</span>${item.description === '' ? '' : `<span class="menu-description">${escape(item.description)}</span>`}</div>`).join('');
    menu.hidden = false;
  };
  /** The `@` picker and the `/` list follow the text before the caret. */
  const follow = async (): Promise<void> => {
    const before = input.value.slice(0, input.selectionStart);
    const mention = mentionQuery(before);
    const slash = commandQuery(before);
    const ask = ++asked;
    const shown = state.scope?.scopeGen;
    const current = (): boolean => ask === asked && shown === state.scope?.scopeGen;

    if (mention !== null && state.key !== null) {
      const response = await deps.fetch(`/v1/conversation/files?window=${encodeURIComponent(state.key)}&q=${encodeURIComponent(mention.query)}`, { credentials: 'same-origin' }).catch(() => null);
      const files = response?.ok === true ? (((await response.json()) as { files?: Array<{ path: string; dir: boolean }> }).files ?? []) : [];

      if (current()) {
        menuOpen = { kind: 'files', start: mention.start, items: files };
        active = 0;
        drawMenu();
      }
    } else if (slash !== null && state.session !== null) {
      const answer = await command('commands', { sessionId: state.session.id });
      const commands = ((answer.body['commands'] as Array<{ name: string; description: string }> | undefined) ?? []).filter((one) => one.name.toLowerCase().includes(slash.toLowerCase()));

      if (current()) {
        menuOpen = { kind: 'commands', items: commands.sort((a, b) => Number(!a.name.toLowerCase().startsWith(slash.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(slash.toLowerCase()))) };
        active = 0;
        drawMenu();
      }
    } else {
      closeMenu();
    }
  };
  const choose = (index: number): void => {
    const open = menuOpen;

    if (open === null || open.items[index] === undefined) {
      return;
    }

    if (open.kind === 'files') {
      const mention = mentionOf(open.items[index].path);

      if (mention !== null) {
        input.setRangeText(`${mention} `, open.start, input.selectionEnd, 'end');
      }
    } else {
      chosen = `/${open.items[index].name}`;
      input.value = `${chosen} `;
      input.setSelectionRange(input.value.length, input.value.length);
    }

    closeMenu();
    input.focus();
    grow();
    refresh();
    keepDraft();
  };
  const submit = async (): Promise<void> => {
    if (!canSend() || state.scope === null || state.session === null) {
      return;
    }

    const text = input.value;
    const asCommand = chosen !== null && (text.trim() === chosen || text.startsWith(`${chosen} `)) && !text.trim().includes('\n');
    const target = { sessionId: state.session.id, launch: state.session.launch };
    const from = draftOf;

    sending = true;
    input.readOnly = true;
    composerHost.classList.add('sending');
    refresh();

    const answer = await command('send', { ...target, text, ...(asCommand ? { command: true } : {}) });

    sending = false;
    const dictated = heldDraft;

    heldDraft = null;
    input.readOnly = false;
    composerHost.classList.remove('sending');

    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    if (answer.status === 200 && late === undefined) {
      if (id !== null) {
        mine.add(id);
      }

      if (from === draftOf) {
        input.value = dictated !== null && dictated.sessionId === target.sessionId ? dictated.text : '';
        chosen = null;
        showError(null);
      }

      const all = drafts();

      if (from !== null) {
        delete all[from];
        localStorage.setItem(DRAFTS, JSON.stringify(all));
      }

      keepDraft();
    } else if (late !== undefined) {
      // Refused before its send answered: the text stays where it was typed, with why.
      unsent.delete(id!);

      if (from === draftOf) {
        showError(late.error);
      } else {
        giveBack(from, text, late.error);
      }
    } else if (from === draftOf) {
      showError(String(answer.body['error'] ?? `Not sent (status ${answer.status}).`));
    } else {
      giveBack(from, '', String(answer.body['error'] ?? `Not sent (status ${answer.status}).`));
    }

    for (const one of held.splice(0)) {
      giveBack(one.workItemId, one.text, one.error);
    }

    walk = null;
    grow();
    refresh();
  };
  /** Puts a message's text that was not sent back in its own work item's draft, below what is there, with why. */
  const giveBack = (workItemId: number | null, text: string, error: string): void => {
    const below = (draft: string): string => (text === '' ? draft : draft.trim() === '' ? text : `${draft.replace(/\n+$/, '')}\n\n${text}`);

    if (workItemId === null || workItemId === draftOf) {
      if (sending) {
        held.push({ text, error, workItemId });
        return;
      }

      input.value = below(input.value);
      showError(error);
      keepDraft();
      grow();
      refresh();
      return;
    }

    const all = drafts();
    const draft = below(all[workItemId] ?? '');

    if (draft !== '') {
      all[workItemId] = draft;
    }

    localStorage.setItem(DRAFTS, JSON.stringify(all));
    errors.set(workItemId, error);
  };

  input.addEventListener('scroll', () => void (mirror.scrollTop = input.scrollTop));
  input.addEventListener('input', () => {
    walk = null;
    grow();
    refresh();
    keepDraft();
    void follow();
  });
  input.addEventListener('keydown', (event) => {
    if (menuOpen !== null && menuOpen.items.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      active = (active + (event.key === 'ArrowDown' ? 1 : menuOpen.items.length - 1)) % menuOpen.items.length;
      drawMenu();
      event.preventDefault();
      return;
    }

    if (menuOpen !== null && (event.key === 'Enter' || event.key === 'Tab') && menuOpen.items.length > 0) {
      choose(active);
      event.preventDefault();
      return;
    }

    if (event.key === 'Escape') {
      if (menuOpen !== null) {
        closeMenu();
      } else if (state.voice?.here === true && state.voice.speaking !== null) {
        void command('stop-speaking');
      }

      return;
    }

    // Up and Down at the box's first and last lines walk the session's earlier messages, and give the draft back after the newest.
    if ((event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) || (event.key === 'ArrowDown' && walk !== null && !input.value.slice(input.selectionEnd).includes('\n'))) {
      const texts = sentTexts(state.items);
      const index = walk === null ? texts.length - 1 : walk.index + (event.key === 'ArrowUp' ? -1 : 1);

      if (event.key === 'ArrowUp' && (texts.length === 0 || index < 0)) {
        return;
      }

      walk ??= { index, draft: input.value };

      if (index >= texts.length) {
        input.value = walk.draft;
        walk = null;
      } else {
        walk.index = index;
        input.value = texts[index]!;
      }

      event.preventDefault();
      grow();
      refresh();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  menu.addEventListener('mousedown', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');

    if (row !== null) {
      event.preventDefault();
      choose(Number(row.dataset['index']));
    }
  });
  send.addEventListener('click', () => void submit());
  errorBox.querySelector('button.dismiss')!.addEventListener('click', () => showError(null));
  composerHost.querySelector('button.slash')!.addEventListener('click', () => {
    if (input.value === '' && !input.disabled) {
      input.value = '/';
      input.focus();
      input.setSelectionRange(1, 1);
      void follow();
    }
  });
  voiceControls.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-voice]');
    const which = button?.dataset['voice'];

    if (which === 'speak-replies') {
      void command('speak-replies', { on: button!.getAttribute('aria-pressed') !== 'true' });
    } else if (which === 'stop') {
      void command('stop-speaking');
    } else if (which === 'talk-here') {
      void command('talk-here').then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? 'The voice did not move here.')));
    }
  });

  /** The composer follows the selected work item: its own draft, enabled only for a session it can talk to. */
  const updateComposer = (): void => {
    const id = state.scope?.workItemId ?? null;

    if (id !== draftOf) {
      draftOf = id;
      // Live words belong to the conversation they were heard for; its clearing event may never reach this one.
      liveWords.textContent = '';
      liveWords.hidden = true;
      input.value = id === null ? '' : (drafts()[id] ?? '');
      chosen = null;
      walk = null;
      showError(id === null ? null : (errors.get(id) ?? null));
      closeMenu();

      if (id !== null) {
        errors.delete(id);
      }
    }

    const full = state.connected && state.session?.conversation === 'full';

    composerHost.hidden = state.scope === null || view.tab !== 'conversation';
    input.disabled = !full;
    input.placeholder = full ? `Message ${shortTitle(selectedEntry(state)?.title ?? state.scope?.title ?? '')}…` : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : 'Connecting to Switchboard…'));
    voiceControls.innerHTML = renderVoice(state.voice);
    grow();
    refresh();
  };

  // ---- Drawing ----
  let mermaidRun: Promise<boolean> | null = null;
  const drawDiagrams = (within: HTMLElement): void => {
    const diagrams = within.querySelectorAll<HTMLElement>('pre.mermaid');

    if (diagrams.length === 0 || deps.loadMermaid === undefined) {
      return;
    }

    mermaidRun ??= deps.loadMermaid();
    void mermaidRun.then((loaded) => {
      const mermaid = (globalThis as { mermaid?: { run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void> } }).mermaid;

      if (loaded && mermaid !== undefined) {
        void mermaid.run({ nodes: diagrams }).catch(() => undefined);
      }
    });
  };
  /** Draws an open Markdown artifact: its text fetched by the page key, its relative pictures from its folder, Mermaid included. */
  const fillArtifact = async (path: string): Promise<void> => {
    const doc = panel.querySelector<HTMLElement>('.artifact-doc');

    if (doc === null || state.key === null) {
      return;
    }

    const key = state.key;
    const response = await deps.fetch(artifactUrl(key, path), { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    const text = response?.ok === true ? await response.text() : null;
    const folder = path.split('/').slice(0, -1);
    const base = (src: string): string | null => {
      const parts = [...folder];

      for (const part of src.split(/[?#]/)[0]!.split('/')) {
        if (part === '..') {
          return null;
        }

        if (part !== '.' && part !== '') {
          parts.push(part);
        }
      }

      return parts.length < 2 ? null : artifactUrl(key, parts.join('/'));
    };

    if (view.artifact === path && panel.contains(doc)) {
      doc.innerHTML = text === null ? '<p class="empty">This artifact could not be read.</p>' : renderMarkdown(markdownBody(text), base);
      drawDiagrams(doc);
    }
  };

  const draw = (): void => {
    list.innerHTML = expired ? '<p class="empty">This page\'s link is no longer valid. Open a new one with Switchboard: Open Web Page in VS Code, or hub.js web.</p>' : renderList(state.groups, state.scope?.workItemId ?? null);

    if (state.scope === null) {
      head.innerHTML = '';
      panel.innerHTML = `<p class="empty">${state.connected ? 'Choose a work item on the left.' : 'Connecting to Switchboard…'}</p>`;
      updateComposer();
      return;
    }

    const atEnd = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
    const scroll = panel.scrollTop;

    head.innerHTML = renderHeader(state, view) + renderTabs(view, state);

    const artifact = view.artifact === null ? undefined : state.artifacts.find((one) => one.path === view.artifact);
    const now = deps.now();

    if (view.tab === 'artifacts' && artifact !== undefined && state.key !== null) {
      // An open artifact stays as it is while other things change, so a frame or a playing video is not reloaded.
      if (panel.querySelector<HTMLElement>('.artifact-view')?.dataset['artifact'] !== artifact.path) {
        panel.innerHTML = renderArtifactView(state.key, artifact);
        void fillArtifact(artifact.path);
      }
    } else {
      panel.innerHTML = view.tab === 'status' ? renderStatus(state, view, now) : view.tab === 'artifacts' ? renderArtifacts(state, now) : renderTimeline(state, view);
      drawDiagrams(panel);
      panel.scrollTop = view.tab === 'conversation' && atEnd ? panel.scrollHeight : scroll;
    }

    panel.classList.toggle('framed', view.tab === 'artifacts' && artifact !== undefined);
    updateComposer();
    checkSeen();
  };

  // ---- Seen ----
  const visibleSince = new Map<string, number>();
  const reported = new Set<string>();
  let seenFor: string | null = null;
  const focusedVisible = (): boolean => document.visibilityState !== 'hidden' && document.hasFocus();
  const checkSeen = (): void => {
    const key = state.scope === null || state.session === null ? null : `${state.scope.scopeGen} ${state.session.id}`;

    if (key !== seenFor) {
      seenFor = key;
      reported.clear();
      visibleSince.clear();
    }

    if (key === null || !focusedVisible()) {
      visibleSince.clear();
      return;
    }

    const box = panel.getBoundingClientRect();
    const visible = [...panel.querySelectorAll<HTMLElement>('[data-unread]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const shown = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);

        return box.height === 0 || (shown > 0 && shown >= Math.min(rect.height, box.height) / 2);
      })
      .map((element) => element.dataset['unread']!)
      .filter((id) => !reported.has(id));
    const now = deps.now();

    for (const id of [...visibleSince.keys()].filter((id) => !visible.includes(id))) {
      visibleSince.delete(id);
    }

    const due: string[] = [];

    for (const id of visible) {
      const since = visibleSince.get(id) ?? now;

      visibleSince.set(id, since);

      if (now - since >= SEEN_MS) {
        due.push(id);
      }
    }

    if (due.length > 0 && state.session !== null) {
      for (const id of due) {
        reported.add(id);
        visibleSince.delete(id);
      }

      void command('seen', { sessionId: state.session.id, ids: due }).then((answer) => {
        if (answer.status !== 200) {
          for (const id of due) {
            reported.delete(id);
          }
        }
      });
    }
  };
  const seenTimer = setInterval(checkSeen, SEEN_CHECK_MS);

  // ---- Focus: a focused, visible page counts as a focused window for the voice ----
  let focusSent: boolean | null = null;
  const reportFocus = (force = false): void => {
    const focused = focusedVisible();

    if (state.key !== null && (force || focused !== focusSent)) {
      focusSent = focused;
      void post('page-focus', { focused });
    }

    checkSeen();
  };

  window.addEventListener('focus', () => reportFocus());
  window.addEventListener('blur', () => reportFocus());
  document.addEventListener('visibilitychange', () => reportFocus());

  // ---- Selecting ----
  const select = async (workItemId: number): Promise<void> => {
    wanted = workItemId;
    view.picker = false;
    view.artifact = null;
    history.replaceState(null, '', `#w=${workItemId}`);

    if (state.scope?.workItemId === workItemId && !selectInFlight) {
      acked = workItemId;
      draw();
      return;
    }

    reconcile();
  };
  // One select at a time; the latest work item asked for wins, whatever order the answers and scope events come in.
  let selectInFlight = false;
  let acked: number | null = null;
  const reconcile = (): void => {
    if (wanted === null || selectInFlight || state.key === null || acked === wanted) {
      return;
    }

    const asked = wanted;
    const key = state.key;

    selectInFlight = true;
    void post('select', { workItemId: asked }).then((answer) => {
      selectInFlight = false;

      if (key !== state.key) {
        return;
      }

      if (answer.status === 200) {
        acked = asked;
      } else if (wanted === asked) {
        showError(String(answer.body['error'] ?? 'The work item could not be opened.'));
        wanted = state.scope?.workItemId ?? null;
        acked = wanted;
        history.replaceState(null, '', wanted === null ? '#' : `#w=${wanted}`);
      }

      reconcile();
    });
  };

  // ---- Cards ----
  const cardQuestions = (key: string): ReturnType<typeof parseQuestions> => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const markdown = kind === 'status' ? (state.status?.id === id ? state.status.markdown : '') : (state.items.find((item): item is Extract<ItemView, { type: 'reply' }> => item.id === id && item.type === 'reply')?.opening ?? '');

    return markdown === '' ? [] : parseQuestions(markdown);
  };
  const cardDraft = (key: string): CardDraft => {
    let draft = view.cards.get(key);

    if (draft === undefined) {
      draft = { choices: new Map(), sent: null, sending: false, error: null };
      view.cards.set(key, draft);
    }

    return draft;
  };
  const submitCard = async (key: string): Promise<void> => {
    const draft = cardDraft(key);
    const questions = cardQuestions(key);

    if (!complete(questions, draft.choices) || draft.sending || state.session === null || state.session.conversation !== 'full') {
      return;
    }

    draft.sending = true;
    draft.sent = answerText(questions, draft.choices);
    draft.error = null;
    draw();

    const answer = await command('send', { sessionId: state.session.id, launch: state.session.launch, text: draft.sent });
    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    draft.sending = false;

    if (answer.status !== 200 || late !== undefined) {
      draft.sent = null;
      draft.error = late?.error ?? String(answer.body['error'] ?? 'Not sent.');
      unsent.delete(id ?? '');
    } else {
      draft.sentId = id;
    }

    draw();
  };

  // ---- Clicks ----
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset['tab'] as Tab | undefined;

    if (tab !== undefined && TABS.some((one) => one.tab === tab)) {
      view.tab = tab;
      view.artifact = tab === 'artifacts' ? view.artifact : null;
      draw();
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    switch (action) {
      case 'select':
        void select(Number(button!.dataset['workItem']));
        break;
      case 'picker':
        view.picker = !view.picker;
        draw();
        break;
      case 'persona':
        void choosePersona();
        break;
      case 'earlier':
        void earlier();
        break;
      case 'more': {
        const key = `more:${button!.dataset['reply']}`;

        if (!view.open.delete(key)) {
          view.open.add(key);
        }

        draw();
        break;
      }
      case 'artifact':
        view.tab = 'artifacts';
        view.artifact = button!.dataset['path'] ?? null;
        draw();
        break;
      case 'close-artifact':
        view.artifact = null;
        draw();
        break;
      case 'pick': {
        const key = button!.dataset['card']!;
        const index = Number(button!.dataset['question']);
        const letter = button!.dataset['letter']!;
        const draft = cardDraft(key);
        const choice = draft.choices.get(index) ?? { letters: [], other: '' };
        const multi = cardQuestions(key)[index]?.multi === true;
        const picked = choice.letters.includes(letter);

        draft.choices.set(index, multi ? { ...choice, letters: picked ? choice.letters.filter((one) => one !== letter) : [...choice.letters, letter] } : { letters: picked ? [] : [letter], other: picked ? choice.other : '' });
        draw();
        break;
      }
      case 'answer':
        void submitCard(button!.dataset['card']!);
        break;
      case 'request-option':
        view.requestValues.set(button!.dataset['field']!, button!.dataset['value']!);
        draw();
        break;
      case 'request-decision':
      case 'request-answer':
        void answerRequest(button!.dataset['request']!, action === 'request-decision' ? button!.dataset['decision']! : null);
        break;
      case 'copy-code':
      case 'copy-reply': {
        const id = button!.closest<HTMLElement>('li[data-id]')?.dataset['id'];
        const reply = state.items.find((item) => item.id === id && item.type === 'reply');
        const text = action === 'copy-code' ? (button!.parentElement?.querySelector('pre')?.textContent ?? '').replace(/\n$/, '') : reply?.type === 'reply' ? reply.opening : null;

        if (text !== null) {
          void navigator.clipboard?.writeText(text);
        }

        break;
      }
      default:
        if (view.picker && target.closest('.header') === null) {
          view.picker = false;
          draw();
        }
    }
  });
  root.addEventListener('toggle', (event) => {
    const fold = event.target as HTMLDetailsElement;
    const id = fold.dataset?.['fold'];

    if (id !== undefined) {
      if (fold.open) {
        view.open.add(id);
      } else {
        view.open.delete(id);
      }
    }
  }, true);
  root.addEventListener('input', (event) => {
    const field = event.target as HTMLInputElement;

    if (field.classList?.contains('request-field')) {
      view.requestValues.set(field.dataset['field']!, field.value);
      return;
    }

    if (!field.classList?.contains('question-other')) {
      return;
    }

    const key = field.dataset['card']!;
    const index = Number(field.dataset['question']);
    const draft = cardDraft(key);
    const choice = draft.choices.get(index) ?? { letters: [], other: '' };
    const single = cardQuestions(key)[index]?.multi !== true;

    draft.choices.set(index, { letters: single && field.value.trim() !== '' ? [] : choice.letters, other: field.value });

    const submit = [...root.querySelectorAll<HTMLButtonElement>('.question-submit')].find((one) => one.dataset['card'] === key) ?? null;

    if (submit !== null) {
      submit.disabled = !complete(cardQuestions(key), draft.choices);
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (event.target as HTMLElement) !== input && state.voice?.here === true && state.voice.speaking !== null) {
      void command('stop-speaking');
    }
  });

  /** Answers a Codex request: a permission with its decision, questions with every answer given; the hub checks it is still pending. */
  const answerRequest = async (requestId: string, decision: string | null): Promise<void> => {
    const request = state.session?.requests?.find((one) => one.id === requestId);

    if (request === undefined || state.session === null) {
      return;
    }

    let answer: unknown = decision;

    if (decision === null) {
      const answers: Record<string, string> = {};

      for (const question of request.questions) {
        const value = view.requestValues.get(`${request.id}:${question.id}`)?.trim() ?? '';

        if (value === '') {
          showError(`Answer "${question.question}" first.`);
          return;
        }

        answers[question.id] = value;
      }

      answer = answers;
    }

    const reply = await command('answer', { sessionId: state.session.id, requestId, answer });

    if (reply.status !== 200) {
      showError(String(reply.body['error'] ?? 'Codex did not confirm the answer. Check its terminal.'));
    }
  };

  const earlier = async (): Promise<void> => {
    const oldest = state.items[0];

    if (state.session === null) {
      return;
    }

    const shown = `${state.key} ${state.scope?.scopeGen} ${state.session.id}`;
    const answer = await command('history', { sessionId: state.session.id, before: oldest?.id ?? null });

    // A page that moved on meanwhile never takes another conversation's history.
    if (answer.status === 200 && shown === `${state.key} ${state.scope?.scopeGen} ${state.session?.id}`) {
      state = withEarlier(state, answer.body['items'] as ItemView[], answer.body['more'] === true);
      draw();
    }
  };

  /** The header's persona button: the roster, and pinning one to the session; a list in the header, as the dropdown is. */
  const choosePersona = async (): Promise<void> => {
    const answer = await command('personas');
    const personas = (answer.body['personas'] as Array<{ id: string; name: string }> | undefined) ?? [];

    if (personas.length === 0 || state.session === null) {
      return;
    }

    const menuList = document.createElement('ul');

    menuList.className = 'conversation-list persona-list';
    menuList.innerHTML = [...personas.map((one) => `<li><button type="button" data-persona="${escape(one.id)}">${escape(one.name)}</button></li>`), state.session.persona?.pinned ? '<li><button type="button" data-persona="">Clear pin</button></li>' : ''].join('');
    head.querySelector('.header')?.appendChild(menuList);
    menuList.addEventListener('click', (event) => {
      const chosenOne = (event.target as HTMLElement).closest<HTMLElement>('[data-persona]');

      if (chosenOne !== null && state.session !== null) {
        void command('persona', { sessionId: state.session.id, personaId: chosenOne.dataset['persona'] || null });
      }

      menuList.remove();
    });
  };

  // ---- The stream ----
  const source = new deps.EventSource('/v1/conversation/events?page=1');

  for (const type of EVENTS) {
    source.addEventListener(type, (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { type: string } & Record<string, unknown>;
      const keyBefore = state.key;

      state = applyEvent(state, data);

      if (type === 'hello') {
        expired = false;

        // A new stream has a new key, unbound: the page selects its work item again.
        if (state.key !== keyBefore) {
          focusSent = null;
          reportFocus(true);
        }

        if (state.key !== keyBefore) {
          acked = null;
          selectInFlight = false;
        }

        reconcile();
      }

      // Dictation (architecture.md § Dictation): live words show dimmed after the box's text; the hub's draft fills the box unless the operator typed over it.
      if (type === 'words') {
        liveWords.textContent = String(data['text'] ?? '');
        liveWords.hidden = liveWords.textContent === '';
        showLive();
      } else if (type === 'draft' && typeof data['sessionId'] === 'string') {
        takeHubDraft(data['sessionId'], String(data['text'] ?? ''));
      }

      // A message this page sent that was not sent: a card's answer goes back to its card, any other text to its own work item's draft.
      if (type === 'message' && (data['message'] as { delivery?: string }).delivery === 'not-sent') {
        const message = data['message'] as Extract<ItemView, { type: 'message' }>;
        const error = message.error ?? 'Not sent.';
        const card = [...view.cards.values()].find((one) => one.sentId === message.id);

        if (card !== undefined) {
          card.sent = null;
          card.sentId = null;
          card.error = error;
        } else if (mine.delete(message.id) || data['giveBack'] === true) {
          giveBack(message.workItemId, message.text, error);
        } else {
          // Its send may not have answered yet.
          unsent.set(message.id, { text: message.text, error, workItemId: message.workItemId });

          for (const old of [...unsent.keys()].slice(0, -50)) {
            unsent.delete(old);
          }
        }
      }

      draw();
    });
  }

  source.addEventListener('error', () => {
    state = { ...state, connected: false };
    // A stream refused for its cookie does not come back: the page needs a new link.
    void deps.fetch('/v1/page/list', { credentials: 'same-origin' }).then((response) => {
      expired = response.status === 401;
      draw();
    }, () => draw());
  });

  draw();

  return {
    state: () => state,
    close: () => {
      clearInterval(seenTimer);
      source.close();
    },
  };
}

/** Loads Mermaid from the hub once, for diagrams in replies, statuses and artifacts; false when the hub has none. */
export function loadMermaid(): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement('script');

    script.src = '/page/mermaid.min.js';
    script.onload = () => {
      const mermaid = (globalThis as { mermaid?: { initialize(options: object): void } }).mermaid;

      mermaid?.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      resolve(mermaid !== undefined);
    };
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}
