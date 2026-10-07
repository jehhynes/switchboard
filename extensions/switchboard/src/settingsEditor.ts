import { randomBytes } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import * as vscode from 'vscode';
import { PERMISSION_MODES, TEMPLATE_VARIABLES } from '@switchboard/core';
import type { PlaybookFields } from '@switchboard/core';
import { SOURCE_KINDS, checkPlaybook, checkSettings, deletePlaybook, playbooksDir, readConfigFiles, savePlaybook, saveSettings } from '@switchboard/hub';
import type { EditorConfig } from './webview/settings.js';

const REFRESH_DELAY_MS = 100;

type Message =
  | { type: 'ready' }
  | { type: 'check'; target: string; seq: number; settings?: unknown; name?: string; playbook?: PlaybookFields }
  | { type: 'save-settings'; value: unknown; version: string | null }
  | { type: 'save-playbook'; name: string; playbook: PlaybookFields; version: string | null }
  | { type: 'create-playbook'; name: string; playbook: PlaybookFields }
  | { type: 'delete-playbook'; name: string; version: string }
  | { type: 'open-file'; path: string };

/**
 * The settings editor: a webview tab that edits settings.json and the playbook files in the config folder. It writes the
 * files directly, and the hub reloads them as it does any edit (PRD R42, R54).
 */
export class SettingsEditor {
  static readonly viewType = 'switchboard.settings';

  private panel: vscode.WebviewPanel | undefined;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** The config folder the open editor reads and watches. */
  private dir = '';

  /** `inUse` counts the open work items of each playbook, so a delete can say what still uses it. */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configDir: () => string,
    private readonly inUse: () => Record<string, number>,
  ) {}

  show(): vscode.WebviewPanel {
    if (this.panel !== undefined) {
      this.panel.reveal();
      return this.panel;
    }

    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(SettingsEditor.viewType, 'Switchboard Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [dist],
      retainContextWhenHidden: true,
    });
    const nonce = randomBytes(16).toString('hex');
    const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';`;
    const uri = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'switchboard-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'switchboard-dark.svg'),
    };
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}"><link rel="stylesheet" href="${uri('settings.css')}">
</head><body><div id="root"></div><script nonce="${nonce}" src="${uri('settings.js')}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((message: Message) => void this.receive(message));
    panel.onDidDispose(() => this.close());

    this.panel = panel;
    this.watch();

    return panel;
  }

  dispose(): void {
    this.panel?.dispose();
  }

  /**
   * Closes an open editor when the config folder setting changes, because its drafts and file versions belong to the
   * old folder, and a save could overwrite an identical copy in the new one.
   */
  moved(): void {
    if (this.panel === undefined || this.dir === this.configDir()) {
      return;
    }

    this.panel.dispose();
    void vscode.window.showWarningMessage('Switchboard Settings closed because switchboard.configDir changed; any unsaved changes were discarded. Open it again to edit the new folder.');
  }

  private watch(): void {
    const refresh = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.send({ type: 'config', config: this.config() }), REFRESH_DELAY_MS);
    };

    this.dir = this.configDir();
    mkdirSync(playbooksDir(this.dir), { recursive: true });
    this.watchers = [watch(this.dir, (_event, file) => file === 'settings.json' && refresh()), watch(playbooksDir(this.dir), { recursive: true }, refresh)];
  }

  private close(): void {
    clearTimeout(this.timer);

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers = [];
    this.panel = undefined;
  }

  private config(): EditorConfig {
    return { ...readConfigFiles(this.dir), permissionModes: [...PERMISSION_MODES], templateVariables: [...TEMPLATE_VARIABLES], sourceKinds: [...SOURCE_KINDS] };
  }

  private send(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Sends the result of a write, then the files as they are now. */
  private written(target: string, errors: string[], done: unknown): void {
    this.send(errors.length > 0 ? { type: 'refused', target, errors } : done);

    if (errors.length === 0) {
      this.send({ type: 'config', config: this.config() });
    }
  }

  private async receive(message: Message): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.send({ type: 'config', config: this.config() });
          return;
        case 'check': {
          const checked = message.target === 'settings' || message.playbook === undefined ? null : checkPlaybook(message.name ?? '', message.playbook);
          const errors = message.target === 'settings' ? checkSettings(message.settings) : checked !== null && 'errors' in checked ? checked.errors : [];

          this.send({ type: 'checked', target: message.target, seq: message.seq, errors });
          return;
        }
        case 'save-settings':
          this.written('settings', saveSettings(this.dir, message.value, message.version), { type: 'saved', target: 'settings' });
          return;
        case 'save-playbook':
          this.written(message.name, savePlaybook(this.dir, message.name, message.playbook, message.version), { type: 'saved', target: message.name });
          return;
        case 'create-playbook':
          this.written('new', savePlaybook(this.dir, message.name, message.playbook, null), { type: 'saved', target: 'new' });
          return;
        case 'delete-playbook': {
          const count = this.inUse()[message.name] ?? 0;
          const detail = count === 0 ? 'Its file is deleted.' : `${count} open work ${count === 1 ? 'item uses' : 'items use'} it. Its file is deleted.`;
          const panel = this.panel;
          const answer = await vscode.window.showWarningMessage(`Delete playbook ${message.name}?`, { modal: true, detail }, 'Delete');

          // The editor closes when the config folder changes, and a confirmation given after that is for the old folder.
          if (answer === 'Delete' && this.panel === panel) {
            this.written(message.name, deletePlaybook(this.dir, message.name, message.version), { type: 'deleted', name: message.name });
          }
          return;
        }
        case 'open-file':
          await vscode.window.showTextDocument(vscode.Uri.file(message.path));
          return;
      }
    } catch (error) {
      const target =
        message.type === 'check' ? message.target : message.type === 'create-playbook' ? 'new' : message.type === 'save-playbook' || message.type === 'delete-playbook' ? message.name : 'settings';

      this.send({ type: 'refused', target, errors: [String((error as Error).message ?? error)] });
    }
  }
}
