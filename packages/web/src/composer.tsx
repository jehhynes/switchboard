// The page's frame and the composer's parts (architecture.md § Web page): the hosts each region is drawn into, the composer's box and footer,
// its `@` and `/` lists, its voice controls and the ended session's note above it.
import type { VNode } from 'preact';
import type { PageState } from './model.js';
import type { NewDraft } from './render.js';
import { providerMark } from '@switchboard/conversation/providerIcons';
import { PROVIDERS } from './listHeader.js';
import { trusted } from './trusted.js';

/** The page's hosts: the list and the drawer's sash, the sashes, the hidden list's sliver and the open drawer's backdrop, the conversation's header, pane, note and composer, the side column, the list header's sheet and the page's sheet. */
export function renderFrame(side: { min: number; max: number }, chat: { min: number; max: number }): VNode {
  return (
    <>
      <aside class="side">
        <div class="side-head"></div>
        <div class="conn-banner-host"></div>
        <div id="list"></div>
        <div class="sash drawer-sash" role="separator" aria-orientation="vertical" aria-label="Work items width" aria-controls="list" tabindex={0} aria-valuemin={side.min} aria-valuemax={side.max} title="Drag to resize; double-click to reset"></div>
      </aside>
      <div class="sash side-sash" role="separator" aria-orientation="vertical" aria-label="Work items width" aria-controls="list" tabindex={0} aria-valuemin={side.min} aria-valuemax={side.max} title="Drag to resize; double-click to reset"></div>
      <div class="sliver" aria-hidden="true"></div>
      <div class="drawer-backdrop" aria-hidden="true"></div>
      <main class="main">
        <div id="head"></div>
        <div class="conn-banner-host"></div>
        <div id="panel" class="scroll"></div>
        <div id="note"></div>
        <div id="composer" hidden></div>
      </main>
      <div class="sash chat-sash" role="separator" aria-orientation="vertical" aria-label="Conversation width" aria-controls="panel" tabindex={0} aria-valuemin={chat.min} aria-valuemax={chat.max} title="Drag to resize; double-click to reset"></div>
      <aside id="detail" class="detail" aria-label="History and artifacts">
        <div class="detail-head"></div>
        <div class="detail-body scroll"></div>
      </aside>
      <div id="list-sheet"></div>
      <div id="sheet"></div>
      <div id="connection"></div>
      <div class="live" aria-live="polite"></div>
    </>
  );
}

