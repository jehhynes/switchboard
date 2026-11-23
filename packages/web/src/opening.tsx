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
      <span class="opening-title" title={opening.title}>
        {opening.title}
      </span>
      <ConnectionDot dot={dot} />
    </header>
  );
}

export function renderOpening(opening: Opening): VNode {
  if (opening.error !== null) {
    return (
      <div class="opening-failed" role="alert">
        <h3>Couldn't open this work item</h3>
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
