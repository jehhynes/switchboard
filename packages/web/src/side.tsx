// The Status and Artifacts tabs (architecture.md § Web page), in the tab strip or the column right of the conversation.
import type { VNode } from 'preact';
import { stampTime } from '@switchboard/conversation/messageMeta';
import { answers } from '@switchboard/conversation/questions';
import { artifactIcon } from './model.js';
import type { PageState } from './model.js';
import { renderMarkdown } from './markdown.js';
import { ago, withoutQuestions } from './render.js';
import type { View } from './render.js';
import { cardOf } from './timeline.js';
import { trusted } from './trusted.js';
import type { StatusView } from './types.js';

/** The Status tab: the latest status as Markdown with its time and age and a New mark while unread, or the stage dimmed. */
export function renderStatus(state: PageState, view: View, now: number): VNode {
  const status: StatusView | null = state.status;

  if (status === null) {
    return <p class="empty">No status yet. It appears here when the session reports one.</p>;
  }

  const answer = (): string | null => {
    const from = state.items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
    const later = (from === -1 ? state.items.filter((item) => item.at > status.at) : state.items.slice(from + 1)).find((item) => item.type === 'message' && answers(item));

    return later?.type === 'message' ? later.text : null;
  };
  const card = status.fallback ? null : cardOf(`status:${status.id}`, status.markdown, answer(), view, state.connected && state.session?.conversation === 'full');

  return (
    <div class={`status-tab${status.fallback ? ' fallback' : ''}${status.unread ? ' unread' : ''}`} data-unread={status.unread ? status.id : undefined}>
      <div class="status-head">
        <span class="codicon codicon-pulse" aria-hidden="true"></span>
        <span class="status-label">{status.fallback ? 'Stage' : 'Status'}</span>
        <span class="status-age">
          {stampTime(status.at)} · {ago(status.at, now)}
        </span>
        {status.unread ? <span class="status-new">New</span> : null}
      </div>
      <div class="status-body body">{trusted(card === null ? renderMarkdown(status.markdown) : withoutQuestions(status.markdown, `status:${status.id}`, view.open))}</div>
      {card}
    </div>
  );
}

/** The Artifacts tab: the work item's artifacts newest first; a click opens one in the page. */
export function renderArtifacts(state: PageState, now: number): VNode {
  if (state.artifacts.length === 0) {
    return <p class="empty">No artifacts yet. They appear here when the session writes one.</p>;
  }

  return (
    <ul class="artifact-list">
      {state.artifacts.map((artifact) => (
        <li key={artifact.path}>
          <button class="artifact-open" type="button" data-action="artifact" data-path={artifact.path} title={artifact.path}>
            <span class={`codicon codicon-${artifactIcon(artifact.type)}`} aria-hidden="true"></span>
            <span class="artifact-title">{artifact.title}</span>
            <span class="artifact-kind">
              {artifact.kind} · {ago(artifact.updatedAt, now)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A pane's one line when it has nothing else to show. */
export function renderEmpty(text: string): VNode {
  return <p class="empty">{text}</p>;
}