/** The composer: its Sent line over the box; in the box the lists, the chips, the text and live words, and the footer's controls. */
export function renderComposer(): VNode {
  return (
    <>
      {/* While a card that can be answered is out of view, how many of its questions wait; the page fills it in (PRD R103). */}
      <button class="question-waiting" type="button" data-action="goto-card" title="Go to the questions" hidden></button>
      <div class="composer-sent" role="status" hidden>
        <span class="codicon codicon-check" aria-hidden="true"></span>
        <span>Sent. Its reply shows on the Conversation tab.</span>
      </div>
      <div class="composer">
        <div class="glass composer-menu" id="composer-list" role="listbox" hidden></div>
        <div class="attachments" role="list" aria-label="Attached files" hidden></div>
        <div class="composer-input">
          <div class="live-mirror">
            <span class="mirror-text" aria-hidden="true"></span>
            <span class="live-words" aria-live="polite" hidden></span>
          </div>
          {/* The box names the list it completes from and its active option, as a combobox does; a textarea may not take that role. */}
          <textarea rows={1} aria-label="Message" aria-autocomplete="list" aria-controls="composer-list"></textarea>
        </div>
        {/* While the box has the focus and the mic is on here: dictation joins the draft and waits for Send (architecture.md § Dictation). */}
        <div class="composer-hint" hidden>
          Your dictation goes into the draft — press Send
        </div>
        <div class="composer-footer">
          <div class="composer-controls">
            <button class="composer-tool attach" type="button" title="Attach files…" aria-label="Attach files">
              <span class="codicon codicon-add" aria-hidden="true"></span>
            </button>
            <input class="attach-input" type="file" multiple hidden tabindex={-1} aria-hidden="true" />
            <button class="composer-tool slash" type="button" title="Show slash commands (/)" aria-label="Show slash commands">
              <span class="slash-glyph">/</span>
            </button>
            <span class="context-meter"></span>
          </div>
          <div class="composer-end">
            <div class="voice-controls"></div>
            <span class="composer-mic"></span>
            <button class="send" type="button" title="Send (Enter)" aria-label="Send" disabled>
              <span class="codicon codicon-arrow-up"></span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** What the composer's list shows: files and folders after `@`, or the session's slash commands after `/`, the active one marked. */
export type ComposerMenu = { kind: 'files'; items: Array<{ path: string; dir: boolean }> } | { kind: 'commands'; items: Array<{ name: string; description: string }> };

/** The id of the composer list's option at `index`, which the box names as its active one. */
export const composerOptionId = (index: number): string => `composer-option-${index}`;

/** The composer's `@` or `/` list, or what found nothing as an option that cannot be chosen. */
export function renderComposerMenu(menu: ComposerMenu, active: number): VNode {
  if (menu.items.length === 0) {
    return (
      <div class="menu-empty" role="option" aria-disabled="true" aria-selected="false">
        {menu.kind === 'files' ? 'No matching files' : 'No matching commands'}
      </div>
    );
  }

  return (
    <>
      {menu.kind === 'files'
        ? menu.items.map((item, index) => (
            <div class={`menu-item${index === active ? ' active' : ''}`} id={composerOptionId(index)} role="option" aria-selected={index === active} data-index={String(index)}>
              <span class={`codicon codicon-${item.dir ? 'folder' : 'file'}`}></span>
              <span class="menu-name">{item.path}</span>
            </div>
          ))
        : menu.items.map((item, index) => (
            <div class={`menu-item command${index === active ? ' active' : ''}`} id={composerOptionId(index)} role="option" aria-selected={index === active} data-index={String(index)}>
              <span class="menu-label">/{item.name}</span>
              {item.description === '' ? null : <span class="menu-description">{item.description}</span>}
            </div>
          ))}
    </>
  );
}

/** HTML of the voice controls, the mic and the context meter, drawn by the renderers in packages/conversation. */
export function renderShared(html: string): VNode {
  return <>{trusted(html)}</>;
}

/**
 * The note above the composer while the session has ended, with Resume; a session the page cannot talk to at all
 * (`none`) gets only its reason.
 */
export function renderEndedNote(session: PageState['session'], resuming: boolean, earlierOf: number | null = null): VNode | null {
  // An earlier session of work item `earlierOf` is only read, so it offers no Resume, ended or not, but a way back to the current one.
  if (earlierOf !== null && session !== null) {
    return (
      <div class="session-note" role="status">
        <span class="codicon codicon-history state-icon tone-muted" aria-hidden="true"></span>
        <span class="session-note-text">An earlier session of this work item, shown read-only.</span>
        <button type="button" class="session-resume" data-action="select" data-work-item={String(earlierOf)}>
          Show current session
        </button>
      </div>
    );
  }

  if (session?.state !== 'ended') {
    return null;
  }

  const resumable = session.conversation !== 'none';

  return (
    <div class="session-note" role="status">
      <span class="codicon codicon-stop-circle state-icon tone-muted" aria-hidden="true"></span>
      <span class="session-note-text">{resumable ? 'The session has ended. Resume continues it.' : (session.reason ?? 'The session has ended.')}</span>
      {resumable ? (
        <button type="button" class="session-resume" data-action="resume" disabled={resuming}>
          {resuming ? 'Resuming…' : 'Resume'}
        </button>
      ) : null}
    </div>
  );
}


/**
 * The note above the composer while New conversation…'s draft shows: that nothing has started yet, the New session form's provider switch while
 * more than one provider is installed, and Cancel, which goes back to the current session and starts nothing.
 */
export function renderDraftNote(draft: NewDraft): VNode {
  const installed = draft.installed ?? [];

  return (
    <div class="session-note draft-note" role="status">
      <span class="codicon codicon-add state-icon tone-muted" aria-hidden="true"></span>
      <span class="session-note-text">{draft.sending ? 'Starting the new conversation…' : 'New conversation. It starts when you send the first message.'}</span>
      {installed.length > 1 ? (
        <div class="provider-switch" role="group" aria-label="Provider">
          {PROVIDERS.filter((one) => installed.includes(one.provider)).map((one) => (
            <button type="button" class="provider-option" data-action="draft-provider" data-provider={one.provider} aria-pressed={one.provider === draft.provider} disabled={draft.sending}>
              {trusted(providerMark(one.provider, 'provider-option-mark'))}
              <span>{one.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" class="session-resume" data-action="draft-cancel" disabled={draft.sending}>
        Cancel
      </button>
    </div>
  );
}
