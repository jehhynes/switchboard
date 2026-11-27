/**
 * The list header's notices (architecture.md § Web page, List header): one list the hub sends every page, each notice by a stable ID, with the
 * dismissals kept here, so a × applies on every device and outlives a reload; and one-time notices, which go to the pages open as a toast.
 */

/** What a notice's button does; `settings`, `voice-computer` and `holder-restart` work on this computer's page only (architecture.md § Remote access). */
export type NoticeAction =
  | { kind: 'settings' | 'held' | 'poll' | 'voice-computer'; label: string }
  | { kind: 'holder-restart'; label: string; confirm: { question: string; detail: string; action: string } };

/**
 * A notice as the dock view builds it: `action` asks the operator to act, `transient` is a state that ends by itself. `dismiss` says
 * whether × dismisses it, and where the dismissal is kept: `kept` in the store, for a notice whose cause outlives a hub restart, `memory` for one
 * that ends with the hub, null for an error, which clears only when fixed.
 */
export interface Notice {
  id: string;
  class: 'action' | 'transient';
  text: string;
  dismiss: 'kept' | 'memory' | null;
  action?: NoticeAction;
}

/** A notice as the page gets it: `at` is when this hub first showed it. */
export interface PageNotice {
  id: string;
  class: 'action' | 'transient';
  text: string;
  at: number;
  dismissible: boolean;
  action?: NoticeAction;
}

/** A one-time notice, sent as the `notice` event and shown as a toast; never part of the header. */
export interface InfoNotice {
  id: string;
  text: string;
  at: number;
}

/** How long after it a one-time notice still goes to a page that opens. */
export const INFO_SHOWN_MS = 120_000;
/** How many kept dismissals the store holds, the newest; an older one's notice shows again if it comes back. */
export const DISMISSALS_KEPT = 50;
/** The `pagePrefs` entry that keeps the dismissals that outlive a hub restart. */
export const DISMISSED_PREF = 'dismissedNotices';

export interface NoticesDeps {
  now(): number;
  /** The kept dismissals, newest last. */
  load(): string[];
  save(ids: string[]): void;
  /** The open pages' keys. */
  pages(): string[];
  /** The sign-in a page key's stream was opened with; null when unknown. */
  signIn(key: string): string | null;
  send(key: string, notice: InfoNotice): void;
}

export class Notices {
  readonly #deps: NoticesDeps;
  /** When each notice shown now first showed. */
  readonly #since = new Map<string, number>();
  readonly #dismissed = new Set<string>();
  #kept: string[];
  /** The one-time notices of the last `INFO_SHOWN_MS`, with the sign-ins (or page keys) each went to. */
  #recent: Array<{ notice: InfoNotice; to: Set<string> }> = [];
  readonly #announced = new Set<string>();

  constructor(deps: NoticesDeps) {
    this.#deps = deps;
    this.#kept = deps.load().filter((id) => typeof id === 'string');
  }

  /**
   * Notes the notices there now, so each keeps when it first showed and one that goes and comes back counts from its return; the hub calls it on
   * each built view, whether or not a page is open.
   */
  observe(notices: readonly Notice[]): void {
    const now = this.#deps.now();
    const ids = new Set(notices.map((one) => one.id));

    for (const id of [...this.#since.keys()]) {
      if (!ids.has(id)) {
        this.#since.delete(id);
      }
    }

    for (const one of notices) {
      if (!this.#since.has(one.id)) {
        this.#since.set(one.id, now);
      }
    }
  }

  /** The page's notices: each not dismissed, with when it first showed, oldest first. */
  header(notices: readonly Notice[]): PageNotice[] {
    this.observe(notices);

    return notices
      .filter((one) => !this.#isDismissed(one.id))
      .map((one) => ({ id: one.id, class: one.class, text: one.text, at: this.#since.get(one.id)!, dismissible: one.dismiss !== null, ...(one.action === undefined ? {} : { action: one.action }) }))
      .sort((a, b) => a.at - b.at);
  }

  /**
   * `page-notice-dismiss`: dismisses the notice `id` among `notices`, the ones shown now, or with null every dismissible one shown; returns why
   * not, or null.
   */
  dismiss(notices: readonly Notice[], id: string | null): string | null {
    const shown = notices.filter((one) => !this.#isDismissed(one.id));

    if (id === null) {
      const dismissible = shown.filter((one) => one.dismiss !== null);

      if (dismissible.length === 0) {
        return 'No notice can be dismissed.';
      }

      dismissible.forEach((one) => this.#dismiss(one));
      return null;
    }

    const notice = shown.find((one) => one.id === id);

    if (notice === undefined) {
      return 'That notice is gone.';
    }

    if (notice.dismiss === null) {
      return 'This notice clears once its cause is fixed, so it cannot be dismissed.';
    }

    this.#dismiss(notice);
    return null;
  }

  /** Sends each one-time notice not sent before to every open page, and keeps it for pages that open within `INFO_SHOWN_MS` of its time. */
  announce(info: readonly InfoNotice[]): void {
    this.#prune();

    for (const notice of info) {
      if (this.#announced.has(notice.id)) {
        continue;
      }

      this.#announced.add(notice.id);

      if (this.#deps.now() - notice.at >= INFO_SHOWN_MS) {
        continue;
      }

      const entry = { notice, to: new Set<string>() };

      this.#recent.push(entry);

      // Every page open now gets it, two tabs of one sign-in included; their sign-ins keep it from a later reload.
      for (const key of this.#deps.pages()) {
        entry.to.add(this.#recipient(key));
        this.#deps.send(key, notice);
      }
    }
  }

  /** A page opened: it gets each recent one-time notice its sign-in has not had, so a reload never shows one again. */
  pageOpened(key: string): void {
    this.#prune();
    this.#recent.forEach((entry) => this.#deliver(entry, key));
  }

  #recipient(key: string): string {
    return this.#deps.signIn(key) ?? `page:${key}`;
  }

  #deliver(entry: { notice: InfoNotice; to: Set<string> }, key: string): void {
    const to = this.#recipient(key);

    if (!entry.to.has(to)) {
      entry.to.add(to);
      this.#deps.send(key, entry.notice);
    }
  }

  #prune(): void {
    const now = this.#deps.now();

    this.#recent = this.#recent.filter((entry) => now - entry.notice.at < INFO_SHOWN_MS);
  }

  #isDismissed(id: string): boolean {
    return this.#dismissed.has(id) || this.#kept.includes(id);
  }

  #dismiss(notice: Notice): void {
    if (notice.dismiss === 'kept') {
      this.#kept = [...this.#kept.filter((one) => one !== notice.id), notice.id].slice(-DISMISSALS_KEPT);
      this.#deps.save(this.#kept);
    } else {
      this.#dismissed.add(notice.id);
    }
  }
}

/** Where the kept dismissals live: the store's `pagePrefs`, as a JSON array; anything else there reads as none. */
export function keptDismissals(store: { pagePref(name: string): string | null; setPagePref(name: string, value: string): void }): Pick<NoticesDeps, 'load' | 'save'> {
  return {
    load: () => {
      try {
        const kept = JSON.parse(store.pagePref(DISMISSED_PREF) ?? '[]') as unknown;

        return Array.isArray(kept) ? kept.filter((one): one is string => typeof one === 'string') : [];
      } catch {
        return [];
      }
    },
    save: (ids) => store.setPagePref(DISMISSED_PREF, JSON.stringify(ids)),
  };
}

/** A short, stable hash of `text`, for a notice ID that changes with what it counts (FNV-1a, 32 bits). */
export function noticeHash(text: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(36);
}
