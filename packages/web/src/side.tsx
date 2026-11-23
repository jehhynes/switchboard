// The Status and Artifacts tabs (architecture.md § Web page), in the tab strip or the column right of the conversation.
import type { VNode } from 'preact';
import { stampTime } from '@switchboard/conversation/messageMeta';
import { artifactIcon } from './model.js';
import type { PageState } from './model.js';
import { renderMarkdown } from './markdown.js';
import { stripQuestionMarkup } from '@switchboard/conversation/questions';
import { UnreadDot } from './header.js';
import { ago, artifactShow, artifactUrl } from './render.js';
import { trusted } from './trusted.js';
import type { ArtifactView, StatusView } from '@switchboard/protocol';

/**
 * The Status tab: the latest status as Markdown with its time and age and the unread dot while unread, or the stage dimmed. Questions in a status are
 * plain Markdown; question cards show only in the conversation.
 */
export function renderStatus(state: PageState, now: number): VNode {
  const status: StatusView | null = state.status;

  if (status === null) {
    return <p class="empty">No status yet. It appears here when the session reports one.</p>;
  }

  return (
    <div class={`status-tab${status.fallback ? ' fallback' : ''}${status.unread ? ' unread' : ''}`} data-unread={status.unread ? status.id : undefined}>
      <div class="status-head">
        <span class="codicon codicon-pulse" aria-hidden="true"></span>
        <span class="status-label">{status.fallback ? 'Stage' : 'Status'}</span>
        <span class="status-age">
          {trusted(stampTime(status.at))} · {ago(status.at, now)}
        </span>
        {status.unread ? <UnreadDot /> : null}
      </div>
      <div class="status-body md-doc body">{trusted(renderMarkdown(stripQuestionMarkup(status.markdown)))}</div>
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
 * loads), and for anything else a note that it cannot be shown. Its head has the kind as a badge and the title, as claude-collab's viewer, then Open in new window.
 * Each version is drawn afresh, so its files load again (`?v=`), and an unchanged one is left as it is, so a frame or a video is not
 * reloaded.
 */
export function renderArtifactView(key: string, artifact: ArtifactView, doc?: string | null): VNode {
  const file = artifactUrl(key, artifact.path);
  const url = `${file}?v=${artifact.updatedAt}`;
  const show = artifactShow(artifact);
  const body = show === 'frame' ? (
    <iframe class="artifact-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src={url} title={artifact.title}></iframe>
  ) : show === 'pdf' ? (
    <iframe class="artifact-frame artifact-pdf" referrerpolicy="no-referrer" src={url} title={artifact.title}></iframe>
  ) : show === 'image' ? (
    <img class="media" alt={artifact.title} src={url} />
  ) : show === 'audio' ? (
    <audio class="media" controls preload="metadata" src={url}></audio>
  ) : show === 'video' ? (
    <video class="media" controls preload="metadata" src={url}></video>
  ) : show === 'markdown' || show === 'text' ? (
    <div class="artifact-doc md-doc body">{doc === undefined ? <p class="empty">Loading…</p> : doc === null ? <p class="empty">This artifact could not be read.</p> : trusted(doc)}</div>
  ) : (
    <p class="empty">The page cannot show this kind of file. Open it in a new window from the button above.</p>
  );

  return (
    <div class="artifact-view" data-artifact={artifact.path} data-version={String(artifact.updatedAt)} key={`${artifact.path}@${artifact.updatedAt}`}>
      <div class="artifact-head">
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
      </div>
      {body}
    </div>
  );
}
