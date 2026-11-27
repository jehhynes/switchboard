// The Artifacts tab and an open artifact (architecture.md § Web page), in the tab strip or the column right of the conversation; the file viewer
// (fileView.tsx) draws an open one.
import type { VNode } from 'preact';
import { ArtifactIcon } from './artifactIcon.js';
import type { PageState } from './model.js';
import { ago, artifactShow, artifactUrl } from './render.js';
import type { FileSpec, ViewKind } from './fileView.js';
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
 * An open artifact as the file viewer shows it (architecture.md § Web page, File viewer): a page or an SVG in a frame sandboxed to scripts with
 * an opaque origin, pictures, recordings and videos in the page, Markdown as the page drew it from its text (`doc`, undefined while it loads),
 * text, data and code in the diff viewer's file mode, and for anything else a note that it cannot be shown. Each version loads its files again
 * (`?v=`). Its path is its real path, an external artifact's `file` or its place in `artifactsDir`, which the head shows by `shown`.
 */
export function artifactFileSpec(key: string, artifact: ArtifactView, doc: { html: string | null | undefined; text?: string | null } | undefined, artifactsDir: string | null, shown: (path: string) => string = (path) => path): FileSpec {
  const show = artifactShow(artifact);
  const kind: ViewKind = show === 'text' ? 'code' : show === 'download' ? 'none' : show;
  const url = `${artifactUrl(key, artifact.path)}?v=${artifact.updatedAt}`;
  const folder = (artifactsDir ?? '').replaceAll('\\', '/').replace(/\/$/, '');
  const path = (artifact.file ?? (folder === '' ? artifact.path : `${folder}/${artifact.path}`)).replaceAll('\\', '/');
  const read = kind === 'code' || kind === 'markdown';

  return {
    id: `artifact:${artifact.path}`,
    version: String(artifact.updatedAt),
    kind,
    html: artifact.type === 'html',
    title: artifact.title,
    path,
    shown: shown(path),
    line: null,
    changed: artifact.updatedAt,
    contents: doc?.text ?? null,
    markdown: kind === 'markdown' ? doc?.html : undefined,
    ...(read ? {} : { rawUrl: url }),
    note: kind !== 'code' ? null : doc === undefined ? 'Loading…' : doc.text == null ? 'This artifact could not be read.' : null,
    open: artifact.type === 'markdown' ? { action: 'artifact-window' } : { href: url },
    artifact: artifact.path,
  };
}
