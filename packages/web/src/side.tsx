// The Artifacts tab and an open artifact (architecture.md § Web page), in the tab strip or the column right of the conversation.
import type { VNode } from 'preact';
import { fullTime } from '@switchboard/conversation/messageMeta';
import { ArtifactIcon } from './artifactIcon.js';
import type { PageState } from './model.js';
import { ago, artifactShow, artifactUrl } from './render.js';
import { trusted } from './trusted.js';
import type { ArtifactView } from '@switchboard/protocol';

/** The Artifacts tab: the work item's artifacts newest first, each by its type's icon, its title and when it changed; a click opens one in the page. */
export function renderArtifacts(state: PageState, now: number): VNode {
  if (state.artifacts.length === 0) {
    return <p class="empty">No artifacts yet. They appear here when the session writes one.</p>;
  }

  return (
    <ul class="artifact-list">
      {state.artifacts.map((artifact) => (
        <li key={artifact.path}>
          <button class="artifact-open" type="button" data-action="artifact" data-path={artifact.path} title={artifact.file ?? artifact.path}>
            <ArtifactIcon artifact={artifact} named />
            <span class="artifact-title">{artifact.title}</span>
            <span class="artifact-age">{ago(artifact.updatedAt, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The conversation pane with no work item open: centred, saying so, and offering the first work item waiting on you in Blocked on you, as F8
 * would open it; while the page connects, that it connects.
 */
export function renderNoWorkItem(connected: boolean, next: { workItemId: number; title: string } | null): VNode {
  return (
    <div class="empty-pane">
      <p class="empty">{connected ? 'No work item open. Choose one in the list to see its conversation.' : 'Connecting to Switchboard…'}</p>
      {connected && next !== null ? (
        <button type="button" class="sheet-button primary empty-pane-next" data-action="select" data-work-item={String(next.workItemId)} title={next.title}>
          <span class="empty-pane-label">Open {next.title}</span>
        </button>
      ) : null}
    </div>
  );
}

/** A pane's one line when it has nothing else to show. */
export function renderEmpty(text: string): VNode {
  return <p class="empty">{text}</p>;
}

/**
 * An open artifact (architecture.md § Web page), in place in its pane: a page or an SVG in a sandboxed frame with an opaque origin, pictures,
 * audio and video in the page, Markdown as the page drew it from its text (`doc`: its HTML, null when it could not be read, undefined while it
 * loads), and for anything else a note that it cannot be shown. Its head has its type's icon, its title, when it changed, with the full time as its
 * tooltip, and Open in new window.
 * Each version is drawn afresh, so its files load again (`?v=`), and an unchanged one is left as it is, so a frame or a video is not
 * reloaded.
 */
export function renderArtifactView(key: string, artifact: ArtifactView, doc?: string | null, now: number = Date.now()): VNode {
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
    <p class="empty">This kind of file cannot be shown here. Open it in a new window.</p>
  );

  return (
    <div class="artifact-view" data-artifact={artifact.path} data-version={String(artifact.updatedAt)} key={`${artifact.path}@${artifact.updatedAt}`}>
      <div class="artifact-head">
        <ArtifactIcon artifact={artifact} named />
        <span class="artifact-title" title={artifact.file}>{artifact.title}</span>
        <time class="artifact-age" dateTime={new Date(artifact.updatedAt).toISOString()} title={fullTime(artifact.updatedAt)}>
          {ago(artifact.updatedAt, now)}
        </time>
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
