import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ArtifactView } from '@switchboard/hub';
import { artifactFile, artifactPage, assetResolver, assetsRoot, unopened } from './artifactModel.js';
import type { Opened } from './artifactModel.js';
import { EMPTY_CONVERSATION } from './conversationModel.js';
import type { ConversationState } from './conversationModel.js';
import { escape } from './webview/conversationRender.js';

/** Opens an artifact of this window by its path, from the Artifacts tab's rows and the timeline's. */
export const OPEN_ARTIFACT = 'switchboard.openArtifact';
/** The webview panel an HTML artifact opens in. */
export const ARTIFACT_PANEL = 'switchboard.artifact';
/** The workspace state key of when each artifact was last opened, by work item and path. */
const OPENED = 'artifacts.opened';
/**
 * The window's artifacts (architecture.md § Artifacts): which of them are new or changed since they were last opened in the workspace, which the
 * Conversation view's Artifacts tab marks and counts, and opening one natively.
 */
export class Artifacts {
  #state: ConversationState = EMPTY_CONVERSATION;
  readonly #panels = new ArtifactPanels();

  /** `changed` hears when the opened artifacts change, so the Artifacts tab is drawn again. */
  constructor(
    private readonly memento: vscode.Memento,
    private readonly changed: () => void,
  ) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(this.#panels, vscode.commands.registerCommand(OPEN_ARTIFACT, (path: unknown) => this.open(String(path))));
  }

  /** What the Artifacts tab lists, its badge and the HTML panels open, for the integration suite. */
  shown(): { artifacts: ArtifactView[]; badge: number; panels: Array<{ path: string; html: string }> } {
    return { artifacts: this.#state.artifacts, badge: this.#unopened().length, panels: this.#panels.shown() };
  }

  /** The paths of the artifacts new or changed since they were last opened in the workspace. */
  unopenedPaths(): string[] {
    return this.#unopened().map((artifact) => artifact.path);
  }

  /** Follows the Conversation view's state: its scope's artifacts, and the HTML panels open on them. */
  update(state: ConversationState): void {
    this.#state = state;

    // The first time a work item's artifacts are seen in this workspace, they count as opened, so the badge counts only later ones. They are seen
    // once a hello named the folder, not on the scope event before it.
    if (state.connected && state.scope !== null && state.artifactsDir !== null && this.#opened(state.scope.workItemId) === null) {
      void this.#record(state.scope.workItemId, Object.fromEntries(state.artifacts.map((artifact) => [artifact.path, artifact.updatedAt]))).then(() => this.changed());
    }

    this.#panels.update(state);
  }

  /**
   * Opens an artifact this window was sent, in VS Code's own editors (architecture.md § Artifacts): Markdown in the Markdown preview, a picture in
   * the image preview, an HTML page in its own panel, and audio, video or any other file with VS Code's editor for it.
   */
  async open(path: string): Promise<void> {
    const found = artifactFile(this.#state.artifactsDir, this.#state.artifacts, path);

    if (found === null) {
      void vscode.window.showWarningMessage(`Switchboard: the artifact ${path} is not in this window's artifact folder.`);
      return;
    }

    const { artifact, file } = found;
    const uri = vscode.Uri.file(file);

    switch (artifact.type) {
      case 'markdown':
        await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', { preview: false });
        break;
      case 'image':
        // The image preview also draws an SVG, which VS Code otherwise opens as text.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'imagePreview.previewEditor', { preview: false });
        break;
      case 'html':
        this.#panels.open(this.#state.artifactsDir!, artifact, file);
        break;
      default:
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    }

    const workItemId = this.#state.scope?.workItemId;

    if (workItemId !== undefined) {
      await this.#record(workItemId, { ...(this.#opened(workItemId) ?? {}), [artifact.path]: artifact.updatedAt });
      this.changed();
    }
  }

  #opened(workItemId: number): Opened | null {
    return this.memento.get<Record<string, Opened>>(OPENED, {})[String(workItemId)] ?? null;
  }

  async #record(workItemId: number, opened: Opened): Promise<void> {
    await this.memento.update(OPENED, { ...this.memento.get<Record<string, Opened>>(OPENED, {}), [String(workItemId)]: opened });
  }

  #unopened(): ArtifactView[] {
    const workItemId = this.#state.scope?.workItemId;

    return workItemId === undefined ? [] : unopened(this.#state.artifacts, this.#opened(workItemId) ?? {});
  }
}

/**
 * HTML artifacts, each in its own webview panel apart from the conversation's (voice-design § 4.4): its scripts run, the files it uses load from
 * the folder beside it, it has no network and navigates nowhere. A panel follows its file and says so when it is deleted.
 */
class ArtifactPanels implements vscode.Disposable {
  readonly #panels = new Map<string, { panel: vscode.WebviewPanel; dir: string; artifact: ArtifactView }>();

  open(dir: string, artifact: ArtifactView, file: string): void {
    const key = `${dir}\0${artifact.path}`;
    const known = this.#panels.get(key);

    if (known !== undefined) {
      known.artifact = artifact;
      this.#render(known, file);
      known.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(ARTIFACT_PANEL, artifact.title, vscode.ViewColumn.Active, { enableScripts: true, enableForms: false, localResourceRoots: [] });
    const entry = { panel, dir, artifact };

    panel.onDidDispose(() => this.#panels.delete(key));
    this.#panels.set(key, entry);
    this.#render(entry, file);
  }

  /** Redraws a panel whose artifact changed; one whose artifact is gone says so. */
  update(state: ConversationState): void {
    for (const entry of this.#panels.values()) {
      // A stream that is reconnecting says nothing about the artifacts.
      if (!state.connected) {
        continue;
      }

      const now = state.artifactsDir === entry.dir ? state.artifacts.find((one) => one.path === entry.artifact.path) : undefined;

      if (now === undefined) {
        if (entry.artifact.updatedAt !== -1) {
          entry.artifact = { ...entry.artifact, updatedAt: -1 };
          entry.panel.webview.html = message('This artifact was deleted, or is no longer this window\'s.');
        }
      } else if (now.updatedAt !== entry.artifact.updatedAt) {
        const found = artifactFile(entry.dir, state.artifacts, now.path);

        entry.artifact = now;

        if (found !== null) {
          this.#render(entry, found.file);
        }
      }
    }
  }

  #render(entry: { panel: vscode.WebviewPanel; dir: string; artifact: ArtifactView }, file: string): void {
    const { panel, dir, artifact } = entry;
    // Only a folder inside the artifact folder by its real path, never one a link takes elsewhere.
    const root = assetsRoot(dir, artifact.path);

    panel.title = artifact.title;
    panel.webview.options = { enableScripts: true, enableForms: false, localResourceRoots: root === null ? [] : [vscode.Uri.file(root)] };

    let html: string;

    try {
      html = readFileSync(file, 'utf8');
    } catch (error) {
      panel.webview.html = message(`The artifact could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    panel.webview.html = artifactPage(html, panel.webview.cspSource, assetResolver(dir, artifact.path), (asset) => panel.webview.asWebviewUri(vscode.Uri.file(asset)).toString());
  }

  /** The panels open now, for the integration suite. */
  shown(): Array<{ path: string; html: string }> {
    return [...this.#panels.values()].map((entry) => ({ path: entry.artifact.path, html: entry.panel.webview.html }));
  }

  dispose(): void {
    for (const entry of this.#panels.values()) {
      entry.panel.dispose();
    }
  }
}

function message(text: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>${escape(text)}</p>`;
}
