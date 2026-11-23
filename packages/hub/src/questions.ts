/**
 * The hub's reading of a session's questions (PRD R103, architecture.md § Conversation view): its ledger from the store, paged back to the
 * cutover, with the questions the operator dismissed; the cutover itself, recorded at the hub's first start on this version. `questionIndex`
 * keeps one ledger per session and conversation revision, which the runtime and the conversation service share.
 */
import type { Store } from '@switchboard/core';
import { questionKey, questionLedger } from '@switchboard/conversation';
import type { LedgerItem, QuestionLedger } from '@switchboard/conversation';

/** The page preference that holds the cutover (design § 9). */
export const QUESTIONS_SINCE = 'questionsLedgerSince';
/** How many of a session's messages and replies a ledger read takes at a time. */
export const QUESTION_PAGE = 100;
/** At most this many pages are read back, so a long conversation cannot hold up the hub. */
export const QUESTION_PAGES_MAX = 50;
/** The most sessions whose ledgers `questionIndex` keeps; the one used longest ago goes first. */
export const QUESTION_INDEX_SESSIONS = 32;

/** The cutover: replies before it keep the rules from before question ids; recorded the first time it is asked for. */
export function questionsSince(store: Pick<Store, 'pagePref' | 'setPagePref'>, now: number): number {
  const stored = Number(store.pagePref(QUESTIONS_SINCE));

  if (Number.isFinite(stored) && stored > 0) {
    return stored;
  }

  store.setPagePref(QUESTIONS_SINCE, String(now));
  return now;
}

/** A session's dismissed questions, by key, with when each was dismissed and the newest item then. */
export function dismissedAt(store: Pick<Store, 'dismissals'>, sessionId: string): Array<{ key: string; at: number; after: string | null }> {
  return store.dismissals(sessionId).map((one) => ({ key: questionKey(one.replyId, one.slug), at: one.at, after: one.afterId }));
}

/**
 * A session's question ledger, read from the store as the views read it. It pages back from the newest item until it reaches an item before the
 * cutover and a message before it, which settled any older card under the old rules, or the conversation's start.
 */
export function sessionLedger(store: Pick<Store, 'conversation' | 'dismissals'>, sessionId: string, since: number): QuestionLedger {
  let page = store.conversation(sessionId, null, QUESTION_PAGE, false);
  let items = page.items;
  let pages = 1;
  const reachedCutover = (): boolean => items.some((item) => item.at < since && item.type === 'message' && !item.provisional);

  while (page.more && items.length > 0 && !reachedCutover() && pages < QUESTION_PAGES_MAX) {
    page = store.conversation(sessionId, items[0]!.id, QUESTION_PAGE, false);
    items = [...page.items, ...items];
    pages++;
  }

  return questionLedger(items as unknown as LedgerItem[], { since, dismissed: dismissedAt(store, sessionId) });
}

type IndexStore = Pick<Store, 'conversation' | 'dismissals' | 'conversationRevision' | 'pagePref' | 'setPagePref'>;

/**
 * Each session's question ledger, built once per conversation revision and cutover, so the reads of one operation (a card draft's check and its
 * broadcast, a send, a voice command, a turn's end) share one.
 */
export class QuestionIndex {
  readonly #store: IndexStore;
  readonly #now: () => number;
  readonly #ledgers = new Map<string, { revision: string; since: number; ledger: QuestionLedger }>();

  constructor(store: IndexStore, now: () => number) {
    this.#store = store;
    this.#now = now;
  }

  /** A session's ledger as of now; callers read it and never change it. */
  ledger(sessionId: string, since: number = questionsSince(this.#store, this.#now())): QuestionLedger {
    const revision = this.#store.conversationRevision(sessionId);
    const kept = this.#ledgers.get(sessionId);

    this.#ledgers.delete(sessionId);

    if (kept !== undefined && kept.revision === revision && kept.since === since) {
      this.#ledgers.set(sessionId, kept);
      return kept.ledger;
    }

    const ledger = sessionLedger(this.#store, sessionId, since);

    this.#ledgers.set(sessionId, { revision, since, ledger });

    for (const old of this.#ledgers.keys()) {
      if (this.#ledgers.size <= QUESTION_INDEX_SESSIONS) {
        break;
      }

      this.#ledgers.delete(old);
    }

    return ledger;
  }
}

const indexes = new WeakMap<object, QuestionIndex>();

/** The store's question index, made on first use with `now` for the cutover; the runtime and the conversation service both take it from here. */
export function questionIndex(store: IndexStore, now: () => number = Date.now): QuestionIndex {
  let index = indexes.get(store);

  if (index === undefined) {
    index = new QuestionIndex(store, now);
    indexes.set(store, index);
  }

  return index;
}
