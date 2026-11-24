// Files attached to a message from the composer (architecture.md § Web page): each work item's files, kept over a reload, each one's upload to
// the hub, and their chips above the box.
import { mount } from './island.js';

/** Where the page keeps each work item's attached files, over a reload. */
const ATTACHMENTS = 'switchboard.attachments';
/** The largest file the composer attaches, the hub's limit. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** The most files one message carries. */
export const MAX_ATTACHMENTS = 10;

/** A file attached to a work item's next message; `path` is null while the hub takes the file. */
export interface Attached {
  id: number;
  name: string;
  path: string | null;
  image: boolean;
  abort: AbortController | null;
}

type Kept = Record<string, Array<{ name: string; path: string; image: boolean }>>;

export interface AttachmentDeps {
  fetch: typeof fetch;
  /** The work item the composer shows, or null. */
  shown(): number | null;
  /** The hub did not take a work item's file, with why. */
  refused(workItemId: number, error: string): void;
  /** The shown work item's files changed. */
  changed(): void;
  /** The hub answered 401: the page's sign-in is gone. */
  expired(): void;
}

export interface Attachments {
  /** A work item's files, read from local storage the first time. */
  of(workItemId: number): Attached[];
  /**
   * Sends files to the hub for a work item's next message, at most 10 MB each and 10 to a message, each as a chip at once; answers why any
   * were refused.
   */
  add(workItemId: number, key: string, scopeGen: number, files: readonly File[]): string[];
  /** Removes a work item's file and ends its upload; false when it has no such file. */
  remove(workItemId: number, id: number): boolean;
  /** Drops the files a sent message carried; files attached while it was sent stay. */
  sent(workItemId: number, files: readonly Attached[]): void;
}

export function attachments(deps: AttachmentDeps): Attachments {
  const attached = new Map<number, Attached[]>();
  let attachedId = 0;

  const kept = (): Kept => {
    try {
      const all = JSON.parse(localStorage.getItem(ATTACHMENTS) ?? '{}') as unknown;

      return typeof all === 'object' && all !== null ? (all as Kept) : {};
    } catch {
      return {};
    }
  };
  const of = (workItemId: number): Attached[] => {
    let list = attached.get(workItemId);

    if (list === undefined) {
      const stored = kept()[workItemId];

      list = (Array.isArray(stored) ? stored : [])
        .filter((one) => typeof one?.name === 'string' && typeof one.path === 'string')
        .map((one) => ({ id: ++attachedId, name: one.name, path: one.path, image: one.image === true, abort: null }));
      attached.set(workItemId, list);
    }

    return list;
  };
  const keep = (workItemId: number): void => {
    const all = kept();
    const ready = of(workItemId).flatMap((one) => (one.path === null ? [] : [{ name: one.name, path: one.path, image: one.image }]));

    if (ready.length === 0) {
      delete all[workItemId];
    } else {
      all[workItemId] = ready;
    }

    localStorage.setItem(ATTACHMENTS, JSON.stringify(all));
  };
  /** Sends one file to the hub for the work item it was attached to, and puts its path on its chip, or drops the chip and says why. */
  const upload = async (workItemId: number, key: string, scopeGen: number, file: File, entry: Attached): Promise<void> => {
    let error: string | null = null;

    try {
      const send = (retry: boolean) => deps.fetch(`/v1/conversation/upload?window=${encodeURIComponent(key)}&scopeGen=${scopeGen}&name=${encodeURIComponent(entry.name)}${retry ? '&retry=1' : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
        body: file,
        signal: entry.abort!.signal,
      });
      let response: Response;

      try {
        response = await send(false);
      } catch (failure) {
        if (!(failure instanceof TypeError) || entry.abort?.signal.aborted === true) {
          throw failure;
        }

        response = await send(true);
      }

      const body = (await response.json().catch(() => ({}))) as { path?: unknown; image?: unknown; error?: unknown };

      if (response.status === 401) {
        deps.expired();
      }

      if (response.ok && typeof body.path === 'string') {
        entry.path = body.path;
        entry.image = body.image === true;
      } else {
        error = String(body.error ?? `${entry.name} was not attached (status ${response.status}).`);
      }
    } catch (failure) {
      // A chip removed while its file was sent ends its request.
      if (entry.abort?.signal.aborted === true) {
        return;
      }

      error = `${entry.name} was not attached: Switchboard did not answer (${String(failure)}).`;
    }

    entry.abort = null;

    const list = of(workItemId);

    if (!list.includes(entry)) {
      return;
    }

    if (error !== null) {
      list.splice(list.indexOf(entry), 1);
      deps.refused(workItemId, error);
    }

    keep(workItemId);

    if (workItemId === deps.shown()) {
      deps.changed();
    }
  };

  return {
    of,
    add(workItemId, key, scopeGen, files) {
      const list = of(workItemId);
      const refused: string[] = [];

      for (const file of files) {
        const name = file.name === '' ? 'Pasted file' : file.name;

        if (list.length >= MAX_ATTACHMENTS) {
          refused.push(`A message takes at most ${MAX_ATTACHMENTS} files.`);
          break;
        }

        if (file.size === 0 || file.size > MAX_ATTACH_BYTES) {
          refused.push(file.size === 0 ? `${name} is empty.` : `${name} is larger than 10 MB.`);
          continue;
        }

        const entry: Attached = { id: ++attachedId, name, path: null, image: file.type.startsWith('image/'), abort: new AbortController() };

        list.push(entry);
        void upload(workItemId, key, scopeGen, file, entry);
      }

      return refused;
    },
    remove(workItemId, id) {
      const list = of(workItemId);
      const entry = list.find((one) => one.id === id);

      if (entry === undefined) {
        return false;
      }

      entry.abort?.abort();
      list.splice(list.indexOf(entry), 1);
      keep(workItemId);
      return true;
    },
    sent(workItemId, files) {
      attached.set(
        workItemId,
        of(workItemId).filter((one) => !files.includes(one)),
      );
      keep(workItemId);
    },
  };
}

/** One attached file: a spinner while the hub takes it, then a file or picture icon, its name, and a button that removes it. */
function Chip({ file, onRemove }: { file: Attached; onRemove(id: number): void }) {
  const icon = file.path === null ? 'loading codicon-modifier-spin' : file.image ? 'file-media' : 'file';

  return (
    <span class="attachment" role="listitem" data-attachment={file.id} title={file.path === null ? `Attaching ${file.name}…` : file.name}>
      <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
      <span class="attachment-name">{file.name}</span>
      <button type="button" class="attachment-remove" aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.id)}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </span>
  );
}

/** Draws the shown work item's files as chips in their host above the box, which is hidden while there are none. */
export function drawChips(host: HTMLElement, files: readonly Attached[], onRemove: (id: number) => void): void {
  host.hidden = files.length === 0;
  mount(
    host,
    files.map((file) => <Chip key={file.id} file={file} onRemove={onRemove} />),
  );
}
