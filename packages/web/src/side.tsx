// The Status and Artifacts tabs (architecture.md § Web page), in the tab strip or the column right of the conversation.
import type { VNode } from 'preact';
import { stampTime } from '@switchboard/conversation/messageMeta';
import { answers } from '@switchboard/conversation/questions';
import { artifactIcon } from './model.js';
import type { PageState } from './model.js';
import { renderMarkdown } from './markdown.js';
import { ago, artifactUrl, framed, withoutQuestions } from './render.js';
import type { View } from './render.js';
import { cardOf } from './timeline.js';
import { trusted } from './trusted.js';
import type { ArtifactView, StatusView } from './types.js';

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

/**
 * An open artifact (architecture.md § Web page), in place in its pane: a page or an SVG in a sandboxed frame with an opaque origin, pictures,
 * audio and video in the page, Markdown as the page drew it from its text (`doc`: its HTML, null when it could not be read, undefined while it
 * loads), and anything else as a download. Its head has the kind as a badge and the title, as claude-collab's viewer, then Open in new window and
 * Download. Each version is drawn afresh, so its files load again (`?v=`), and an unchanged one is left as it is, so a frame or a video is not
 * reloaded.
 */
export function renderArtifactView(key: string, artifact: ArtifactView, doc?: string | null): VNode {
  const file = artifactUrl(key, artifact.path);
  const url = `${file}?v=${artifact.updatedAt}`;
  const body = framed(artifact) ? (
    <iframe class="artifact-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src={url} title={artifact.title}></iframe>
  ) : artifact.type === 'image' ? (
    <img class="media" alt={artifact.title} src={url} />
  ) : artifact.type === 'audio' ? (
    <audio class="media" controls preload="metadata" src={url}></audio>
  ) : artifact.type === 'video' ? (
    <video class="media" controls preload="metadata" src={url}></video>
  ) : artifact.type === 'markdown' ? (
    <div class="artifact-doc body">{doc === undefined ? <p class="empty">Loading…</p> : doc === null ? <p class="empty">This artifact could not be read.</p> : trusted(doc)}</div>
  ) : (
    <p class="empty">
      <a href={file} download="">
        Download {artifact.path.split('/').pop() ?? artifact.path}
      </a>
    </p>
  );

  return (
    <div class="artifact-view" data-artifact={artifact.path} data-version={String(artifact.updatedAt)} key={`${artifact.path}@${artifact.updatedAt}`}>
      <div class="artifact-head">
        <button class="icon" type="button" data-action="close-artifact" title="Back to the list" aria-label="Back">
          <span class="codicon codicon-arrow-left"></span>
        </button>
        <span class="artifact-badge">{artifact.kind}</span>
        <span class="artifact-title">{artifact.title}</span>
        {artifact.type === 'markdown' ? (
          <button class="icon" type="button" data-action="artifact-window" title="Open in new window" aria-label="Open in new window">
            <span class="codicon codicon-link-external"></span>
          </button>
        ) : (
          <a class="icon" href={url} target="_blank" rel="noopener noreferrer" title="Open in new window" aria-label="Open in new window">
            <span class="codicon codicon-link-external"></span>
          </a>
        )}
        <a class="icon" href={file} download="" title="Download" aria-label="Download">
          <span class="codicon codicon-desktop-download"></span>
        </a>
      </div>
      {body}
    </div>
  );
}
