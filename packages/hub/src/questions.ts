/**
 * The hub's reading of a session's questions (PRD R103, architecture.md § Conversation view): its ledger from the store, paged back to the
 * cutover, with the questions the operator dismissed; the cutover itself, recorded at the hub's first start on this version.
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
