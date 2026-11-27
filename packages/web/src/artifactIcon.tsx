// An artifact's type, by what the file is and how the page shows it, which the page shows in place of the kind its session gave it.
import type { VNode } from 'preact';
import type { ArtifactView } from '@switchboard/protocol';
import { artifactShow } from './render.js';
import { viewType } from './fileView.js';

/** An artifact's type as the page names it, and its codicon: the file viewer's (`viewType`), by how the page shows it. */
export function artifactType(artifact: ArtifactView): { name: string; icon: string } {
  const show = artifactShow(artifact);

  return viewType(show === 'text' ? 'code' : show === 'download' ? 'none' : show, artifact.type === 'html');
}

/** An artifact's type icon: named by its type where `named`, as where nothing else around it names the type, else hidden from screen readers. */
export function ArtifactIcon({ artifact, named = false }: { artifact: ArtifactView; named?: boolean }): VNode {
  const { name, icon } = artifactType(artifact);

  return named ? <span class={`codicon codicon-${icon} artifact-type`} role="img" aria-label={name} title={name}></span> : <span class={`codicon codicon-${icon} artifact-type`} aria-hidden="true"></span>;
}
