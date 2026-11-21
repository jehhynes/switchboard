import type { ConversationState } from '../conversationModel.js';
import { commandQuery, matchCommands, mentionOf, mentionQuery, messageHistory, pathOfUri, relativeTo, sendsAsCommand } from '../composerModel.js';
import type { CommandItem, FileItem } from '../composerModel.js';
import type { ConversationMessage } from './conversationRender.js';

/** What the extension answers the composer's requests with. */
export type ExtrasReply =
  | { type: 'files'; id: number; items: FileItem[] }
  | { type: 'commands'; id: number; commands: CommandItem[] | null; error: string | null }
  | { type: 'mentions'; paths: string[] }
  | { type: 'image'; id: number; path: string | null; error: string | null };

/** How long the picker waits after a key before it asks for files. */
const FILES_DELAY_MS = 80;
/** A drag that leaves within this long of entering was taken by VS Code, which drops into a webview only with Shift held. */
const TAKEN_DRAG_MS = 500;
/** The largest pasted image the composer sends to the extension. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The image types a paste becomes a file for. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const SHIFT_HINT = 'Hold Shift while dragging to drop files here.';
/** Files dragged from the operating system's file manager carry no path in a webview. */
export const VS_CODE_FILES_ONLY = 'Only files dragged from VS Code can be dropped here, with Shift held.';

