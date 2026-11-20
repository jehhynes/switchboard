import type { ConversationState } from '../conversationModel.js';
import { EMPTY_CONVERSATION } from '../conversationModel.js';
import { ago, moreKey, PICKER, renderConversation, renderMicButton, renderVoiceControls, replyText, TABS } from './conversationRender.js';
import type { CardDraft } from './conversationRender.js';
import { answerText, complete, parseQuestions } from '@switchboard/conversation/questions';
import { selectedEntry, statusLine } from '../conversationModel.js';
import type { ConversationMessage, SendTarget, Tab } from './conversationRender.js';
import { startComposerExtras } from './composerExtras.js';
import { morph } from './morph.js';
import type { ExtrasReply } from './composerExtras.js';

interface VsCodeApi {
  postMessage(message: ConversationMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * What the page keeps while hidden, since it is not retained, and over a reload: its open folds, whether it was scrolled to the end, the tab
 * shown, and the composer's draft with the slash command chosen for it.
 */
interface PageState {
  open: string[];
  scroll: number | null;
  tab?: Tab;
  draft?: string;
  command?: string | null;
}

/** How long a copy button shows its check. */
const COPIED_MS = 2_000;
/** How long an unread reply or status must be visible in a focused window before it counts as seen (architecture.md § Unread). */
export const SEEN_MS = 1_000;
/** How often the page checks again while an unread item is on its way to seen, so one hidden and shown again in between starts over. */
const SEEN_CHECK_MS = 250;
/** How long a status that replaced the one before is marked New once the Status tab shows it, unless the operator opens it first. */
export const STATUS_NEW_MS = 60_000;
/** How often the ages of the status and the artifacts are redrawn. */
const STATUS_AGE_MS = 30_000;
/** The tallest the composer grows before it scrolls, as Claude Code's. */
const COMPOSER_MAX_PX = 200;
/** The longest title the placeholder names before it is cut. */
const PLACEHOLDER_TITLE_CHARS = 40;
/** How long the composer waits after the last key before it tells the hub its draft (architecture.md § Dictation). */
export const COMPOSER_DRAFT_MS = 300;

/** The work item's title for the placeholder: without leading tags such as "[Feedback]", cut at a word to fit one line. */
export function shortTitle(title: string): string {
  const bare = title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim() || title.trim();

  if (bare.length <= PLACEHOLDER_TITLE_CHARS) {
    return bare;
  }

  const cut = bare.slice(0, PLACEHOLDER_TITLE_CHARS + 1);
  const space = cut.lastIndexOf(' ');

  return (space > PLACEHOLDER_TITLE_CHARS / 2 ? cut.slice(0, space) : cut.slice(0, PLACEHOLDER_TITLE_CHARS)).trimEnd();
}

/** Sets an element's HTML only when it changed, so a button under the pointer survives a redraw with the same state. */
function redraw(element: HTMLElement, html: string): void {
  if (element.dataset['html'] !== html) {
    element.dataset['html'] = html;
    element.innerHTML = html;
  }
}

/**
 * The composer (architecture.md § Conversation view): a box that grows with its text, Enter to send and Shift+Enter for a new line. It is
 * enabled only for a session the view can talk to, keeps its text until the hub took the message, takes back the text of a message that was
 * not sent, and shows why above the box until dismissed.
 */
function startComposer(
  host: HTMLElement,
  vscode: VsCodeApi,
): {
  update(state: ConversationState): void;
  sent(id: number, error: string | null): void;
  unsent(text: string, error: string, workItemId: number | null): void;
  receive(reply: ExtrasReply): void;
  draft(text: string, workItemId: number | null): void;
  words(text: string): void;
  refused(error: string, workItemId: number | null): void;
} {
  // As Claude Code's input: the text area over a footer, whose left side is kept for the controls later slices add. Why a message did not go
  // shows above it until dismissed.
  host.innerHTML =
    '<div class="composer-error" role="alert" hidden><span class="composer-error-text"></span>' +
    '<button class="dismiss" type="button" title="Dismiss" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>' +
    '<div class="composer"><div class="composer-input"><div class="live-mirror"><span class="mirror-text" aria-hidden="true"></span><span class="live-words" aria-live="polite" hidden></span></div><textarea rows="1" aria-label="Message"></textarea></div><div class="composer-footer"><div class="composer-controls"></div>' +
    '<span class="mic-slot"></span><button class="send" type="button" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button></div></div>';

  const input = host.querySelector('textarea')!;
  const send = host.querySelector<HTMLButtonElement>('button.send')!;
  const error = host.querySelector<HTMLElement>('.composer-error')!;
  const errorText = host.querySelector<HTMLElement>('.composer-error-text')!;
  const liveWords = host.querySelector<HTMLElement>('.live-words')!;
  const mirror = host.querySelector<HTMLElement>('.live-mirror')!;
  const mirrorText = host.querySelector<HTMLElement>('.mirror-text')!;
  const micSlot = host.querySelector<HTMLElement>('.mic-slot')!;
  // The voice in this window, and a draft the hub changed while the box held a message being sent, which takes the box once the hub answered.
  let voiceHere = false;
  let micListening = false;
  let hubDraft: string | null = null;
  /** The draft text the hub last had: what the box reported, or what the hub sent, so a late recognition joins the box's text instead of replacing it. */
  let hubKnows = '';
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tells the hub the box's focus and draft, for the focus rule (architecture.md § Dictation); a message being sent is no draft. */
  const tellHub = (): void => {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }

    hubKnows = sending === null ? input.value : '';
    vscode.postMessage({ type: 'composer', focused: document.activeElement === input, draft: hubKnows });
  };
  // Messages that were not sent while another was being sent, with the conversation each belongs to, put back once the box is writable.
  const returned: Array<{ text: string; error: string; workItemId: number | null }> = [];
  const showError = (text: string | null): void => {
    errorText.textContent = text ?? '';
    error.hidden = text === null;
  };
  const putBack = (): void => {
    for (const one of returned.splice(0)) {
      // Below a draft, after a blank line; one of another conversation goes to its draft.
      if (one.workItemId === current) {
        input.value = below(input.value, one.text);
        showError(one.error);
      } else if (one.workItemId !== null) {
        extras.setDraft(one.workItemId, below(extras.draftOf(one.workItemId), one.text));
        errors.set(one.workItemId, one.error);
      }
    }

    grow();
    refresh();
    extras.changed();
  };
  let enabled = false;
  let target: SendTarget | null = null;
  // The message being sent, its text, and the conversation it was typed in.
  let sending: { id: number; text: string; workItemId: number | null } | null = null;
  let next = 1;
  // A draft per conversation, kept in the page's state by the extras, and a refusal per conversation (architecture.md § Conversation view): the box
  // holds the selected one's; the others wait.
  let current: number | null = null;
  const errors = new Map<number, string>();
  /** Adds a text that was not sent below a draft, after a blank line. */
  const below = (draft: string, text: string): string => (draft.trim() === '' ? text : `${draft.replace(/\n+$/, '')}\n\n${text}`);
  /** Keeps the box's draft and refusal for the conversation it belonged to, and shows those of the newly selected one. */
  const switchTo = (workItemId: number | null): void => {
    if (workItemId === current) {
      return;
    }

    // The text being sent is not a draft: it shows read-only in its conversation until the hub answers.
    if (current !== null) {
      if (sending?.workItemId !== current) {
        extras.setDraft(current, input.value);
      }

      if (!error.hidden) {
        errors.set(current, errorText.textContent ?? '');
      }
    }

    current = workItemId;

    const busy = sending !== null && sending.workItemId === current;

    input.value = busy ? sending!.text : workItemId === null ? '' : extras.draftOf(workItemId);
    showError(workItemId === null ? null : (errors.get(workItemId) ?? null));
    // The extras follow the selected conversation: its chosen command, its history walk and its list.
    extras.enter(workItemId);

    if (workItemId !== null) {
      errors.delete(workItemId);
    }

    input.readOnly = busy;
    host.classList.toggle('sending', busy);
    grow();
    refresh();

    // The hub keeps one draft per conversation: it learns the one now shown, so dictation never joins another's.
    if (voiceHere) {
      tellHub();
    }
  };
  /**
   * Live words show dimmed right after the box's text, on its line, from a copy of the text laid out under the box with the same font, padding and
   * wrapping (architecture.md § Dictation); when they settle, the hub's draft takes them in place.
   */
  const syncLive = (): void => {
    const shown = !liveWords.hidden;

    mirrorText.textContent = shown ? input.value : '';
    liveWords.dataset['lead'] = shown && input.value !== '' && !/\s$/.test(input.value) ? ' ' : '';
    mirror.scrollTop = input.scrollTop;
    host.classList.toggle('live-showing', shown);
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
  const canSend = (): boolean => enabled && target !== null && sending === null && input.value.trim() !== '';
  const refresh = (): void => {
    send.disabled = !canSend();
  };
  const submit = (): void => {
    if (!canSend()) {
      return;
    }

    sending = { id: next++, text: input.value, workItemId: current };

    // The text in flight is no draft; a refusal or a not-sent message brings it back.
    if (current !== null) {
      extras.setDraft(current, '');
    }

    input.readOnly = true;
    host.classList.add('sending');
    refresh();
    vscode.postMessage({ type: 'send', id: sending.id, text: input.value, target: target!, ...(extras.command(input.value) ? { command: true as const } : {}) });

    // Sending hands the box back to the voice: the focus goes to the timeline, and dictation resumes (architecture.md § Dictation).
    if (voiceHere && micListening && document.activeElement === input) {
      input.blur();
      document.querySelector<HTMLElement>('.timeline')?.focus();
    }
  };
  const extras = startComposerExtras(host, input, host.querySelector<HTMLElement>('.composer-controls')!, vscode, () => {
    grow();
    refresh();
  }, (text) => showError(text));
  // The voice's controls on the footer's left (architecture.md § Voice): Speak replies, Stop while speaking, and Talk here while the voice is elsewhere.
  const voiceControls = document.createElement('div');

  voiceControls.className = 'voice-controls';
  host.querySelector<HTMLElement>('.composer-controls')!.appendChild(voiceControls);
  voiceControls.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-voice]');

    if (button?.dataset['voice'] === 'speak-replies') {
      vscode.postMessage({ type: 'speak-replies', on: button.getAttribute('aria-pressed') !== 'true' });
    } else if (button?.dataset['voice'] === 'stop') {
      vscode.postMessage({ type: 'stop-speaking' });
    } else if (button?.dataset['voice'] === 'talk-here') {
      vscode.postMessage({ type: 'talk-here' });
    }
  });
  let speaking = false;

  micSlot.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-voice="mic"]');

    if (button !== null) {
      vscode.postMessage({ type: 'mic', on: button.dataset['on'] === 'true' });
    }
  });
  input.addEventListener('scroll', () => void (mirror.scrollTop = input.scrollTop));
  input.addEventListener('focus', tellHub);
  input.addEventListener('blur', tellHub);
  input.addEventListener('input', () => {
    grow();
    refresh();

    if (voiceHere && document.activeElement === input) {
      if (draftTimer !== null) {
        clearTimeout(draftTimer);
      }

      draftTimer = setTimeout(tellHub, COMPOSER_DRAFT_MS);
    }
  });
  error.querySelector('button.dismiss')!.addEventListener('click', () => {
    showError(null);
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (extras.keydown(event)) {
      return;
    }

    // Escape stops speech while the view has focus.
    if (event.key === 'Escape' && speaking) {
      vscode.postMessage({ type: 'stop-speaking' });
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    submit();
  });
  send.addEventListener('click', () => {
    submit();
    input.focus();
  });

  return {
    update: (state) => {
      switchTo(state.scope?.workItemId ?? null);
      enabled = state.connected && state.session?.conversation === 'full';
      extras.update(state);
      target = state.scope === null || state.session === null ? null : { scopeGen: state.scope.scopeGen, sessionId: state.session.id, launch: state.session.launch };
      // A window with no selected conversation, such as a folder window before its first, has no composer.
      host.hidden = state.scope === null || state.scope.workItemId === null;
      input.disabled = !enabled;
      input.placeholder = enabled ? `Message ${shortTitle(selectedEntry(state)?.title ?? state.scope?.title ?? '')}…` : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : 'Connecting to Switchboard…'));
      // Redrawn only when they change, so a state event between a press and its release does not swallow the click.
      redraw(voiceControls, renderVoiceControls(state.voice, enabled));
      redraw(micSlot, enabled ? renderMicButton(state.voice) : '');
      speaking = state.voice?.here === true && state.voice.speaking !== null;
      const wasHere = voiceHere;

      voiceHere = state.voice?.enabled === true && state.voice.here;

      // A draft restored with the page, or one made before the voice came here, is told to the hub once.
      if (voiceHere && !wasHere) {
        tellHub();
      }
      micListening = voiceHere && state.voice!.mic !== 'off' && state.voice!.mic !== 'idle-off';
      host.classList.toggle('dictating', micListening);

      if (!voiceHere && !liveWords.hidden) {
        liveWords.hidden = true;
        grow();
      }

      refresh();
    },
    draft: (text, workItemId) => {
      // The hub's draft is the box's text: a spoken turn sent it, or dictation joined it (architecture.md § Dictation).
      if (workItemId !== null && workItemId !== current) {
        extras.setDraft(workItemId, text);
        return;
      }

      if (sending !== null && sending.workItemId === current) {
        hubDraft = text;
        return;
      }

      // A recognition that settles while the box has the focus joins the end of what the operator has now, never replacing a correction.
      if (document.activeElement === input && text.startsWith(hubKnows) && input.value !== hubKnows) {
        input.value = `${input.value}${text.slice(hubKnows.length)}`;
        hubKnows = text;
        tellHub();
      } else {
        input.value = text;
        hubKnows = text;
      }

      grow();
      refresh();
      extras.changed();
    },
    words: (text) => {
      liveWords.textContent = text;
      liveWords.hidden = text === '';
      showLive();
    },
    refused: (why, workItemId) => {
      if (workItemId !== null && workItemId !== current) {
        errors.set(workItemId, why);
        return;
      }

      showError(why);
    },
    sent: (id, refusal) => {
      if (id !== sending?.id) {
        return;
      }

      const from = sending.workItemId;
      const sent = sending;

      sending = null;
      input.readOnly = false;
      host.classList.remove('sending');

      // Sent from a conversation no longer selected: a refused text goes back to its draft, with why.
      if (from !== current) {
        if (from !== null && refusal !== null) {
          extras.setDraft(from, below(extras.draftOf(from), sent.text));
          errors.set(from, refusal);
        }

        extras.sent(false);
        putBack();
        return;
      }

      if (refusal === null) {
        input.value = hubDraft ?? '';
        hubDraft = null;
        grow();
        showError(null);
        extras.sent(true);
      } else {
        showError(refusal);
        extras.sent(false);
      }

      putBack();
    },
    unsent: (text, why, workItemId) => {
      const target = workItemId ?? current;

      // A late refusal goes back only to the draft of the conversation it was sent in, after a message of that conversation still being sent.
      if (sending !== null && sending.workItemId === target) {
        returned.push({ text, error: why, workItemId: target });
        return;
      }

      if (target !== current) {
        if (target !== null) {
          extras.setDraft(target, below(extras.draftOf(target), text));
          errors.set(target, why);
        }

        return;
      }

      returned.push({ text, error: why, workItemId: target });
      putBack();
    },
    receive: (reply) => extras.receive(reply),
  };
}

