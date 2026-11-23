// The page's frame and the composer's parts (architecture.md § Web page): the hosts each region is drawn into, the composer's box and footer,
// its `@` and `/` lists, its voice controls and the ended session's note above it.
import type { VNode } from 'preact';
import type { PageState } from './model.js';
import { trusted } from './trusted.js';

/** The page's hosts: the list and its sheet and the drawer's sash, the sashes, the hidden list's sliver and the open drawer's backdrop, the conversation's header, pane, note and composer, the side column, History and the sheet. */
export function renderFrame(side: { min: number; max: number }, chat: { min: number; max: number }): VNode {
  return (
    <>
      <aside class="side">
        <div class="side-head"></div>
        <div id="list"></div>
        <div id="list-sheet"></div>
        <div class="sash drawer-sash" role="separator" aria-orientation="vertical" aria-label="Work items width" aria-controls="list" tabindex={0} aria-valuemin={side.min} aria-valuemax={side.max} title="Drag to resize; double-click to reset"></div>
      </aside>
      <div class="sash side-sash" role="separator" aria-orientation="vertical" aria-label="Work items width" aria-controls="list" tabindex={0} aria-valuemin={side.min} aria-valuemax={side.max} title="Drag to resize; double-click to reset"></div>
      <div class="sliver" aria-hidden="true"></div>
      <div class="drawer-backdrop" aria-hidden="true"></div>
      <main class="main">
        <div id="head"></div>
        <div id="panel" class="scroll"></div>
        <div id="note"></div>
        <div id="composer" hidden></div>
      </main>
      <div class="sash chat-sash" role="separator" aria-orientation="vertical" aria-label="Conversation width" aria-controls="panel" tabindex={0} aria-valuemin={chat.min} aria-valuemax={chat.max} title="Drag to resize; double-click to reset"></div>
      <aside id="detail" class="detail" aria-label="Status and artifacts">
        <div class="detail-head"></div>
        <div class="detail-body scroll"></div>
      </aside>
      <section id="history" class="history-view" aria-label="History"></section>
      <div id="sheet"></div>
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
        <div class="glass composer-menu" role="listbox" hidden></div>
        <div class="attachments" role="list" aria-label="Attached files" hidden></div>
        <div class="composer-input">
          <div class="live-mirror">
            <span class="mirror-text" aria-hidden="true"></span>
            <span class="live-words" aria-live="polite" hidden></span>
          </div>
          <textarea rows={1} aria-label="Message"></textarea>
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

/** The composer's `@` or `/` list, or what found nothing. */
export function renderComposerMenu(menu: ComposerMenu, active: number): VNode {
  if (menu.items.length === 0) {
    return <div class="menu-empty">{menu.kind === 'files' ? 'No matching files' : 'No matching commands'}</div>;
  }

  return (
    <>
      {menu.kind === 'files'
        ? menu.items.map((item, index) => (
            <div class={`menu-item${index === active ? ' active' : ''}`} role="option" data-index={String(index)}>
              <span class={`codicon codicon-${item.dir ? 'folder' : 'file'}`}></span>
              <span class="menu-name">{item.path}</span>
            </div>
          ))
        : menu.items.map((item, index) => (
            <div class={`menu-item command${index === active ? ' active' : ''}`} role="option" data-index={String(index)}>
              <span class="menu-label">/{item.name}</span>
              {item.description === '' ? null : <span class="menu-description">{item.description}</span>}
            </div>
          ))}
    </>
  );
}

/** HTML of the voice controls, the mic and the context meter, drawn by the renderers the Conversation view shares. */
export function renderShared(html: string): VNode {
  return <>{trusted(html)}</>;
}

/**
 * The note above the composer while the session has ended, with Resume, as the Conversation view's; a session the page cannot talk to at all
 * (`none`) gets only its reason.
 */
export function renderEndedNote(session: PageState['session'], resuming: boolean): VNode | null {
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