interface Api {
  postMessage(message: ConversationMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** Escapes text for HTML. */
function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The composer's extras (architecture.md § Conversation view), as Claude Code's panel has them: the `@` file picker, the `/` command list, files
 * dropped or attached as mentions, a pasted image as a file mention, Up and Down through earlier messages at the box's edges, and the draft
 * kept in the page's state over a reload. `changed` tells the composer the box's text changed, so it grows and checks its send button.
 */
export function startComposerExtras(host: HTMLElement, input: HTMLTextAreaElement, controls: HTMLElement, vscode: Api, changed: () => void, showError: (text: string) => void) {
  host.classList.add('has-extras');
  controls.insertAdjacentHTML(
    'afterbegin',
    '<button class="composer-tool attach" type="button" title="Attach files…" aria-label="Attach files"><span class="codicon codicon-add" aria-hidden="true"></span></button>' +
      '<button class="composer-tool slash" type="button" title="Show slash commands (/)" aria-label="Show slash commands"><span class="slash-glyph" aria-hidden="true">/</span></button>',
  );

  const attach = controls.querySelector<HTMLButtonElement>('button.attach')!;
  const slash = controls.querySelector<HTMLButtonElement>('button.slash')!;
  const menu = document.createElement('div');

  menu.className = 'glass composer-menu';
  menu.id = 'composer-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  // Inside the box, so it sits above the box at the box's width.
  host.querySelector('.composer')!.prepend(menu);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', menu.id);
  input.setAttribute('aria-expanded', 'false');

  let state: ConversationState | null = null;
  let enabled = false;
  // The command chosen from the list; the text goes as that command while it still starts with it.
  let chosen: string | null = null;
  // Up and Down's walk through earlier messages, with the text it started from.
  let walk: { index: number; draft: string } | null = null;
  // The open list: files after an `@`, or commands after a leading `/`, with the highlighted row.
  let open: { kind: 'files'; start: number; items: FileItem[] } | { kind: 'commands'; items: CommandItem[] } | null = null;
  let active = 0;
  let next = 1;
  let filesAsked = 0;
  let filesTimer: ReturnType<typeof setTimeout> | undefined;
  let commandsAsked = 0;
  // Whether the commands were asked for since the list last closed.
  let listAsked = false;
  // The session's commands as the hub last listed them, for the session they came from.
  let commands: { sessionId: string; list: CommandItem[] } | null = null;
  const images = new Map<number, true>();
  // Paths to mention that arrived while a message was being sent.
  const deferred: string[] = [];
  let dragAt = 0;

  // The selected conversation, whose draft the box holds.
  let conversation: number | null = null;
  /** Each conversation's draft and chosen command, kept in the page's state over a reload. */
  const kept = (): Record<string, { text: string; command: string | null }> => {
    const drafts = ((vscode.getState() as Record<string, unknown> | null) ?? {})['drafts'];

    return typeof drafts === 'object' && drafts !== null ? (drafts as Record<string, { text: string; command: string | null }>) : {};
  };
  const keep = (id: number, text: string, command: string | null): void => {
    const saved = (vscode.getState() as Record<string, unknown> | null) ?? {};
    const drafts = { ...kept() };

    if (text === '') {
      delete drafts[id];
    } else {
      drafts[id] = { text, command: command !== null && sendsAsCommand(text, command) ? command : null };
    }

    vscode.setState({ ...saved, drafts });
  };
  // The text being sent shows read-only and is no draft.
  const save = (): void => {
    if (conversation !== null && !input.readOnly) {
      keep(conversation, input.value, chosen);
    }
  };

  const cwd = (): string | null => state?.scope?.cwd ?? null;

  const close = (): void => {
    open = null;
    listAsked = false;
    // Answers to requests made for this list are dropped.
    clearTimeout(filesTimer);
    filesAsked = 0;
    commandsAsked = 0;
    menu.hidden = true;
    menu.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const draw = (): void => {
    if (open === null) {
      close();
      return;
    }

    if (open.items.length === 0) {
      menu.innerHTML = `<div class="menu-empty">${open.kind === 'files' ? 'No matching files' : 'No matching commands'}</div>`;
    } else if (open.kind === 'files') {
      menu.innerHTML = open.items
        .map((item, index) => {
          const trimmed = item.path.replace(/\/$/, '');
          const slashAt = trimmed.lastIndexOf('/');
          const name = trimmed.slice(slashAt + 1);
          const dir = slashAt === -1 ? '' : trimmed.slice(0, slashAt);

          return (
            `<div class="menu-item${index === active ? ' active' : ''}" role="option" id="composer-option-${index}" aria-selected="${index === active}" data-index="${index}">` +
            `<span class="codicon codicon-${item.dir ? 'folder' : 'file'}" aria-hidden="true"></span><span class="menu-name">${escape(name)}${item.dir ? '/' : ''}</span>` +
            `<span class="menu-dir"><bdi>${escape(dir)}</bdi></span></div>`
          );
        })
        .join('');
    } else {
      menu.innerHTML = open.items
        .map(
          (item, index) =>
            `<div class="menu-item command${index === active ? ' active' : ''}" role="option" id="composer-option-${index}" aria-selected="${index === active}" data-index="${index}">` +
            `<span class="menu-label">/${escape(item.name)}</span>${item.description === '' ? '' : `<span class="menu-description">${escape(item.description)}</span>`}</div>`,
        )
        .join('');
    }

    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    if (open.items.length > 0) {
      input.setAttribute('aria-activedescendant', `composer-option-${active}`);
      menu.querySelector('.menu-item.active')?.scrollIntoView?.({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  /** Replaces the text from `start` to the caret, as typing would, so Undo takes it back where the browser allows. */
  const replace = (start: number, text: string): void => {
    input.focus();
    input.setRangeText(text, start, input.selectionEnd, 'end');
    walk = null;
    changed();
    save();
  };

  /** Puts mentions at the caret, with a space before one that would join the word before it and one after each. */
  const insertMentions = (paths: string[]): void => {
    const mentions: string[] = [];

    for (const path of paths) {
      const mention = mentionOf(relativeTo(path, cwd()));

      if (mention === null) {
        showError(`This path cannot be mentioned: ${path}`);
      } else {
        mentions.push(mention);
      }
    }

    if (mentions.length === 0 || !enabled) {
      return;
    }

    // The box is read-only while the hub takes a message; what arrives meanwhile goes in once it answered.
    if (input.readOnly) {
      deferred.push(...paths);
      return;
    }

    const at = input.selectionStart;
    const before = input.value.slice(0, at);

    replace(at, `${before === '' || /\s$/.test(before) ? '' : ' '}${mentions.join(' ')} `);
  };

  /** Opens, narrows or closes the list for the text before the caret. */
  const refresh = (): void => {
    if (!enabled || input.readOnly || input.selectionStart !== input.selectionEnd) {
      close();
      return;
    }

    const before = input.value.slice(0, input.selectionStart);
    const command = commandQuery(before);

    if (command !== null) {
      const session = state?.session?.id ?? null;

      if (commands !== null && commands.sessionId === session) {
        const items = matchCommands(commands.list, command);

        active = open?.kind === 'commands' ? Math.min(active, Math.max(0, items.length - 1)) : 0;
        open = { kind: 'commands', items };
        draw();
      }

      // Asked again each time the list opens, so skills the session gained since show.
      if (session !== null && !listAsked) {
        listAsked = true;
        commandsAsked = next++;
        vscode.postMessage({ type: 'commands', id: commandsAsked });
      }

      return;
    }

    const mention = mentionQuery(before);

    if (mention !== null) {
      // An answer for an earlier query is dropped from now on, not only once the new one is asked.
      clearTimeout(filesTimer);
      filesAsked = 0;
      filesTimer = setTimeout(() => {
        filesAsked = next++;
        vscode.postMessage({ type: 'files', id: filesAsked, query: mention.query });
      }, FILES_DELAY_MS);

      if (open?.kind !== 'files') {
        open = { kind: 'files', start: mention.start, items: [] };
        active = 0;
        menu.innerHTML = '<div class="menu-empty">Searching…</div>';
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      } else {
        open.start = mention.start;
      }

      return;
    }

    close();
  };

  const choose = (index: number): void => {
    if (open === null || open.items.length === 0) {
      return;
    }

    if (open.kind === 'files') {
      const item = open.items[index]!;
      const mention = mentionOf(item.path);

      if (mention === null) {
        showError(`This path cannot be mentioned: ${item.path}`);
        close();
        return;
      }

      // A folder stays open, so the picker can go on into it.
      replace(open.start, item.dir && !mention.endsWith('"') ? mention : `${mention} `);
    } else {
      const item = open.items[index]!;
      const rest = input.value.slice(input.selectionEnd).replace(/^ +/, '');

      chosen = item.name;
      input.value = `/${item.name} ${rest}`;
      input.setSelectionRange(item.name.length + 2, item.name.length + 2);
      walk = null;
      changed();
      save();
    }

    close();
    refresh();
  };

  /** Up and Down at the box's edges: the previous or next of the session's messages, and the text the walk started from after the newest. */
  const recall = (up: boolean): boolean => {
    const history = state === null ? [] : messageHistory(state.items);
    const caret = input.selectionStart;

    if (history.length === 0 || caret !== input.selectionEnd || (up ? input.value.slice(0, caret).includes('\n') : input.value.slice(caret).includes('\n'))) {
      return false;
    }

    if (up) {
      walk ??= { index: history.length, draft: input.value };

      if (walk.index === 0) {
        return true;
      }

      walk.index = Math.min(walk.index, history.length) - 1;
      input.value = history[walk.index]!;
    } else {
      if (walk === null) {
        return false;
      }

      walk.index++;

      if (walk.index >= history.length) {
        input.value = walk.draft;
        walk = null;
      } else {
        input.value = history[walk.index]!;
      }
    }

    // A recalled message is a message; a command goes as one only when chosen from the list.
    chosen = null;
    input.setSelectionRange(input.value.length, input.value.length);
    changed();
    save();
    return true;
  };

  input.addEventListener('input', () => {
    walk = null;

    // Editing the command's name, or emptying the box, makes the text a message again.
    if (chosen !== null && !sendsAsCommand(input.value, chosen)) {
      chosen = null;
    }

    save();
    refresh();
  });
  input.addEventListener('click', refresh);
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      refresh();
    }
  });
  input.addEventListener('blur', () => {
    // A click in the list keeps the focus (its mousedown is prevented), so a blur means the operator left the box.
    close();
  });
  menu.addEventListener('mousedown', (event) => event.preventDefault());
  menu.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.menu-item');

    if (row !== null) {
      choose(Number(row.dataset['index']));
    }
  });
  menu.addEventListener('mousemove', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.menu-item');

    if (row !== null && Number(row.dataset['index']) !== active) {
      active = Number(row.dataset['index']);
      draw();
    }
  });

  attach.addEventListener('click', () => {
    vscode.postMessage({ type: 'attach' });
  });
  slash.addEventListener('click', () => {
    if (!enabled || input.readOnly) {
      return;
    }

    input.focus();

    // The list opens for a slash at the start of the box, put there unless the box already starts with one.
    if (!input.value.startsWith('/')) {
      input.value = `/${input.value === '' ? '' : ` ${input.value}`}`;
      changed();
    }

    input.setSelectionRange(1, 1);
    refresh();
  });

  input.addEventListener('paste', (event) => {
    const data = event.clipboardData;
    const image = [...(data?.files ?? [])].find((one) => IMAGE_TYPES.includes(one.type));

    // Text pasted with a picture, as from a web page, stays text.
    if (data === null || image === undefined || data.types.includes('text/plain') || !enabled) {
      return;
    }

    event.preventDefault();

    if (image.size > MAX_IMAGE_BYTES) {
      showError('The pasted image is larger than 10 MB.');
      return;
    }

    const id = next++;

    images.set(id, true);
    void image.arrayBuffer().then((bytes) => {
      let binary = '';
      const view = new Uint8Array(bytes);

      for (let at = 0; at < view.length; at += 0x8000) {
        binary += String.fromCharCode(...view.subarray(at, at + 0x8000));
      }

      vscode.postMessage({ type: 'image', id, mime: image.type, data: btoa(binary) });
    });
  });

  // Files dragged from VS Code: its Explorer, an editor's tab, or a link. VS Code lets a webview take a drop only while Shift is held.
  // The composer shows only on the Conversation tab, so a drop on another tab is left alone.
  const onConversationTab = (): boolean => (document.body.dataset['tab'] ?? 'conversation') === 'conversation';
  const carriesFiles = (types: readonly string[] | undefined): boolean => types !== undefined && (types.includes('Files') || types.includes('resourceurls') || types.includes('codeeditors') || types.includes('text/uri-list'));

  document.addEventListener('dragenter', (event) => {
    if (enabled && onConversationTab() && carriesFiles(event.dataTransfer?.types)) {
      dragAt = Date.now();
      host.classList.add('drop-target');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (enabled && onConversationTab() && carriesFiles(event.dataTransfer?.types)) {
      event.preventDefault();
      host.classList.add('drop-target');
    }
  });
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget !== null) {
      return;
    }

    host.classList.remove('drop-target');

    if (dragAt !== 0 && Date.now() - dragAt < TAKEN_DRAG_MS) {
      showError(SHIFT_HINT);
    }

    dragAt = 0;
  });
  document.addEventListener('drop', (event) => {
    host.classList.remove('drop-target');
    dragAt = 0;

    const data = event.dataTransfer;

    if (!enabled || !onConversationTab() || data === null || !carriesFiles(data.types)) {
      return;
    }

    event.preventDefault();

    const uris: string[] = [];
    const read = (type: string): string => {
      try {
        return data.getData(type);
      } catch {
        return '';
      }
    };

    for (const raw of [read('resourceurls'), read('codeeditors')]) {
      try {
        const parsed: unknown = raw === '' ? [] : JSON.parse(raw);

        for (const one of Array.isArray(parsed) ? parsed : []) {
          const uri = typeof one === 'string' ? one : (one as { resource?: { external?: unknown } } | null)?.resource?.external;

          if (typeof uri === 'string') {
            uris.push(uri);
          }
        }
      } catch {
        // Not a list VS Code wrote.
      }
    }

    uris.push(...read('text/uri-list').split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#')));

    const paths = [...new Set(uris.map(pathOfUri).filter((path): path is string => path !== null))];

    if (paths.length === 0) {
      showError(VS_CODE_FILES_ONLY);
      return;
    }

    insertMentions(paths);
  });

  return {
    /** Keys for the list and the history; true when it took the key, so the composer does nothing more with it. */
    keydown(event: KeyboardEvent): boolean {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || input.readOnly) {
        return false;
      }

      // Escape also stops a list still waiting for its first answer.
      if (open === null && commandsAsked !== 0 && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return true;
      }

      if (open !== null) {
        const count = open.items.length;

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (count > 0) {
            active = (active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
            draw();
          }

          event.preventDefault();
          return true;
        }

        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          if (count === 0) {
            if (event.key === 'Tab') {
              return false;
            }

            close();
            return false;
          }

          event.preventDefault();
          choose(active);
          return true;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return true;
        }

        return false;
      }

      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && recall(event.key === 'ArrowUp')) {
        event.preventDefault();
        return true;
      }

      return false;
    },
    /** Whether the text goes as the chosen slash command. */
    command(text: string): boolean {
      return sendsAsCommand(text, chosen);
    },
    update(next: ConversationState): void {
      // Another session's list, and answers asked for it, are dropped.
      if (state?.session?.id !== next.session?.id || state?.scope?.scopeGen !== next.scope?.scopeGen) {
        commands = null;
        close();
      }

      state = next;
      enabled = next.connected && next.session?.conversation === 'full';
      attach.disabled = !enabled;
      slash.disabled = !enabled;

      if (!enabled) {
        close();
      }
    },
    /**
     * The hub answered a send: when it took the message, the box is empty and the walk and the chosen command start over. Either way the
     * mentions that arrived meanwhile go in.
     */
    sent(taken: boolean): void {
      if (taken) {
        chosen = null;
        walk = null;
        close();
      }

      save();
      insertMentions(deferred.splice(0));
    },
    /** The box's text changed from outside, as when a message that was not sent came back. */
    changed(): void {
      save();
    },
    /** A conversation's kept draft, empty with none. */
    draftOf(id: number): string {
      return kept()[id]?.text ?? '';
    },
    /** Keeps a conversation's draft, with its chosen command while it is the selected one's. */
    setDraft(id: number, text: string): void {
      keep(id, text, id === conversation ? chosen : (kept()[id]?.command ?? null));
    },
    /** The selected conversation changed: its chosen command comes back while its draft still starts with it, and the walk and the list start over. */
    enter(id: number | null): void {
      conversation = id;
      walk = null;
      close();

      const saved = id === null ? undefined : kept()[id];

      chosen = saved?.command != null && sendsAsCommand(input.value, saved.command) ? saved.command : null;
    },
    receive(reply: ExtrasReply): void {
      if (reply.type === 'files') {
        if (reply.id === filesAsked && open?.kind === 'files') {
          open.items = reply.items;
          active = 0;
          draw();
        }
      } else if (reply.type === 'commands') {
        if (reply.id !== commandsAsked) {
          return;
        }

        commandsAsked = 0;

        if (reply.commands === null) {
          showError(reply.error ?? 'Switchboard could not list the slash commands.');
          close();
          return;
        }

        const session = state?.session?.id;

        commands = session === undefined ? null : { sessionId: session, list: reply.commands };
        refresh();
      } else if (reply.type === 'mentions') {
        insertMentions(reply.paths);
      } else if (images.delete(reply.id)) {
        if (reply.path === null) {
          showError(reply.error ?? 'The pasted image could not be saved.');
        } else {
          insertMentions([reply.path]);
        }
      }
    },
  };
}