/** Wires the Conversation view's page: draws each state the extension sends, keeps folds and the scroll position, and posts clicks back. */
export function startConversation(root: HTMLElement, live: HTMLElement, vscode: VsCodeApi, composerHost?: HTMLElement): void {
  const composer = composerHost === undefined ? null : startComposer(composerHost, vscode);
  const saved = vscode.getState() as Partial<PageState> | null;
  // The conversation list never stays open across a reload.
  const open = new Set((saved?.open ?? []).filter((id) => id !== PICKER));
  let state: ConversationState = EMPTY_CONVERSATION;
  let tab: Tab = TABS.some((one) => one.tab === saved?.tab) ? saved!.tab! : 'conversation';
  // The artifacts new or changed since they were last opened in the workspace, which the extension keeps.
  let unopened = new Set<string>();
  let shownIds = new Set<string>();
  let restore = saved?.scroll ?? null;
  // Whether the conversation follows its end: set by the operator's own scrolling, never by a size measured after a layout change, so a composer,
  // banner or fold that changes height keeps a conversation at its end there.
  let pinned = restore === null;
  /** Where the page itself last scrolled the conversation, so its own scroll events, which can come after more items, never stop the following. */
  let ownTop = 0;
  let focused: string | null = null;
  // New items arrived below the part the operator is reading, until they scroll to the end.
  let unseenBelow = false;
  // Copy buttons waiting for the extension to say it wrote the clipboard.
  const copies = new Map<number, HTMLElement>();
  let nextCopy = 1;
  // The question cards' choices by card key, and the cards whose answer is being sent by send ID, numbered apart from the composer's.
  const cards = new Map<string, CardDraft>();
  const cardSends = new Map<number, string>();
  let nextCardSend = 1_000_000;
  /** The questions a card asks, read again from the reply or status it belongs to. */
  const cardQuestions = (key: string): ReturnType<typeof parseQuestions> => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const markdown = kind === 'status' ? (state.status?.id === id ? state.status.markdown : '') : (state.items.flatMap((item) => (item.id === id && item.type === 'reply' ? [item.opening] : []))[0] ?? '');

    return markdown === '' ? [] : parseQuestions(markdown);
  };
  const cardDraft = (key: string): CardDraft => {
    let draft = cards.get(key);

    if (draft === undefined) {
      draft = { choices: new Map(), sent: null, workItemId: null, sending: false, error: null };
      cards.set(key, draft);
    }

    return draft;
  };
  /** Sends a card's answer as an ordinary message, to the session the page shows, as the composer's Enter does. */
  const submitCard = (key: string): void => {
    const draft = cards.get(key);
    const questions = cardQuestions(key);
    const text = draft === undefined || !complete(questions, draft.choices) ? '' : answerText(questions, draft.choices);

    if (draft === undefined || text === '' || draft.sending || draft.sent !== null || state.scope === null || state.session === null || !state.connected || state.session.conversation !== 'full') {
      return;
    }

    const id = nextCardSend++;

    cardSends.set(id, key);
    draft.sending = true;
    draft.sent = text;
    draft.workItemId = state.scope.workItemId;
    draft.error = null;
    draw();
    vscode.postMessage({ type: 'send', id, text, target: { scopeGen: state.scope.scopeGen, sessionId: state.session.id, launch: state.session.launch } });
  };
  // The status the Status tab last had, and until when a status that replaced it is marked New: Infinity until the tab shows it.
  let shownStatus: { sessionId: string | null; id: string; markdown: string } | null = null;
  // Whether this VS Code window has the focus, which the extension says; unread items count as seen only then.
  let windowFocused = false;
  // Unread items visible since when, and those already reported seen, for the session the page shows.
  const visibleSince = new Map<string, number>();
  const reported = new Set<string>();
  let reportedFor: string | null = null;
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  let wasConnected = false;
  // The timeline's size changes without a window resize when a fold opens or the composer grows.
  const resized =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          follow();
          checkSeen();
        })
      : null;
  /** Keeps a conversation that follows its end at its end. */
  const follow = (): void => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (scroller !== null && pinned && !atEnd(scroller)) {
      scroller.scrollTop = scroller.scrollHeight;
      ownTop = scroller.scrollTop;
    }
  };
  /**
   * The unread items on screen, only in the tab shown: the status on the Status tab, and the replies at least half in the timeline's viewport, or
   * filling half of it. None while the window has no focus or the page is hidden.
   */
  const visibleUnread = (): string[] => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (!windowFocused || document.visibilityState === 'hidden') {
      return [];
    }

    const view = scroller?.getBoundingClientRect();

    return [...root.querySelectorAll<HTMLElement>('[data-unread]')]
      .filter((element) => {
        if (scroller === null || view === undefined || !scroller.contains(element)) {
          return true;
        }

        const box = element.getBoundingClientRect();
        const shown = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);

        return shown > 0 && shown >= Math.min(box.height, view.height) / 2;
      })
      .map((element) => element.dataset['unread']!)
      .filter((id) => !reported.has(id));
  };
  /** Reports each unread item that stayed visible for `SEEN_MS`, each once, and checks again when the next one is due. */
  const checkSeen = (): void => {
    clearTimeout(seenTimer);

    const target = state.scope === null || state.session === null ? null : { scopeGen: state.scope.scopeGen, sessionId: state.session.id };
    const key = target === null ? null : `${target.scopeGen} ${target.sessionId}`;

    if (key !== reportedFor) {
      reportedFor = key;
      reported.clear();
      visibleSince.clear();
    }

    if (target === null || !root.isConnected) {
      return;
    }

    const now = Date.now();
    const visible = new Set(visibleUnread());

    for (const id of [...visibleSince.keys()].filter((one) => !visible.has(one))) {
      visibleSince.delete(id);
    }

    for (const id of visible) {
      if (!visibleSince.has(id)) {
        visibleSince.set(id, now);
      }
    }

    const due = [...visibleSince].filter(([, since]) => now - since >= SEEN_MS).map(([id]) => id);

    if (due.length > 0) {
      for (const id of due) {
        visibleSince.delete(id);
        reported.add(id);
      }

      vscode.postMessage({ type: 'seen', ids: due, target });
    }

    // While an unread item is on the page of a focused window, a layout change can show or hide it without an event, so it is checked again.
    const waiting = windowFocused && [...root.querySelectorAll<HTMLElement>('[data-unread]')].some((element) => !reported.has(element.dataset['unread']!));

    if (visibleSince.size > 0 || waiting) {
      seenTimer = setTimeout(checkSeen, visibleSince.size === 0 ? SEEN_CHECK_MS : Math.min(SEEN_CHECK_MS, Math.max(0, SEEN_MS - (now - Math.min(...visibleSince.values())))));
    }
  };
  let freshUntil = 0;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  const seenStatus = (): void => {
    if (freshUntil !== 0) {
      freshUntil = 0;
      clearTimeout(freshTimer);

      if (root.isConnected) {
        draw();
      }
    }
  };
  // A New status's minute starts once the Status tab shows it, so one that came while another tab was shown is still New there.
  const startFreshClock = (): void => {
    if (freshUntil !== Infinity || tab !== 'status' || document.visibilityState === 'hidden') {
      return;
    }

    freshUntil = Date.now() + STATUS_NEW_MS;
    freshTimer = setTimeout(() => {
      freshUntil = 0;

      if (root.isConnected) {
        draw();
      }
    }, STATUS_NEW_MS);
  };
  // A status that replaces the one the page had for the same session is New for a while; a first status after the stage is too.
  const noteStatus = (): void => {
    const status = state.status;
    const sessionId = state.scope?.sessionId ?? null;

    if (status !== null && !status.fallback && shownStatus !== null && shownStatus.sessionId === sessionId && (shownStatus.id !== status.id || shownStatus.markdown !== status.markdown)) {
      freshUntil = Infinity;
      clearTimeout(freshTimer);
      live.textContent = `New status: ${statusLine(status.markdown)}`;
    } else if (status === null || shownStatus?.sessionId !== sessionId) {
      freshUntil = 0;
      clearTimeout(freshTimer);
    }

    shownStatus = status === null ? null : { sessionId, id: status.id, markdown: status.markdown };
  };

  // The ages of the status and the artifacts, redrawn while the page is shown; a page taken off the document stops.
  const tickAges = (): void => {
    if (!root.isConnected) {
      return;
    }

    for (const age of root.querySelectorAll<HTMLElement>('.age')) {
      age.textContent = ago(Number(age.dataset['at']), Date.now());
    }

    setTimeout(tickAges, STATUS_AGE_MS);
  };

  setTimeout(tickAges, STATUS_AGE_MS);

  const save = (): void => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    // Off the Conversation tab, the scroll position it had is kept until it is shown again. The composer keeps its draft in the same state.
    const scroll = scroller === null ? restore : pinned ? null : scroller.scrollTop;

    vscode.setState({ ...((vscode.getState() as object | null) ?? {}), open: [...open], scroll, tab } satisfies PageState);
  };
  const atEnd = (scroller: HTMLElement): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;

  /** A focused tab or button outside the timeline, found again after a redraw by its tab, action and path. */
  const focusKey = (element: Element | null): { tab?: string | undefined; action?: string | undefined; path?: string | undefined } | null => {
    // A question card's controls are found again by their card, question and letter.
    if (!(element instanceof HTMLElement) || !root.contains(element) || element.closest('.timeline') !== null || element.dataset['card'] !== undefined) {
      return null;
    }

    return element.dataset['tab'] !== undefined ? { tab: element.dataset['tab'] } : element.dataset['action'] !== undefined ? { action: element.dataset['action'], path: element.dataset['path'] } : null;
  };

  /**
   * Draws the state by changing only what differs (`morph`), so the nodes kept keep the focus, a selection, scroll positions and open menus; a
   * conversation that follows its end stays at it, and new items below a conversation scrolled up bring the New messages pill.
   */
  const draw = (): void => {
    const before = root.querySelector<HTMLElement>('.scroll');
    // A redraw puts the focus back on the item it was on only while the timeline had it, never taking it from the composer.
    const timelineFocused = root.contains(document.activeElement);
    const refocus = focusKey(document.activeElement);
    const ids = new Set(state.items.map((item) => item.id));
    const added = state.items.filter((item) => !shownIds.has(item.id));

    // Items that come below where the operator was reading, while another tab is shown or the conversation is scrolled up.
    if (added.length > 0 && shownIds.size > 0 && (before === null ? restore !== null : !pinned)) {
      unseenBelow = true;
    }

    startFreshClock();
    morph(root, renderConversation(state, open, Date.now(), freshUntil > Date.now(), { tab, unopened, cards, pill: unseenBelow }));
    document.body.dataset['tab'] = tab;

    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (scroller !== null) {
      // A conversation shown again, or another conversation: back where the operator left it, else at its end.
      if (scroller !== before) {
        pinned = restore === null;
        scroller.scrollTop = restore ?? scroller.scrollHeight;
        ownTop = scroller.scrollTop;
        restore = null;
        resized?.disconnect();
        resized?.observe(scroller);
      }

      const list = scroller.querySelector('.timeline');

      if (list !== null) {
        resized?.observe(list);
      }

      follow();

      if (unseenBelow && atEnd(scroller)) {
        unseenBelow = false;
      }

      const pill = root.querySelector<HTMLElement>('.pill');

      if (pill !== null) {
        pill.hidden = !unseenBelow;
      }
    }

    // New replies are read out by a screen reader once.
    const spoken = added.filter((item) => item.type === 'reply' && item.kind === 'reply' && shownIds.size > 0);

    if (spoken.length > 0) {
      live.textContent = spoken.map((item) => (item.type === 'reply' ? item.opening : '')).join(' ');
    }

    shownIds = ids;

    // The focused node is kept when it is drawn again; one drawn anew is found by its tab, action and path.
    if (refocus !== null && !root.contains(document.activeElement)) {
      [...root.querySelectorAll<HTMLElement>('[data-tab], [data-action]')].find((element) => focusKey(element) !== null && element.dataset['tab'] === refocus.tab && element.dataset['action'] === refocus.action && element.dataset['path'] === refocus.path)?.focus();
    } else if (focused !== null && timelineFocused && !root.contains(document.activeElement)) {
      root.querySelector<HTMLElement>(`li[data-id="${CSS.escape(focused)}"]`)?.focus();
    }

    checkSeen();
  };

  /** Shows a tab, keeping the conversation's scroll position for when it is shown again. */
  const selectTab = (next: Tab): void => {
    if (next === tab) {
      return;
    }

    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (scroller !== null) {
      restore = pinned ? null : scroller.scrollTop;
    }

    tab = next;
    focused = null;
    draw();
    save();
    root.querySelector<HTMLElement>(`[role="tab"][data-tab="${tab}"]`)?.focus();
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLElement>('[role="tab"]');

    if (tabButton !== null) {
      selectTab(tabButton.dataset['tab'] as Tab);
      return;
    }

    const link = target.closest<HTMLElement>('a[data-href]');

    if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', href: link.dataset['href'] ?? '' });
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    if (action === 'answer-request' && state.scope !== null && state.session !== null) {
      vscode.postMessage({ type: 'answer-request', requestId: button?.dataset['request'] ?? '', target: { sessionId: state.session.id, scopeGen: state.scope.scopeGen } });
    } else if (action === 'terminal' || action === 'earlier' || action === 'statuses' || action === 'new' || action === 'persona') {
      vscode.postMessage({ type: action });
    } else if (action === 'pill') {
      // The New messages pill goes to the end, where the conversation follows new items again.
      const scroller = root.querySelector<HTMLElement>('.scroll');

      if (scroller !== null) {
        pinned = true;
        unseenBelow = false;
        button!.hidden = true;
        scroller.scrollTop = scroller.scrollHeight;
        ownTop = scroller.scrollTop;
      }
    } else if (action === 'picker') {
      if (!open.delete(PICKER)) {
        open.add(PICKER);
      }

      draw();
      root.querySelector<HTMLElement>(open.has(PICKER) ? '.conversation-list button.selected, .conversation-list button' : 'button.picker')?.focus();
    } else if (action === 'select') {
      open.delete(PICKER);
      draw();
      vscode.postMessage({ type: 'select', workItemId: Number(button!.dataset['workItem']) });
    } else if (action === 'pick') {
      // One option per question, picked again to clear it, or several where the question takes several; a pick replaces a single question's Other text.
      const key = button!.dataset['card']!;
      const index = Number(button!.dataset['question']);
      const letter = button!.dataset['letter']!;
      const question = cardQuestions(key)[index];
      const draft = cardDraft(key);
      const choice = draft.choices.get(index) ?? { letters: [], other: '' };
      const picked = choice.letters.includes(letter);

      if (question === undefined) {
        return;
      }

      draft.choices.set(index, question.multi ? { ...choice, letters: picked ? choice.letters.filter((one) => one !== letter) : [...choice.letters, letter] } : { letters: picked ? [] : [letter], other: picked ? choice.other : '' });
      draft.error = null;
      draw();
    } else if (action === 'answer') {
      submitCard(button!.dataset['card']!);
    } else if (action === 'more') {
      // Show more and Show less flip the reply from where it starts (architecture.md § Voice).
      const key = moreKey(button!.dataset['reply'] ?? '');

      if (!open.delete(key)) {
        open.add(key);
      }

      draw();
      save();
    } else if (action === 'artifact') {
      vscode.postMessage({ type: 'artifact', path: button!.dataset['path'] ?? '' });
    } else if (action === 'status-open') {
      seenStatus();
      vscode.postMessage({ type: 'status-open' });
    } else if (action === 'copy-code' || action === 'copy-reply') {
      // A code block's text as written, without the newline that ends every block; a reply's Markdown from the state, not from the page.
      const id = button!.closest<HTMLElement>('li[data-id]')?.dataset['id'];
      const reply = state.items.find((item) => item.id === id && item.type === 'reply');
      const text = action === 'copy-code' ? (button!.parentElement?.querySelector('pre')?.textContent ?? '').replace(/\n$/, '') : reply?.type === 'reply' ? replyText(reply) : null;

      if (text !== null) {
        const copy = nextCopy++;

        copies.set(copy, button!);
        vscode.postMessage({ type: 'copy', id: copy, text });
      }
    }
  });

  root.addEventListener(
    'toggle',
    (event) => {
      const fold = event.target as HTMLDetailsElement;
      const id = fold.dataset['fold'];

      if (id !== undefined) {
        if (fold.open) {
          open.add(id);
        } else {
          open.delete(id);
        }

        save();
        checkSeen();
      }
    },
    true,
  );

  // An Other field keeps its text without a redraw, so the caret stays; text in a single question's field replaces its picked option.
  root.addEventListener('input', (event) => {
    const field = event.target as HTMLElement;

    if (!(field instanceof HTMLInputElement) || !field.classList.contains('question-other')) {
      return;
    }

    const key = field.dataset['card']!;
    const index = Number(field.dataset['question']);
    const draft = cardDraft(key);
    const choice = draft.choices.get(index) ?? { letters: [], other: '' };
    const single = cardQuestions(key)[index]?.multi !== true;

    draft.choices.set(index, { letters: single && field.value.trim() !== '' ? [] : choice.letters, other: field.value });
    draft.error = null;

    if (single && choice.letters.length > 0 && field.value.trim() !== '') {
      draw();
    } else {
      const submit = root.querySelector<HTMLButtonElement>(`.question-submit[data-card="${CSS.escape(key)}"]`);

      if (submit !== null) {
        submit.disabled = !complete(cardQuestions(key), draft.choices);
      }
    }
  });

  // Enter in an Other field submits its card.
  root.addEventListener('keydown', (event) => {
    const field = event.target as HTMLElement;

    if (field instanceof HTMLInputElement && field.classList.contains('question-other') && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submitCard(field.dataset['card']!);
    }
  });

  // Escape stops speech while the view has focus, unless it closes the conversation list.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !open.has(PICKER) && state.voice?.here === true && state.voice.speaking !== null) {
      vscode.postMessage({ type: 'stop-speaking' });
    }
  });

  // A press outside the header closes the conversation list, as a VS Code dropdown does.
  document.addEventListener('pointerdown', (event) => {
    if (open.has(PICKER) && !(event.target instanceof Node && root.querySelector('.header')?.contains(event.target) === true)) {
      open.delete(PICKER);
      draw();
    }
  });

  // Escape closes the conversation list; Up and Down move within it.
  root.addEventListener('keydown', (event) => {
    if (!open.has(PICKER)) {
      return;
    }

    const options = [...root.querySelectorAll<HTMLElement>('.conversation-list button')];
    const at = options.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'Escape') {
      open.delete(PICKER);
      draw();
      root.querySelector<HTMLElement>('button.picker')?.focus();
      event.stopImmediatePropagation();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length > 0) {
      options[Math.max(0, Math.min(options.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  // The tab strip is one tab stop, as VS Code's: Left and Right move to the tab before or after, Home and End to the first or last.
  root.addEventListener('keydown', (event) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -TABS.length, End: TABS.length };

    if (current === null || keys[event.key] === undefined) {
      return;
    }

    const index = TABS.findIndex((one) => one.tab === current.dataset['tab']);

    event.preventDefault();
    selectTab(TABS[Math.max(0, Math.min(TABS.length - 1, index + keys[event.key]!))]!.tab);
  });

  // The timeline is one tab stop; Up and Down move between items, Enter or Space toggles an item's first fold.
  root.addEventListener('keydown', (event) => {
    const list = root.querySelector<HTMLElement>('.timeline');
    const items = [...(list?.querySelectorAll<HTMLElement>(':scope > li[data-id]') ?? [])];
    const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.timeline > li[data-id]') ?? null;

    // Keys typed in a field, such as a question card's Other field, are its own.
    if (items.length === 0 || (document.activeElement !== list && current === null) || event.target instanceof HTMLInputElement) {
      return;
    }

    const index = current === null ? -1 : items.indexOf(current);
    const move = (to: number): void => {
      const next = items[Math.max(0, Math.min(items.length - 1, to))]!;

      focused = next.dataset['id'] ?? null;
      next.focus();
      event.preventDefault();
    };

    if (event.key === 'ArrowDown') {
      move(index + 1);
    } else if (event.key === 'ArrowUp') {
      move(index === -1 ? items.length - 1 : index - 1);
    } else if ((event.key === 'r' || event.key === 'R') && !event.ctrlKey && !event.metaKey && !event.altKey && current?.dataset['speak'] === '1') {
      // R speaks a reply's passage again (architecture.md § Voice).
      vscode.postMessage({ type: 'replay', replyId: current.dataset['id']! });
      event.preventDefault();
    } else if ((event.key === 'Enter' || event.key === ' ') && current !== null && (event.target as HTMLElement).closest('button, a') === null) {
      // An artifact's row opens it.
      if (current.dataset['path'] !== undefined) {
        vscode.postMessage({ type: 'artifact', path: current.dataset['path'] });
        event.preventDefault();
        return;
      }

      // A reply in focused mode flips its Show more first.
      const more = current.querySelector<HTMLButtonElement>(':scope > .body > .show-more');

      if (more !== null) {
        more.click();
        root.querySelector<HTMLElement>(`li[data-id="${CSS.escape(current.dataset['id'] ?? '')}"]`)?.focus();
        event.preventDefault();
        return;
      }

      const fold = current.querySelector<HTMLDetailsElement>('details');

      if (fold !== null) {
        fold.open = !fold.open;
        event.preventDefault();
      }
    }
  });

  // The operator's own scrolling decides whether the conversation follows its end: away from it stops following, back at it follows again.
  root.addEventListener(
    'scroll',
    (event) => {
      const scroller = event.target;

      if (!(scroller instanceof HTMLElement) || !scroller.classList.contains('scroll')) {
        return;
      }

      if (atEnd(scroller)) {
        pinned = true;
        unseenBelow = false;
        root.querySelector<HTMLElement>('.pill')?.setAttribute('hidden', '');
      } else if (Math.abs(scroller.scrollTop - ownTop) > 1) {
        pinned = false;
      }

      save();
      checkSeen();
    },
    true,
  );
  window.addEventListener('resize', checkSeen);
  document.addEventListener('visibilitychange', () => {
    // A New status that came while the page was hidden starts its minute once the page shows it.
    startFreshClock();
    checkSeen();
  });

  window.addEventListener('message', (event: MessageEvent<{ type: 'state'; state: ConversationState; unopened?: string[] } | { type: 'focus'; focused: boolean } | { type: 'seen-failed'; ids: string[] } | { type: 'sent'; id: number; error: string | null } | { type: 'copied'; id: number; ok: boolean } | { type: 'unsent'; returned: Array<{ text: string; error: string; workItemId: number | null }> } | { type: 'draft'; text: string; workItemId: number | null } | { type: 'words'; text: string } | { type: 'refused'; error: string; workItemId: number | null } | ExtrasReply>) => {
    if (event.data.type === 'files' || event.data.type === 'commands' || event.data.type === 'mentions' || event.data.type === 'image') {
      composer?.receive(event.data);
    } else if (event.data.type === 'draft') {
      composer?.draft(event.data.text, event.data.workItemId);
    } else if (event.data.type === 'words') {
      composer?.words(event.data.text);
    } else if (event.data.type === 'refused') {
      composer?.refused(event.data.error, event.data.workItemId);
    } else if (event.data.type === 'focus') {
      windowFocused = event.data.focused;
      checkSeen();
    } else if (event.data.type === 'seen-failed') {
      // The hub did not take them, so they are reported again once they have been visible for another second.
      for (const id of event.data.ids) {
        reported.delete(id);
      }

      checkSeen();
    } else if (event.data.type === 'state') {
      state = event.data.state;
      unopened = new Set(event.data.unopened ?? []);

      // A reconnect starts from the hub's state: items reported while the stream was down are reported again if still unread.
      if (state.connected && !wasConnected) {
        reported.clear();
      }

      wasConnected = state.connected;

      // A card's answer that shows in the conversation with its delivery settled is done with: only one still on its way can come back not sent.
      for (const [key, draft] of cards) {
        const replyId = key.startsWith('status:st-') ? key.slice('status:st-'.length) : key.startsWith('reply:') ? key.slice('reply:'.length) : null;
        const from = state.items.findIndex((item) => item.id === replyId);

        if (draft.sent !== null && !draft.sending && draft.workItemId === state.scope?.workItemId && from !== -1 && state.items.slice(from + 1).some((item) => item.type === 'message' && !item.withdrawn && item.delivery !== 'open' && item.text === draft.sent)) {
          draft.sent = null;
        }
      }

      noteStatus();
      // The composer first, so the conversation is drawn and scrolled against its final height.
      composer?.update(state);
      draw();
    } else if (event.data.type === 'sent') {
      const key = cardSends.get(event.data.id);

      if (key === undefined) {
        composer?.sent(event.data.id, event.data.error);
        return;
      }

      // A refused answer keeps the card's choices and shows why; a taken one waits, greyed, until its message shows in the conversation.
      const draft = cardDraft(key);

      cardSends.delete(event.data.id);
      draft.sending = false;

      if (event.data.error !== null) {
        draft.error = event.data.error;
        draft.sent = null;
      }

      draw();
    } else if (event.data.type === 'unsent') {
      for (const one of event.data.returned) {
        // A card's answer that was not sent goes back to its card, with why, rather than into the composer.
        const card = [...cards.values()].find((draft) => draft.sent !== null && draft.sent === one.text && draft.workItemId === one.workItemId);

        if (card !== undefined) {
          card.sent = null;
          card.error = one.error;
          draw();
        } else {
          composer?.unsent(one.text, one.error, one.workItemId);
        }
      }
    } else if (event.data.type === 'copied') {
      const button = copies.get(event.data.id);

      copies.delete(event.data.id);

      // As Claude Code's: a check in place of the copy icon for 2 seconds; a redraw in between draws the copy icon again.
      if (button !== undefined && event.data.ok) {
        const icon = button.querySelector('.codicon');
        const title = button.title;

        icon?.classList.replace('codicon-copy', 'codicon-check');
        button.title = 'Copied';
        live.textContent = 'Copied';
        setTimeout(() => {
          icon?.classList.replace('codicon-check', 'codicon-copy');
          button.title = title;
        }, COPIED_MS);
      }
    }
  });

  composer?.update(state);
  draw();
  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startConversation(document.getElementById('root')!, document.getElementById('live')!, acquireVsCodeApi(), document.getElementById('composer')!);
}
