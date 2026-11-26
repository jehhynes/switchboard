// A work item being opened (architecture.md § Web page, Opening a work item): its own head and a placeholder at once, then its conversation, or
// why it could not be opened in its place. The work item shown before never shows under another one's title.
import type { VNode } from 'preact';
import { ConnectionDot } from './connectionView.js';
import type { DotView } from './connectionView.js';

/** The work item being opened, and why it could not be, or null while it opens. */
export interface Opening {
  workItemId: number;
  title: string;
  error: string | null;
}

export function renderOpeningHead(opening: Opening, dot: DotView | null | undefined): VNode {
  return (
    <header class="header opening-head">
      <button type="button" class="icon back-toggle" data-action="back" title="Back to work items" aria-label="Back to work items">
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>
      <button type="button" class="icon list-toggle" data-action="drawer" title="Work items" aria-label="Work items" aria-controls="list">
        <span class="codicon codicon-layout-sidebar-left" aria-hidden="true"></span>
      </button>
      {/* Drawn as the picker the work item's own head has, so the head keeps its height. */}
      <button type="button" class="picker opening-title" title={opening.title} tabindex={-1} disabled>
        <span class="title">{opening.title}</span>
      </button>
      <ConnectionDot dot={dot} />
    </header>
  );
}

export function renderOpening(opening: Opening): VNode {
  if (opening.error !== null) {
    return (
      <div class="opening-failed" role="alert">
        <h3>This work item did not open</h3>
        <p class="opening-why">{opening.error}</p>
        <div class="opening-actions">
          <button type="button" class="conn-primary" data-action="open-retry">
            Try again
          </button>
          <button type="button" class="opening-back" data-action="open-back">
            Back to the list
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="opening" role="status" aria-busy="true">
      <p class="opening-note">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
        <span>Opening…</span>
      </p>
      <div class="opening-skeleton mine"></div>
      <div class="opening-skeleton"></div>
      <div class="opening-skeleton mine"></div>
      <div class="opening-skeleton"></div>
    </div>
  );
}

/**
 * The tab strip in the place of the work item's own while it opens: Conversation where the tabs hold it, then History and Console, dimmed and
 * inert, so the strip keeps its height and the work item's own replaces it in place. `column` for the strip atop the column right of the conversation.
 */
export function renderOpeningTabs(column: boolean): VNode {
  const labels = column ? ['History', 'Console'] : ['Conversation', 'History', 'Console'];

  return (
    <nav class={`tabs opening-tabs${column ? ' side-switch' : ''}`} aria-hidden="true">
      {labels.map((label, index) => (
        <button type="button" class={`tab${index === 0 ? ' selected' : ''}`} tabindex={-1} disabled>
          {label}
        </button>
      ))}
    </nav>
  );
}

/** The column right of the conversation while the work item opens: a loading note, or nothing once the open failed, whose reason the conversation's place shows. */
export function renderOpeningSide(opening: Opening): VNode | null {
  if (opening.error !== null) {
    return null;
  }

  return (
    <div class="opening opening-side" aria-busy="true">
      <p class="opening-note">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span> Loading…
      </p>
      <div class="opening-skeleton"></div>
      <div class="opening-skeleton short"></div>
    </div>
  );
}
