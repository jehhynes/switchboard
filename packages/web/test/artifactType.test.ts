import { describe, expect, it } from 'vitest';
import { artifactType } from '../src/artifactIcon.js';
import { EMPTY } from '../src/model.js';
import { newView } from '../src/render.js';
import { renderArtifacts } from '../src/side.js';
import { renderTimeline } from '../src/timeline.js';
import type { ArtifactView, MessageView, SessionView } from '@switchboard/protocol';
import { html } from './html.js';

const artifact = (path: string, type: ArtifactView['type'], patch: Partial<ArtifactView> = {}): ArtifactView => ({ path, owner: 'chat', kind: 'plan', title: 'Rollout steps', ext: path.slice(path.lastIndexOf('.') + 1), type, updatedAt: 1_000, ...patch });
const parse = (markup: string): HTMLElement => {
  const root = document.createElement('div');

  root.innerHTML = markup;

  return root;
};
const session: SessionView = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null };
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const message: MessageView = { type: 'message', id: 'm1', sessionId: 's', workItemId: 1, at: 500, ord: 1, provisional: false, withdrawn: false, origin: 'typed', text: 'Write the plan', delivery: 'sent', error: null };

describe('artifactType', () => {
  it('ArtifactType_EachWayThePageShowsAFile_NamesItAndPicksItsIcon', () => {
    expect([
      artifact('chat/a.md', 'markdown'),
      artifact('chat/a.html', 'html'),
      artifact('chat/a.svg', 'image'),
      artifact('chat/a.png', 'image'),
      artifact('chat/a.mp3', 'audio'),
      artifact('chat/a.mp4', 'video'),
      artifact('chat/a.pdf', 'file'),
      artifact('chat/a.json', 'file'),
      artifact('chat/a.zip', 'file'),
    ].map(artifactType)).toEqual([
      { name: 'Markdown document', icon: 'markdown' },
      { name: 'HTML page', icon: 'globe' },
      { name: 'Picture', icon: 'file-media' },
      { name: 'Picture', icon: 'file-media' },
      { name: 'Recording', icon: 'unmute' },
      { name: 'Video', icon: 'device-camera-video' },
      { name: 'PDF', icon: 'file-pdf' },
      { name: 'Text or data', icon: 'file-text' },
      { name: 'Other file', icon: 'file-binary' },
    ]);
  });

  it('ArtifactsTab_ArtifactWithKind_ShowsTypeIconTitleAndAgeNotKind', () => {
    const root = parse(html(renderArtifacts({ ...EMPTY, artifacts: [artifact('chat/plan.pdf', 'file')] }, 1_000 + 4 * 60_000)));
    const open = root.querySelector('.artifact-open')!;

    expect(open.querySelector('.artifact-type.codicon-file-pdf')!.getAttribute('aria-label')).toBe('PDF');
    expect(open.querySelector('.artifact-title')!.textContent).toBe('Rollout steps');
    expect(open.querySelector('.artifact-age')!.textContent).toBe('4 min ago');
    expect(open.textContent).not.toContain('plan');
    expect(root.querySelector('.artifact-kind')).toBeNull();
  });

  it('ConversationArtifactCard_ArtifactWithKind_ShowsTypeIconTitleAndAgeNotKind', () => {
    const root = parse(html(renderTimeline({ ...EMPTY, connected: true, scope, session, items: [message], artifacts: [artifact('chat/plan.html', 'html')] }, newView(), 1_000 + 2 * 3_600_000)));
    const card = root.querySelector('li.artifact .artifact-open')!;

    expect(card.querySelector('.artifact-type.codicon-globe')!.getAttribute('aria-label')).toBe('HTML page');
    expect(card.querySelector('.artifact-title')!.textContent).toBe('Rollout steps');
    expect(card.querySelector('.artifact-age')!.textContent).toBe('2 h ago');
    expect(card.textContent).not.toContain('plan');
  });
});
