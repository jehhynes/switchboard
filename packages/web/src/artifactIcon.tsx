// An artifact's type, by what the file is and how the page shows it, which the page shows in place of the kind its session gave it.
import type { VNode } from 'preact';
import type { ArtifactView } from '@switchboard/protocol';
import { artifactShow } from './render.js';

/** An artifact's type as the page names it, and its codicon. */
export function artifactType(artifact: ArtifactView): { name: string; icon: string } {
  switch (artifactShow(artifact)) {
    case 'markdown':
      return { name: 'Markdown document', icon: 'markdown' };
    case 'frame':
      return artifact.type === 'html' ? { name: 'HTML page', icon: 'globe' } : { name: 'Picture', icon: 'file-media' };
    case 'image':
      return { name: 'Picture', icon: 'file-media' };
    case 'audio':
      return { name: 'Recording', icon: 'unmute' };
    case 'video':
      return { name: 'Video', icon: 'device-camera-video' };
    case 'pdf':
      return { name: 'PDF', icon: 'file-pdf' };
    case 'text':
      return { name: 'Text or data', icon: 'file-text' };
    case 'download':
      return { name: 'Other file', icon: 'file-binary' };
  }
}

/** An artifact's type icon: named by its type where `named`, as where nothing else around it names the type, else hidden from screen readers. */
export function ArtifactIcon({ artifact, named = false }: { artifact: ArtifactView; named?: boolean }): VNode {
  const { name, icon } = artifactType(artifact);

  return named ? <span class={`codicon codicon-${icon} artifact-type`} role="img" aria-label={name} title={name}></span> : <span class={`codicon codicon-${icon} artifact-type`} aria-hidden="true"></span>;
}
